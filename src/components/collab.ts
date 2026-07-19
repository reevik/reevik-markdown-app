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
import { rephrase } from "../lib/api";

// --- Agent working region -------------------------------------------------

type AgentRange = { from: number; to: number } | null;

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
    readonly kind: "user" | "agent",
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

  if (agent.to > agent.from) {
    deco.push(Decoration.mark({ class: "collab-agent-range" }).range(agent.from, agent.to));
  }
  deco.push(Decoration.widget({ widget: new FlagWidget("Agent", "agent"), side: -1 }).range(agent.from));

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

// --- ⌘⇧R: rephrase the selection (or current line) ------------------------

export function rephraseSelection(view: EditorView): boolean {
  const sel = view.state.selection.main;
  let { from, to } = sel;
  if (from === to) {
    const line = view.state.doc.lineAt(from);
    from = line.from;
    to = line.to;
  }
  const text = view.state.doc.sliceString(from, to);
  if (!text.trim()) return false;

  // Flag the region as the agent's, then swap in the rephrased text on return.
  view.dispatch({ effects: setAgentRange.of({ from, to }) });

  rephrase(text)
    .then((result) => {
      const range = view.state.field(agentField, false);
      if (!range) return;
      const replacement = result.trim();
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: replacement },
        effects: setAgentRange.of(null),
        selection: { anchor: range.from + replacement.length },
      });
    })
    .catch((e) => {
      console.error("rephrase failed", e);
      view.dispatch({ effects: setAgentRange.of(null) });
    });

  return true;
}

export const collabKeymap = keymap.of([{ key: "Mod-Shift-r", run: rephraseSelection }]);
