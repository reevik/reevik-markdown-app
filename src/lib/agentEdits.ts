/**
 * Edits the Editorial agent makes to the open note.
 *
 * When the author asks for a change ("add a conclusion", "fix the intro"),
 * the agent ends its reply with a block like:
 *
 *   <edits>
 *   <edit><find>exact text</find><replace>new text</replace></edit>
 *   <edit><append>new section</append></edit>
 *   </edits>
 *
 * Tags rather than JSON, because the payload is multi-line Markdown full of
 * quotes and backslashes that a model escapes unreliably. Inserting in the
 * middle is expressed as a replace that keeps its anchor, which keeps the
 * whitespace entirely under the model's control.
 */

export type AgentEdit =
  | { kind: "replace"; find: string; replace: string }
  | { kind: "append"; text: string }
  | { kind: "rewrite"; text: string };

/** A change in the coordinates of the document it was resolved against. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** What happened when edits were applied, kept with the chat message. */
export interface EditOutcome {
  /** File name of the note the edits targeted. */
  note: string;
  applied: number;
  /** The `find` text of each edit that couldn't be placed, for the author to see. */
  failed: string[];
  /** Set when nothing could be tried at all, e.g. the note was closed. */
  reason?: string;
  /** Applied in the live editor, so one ⌘Z reverts it. */
  undoable?: boolean;
}

/**
 * Splits a reply into what the author reads and the edits to apply. While a
 * reply is still streaming the block may be half-written: `editing` says the
 * agent has started on it, so the panel can say so instead of showing tags.
 */
export function splitReply(reply: string): { text: string; edits: AgentEdit[]; editing: boolean } {
  const at = reply.indexOf("<edits>");
  if (at === -1) return { text: reply, edits: [], editing: false };

  // Models sometimes wrap the block in a code fence despite being told not to;
  // don't leave a dangling fence in the visible text.
  const text = reply
    .slice(0, at)
    .replace(/```[a-z]*\s*$/i, "")
    .trimEnd();
  const block = reply.slice(at);
  const done = block.includes("</edits>");
  if (!done) return { text, edits: [], editing: true };

  const edits: AgentEdit[] = [];
  for (const m of block.matchAll(/<edit>([\s\S]*?)<\/edit>/g)) {
    const body = m[1];
    const rewrite = tag(body, "rewrite");
    const append = tag(body, "append");
    const find = tag(body, "find");
    const replace = tag(body, "replace");
    if (rewrite !== null) edits.push({ kind: "rewrite", text: rewrite });
    else if (append !== null) edits.push({ kind: "append", text: append });
    else if (find !== null && find.trim() !== "" && replace !== null) edits.push({ kind: "replace", find, replace });
  }
  return { text, edits, editing: false };
}

/** The contents of `<name>…</name>`, minus the line breaks a model puts
 *  just inside the tags when it writes them on their own lines. */
function tag(body: string, name: string): string | null {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return null;
  return m[1].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

/**
 * Places edits in `doc`. Every position refers to `doc` as given (the edits
 * don't shift each other), which is the form an editor transaction expects.
 * An edit that can't be found, or that overlaps one already placed, is
 * reported rather than guessed.
 */
export function resolveEdits(doc: string, edits: AgentEdit[]): { changes: TextChange[]; failed: string[] } {
  // A full rewrite supersedes everything else in the same reply.
  const rewrite = [...edits].reverse().find((e) => e.kind === "rewrite");
  if (rewrite && rewrite.kind === "rewrite") {
    return { changes: [{ from: 0, to: doc.length, insert: ensureTrailingNewline(rewrite.text) }], failed: [] };
  }

  const changes: TextChange[] = [];
  const failed: string[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (from: number, to: number) => claimed.some(([a, b]) => from < b && to > a);

  for (const e of edits) {
    if (e.kind !== "replace") continue;
    const hit = locate(doc, e.find, overlaps);
    if (!hit) {
      failed.push(e.find);
      continue;
    }
    let { from, to } = hit;
    // Deleting a whole paragraph would leave a double gap; take one with it.
    if (e.replace === "" && doc.slice(from - 2, from) === "\n\n" && doc.slice(to, to + 2) === "\n\n") to += 2;
    claimed.push([from, to]);
    changes.push({ from, to, insert: e.replace });
  }

  // Appends all land at the end, in the order given, as one block.
  const appends = edits.filter((e): e is Extract<AgentEdit, { kind: "append" }> => e.kind === "append");
  if (appends.length > 0) {
    const body = appends.map((a) => a.text.replace(/^\n+|\n+$/g, "")).join("\n\n");
    const gap = doc.length === 0 ? "" : doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
    changes.push({ from: doc.length, to: doc.length, insert: `${gap}${body}\n` });
  }

  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  return { changes, failed };
}

/** Applies resolved changes to a string — for a note that isn't in the editor. */
export function applyChanges(doc: string, changes: TextChange[]): string {
  let out = "";
  let last = 0;
  for (const c of changes) {
    out += doc.slice(last, c.from) + c.insert;
    last = c.to;
  }
  return out + doc.slice(last);
}

/**
 * Finds `needle` in `doc`, skipping anything already claimed by another edit.
 * Exact first; then tolerant of whitespace, since models often reflow a line
 * or collapse a double space when quoting.
 */
function locate(
  doc: string,
  needle: string,
  taken: (from: number, to: number) => boolean,
): { from: number; to: number } | null {
  for (let at = doc.indexOf(needle); at !== -1; at = doc.indexOf(needle, at + 1)) {
    if (!taken(at, at + needle.length)) return { from: at, to: at + needle.length };
  }

  const words = needle.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "g");
  for (const m of doc.matchAll(pattern)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (!taken(from, to)) return { from, to };
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/** Short, single-line preview of a failed `find`, for the status line. */
export function preview(s: string, max = 60): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
