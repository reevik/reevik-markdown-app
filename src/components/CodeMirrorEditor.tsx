import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState, Compartment, type Extension, type Range } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxTree, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { readImageDataUrl, saveAttachment } from "../lib/api";
import { agentField, collabDecorations, collabKeymap, rephraseSelection } from "./collab";
import { INSERT_ACTIONS } from "./InsertToolbar";
import type { VisualizationSpec } from "vega-embed";
import type { Config } from "vega";
import "katex/dist/katex.min.css";
import { VEGA_CONFIG } from "../lib/chartTheme";

interface Props {
  /** Initial Markdown. Read once at mount — remount (via `key`) to replace it. */
  initial: string;
  /** Live Preview (Obsidian-style inline rendering) vs. plain highlighted source. */
  livePreview: boolean;
  /** Absolute path of the open note, used to resolve/save relative image paths. */
  notePath: string;
  onChange: (markdown: string) => void;
}

/** A markdown insertion: wraps the selection (or a placeholder) with before/after. */
export interface EditSpec {
  before?: string;
  after?: string;
  placeholder?: string;
  block?: boolean;
}
export interface EditorHandle {
  applyEdit(spec: EditSpec): void;
  /** Run the AI rephrase on the current selection (same as ⌘⇧R). */
  rephrase(): void;
}

/**
 * Formatting shortcuts, bound inside the editor so they only fire while it has
 * focus (a global handler would hijack ⌘B in the sidebar filter, etc.). ⌘K is the
 * command palette, so links take ⌘⇧K.
 */
const FORMAT_BINDINGS: Array<{ key: string; action: string }> = [
  { key: "Mod-b", action: "b" },
  { key: "Mod-i", action: "i" },
  { key: "Mod-e", action: "code" },
  { key: "Mod-Shift-k", action: "link" },
  { key: "Mod-Shift-x", action: "s" },
  { key: "Mod-Shift-c", action: "codeblock" },
  { key: "Mod-Shift-l", action: "ul" },
  { key: "Mod-Shift-t", action: "task" },
];

const formatKeymap = keymap.of(
  FORMAT_BINDINGS.map(({ key, action }) => ({
    key,
    run: (view: EditorView) => {
      const spec = INSERT_ACTIONS.find((a) => a.key === action)?.spec;
      if (!spec) return false;
      applyEditToView(view, spec);
      return true;
    },
  })),
);

function applyEditToView(view: EditorView | null, spec: EditSpec) {
  if (!view) return;
  const { before = "", after = "", placeholder = "", block = false } = spec;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || placeholder;
  let lead = "";
  let trail = "";
  if (block) {
    const line = view.state.doc.lineAt(from);
    lead = from === line.from ? "" : "\n";
    const nextChar = view.state.sliceDoc(to, to + 1);
    if (nextChar !== "" && nextChar !== "\n") trail = "\n";
  }
  const insert = lead + before + selected + after + trail;
  const selStart = from + lead.length + before.length;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: selStart, head: selStart + selected.length },
  });
  view.focus();
}

// --- Syntax colouring (applies in both modes) ---
const highlightStyle = HighlightStyle.define([
  { tag: t.heading, color: "var(--text-primary)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-tertiary)" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--text-tertiary)" },
  { tag: t.monospace, fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', color: "#c7254e" },
  { tag: t.quote, color: "var(--text-secondary)" },
  { tag: t.list, color: "var(--accent)" },
  { tag: t.contentSeparator, color: "var(--text-tertiary)" },
  { tag: t.processingInstruction, color: "var(--text-tertiary)" },
  // Code-token colours for fenced blocks (nested languages).
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#9333ea" },
  { tag: [t.string, t.special(t.string)], color: "#0a7d3c" },
  { tag: t.comment, color: "#8a8f98", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.atom], color: "#b45309" },
  { tag: [t.typeName, t.className, t.namespace], color: "#0369a1" },
  { tag: t.function(t.variableName), color: "#7c3aed" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#475569" },
]);

// --- Glossy, transparent theme so the window vibrancy shows through ---
const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--text-primary)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      overflow: "auto",
      // Driven by CSS variables so the Settings font applies live, without
      // rebuilding the theme or remounting the editor.
      fontFamily:
        'var(--editor-font-family, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif)',
      fontSize: "var(--editor-font-size, 15px)",
      lineHeight: "1.75",
    },
    ".cm-content": {
      maxWidth: "720px",
      margin: "0 auto",
      padding: "40px 40px 160px",
      caretColor: "var(--accent)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgba(99, 102, 241, 0.2)",
    },
    ".cm-line": { padding: "0 2px" },
  },
  { dark: false },
);

