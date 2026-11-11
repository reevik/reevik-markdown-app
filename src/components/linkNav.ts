/**
 * Links in the editor: drawing `[[wikilinks]]`, opening any link on click,
 * and completing note names after `[[` and paths after `](`.
 *
 * Opening: in Live Preview a plain click on a shown link opens it; ⌘-click
 * always does, including in Source mode, where a plain click must stay a
 * plain click for editing.
 */
import { type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { openExternal, revealInFinder } from "../lib/api";
import { markdownHref, relative, resolveHref, resolveWiki, vaultIndex, wikiName } from "../lib/links";
import { openNoteAt, scrollToAnchor, slugify } from "./noteAnchor";
import { notify } from "./collab";
import { isConcealed } from "../lib/hidden";

const WIKI = /\[\[([^[\]\n]+)\]\]/g;
const CODE = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "CodeInfo"]);

function inCode(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (CODE.has(n.name)) return true;
  }
  return false;
}

export interface Wikilink {
  from: number;
  to: number;
  inner: string;
}

/** `[[…]]` links between `from` and `to`, outside code. */
export function findWikilinks(state: EditorState, from: number, to: number): Wikilink[] {
  const out: Wikilink[] = [];
  const doc = state.doc;
  for (let pos = doc.lineAt(from).from; pos <= to; ) {
    const line = doc.lineAt(pos);
    for (const m of line.text.matchAll(WIKI)) {
      const start = line.from + (m.index ?? 0);
      if (!inCode(state, start)) out.push({ from: start, to: start + m[0].length, inner: m[1] });
    }
    pos = line.to + 1;
  }
  return out;
}

/**
 * Live Preview decorations for wikilinks: the brackets (and the target, when
 * there's an `|alias`) are hidden unless the cursor is in the link; a link to
 * a note that doesn't exist is drawn as missing.
 */
export function wikiDecorations(
  links: Wikilink[],
  notePath: string,
  editing: (from: number, to: number) => boolean,
): Range<Decoration>[] {
  const { root, notes } = vaultIndex();
  const out: Range<Decoration>[] = [];
  for (const w of links) {
    const missing = notes.length > 0 && resolveWiki(w.inner, notePath, root, notes).kind === "missing";
    const cls = `cm-link cm-wikilink${missing ? " cm-link-missing" : ""}`;
    if (editing(w.from, w.to)) {
      out.push(Decoration.mark({ class: cls }).range(w.from + 2, w.to - 2));
      continue;
    }
    const bar = w.inner.indexOf("|");
    const shownFrom = bar === -1 ? w.from + 2 : w.from + 2 + bar + 1;
    out.push(Decoration.replace({}).range(w.from, shownFrom));
    if (w.to - 2 > shownFrom) out.push(Decoration.mark({ class: cls }).range(shownFrom, w.to - 2));
    out.push(Decoration.replace({}).range(w.to - 2, w.to));
  }
  return out;
}

// --- What's at a position ----------------------------------------------------

type LinkHit = { kind: "wiki"; inner: string; from: number; to: number } | { kind: "href"; href: string; from: number; to: number };

/** Reference definitions (`[label]: url`) in the note, by lower-cased label. */
export function definitions(state: EditorState): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of state.doc.toString().matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]*>|\S+)/gm)) {
    out.set(m[1].trim().toLowerCase(), m[2]);
  }
  return out;
}

/** A Link node that actually points somewhere: an inline URL, a full
 *  reference, or a shortcut whose label is defined. `[text]` alone is not. */
export function linkTarget(state: EditorState, node: SyntaxNode, defs?: Map<string, string>): string | null {
  const url = node.getChild("URL");
  if (url) return state.sliceDoc(url.from, url.to);
  // `[text][label]` names its label; `[text]` and `[text][]` use the text.
  const label = node.getChild("LinkLabel");
  const text = label
    ? state.sliceDoc(label.from + 1, label.to - 1)
    : (/^\[([^\]]*)\]/.exec(state.sliceDoc(node.from, node.to))?.[1] ?? "");
  if (!text.trim()) return null;
  return (defs ?? definitions(state)).get(text.trim().toLowerCase()) ?? null;
}

