/**
 * Hidden notes: kept out of sight for privacy. Stored per vault in
 * `.reevik/hidden.json` (vault-relative, so it syncs across Macs).
 *
 * Hiding is a view, not protection — the files stay readable in Finder and
 * Obsidian. "Show hidden" is deliberately not remembered: every launch starts
 * with hidden notes out of sight.
 */
import { useSyncExternalStore } from "react";
import { readHidden, writeHidden } from "./api";
import { notifyVaultChanged } from "./contentIndex";

interface State {
  vault: string | null;
  hidden: Set<string>;
  /** Show hidden notes (dimmed) for now; reset on every launch. */
  showing: boolean;
}

let state: State = { vault: null, hidden: new Set(), showing: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  // Content Index lists drop hidden notes; let them redraw.
  notifyVaultChanged();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useHidden(vault: string): State {
  if (state.vault !== vault) {
    state = { vault, hidden: new Set(), showing: false };
    readHidden(vault)
      .then((paths) => {
        if (state.vault === vault) set({ hidden: new Set(paths) });
      })
      .catch((e) => console.error(e));
  }
  return useSyncExternalStore(subscribe, () => state);
}

/** Whether `path` is out of sight right now (hidden, and not being shown). */
export function isConcealed(path: string): boolean {
  return !state.showing && state.hidden.has(path);
}

/** The hidden set, whether or not it's being shown — for AI vault actions,
 *  which leave hidden notes out either way. */
export function hiddenPaths(): Set<string> {
  return state.hidden;
}

function save() {
  if (state.vault) writeHidden(state.vault, [...state.hidden]).catch((e) => console.error(e));
}

export function setHidden(paths: string[], hide: boolean) {
  const hidden = new Set(state.hidden);
  for (const p of paths) {
    if (hide) hidden.add(p);
    else hidden.delete(p);
  }
  set({ hidden });
  save();
}

export function setShowingHidden(showing: boolean) {
  set({ showing });
}

/** Follow a rename or move; forget a deleted note or folder. */
export function remapHidden(oldPath: string, newPath: string | null) {
  const affects = (p: string) => p === oldPath || p.startsWith(`${oldPath}/`);
  if (![...state.hidden].some(affects)) return;
  const hidden = new Set<string>();
  for (const p of state.hidden) {
    if (!affects(p)) hidden.add(p);
    else if (newPath) hidden.add(p === oldPath ? newPath : newPath + p.slice(oldPath.length));
  }
  set({ hidden });
  save();
}