// --- Image rendering ---

function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** data: URL cache keyed by `notePath\0src` so decoration rebuilds don't refetch. */
const imageCache = new Map<string, string>();

/** Resolve an image `src` (vault-relative, http, or data) into the <img>. */
function loadImageSrc(img: HTMLImageElement, notePath: string, src: string, onError: () => void) {
  const key = `${notePath}\0${src}`;
  const cached = imageCache.get(key);
  if (cached) {
    img.src = cached;
    return;
  }
  if (/^(https?:|data:)/i.test(src)) {
    img.src = src;
    imageCache.set(key, src);
    return;
  }
  readImageDataUrl(notePath, decodePath(src))
    .then((url) => {
      imageCache.set(key, url);
      img.src = url;
    })
    .catch(onError);
}

class ImageWidget extends WidgetType {
  constructor(
    readonly notePath: string,
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.notePath === this.notePath;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-image-widget";
    const img = document.createElement("img");
    img.alt = this.alt;
    if (this.alt) img.title = this.alt;
    wrap.appendChild(img);

    loadImageSrc(img, this.notePath, this.src, () => wrap.classList.add("cm-image-error"));
    return wrap;
  }
}

// --- Standalone images rendered as resizable/alignable blocks ---

interface ImageBlock {
  from: number;
  to: number;
  alt: string;
  src: string;
  editing: boolean;
}

/** Images that are alone on their line become block widgets (resize/align). */
function imageBlocks(state: EditorState): ImageBlock[] {
  const out: ImageBlock[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Image") return;
      const line = state.doc.lineAt(node.from);
      const raw = state.doc.sliceString(node.from, node.to);
      if (line.text.trim() !== raw.trim()) return; // only images alone on their line
      const m = /^!\[([^\]]*)\]\(\s*<?([^>\s)]+)>?[^)]*\)$/.exec(raw);
      if (!m) return;
      const editing = state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from);
      out.push({ from: line.from, to: line.to, alt: m[1], src: m[2], editing });
    },
  });
  return out;
}

/** Layout is stored in the alt text as `alt|width|align` (Obsidian-style width). */
function parseImageAlt(alt: string): { text: string } & ChartMeta {
  const parts = alt.split("|");
  let width: number | undefined;
  let align: "left" | "center" | "right" | undefined;
  for (const p of parts.slice(1)) {
    const t = p.trim();
    if (/^\d+$/.test(t)) width = Number(t);
    else if (t === "left" || t === "center" || t === "right") align = t;
  }
  return { text: parts[0], width, align };
}

function buildImageAlt(text: string, meta: ChartMeta): string {
  let alt = text;
  if (meta.width) alt += `|${meta.width}`;
  if (meta.align && meta.align !== "left") alt += `|${meta.align}`;
  return alt;
}

class ImageBlockWidget extends WidgetType {
  constructor(
    readonly notePath: string,
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageBlockWidget) {
    return other.src === this.src && other.alt === this.alt && other.notePath === this.notePath;
  }