function linkAt(state: EditorState, pos: number): LinkHit | null {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(WIKI)) {
    const from = line.from + (m.index ?? 0);
    const to = from + m[0].length;
    if (pos >= from && pos <= to && !inCode(state, from)) return { kind: "wiki", inner: m[1], from, to };
  }
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "Link") {
      const href = linkTarget(state, n);
      return href ? { kind: "href", href, from: n.from, to: n.to } : null;
    }
    if (n.name === "Autolink" || (n.name === "URL" && n.parent?.name !== "Link")) {
      const url = n.name === "URL" ? n : n.getChild("URL");
      return url ? { kind: "href", href: state.sliceDoc(url.from, url.to), from: n.from, to: n.to } : null;
    }
    if (n.name === "Image" || CODE.has(n.name)) return null;
  }
  return null;
}

function openLink(view: EditorView, link: LinkHit, notePath: string) {
  const { root, notes } = vaultIndex();
  const target =
    link.kind === "wiki" ? resolveWiki(link.inner, notePath, root, notes) : resolveHref(link.href, notePath, root, notes);
  switch (target.kind) {
    case "web":
      openExternal(target.url).catch(() => notify(view, link.from, "Couldn't open the link", "error"));
      return;
    case "note": {
      const anchor = target.heading ? slugify(target.heading) : null;
      if (target.path === notePath) {
        if (anchor) scrollToAnchor(view, anchor);
      } else {
        openNoteAt(target.path, anchor);
      }
      return;
    }
    case "file":
      // Revealed, not opened: a linked file could be anything.
      revealInFinder(target.path).catch(() => notify(view, link.from, "File not found", "error"));
      return;
    case "missing":
      notify(view, link.from, `No note “${target.label}”`, "error");
  }
}

export function linkClicks(notePath: string) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0 || e.shiftKey || e.altKey) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const link = linkAt(view.state, pos);
      if (!link) return false;
      const sel = view.state.selection.main;
      const editing = sel.from <= link.to && sel.to >= link.from;
      // Shown as a link (Live Preview) and not being edited: a click opens it.
      const shown = !!(e.target as HTMLElement).closest?.(".cm-link") && !editing;
      if (!e.metaKey && !shown) return false;
      e.preventDefault();
      openLink(view, link, notePath);
      return true;
    },
  });
}

// --- Completion -----------------------------------------------------------------

const stripExt = (p: string) => p.replace(/\.(md|markdown)$/i, "");

/** Insert `text`, skip a closing `close` that's already there, land after it. */
function applyWith(text: string, close: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const has = view.state.sliceDoc(to, to + close.length) === close;
    const insert = has ? text : text + close;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + text.length + close.length },
    });
  };
}

function complete(ctx: CompletionContext, notePath: string): CompletionResult | null {
  const { root, notes } = vaultIndex();
  // Hidden notes aren't suggested (links already written still open them).
  const others = notes.filter((p) => p !== notePath && !isConcealed(p));
  if (others.length === 0 || inCode(ctx.state, ctx.pos)) return null;

  // [[… — list notes by their path, insert the shortest unique name.
  const wiki = ctx.matchBefore(/\[\[[^[\]\n|#]*/);
  if (wiki) {
    return {
      from: wiki.from + 2,
      options: others.map((p) => {
        const name = wikiName(p, root, notes);
        return { label: stripExt(relative(root, p)), apply: applyWith(name, "]]") };
      }),
      validFor: /^[^[\]\n|#]*$/,
    };
  }

  // ]( … — relative paths from this note.
  const md = ctx.matchBefore(/\]\([^)\s]*/);
  if (md) {
    return {
      from: md.from + 2,
      options: others.map((p) => {
        const href = markdownHref(notePath, p);
        return { label: decodeURIComponent(href), apply: applyWith(href, ")") };
      }),
      validFor: /^[^)\s]*$/,
    };
  }
  return null;
}

export function linkCompletion(notePath: string) {
  return autocompletion({ override: [(ctx) => complete(ctx, notePath)], icons: false });
}

