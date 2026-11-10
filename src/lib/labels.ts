/**
 * Coloured labels on notes, stored as frontmatter `tags:` — the same field
 * Obsidian uses — so a label travels with its note through iCloud, renames and
 * moves, and Obsidian sees it too. Colours aren't part of any note: they live
 * in the vault's `.reevik/labels.json`.
 *
 * Frontmatter follows the rule the editor and backend already use: the first
 * line is `---`, and the block ends at the next `---` line.
 */
import { useSyncExternalStore } from "react";
import { readFrontmatters, readLabelColors, writeLabelColors } from "./api";

// --- Frontmatter -------------------------------------------------------------

/** The frontmatter body (between the fences) and where the block ends, or null. */
export function frontmatter(text: string): { body: string; end: number } | null {
  const lines = text.split("\n");
  if (lines.length < 2 || lines[0].trim() !== "---") return null;
  let offset = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      const body = lines.slice(1, i).join("\n");
      return { body, end: offset + lines[i].length };
    }
    offset += lines[i].length + 1;
  }
  return null;
}

/** Labels from frontmatter, in any form Obsidian accepts: `tags: [a, b]`,
 *  a `- item` list, `tags: a, b` or `a b`, and the singular `tag:`. */
export function parseTags(body: string): string[] {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(tags?)\s*:\s*(.*)$/);
    if (!m) continue;
    const rest = m[2].trim();
    let items: string[];
    if (rest.startsWith("[")) {
      items = rest.replace(/^\[|\]$/g, "").split(",");
    } else if (rest === "") {
      items = [];
      for (let j = i + 1; j < lines.length && /^\s+-\s*/.test(lines[j]); j++) {
        items.push(lines[j].replace(/^\s+-\s*/, ""));
      }
    } else {
      items = rest.split(/[,\s]+/);
    }
    return dedupe(items.map(clean).filter(Boolean));
  }
  return [];
}

function clean(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").trim();
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** A label as Obsidian would accept it as a tag: no spaces, no `#`. */
export function normalizeLabel(name: string): string {
  return name
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_\-/]/gu, "");
}

/**
 * The note with its labels set to `tags`. Replaces the existing `tags`/`tag`
 * field in whatever form it was written, keeps every other field as it was,
 * creates a frontmatter block when there is none, and removes a block that
 * held nothing but the labels being cleared.
 */
export function setTags(text: string, tags: string[]): string {
  const list = dedupe(tags.map(normalizeLabel).filter(Boolean));
  const line = `tags: [${list.join(", ")}]`;
  const fm = frontmatter(text);

  if (!fm) {
    if (list.length === 0) return text;
    return `---\n${line}\n---\n\n${text.replace(/^\n+/, "")}`;
  }

  const lines = fm.body === "" ? [] : fm.body.split("\n");
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^tags?\s*:/.test(lines[i])) {
      // Skip a block-list continuation too.
      while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1])) i++;
      if (!replaced && list.length > 0) out.push(line);
      replaced = true;
      continue;
    }
    out.push(lines[i]);
  }
  if (!replaced && list.length > 0) out.unshift(line);

  const rest = text.slice(fm.end);
  if (out.every((l) => l.trim() === "")) return rest.replace(/^\n+/, "");
  return `---\n${out.join("\n")}\n---${rest}`;
}

// --- Colours -----------------------------------------------------------------

/** Distinct, readable on the light sidebar, in a sensible pick order. */
export const PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];

/** A label's colour: its chosen one, else a stable pick from the palette. */
export function colorOf(label: string, colors: Record<string, string>): string {
  if (colors[label]) return colors[label];
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// --- Store -------------------------------------------------------------------

interface State {
  vault: string | null;
  /** Labels per note path; notes without labels are absent. */
  notes: Record<string, string[]>;
  colors: Record<string, string>;
}

let state: State = { vault: null, notes: {}, colors: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The labels of every note in `vault`, loading them the first time. */
export function useLabels(vault: string): State {
  if (state.vault !== vault) {
    state = { vault, notes: {}, colors: {} };
    void load(vault);
  }
  return useSyncExternalStore(subscribe, () => state);
}

async function load(vault: string) {
  try {
    const [fms, colors] = await Promise.all([readFrontmatters(vault), readLabelColors(vault)]);
    if (state.vault !== vault) return;
    const notes: Record<string, string[]> = {};
    for (const [path, body] of Object.entries(fms)) {
      const tags = parseTags(body);
      if (tags.length) notes[path] = tags;
    }
    set({ notes, colors });
  } catch (e) {
    console.error(e);
  }
}

/** Re-read a note's labels from its text — after an edit, by hand or by us. */
export function noteTextChanged(path: string, text: string) {
  const fm = frontmatter(text);
  const tags = fm ? parseTags(fm.body) : [];
  const had = state.notes[path] ?? [];
  if (had.join("\u0000") === tags.join("\u0000")) return;
  const notes = { ...state.notes };
  if (tags.length) notes[path] = tags;
  else delete notes[path];
  set({ notes });
}

/** Follow a rename or move; forget a deleted note or folder. */
export function remapLabels(oldPath: string, newPath: string | null) {
  const affects = (p: string) => p === oldPath || p.startsWith(`${oldPath}/`);
  const entries = Object.entries(state.notes);
  if (!entries.some(([p]) => affects(p))) return;
  const notes: Record<string, string[]> = {};
  for (const [p, tags] of entries) {
    if (!affects(p)) notes[p] = tags;
    else if (newPath) notes[p === oldPath ? newPath : newPath + p.slice(oldPath.length)] = tags;
  }
  set({ notes });
}

export async function setLabelColor(label: string, color: string) {
  if (!state.vault) return;
  const colors = { ...state.colors, [label]: color };
  set({ colors });
  await writeLabelColors(state.vault, colors);
}