  /** Rewrite this image's markdown (alt tokens) to persist width/alignment. */
  private commit(view: EditorView, wrap: HTMLElement, patch: ChartMeta) {
    const pos = view.posAtDOM(wrap);
    const block = imageBlocks(view.state).find((b) => b.from <= pos && pos <= b.to);
    if (!block) return;
    const text = view.state.doc.sliceString(block.from, block.to);
    const m = /^(\s*)!\[([^\]]*)\]\((.*)\)(\s*)$/.exec(text);
    if (!m) return;
    const parsed = parseImageAlt(m[2]);
    const meta: ChartMeta = { width: parsed.width, align: parsed.align, ...patch };
    view.dispatch({
      changes: { from: block.from, to: block.to, insert: `${m[1]}![${buildImageAlt(parsed.text, meta)}](${m[3]})${m[4]}` },
    });
  }

  toDOM(view: EditorView) {
    const meta = parseImageAlt(this.alt);
    const wrap = document.createElement("div");
    wrap.className = "cm-image";

    const frame = document.createElement("div");
    frame.className = "cm-image-frame";
    if (meta.width) frame.style.maxWidth = `${meta.width}px`;
    const align = meta.align ?? "left";
    frame.style.marginLeft = align === "left" ? "0" : "auto";
    frame.style.marginRight = align === "right" ? "0" : "auto";

    const img = document.createElement("img");
    img.className = "cm-image-el";
    img.alt = meta.text;
    if (meta.text) img.title = meta.text;
    if (meta.width) img.style.width = "100%";
    loadImageSrc(img, this.notePath, this.src, () => wrap.classList.add("cm-image-error"));
    frame.appendChild(img);

    const handle = document.createElement("div");
    handle.className = "cm-chart-resize";
    handle.title = "Drag to resize";
    frame.appendChild(handle);

    const toolbar = document.createElement("div");
    toolbar.className = "cm-chart-toolbar";
    (["left", "center", "right"] as const).forEach((a) => {
      const b = document.createElement("button");
      b.className = "cm-chart-btn";
      b.title = `Align ${a}`;
      b.innerHTML = alignIcon(a);
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commit(view, wrap, { align: a });
      });
      toolbar.appendChild(b);
    });
    const edit = document.createElement("button");
    edit.className = "cm-chart-btn cm-chart-edit-btn";
    edit.textContent = "Edit";
    edit.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) + 1 } });
      view.focus();
    });
    toolbar.appendChild(edit);
    frame.appendChild(toolbar);
    wrap.appendChild(frame);

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = frame.getBoundingClientRect().width;
      const maxW = wrap.getBoundingClientRect().width;
      let w = startW;
      img.style.width = "100%";
      frame.style.maxWidth = `${startW}px`;
      const onMove = (ev: MouseEvent) => {
        w = Math.max(80, Math.min(maxW, startW + (ev.clientX - startX)));
        frame.style.maxWidth = `${w}px`;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        this.commit(view, wrap, { width: Math.round(w) });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
    });

    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function imageDecoration(notePath: string): Extension {
  return EditorView.decorations.compute(["doc", "selection"], (state) => {
    const blocks = imageBlocks(state).filter((b) => !b.editing);
    if (blocks.length === 0) return Decoration.none;
    return Decoration.set(
      blocks.map((b) =>
        Decoration.replace({ widget: new ImageBlockWidget(notePath, b.src, b.alt), block: true }).range(b.from, b.to),
      ),
      true,
    );
  });
}

// --- YAML frontmatter rendered as a single "Document Metadata" badge ---

class FrontmatterWidget extends WidgetType {
  constructor(readonly raw: string) {
    super();
  }
  eq(other: FrontmatterWidget) {
    return other.raw === this.raw;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-frontmatter";

    const badge = document.createElement("span");
    badge.className = "cm-fm-badge";
    badge.title = "Click to edit document metadata";
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
    const label = document.createElement("span");
    label.textContent = "Document Metadata";
    badge.appendChild(label);
    wrap.appendChild(badge);

    // Click reveals the raw YAML for editing.
    wrap.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      view.dispatch({ selection: { anchor: 1 } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

/** End position of a leading `--- … ---` frontmatter block, or -1 if none. */
function frontmatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return -1;
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text.trim() === "---") return doc.line(n).to;
  }
  return -1;
}

/** Frontmatter end when it should render as badges (cursor not inside), else -1. */
function frontmatterRendered(state: EditorState): number {
  const to = frontmatterEnd(state);
  if (to < 0) return -1;
  const inside = state.selection.ranges.some((r) => r.from <= to && r.to >= 0);
  return inside ? -1 : to;
}

/** Initial caret just past the frontmatter, so a freshly opened note renders it. */
function bodyStart(text: string): number {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return Math.min(lines.slice(0, i + 1).join("\n").length + 1, text.length);
    }
  }
  return 0;
}

// Block decoration must come from the state (facet), not a view plugin.
const frontmatterDecoration = EditorView.decorations.compute(["doc", "selection"], (state) => {
  const to = frontmatterRendered(state);
  if (to < 0) return Decoration.none;
  const raw = state.doc.sliceString(0, to);
  return Decoration.set([
    Decoration.replace({ widget: new FrontmatterWidget(raw), block: true }).range(0, to),
  ]);
});

// --- Vega-Lite chart code blocks (```vega-lite) rendered in Live Preview ---

const CHART_LANGS = new Set(["vega-lite", "vegalite", "vl"]);

// Chart theme: transparent surface, app fonts/ink, validated categorical palette.

interface ChartBlock {
  from: number;
  to: number;
  codeFrom: number;
  codeTo: number;
  code: string;
  editing: boolean;
}

