/** A folder registered as a vault (an Obsidian-style document root). */
export interface Vault {
  path: string;
  name: string;
}

/** A node in a vault's document tree: a Markdown file or a folder. */
export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children: TreeNode[] | null;
}

/** One row of a Content Index: a note, a folder heading above them, or a heading
 *  inside a note. `depth` is the indent level — folder nesting, plus a heading's
 *  own `#` count. */
export interface ContentIndexEntry {
  title: string;
  /** The note (or folder) this row points at — for a heading, its note. */
  path: string;
  kind: "file" | "dir" | "heading";
  depth: number;
  /** Slug of a heading row, so a link can jump to it; empty otherwise. */
  anchor: string;
}

/** One editorial suggestion from the AI agent — a concrete original→replacement edit. */
export interface Suggestion {
  title: string;
  detail: string;
  /** Exact span in the document to replace; empty if not individually applicable. */
  original: string;
  replacement: string;
}

/** How good the document is right now, 0-100 overall plus per-dimension scores. */
export interface Quality {
  score: number;
  verdict: string;
  clarity: number;
  structure: number;
  grammar: number;
  tone: number;
}

/** The AI agent's review of a note. */
export interface Review {
  /** null when the model omitted or malformed the rating. */
  quality: Quality | null;
  summary: string;
  /** Local, individually-applicable edits — the agent never rewrites the whole note. */
  suggestions: Suggestion[];
}

/** A source found by the research agent via web search. */
export interface Reference {
  title: string;
  url: string;
  source: string;
  year: string;
  /** "paper" | "article" | "docs" | "book" | "other" */
  kind: string;
  summary: string;
  relevance: string;
}

export interface ReferenceResult {
  query: string;
  references: Reference[];
}

export type AiBackend = "cli" | "api" | "none";
