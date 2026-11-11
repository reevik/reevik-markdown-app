import { StateField, StateEffect, type Range } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
  keymap,
} from "@codemirror/view";
import { CLI_NOT_LOGGED_IN, COPILOT_CLI_MISSING, rephrase, restoreDiacritics, translate } from "../lib/api";
import { onlyAccentsChanged } from "../lib/diacritics";

// --- Agent working region -------------------------------------------------

/**
 * The span the agent is working on, with what its flag says. With a `tone`
 * it is a brief message rather than work in progress: the flag shows, the
 * span doesn't pulse.
 */
type AgentRange = { from: number; to: number; label?: string; tone?: "note" | "error" } | null;

/** Set (or clear with `null`) the span the AI agent is currently working on. */
export const setAgentRange = StateEffect.define<AgentRange>();

export const agentField = StateField.define<AgentRange>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setAgentRange)) return e.value;
    // Keep the region anchored to its text as the document changes.
    if (value && tr.docChanged) {
      return { from: tr.changes.mapPos(value.from, 1), to: tr.changes.mapPos(value.to, -1) };
    }
    return value;
  },
});

// --- Google-Docs-style collaborator flags --------------------------------

class FlagWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly kind: "user" | "agent" | "error",
  ) {
    super();
  }
  eq(o: FlagWidget) {
    return o.label === this.label && o.kind === this.kind;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = `collab-flag collab-${this.kind}`;
    const tag = document.createElement("span");
    tag.className = "collab-tag";
    tag.textContent = this.label;
    wrap.appendChild(tag);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function build(view: EditorView): DecorationSet {
  const agent = view.state.field(agentField, false) ?? null;
  // Flags only exist while a collaboration is in progress; otherwise nothing.
  if (!agent) return Decoration.none;

  const deco: Range<Decoration>[] = [];

  if (agent.to > agent.from && !agent.tone) {
    deco.push(Decoration.mark({ class: "collab-agent-range" }).range(agent.from, agent.to));
  }
  const kind = agent.tone === "error" ? "error" : "agent";
  deco.push(Decoration.widget({ widget: new FlagWidget(agent.label ?? "Agent", kind), side: -1 }).range(agent.from));

  // The user's own caret is marked only during the collaboration.
  if (view.hasFocus) {
    const head = view.state.selection.main.head;
    deco.push(Decoration.widget({ widget: new FlagWidget("User", "user"), side: 1 }).range(head));
  }

  return Decoration.set(deco, true);
}

export const collabDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.focusChanged ||
        u.startState.field(agentField) !== u.state.field(agentField)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// --- AI actions on the selection: ⌘⇧R rephrase, ⌘⇧D restore diacritics ----

/**
 * Sends the selection (or the current line) to an AI action and swaps in the
 * result, flagging the span as the agent's while it works. `check` can veto a
 * result. Failures show as a short-lived flag rather than vanishing.
 */
interface RunOptions {
  label: string;
  run: (text: string) => Promise<string>;
  check?: (before: string, after: string) => string | null;
  unchanged?: string;
}

/** The selection, or the current line when nothing is selected; null if blank. */
function selectionRange(view: EditorView): { from: number; to: number } | null {
  let { from, to } = view.state.selection.main;
  if (from === to) {
    const line = view.state.doc.lineAt(from);
    from = line.from;
    to = line.to;
  }
  return view.state.doc.sliceString(from, to).trim() ? { from, to } : null;
}

function runOnSelection(view: EditorView, opts: RunOptions): boolean {
  const r = selectionRange(view);
  if (!r) return false;
  runOnRange(view, r.from, r.to, opts);
  return true;
}

function runOnRange(view: EditorView, from: number, to: number, opts: RunOptions) {
  const text = view.state.doc.sliceString(from, to);
  view.dispatch({ effects: setAgentRange.of({ from, to, label: opts.label }) });

  opts
    .run(text)
    .then((result) => {
      const range = view.state.field(agentField, false);
      if (!range) return;
      // Keep the selection's own leading and trailing whitespace.
      const lead = text.match(/^\s*/)![0];
      const trail = text.match(/\s*$/)![0];
      const replacement = text.trim() ? lead + result.trim() + trail : result;
      const problem = opts.check?.(text, replacement);
      if (problem) return flash(view, range.from, problem, "error");
      if (replacement === text) return flash(view, range.from, opts.unchanged ?? "Nothing to change", "note");
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: replacement },
        effects: setAgentRange.of(null),
        selection: { anchor: range.from + replacement.length },
      });
    })
    .catch((e) => {
      console.error(`${opts.label} failed`, e);
      const range = view.state.field(agentField, false);
      flash(view, range?.from ?? from, failureLabel(e), "error");
    });
}

/** A few words on a flag at `at`, then gone — e.g. "No note “Plan”". */
export function notify(view: EditorView, at: number, label: string, tone: "note" | "error" = "note") {
  flash(view, at, label, tone);
}

/** A few words on the flag, then gone. */
function flash(view: EditorView, at: number, label: string, tone: "note" | "error") {
  try {
    view.dispatch({ effects: setAgentRange.of({ from: at, to: at, label, tone }) });
  } catch {
    return; // the note was closed meanwhile
  }
  setTimeout(() => {
    try {
      if (view.state.field(agentField, false)?.label === label) view.dispatch({ effects: setAgentRange.of(null) });
    } catch {
      /* closed */
    }
  }, 4000);
}

function failureLabel(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  if (text === CLI_NOT_LOGGED_IN) return "Log in to the Claude CLI";
  if (text === COPILOT_CLI_MISSING) return "Copilot CLI not installed";
  if (text.startsWith("The selection is too long")) return "Selection too long";
  return "AI request failed";
}

export function rephraseSelection(view: EditorView): boolean {
  return runOnSelection(view, { label: "Rephrasing…", run: rephrase });
}

/** ⌘⇧D: put missing accents back — and only accents. */
export function restoreDiacriticsSelection(view: EditorView): boolean {
  return runOnSelection(view, {
    label: "Restoring accents…",
    run: restoreDiacritics,
    check: (before, after) => (onlyAccentsChanged(before, after) ? null : "Changed more than accents — not applied"),
    unchanged: "No accents to restore",
  });
}

/**
 * ⌘⇧T: ask which language, then translate. The editor component owns the
 * language picker, so this only announces the range and where to show it.
 */
export const TRANSLATE_REQUEST = "reevik-translate";

export function requestTranslate(view: EditorView): boolean {
  const r = selectionRange(view);
  if (!r) return false;
  const at = view.coordsAtPos(r.from);
  view.dom.dispatchEvent(
    new CustomEvent(TRANSLATE_REQUEST, { detail: { ...r, x: at?.left ?? 0, y: (at?.bottom ?? 0) + 6 } }),
  );
  return true;
}

export function translateRange(view: EditorView, from: number, to: number, language: string) {
  // The document may have shifted while the picker was open; stay in bounds.
  const len = view.state.doc.length;
  runOnRange(view, Math.min(from, len), Math.min(to, len), {
    label: `Translating to ${language}…`,
    run: (text) => translate(text, language),
    unchanged: `Already in ${language}`,
  });
}

export const collabKeymap = keymap.of([
  { key: "Mod-Shift-r", run: rephraseSelection },
  { key: "Mod-Shift-d", run: restoreDiacriticsSelection },
  { key: "Mod-Shift-t", run: requestTranslate },
]);