/** Find fenced code blocks tagged as a chart language, with their spec + edit state. */
function chartBlocks(state: EditorState): ChartBlock[] {
  const out: ChartBlock[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      const lang = info ? state.doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
      if (!CHART_LANGS.has(lang)) return;
      const codeNode = node.node.getChild("CodeText");
      if (!codeNode) return;
      const editing = state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from);
      out.push({
        from: node.from,
        to: node.to,
        codeFrom: codeNode.from,
        codeTo: codeNode.to,
        code: state.doc.sliceString(codeNode.from, codeNode.to),
        editing,
      });
    },
  });
  return out;
}

type ChartMeta = { width?: number; align?: "left" | "center" | "right" };

/** Layout metadata is stashed in the spec's `usermeta` (which Vega-Lite ignores). */
function readChartMeta(spec: Record<string, unknown>): ChartMeta {
  const um = (spec.usermeta as Record<string, unknown> | undefined)?.vellum as Record<string, unknown> | undefined;
  const width = typeof um?.width === "number" ? um.width : undefined;
  const align =
    um?.align === "left" || um?.align === "center" || um?.align === "right" ? um.align : undefined;
  return { width, align };
}

function writeChartMeta(spec: Record<string, unknown>, patch: ChartMeta) {
  const usermeta = (spec.usermeta as Record<string, unknown>) ?? {};
  const vellum = { ...(usermeta.vellum as Record<string, unknown> | undefined), ...patch };
  spec.usermeta = { ...usermeta, vellum };
}

const ALIGN_ICONS: Record<"left" | "center" | "right", string> = {
  left: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="17" x2="17" y2="17"/>',
  center: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="17" x2="19" y2="17"/>',
  right: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="7" y1="17" x2="20" y2="17"/>',
};
const alignIcon = (a: "left" | "center" | "right") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${ALIGN_ICONS[a]}</svg>`;

class ChartWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(other: ChartWidget) {
    return other.code === this.code;
  }

  /** Rewrite the spec JSON for this block in the document (persists layout). */
  private commit(view: EditorView, wrap: HTMLElement, mutate: (s: Record<string, unknown>) => void) {
    const pos = view.posAtDOM(wrap);
    const block = chartBlocks(view.state).find((b) => b.from <= pos && pos <= b.to);
    if (!block) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(block.code) as Record<string, unknown>;
    } catch {
      return;
    }
    mutate(parsed);
    view.dispatch({
      changes: { from: block.codeFrom, to: block.codeTo, insert: JSON.stringify(parsed, null, 2) },
    });
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-chart";

    const frame = document.createElement("div");
    frame.className = "cm-chart-frame";
    const target = document.createElement("div");
    target.className = "cm-chart-target";
    frame.appendChild(target);
    const handle = document.createElement("div");
    handle.className = "cm-chart-resize";
    handle.title = "Drag to resize";
    frame.appendChild(handle);
    wrap.appendChild(frame);

    // Hover toolbar: alignment + edit.
    const toolbar = document.createElement("div");
    toolbar.className = "cm-chart-toolbar";
    (["left", "center", "right"] as const).forEach((a) => {
      const b = document.createElement("button");
      b.className = "cm-chart-btn";
      b.title = `Align ${a}`;
      b.innerHTML = alignIcon(a);
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commit(view, wrap, (s) => writeChartMeta(s, { align: a }));
      });
      toolbar.appendChild(b);
    });
    const edit = document.createElement("button");
    edit.className = "cm-chart-btn cm-chart-edit-btn";
    edit.textContent = "Edit";
    edit.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) + 1 } });
      view.focus();
    });
    toolbar.appendChild(edit);
    frame.appendChild(toolbar);

    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(this.code) as Record<string, unknown>;
    } catch {
      wrap.classList.add("cm-chart-error");
      target.textContent = "⚠ Invalid chart JSON";
      return wrap;
    }

    // Apply persisted layout (width + alignment) to the frame.
    const meta = readChartMeta(spec);
    frame.style.maxWidth = meta.width ? `${meta.width}px` : "";
    const align = meta.align ?? "left";
    frame.style.marginLeft = align === "left" ? "0" : "auto";
    frame.style.marginRight = align === "right" ? "0" : "auto";

    // Fill the frame by default so small charts don't sit cramped; author's fixed
    // width is respected only when no explicit layout has been set here.
    const composed =
      "facet" in spec || "concat" in spec || "hconcat" in spec || "vconcat" in spec || "repeat" in spec;
    if (!composed && (meta.width || !("width" in spec))) spec.width = "container";

    // Lazy-load the (large) chart library only when a chart is actually rendered.
    import("vega-embed")
      .then(({ default: embed }) =>
        embed(target, spec as VisualizationSpec, {
          actions: false,
          renderer: "svg",
          config: VEGA_CONFIG as unknown as Config,
        }),
      )
      .then((res) => {
        (target as unknown as { __view?: { finalize(): void } }).__view = res.view;
      })
      .catch((err: unknown) => {
        wrap.classList.add("cm-chart-error");
        target.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
      });

    // Drag the right edge to resize; commit the final width to the spec.
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = frame.getBoundingClientRect().width;
      const maxW = wrap.getBoundingClientRect().width;
      let w = startW;
      frame.style.maxWidth = `${startW}px`;
      const onMove = (ev: MouseEvent) => {
        w = Math.max(180, Math.min(maxW, startW + (ev.clientX - startX)));
        frame.style.maxWidth = `${w}px`;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        this.commit(view, wrap, (s) => writeChartMeta(s, { width: Math.round(w) }));
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
    });

    return wrap;
  }
  destroy(dom: HTMLElement) {
    const target = dom.querySelector(".cm-chart-target") as unknown as { __view?: { finalize(): void } } | null;
    target?.__view?.finalize();
  }
  ignoreEvent() {
    return true;
  }
}

// Block decorations must come from state, not a plugin.
const chartDecoration = EditorView.decorations.compute(["doc", "selection"], (state) => {
  const blocks = chartBlocks(state).filter((b) => !b.editing);
  if (blocks.length === 0) return Decoration.none;
  return Decoration.set(
    blocks.map((b) => Decoration.replace({ widget: new ChartWidget(b.code), block: true }).range(b.from, b.to)),
    true,
  );
});

// --- Mermaid diagram code blocks (```mermaid) rendered in Live Preview ---
// Layout is stored in the fence info tokens: ```mermaid|<width>|<align>

