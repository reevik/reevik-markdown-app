import { readContentIndex } from "./api";
import type { ContentIndexEntry } from "./types";

/**
 * Shared state behind the Content Index block.
 *
 * The block renders a list nobody typed: it is derived from the vault every time
 * it is drawn, so it can never drift from what is actually on disk. That only
 * holds if something tells it when the hierarchy moved — this module is that
 * something. Index widgets live inside CodeMirror rather than the React tree, so
 * they can't reach React Query; they subscribe here instead.
 */

/** Bumped whenever the vault's file hierarchy may have changed. */
let revision = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, { rev: number; entries: Promise<ContentIndexEntry[]> }>();

/** Tell every mounted Content Index that the hierarchy shifted under it. */
export function notifyVaultChanged() {
  revision += 1;
  cache.clear();
  for (const listener of listeners) listener();
}

// Notes also arrive from outside the app — a sync client, a coding agent, an
// editor in another window — and none of those go through our mutations. Coming
// back to the window is the cheapest reliable moment to re-check.
const onWindowFocus = () => notifyVaultChanged();

export function subscribeVaultChanges(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("focus", onWindowFocus);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("focus", onWindowFocus);
  };
}

/**
 * Cached per (dir, depth, headers, exclude) and cleared on every revision bump,
 * so a note holding several indexes — or a widget CodeMirror redraws
 * mid-keystroke — walks the disk once rather than once per paint.
 */
export function loadContentIndex(
  dir: string,
  maxDepth: number,
  includeHeaders: number,
  exclude: string | null,
): Promise<ContentIndexEntry[]> {
  const key = `${dir} ${maxDepth} ${includeHeaders} ${exclude ?? ""}`;
  const hit = cache.get(key);
  if (hit && hit.rev === revision) return hit.entries;

  // A failed walk must not be remembered, or the block stays broken until the
  // next unrelated change.
  const entries = readContentIndex(dir, maxDepth, includeHeaders, exclude).catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { rev: revision, entries });
  return entries;
}