interface MermaidBlock {
  from: number;
  to: number;
  infoFrom: number;
  infoTo: number;
  code: string;
  editing: boolean;
  width?: number;
  align?: "left" | "center" | "right";
}

function mermaidBlocks(state: EditorState): MermaidBlock[] {
  const out: MermaidBlock[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info) return;
      const parts = state.doc.sliceString(info.from, info.to).split("|");
      if (parts[0].trim().toLowerCase() !== "mermaid") return;
      const codeNode = node.node.getChild("CodeText");
      if (!codeNode) return;
      let width: number | undefined;
      let align: "left" | "center" | "right" | undefined;
      for (const p of parts.slice(1)) {
        const t = p.trim();
        if (/^\d+$/.test(t)) width = Number(t);
        else if (t === "left" || t === "center" || t === "right") align = t;
      }
      const editing = state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from);
      out.push({
        from: node.from,
        to: node.to,
        infoFrom: info.from,
        infoTo: info.to,
        code: state.doc.sliceString(codeNode.from, codeNode.to),
        editing,
        width,
        align,
      });
    },
  });
  return out;
}

let mermaidReady = false;
let mermaidCounter = 0;

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly width?: number,
    readonly align?: "left" | "center" | "right",
  ) {
    super();
  }
  eq(other: MermaidWidget) {
    return other.code === this.code && other.width === this.width && other.align === this.align;
  }

  /** Rewrite the ```mermaid fence info tokens to persist width/alignment. */
  private commit(view: EditorView, wrap: HTMLElement, patch: ChartMeta) {
    const pos = view.posAtDOM(wrap);
    const block = mermaidBlocks(view.state).find((b) => b.from <= pos && pos <= b.to);
    if (!block) return;
    const meta: ChartMeta = { width: block.width, align: block.align, ...patch };
    let info = "mermaid";
    if (meta.width) info += `|${meta.width}`;
    if (meta.align && meta.align !== "left") info += `|${meta.align}`;
    view.dispatch({ changes: { from: block.infoFrom, to: block.infoTo, insert: info } });
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-mermaid";

    const frame = document.createElement("div");
    frame.className = "cm-mermaid-frame";
    if (this.width) frame.style.maxWidth = `${this.width}px`;
    const align = this.align ?? "left";
    frame.style.marginLeft = align === "left" ? "0" : "auto";
    frame.style.marginRight = align === "right" ? "0" : "auto";

    const target = document.createElement("div");
    target.className = "cm-mermaid-target";
    frame.appendChild(target);

    const handle = document.createElement("div");
    handle.className = "cm-chart-resize";
    handle.title = "Drag to resize";
    frame.appendChild(handle);

    const toolbar = document.createElement("div");
    toolbar.className = "cm-chart-toolbar";
    (["left", "center", "right"] as const).forEach((a) => {
      const b = document.createElement("button");
      b.className = "cm-chart-btn";
      b.title = `Align ${a}`;
      b.innerHTML = alignIcon(a);
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commit(view, wrap, { align: a });
      });
      toolbar.appendChild(b);
    });
    const edit = document.createElement("button");
    edit.className = "cm-chart-btn cm-chart-edit-btn";
    edit.textContent = "Edit";
    edit.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) + 1 } });
      view.focus();
    });
    toolbar.appendChild(edit);
    frame.appendChild(toolbar);
    wrap.appendChild(frame);

    const widthSet = this.width;
    import("mermaid")
      .then(({ default: mermaid }) => {
        if (!mermaidReady) {
          mermaid.initialize({
            startOnLoad: false,
            theme: "default",
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
          });
          mermaidReady = true;
        }
        return mermaid.render(`vellum-mermaid-${mermaidCounter++}`, this.code);
      })
      .then(({ svg }) => {
        target.innerHTML = svg;
        const el = target.querySelector("svg");
        if (el) {
          el.style.maxWidth = "100%";
          el.style.height = "auto";
          if (widthSet) el.style.width = "100%";
        }
      })
      .catch((err: unknown) => {
        wrap.classList.add("cm-chart-error");
        target.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
      });

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const svg = target.querySelector("svg");
      if (svg) {
        svg.style.width = "100%";
        svg.style.maxWidth = "none";
      }
      const startX = e.clientX;
      const startW = frame.getBoundingClientRect().width;
      const maxW = wrap.getBoundingClientRect().width;
      let w = startW;
      frame.style.maxWidth = `${startW}px`;
      const onMove = (ev: MouseEvent) => {
        w = Math.max(120, Math.min(maxW, startW + (ev.clientX - startX)));
        frame.style.maxWidth = `${w}px`;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        this.commit(view, wrap, { width: Math.round(w) });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
    });

    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const mermaidDecoration = EditorView.decorations.compute(["doc", "selection"], (state) => {
  const blocks = mermaidBlocks(state).filter((b) => !b.editing);
  if (blocks.length === 0) return Decoration.none;
  return Decoration.set(
    blocks.map((b) =>
      Decoration.replace({ widget: new MermaidWidget(b.code, b.width, b.align), block: true }).range(b.from, b.to),
    ),
    true,
  );
});

// --- LaTeX math ($...$ inline, $$...$$ display) rendered with KaTeX ---

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math cm-math-display" : "cm-math";
    import("katex")
      .then(({ default: katex }) => {
        katex.render(this.tex, el, { displayMode: this.display, throwOnError: false, output: "html" });
      })
      .catch(() => {
        el.classList.add("cm-math-error");
        el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
      });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

interface MathBlock {
  from: number;
  to: number;
  tex: string;
  editing: boolean;
}

/** Display math blocks: `$$ … $$` on their own line(s). */
function mathBlocks(state: EditorState): MathBlock[] {
  const out: Omit<MathBlock, "editing">[] = [];
  const doc = state.doc;
  let n = 1;
  while (n <= doc.lines) {
    const line = doc.line(n);
    const t = line.text.trim();
    const single = /^\$\$(.+?)\$\$$/.exec(t);
    if (single) {
      out.push({ from: line.from, to: line.to, tex: single[1].trim() });
      n += 1;
      continue;
    }
    if (t === "$$") {
      let m = n + 1;
      while (m <= doc.lines && doc.line(m).text.trim() !== "$$") m += 1;
      if (m <= doc.lines && m > n + 1) {
        const tex = doc.sliceString(doc.line(n + 1).from, doc.line(m - 1).to);
        out.push({ from: line.from, to: doc.line(m).to, tex });
        n = m + 1;
        continue;
      }
    }
    n += 1;
  }
  return out.map((b) => ({
    ...b,
    editing: state.selection.ranges.some((r) => r.from <= b.to && r.to >= b.from),
  }));
}

const mathDecoration = EditorView.decorations.compute(["doc", "selection"], (state) => {
  const blocks = mathBlocks(state).filter((b) => !b.editing);
  if (blocks.length === 0) return Decoration.none;
  return Decoration.set(
    blocks.map((b) => Decoration.replace({ widget: new MathWidget(b.tex, true), block: true }).range(b.from, b.to)),
    true,
  );
});

/** Inline `$…$` math on a single line (used by the live-preview view plugin). */
const INLINE_MATH = /(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g;

// --- Obsidian-style Live Preview: style blocks, render images, conceal markers ---

const MARK_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "QuoteMark",
  "LinkMark",
  "CodeMark",
  "URL",
]);

function buildDecorations(view: EditorView, notePath: string): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const { doc } = view.state;
  const sel = view.state.selection;
  const editing = (from: number, to: number) => sel.ranges.some((r) => r.from <= to && r.to >= from);

  const addLine = (pos: number, cls: string) => {
    const line = doc.lineAt(pos);
    deco.push(Decoration.line({ class: cls }).range(line.from));
  };
  const addLines = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      addLine(line.from, cls);
      pos = line.to + 1;
    }
  };

  // The frontmatter/chart block widgets are provided by state facets; here we only
  // skip the underlying nodes while they're rendered.
  const fmEnd = frontmatterRendered(view.state);
  const charts = chartBlocks(view.state).filter((c) => !c.editing);
  const mermaids = mermaidBlocks(view.state).filter((m) => !m.editing);
  const maths = mathBlocks(view.state).filter((m) => !m.editing);
  const codeRanges: [number, number][] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        // Track code regions so inline math ($…$) never fires inside code.
        if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") {
          codeRanges.push([node.from, node.to]);
        }
        // Skip nodes inside a rendered frontmatter, chart, mermaid, or math block.
        if (fmEnd > 0 && node.from < fmEnd) return;
        if (charts.some((c) => node.from >= c.from && node.from < c.to)) return;
        if (mermaids.some((m) => node.from >= m.from && node.from < m.to)) return;
        if (maths.some((m) => node.from >= m.from && node.from < m.to)) return;
        const name = node.name;

        if (/^ATXHeading[1-6]$/.test(name)) {
          addLine(node.from, `cm-h${name.slice(-1)}`);
        } else if (name === "Blockquote") {
          addLines(node.from, node.to, "cm-quote");
        } else if (name === "HorizontalRule") {
          addLine(node.from, "cm-hr");
        } else if (name === "FencedCode" || name === "CodeBlock") {
          // Gray background only while the cursor is inside (edit mode); rendered
          // blocks are transparent.
          const codeEditing = editing(node.from, node.to);
          addLines(node.from, node.to, codeEditing ? "cm-codeblock cm-codeblock-editing" : "cm-codeblock");
          // Hide the ``` fence lines in Live Preview (reveal when editing the block).
          if (name === "FencedCode" && !codeEditing) {
            const first = doc.lineAt(node.from);
            const last = doc.lineAt(Math.max(node.from, node.to - 1));
            if (last.number > first.number) {
              if (first.length > 0) deco.push(Decoration.replace({}).range(first.from, first.to));
              if (last.length > 0) deco.push(Decoration.replace({}).range(last.from, last.to));
            }
          }
        } else if (name === "InlineCode") {
          deco.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
        } else if (name === "Image") {
          const imgRaw = doc.sliceString(node.from, node.to); // ![alt](src "title")
          // Images alone on their line are rendered as resizable blocks by a facet.
          if (doc.lineAt(node.from).text.trim() === imgRaw.trim()) return;
          if (!editing(node.from, node.to)) {
            const m = /^!\[([^\]]*)\]\(\s*<?([^>\s)]+)>?[^)]*\)/.exec(imgRaw);
            if (m) {
              const widget = new ImageWidget(notePath, m[2], m[1]);
              deco.push(Decoration.replace({ widget }).range(node.from, node.to));
            }
          }
        } else if (name === "Link") {
          deco.push(Decoration.mark({ class: "cm-link" }).range(node.from, node.to));
        } else if (MARK_NODES.has(name)) {
          const parent = node.node.parent;
          if (!parent) return;
          if (name === "CodeMark" && parent.name !== "InlineCode") return;
          if ((name === "LinkMark" || name === "URL") && parent.name !== "Link") return;
          if (editing(parent.from, parent.to)) return;

          let end = node.to;
          if (name === "HeaderMark" || name === "QuoteMark") {
            while (doc.sliceString(end, end + 1) === " ") end++;
          }
          if (end > node.from) deco.push(Decoration.replace({}).range(node.from, end));
        }
      },
    });
  }

  // Inline math ($…$): rendered per visible line, but never inside code or a block.
  const skip: [number, number][] = [
    ...(fmEnd > 0 ? ([[0, fmEnd]] as [number, number][]) : []),
    ...charts.map((c) => [c.from, c.to] as [number, number]),
    ...mermaids.map((m) => [m.from, m.to] as [number, number]),
    ...maths.map((m) => [m.from, m.to] as [number, number]),
    ...codeRanges,
  ];
  const inSkip = (a: number, b: number) => skip.some(([x, y]) => x < b && y > a);
  for (const { from, to } of view.visibleRanges) {
    let line = doc.lineAt(from);
    for (;;) {
      INLINE_MATH.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = INLINE_MATH.exec(line.text)) !== null) {
        const mFrom = line.from + mm.index;
        const mTo = mFrom + mm[0].length;
        if (inSkip(mFrom, mTo) || editing(mFrom, mTo)) continue;
        deco.push(Decoration.replace({ widget: new MathWidget(mm[1], false) }).range(mFrom, mTo));
      }
      if (line.to >= to || line.to + 1 > doc.length) break;
      line = doc.lineAt(line.to + 1);
    }
  }

  return Decoration.set(deco, true);
}

function livePreviewExtension(notePath: string): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, notePath);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
          this.decorations = buildDecorations(u.view, notePath);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// --- Paste / drop image insertion ---

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extForFile(file: File): string {
  const dot = file.name.lastIndexOf(".");
  if (dot >= 0 && dot < file.name.length - 1) return file.name.slice(dot + 1);
  const m = /image\/([\w+.-]+)/.exec(file.type);
  return m ? m[1].replace("+xml", "") : "png";
}

function imagesFromTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith("image/")) out.push(f);
  }
  if (out.length === 0) {
    for (const it of Array.from(dt.items ?? [])) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

async function insertImages(view: EditorView, notePath: string, files: File[], at: number) {
  let pos = at;
  for (const file of files) {
    try {
      const b64 = arrayBufferToBase64(await file.arrayBuffer());
      const rel = await saveAttachment(notePath, b64, extForFile(file));
      const needLead = pos > 0 && view.state.doc.sliceString(pos - 1, pos) !== "\n";
      const text = `${needLead ? "\n" : ""}![](${rel})\n`;
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
      });
      pos += text.length;
    } catch (e) {
      console.error("image insert failed", e);
    }
  }
}

function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

function attachmentHandlers(notePath: string): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const imgs = imagesFromTransfer(event.clipboardData);
      if (imgs.length === 0) return false;
      event.preventDefault();
      insertImages(view, notePath, imgs, view.state.selection.main.head);
      return true;
    },
    // The browser only fires `drop` when `dragover` is prevented for the drag.
    dragover(event) {
      if (hasFiles(event.dataTransfer)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }
      return false;
    },
    drop(event, view) {
      const imgs = imagesFromTransfer(event.dataTransfer);
      if (imgs.length === 0) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      insertImages(view, notePath, imgs, pos);
      return true;
    },
  });
}

// --- Component ---

const CodeMirrorEditor = forwardRef<EditorHandle, Props>(function CodeMirrorEditor(
  { initial, livePreview, notePath, onChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(
    ref,
    () => ({
      applyEdit: (spec) => applyEditToView(viewRef.current, spec),
      rephrase: () => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        rephraseSelection(view);
      },
    }),
    [],
  );

  const [compartment] = useState(() => new Compartment());
  // Live-mode extensions: inline/line decorations (plugin) + the frontmatter block
  // decoration (must come from the state facet, not the plugin).
  const [liveExt] = useState<Extension>(() => [
    livePreviewExtension(notePath),
    frontmatterDecoration,
    chartDecoration,
    mermaidDecoration,
    mathDecoration,
    imageDecoration(notePath),
  ]);

  // Create the editor once. Content is seeded from `initial`; the parent remounts
  // (via `key`) to swap notes or apply external edits.
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: initial,
      selection: { anchor: bodyStart(initial) },
      extensions: [
        history(),
        collabKeymap,
        formatKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        drawSelection(),
        agentField,
        collabDecorations,
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlightStyle),
        theme,
        attachmentHandlers(notePath),
        compartment.of(livePreview ? liveExt : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle Live Preview without tearing down the editor (keeps cursor/history).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartment.reconfigure(livePreview ? liveExt : []),
    });
  }, [livePreview, compartment, liveExt]);

  return <div ref={hostRef} className="cm-host h-full" />;
});

export default CodeMirrorEditor;
