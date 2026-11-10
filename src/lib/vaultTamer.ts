/**
 * "Tame my vault": rate every note for completeness in the background, so the
 * author can see which half-started notes are safe to delete.
 *
 * A module-level store rather than component state, because a run can take
 * minutes and must survive the sidebar being collapsed (which unmounts it).
 * Ratings are cached per vault against each file's size and modified time, so
 * a re-run only spends AI calls on notes that changed.
 */
import { useSyncExternalStore } from "react";
import { noteSignatures, rateNotes, type RatedNote, type Verdict } from "./api";

export interface Rating {
  score: number;
  verdict: Verdict;
  reason: string;
  sig: string;
}

export interface Job {
  total: number;
  done: number;
}

export interface RunResult {
  rated: number;
  stubs: number;
  total: number;
  /** Set when the run stopped early; ratings made so far are kept. */
  error?: string;
  cancelled?: boolean;
}

interface State {
  vault: string | null;
  ratings: Record<string, Rating>;
  job: Job | null;
  last: RunResult | null;
}

/** Notes per AI request: few enough to keep each prompt modest, enough to
 *  amortise the CLI's start-up cost. */
const BATCH = 10;
const KEY = "vault.ratings";

let state: State = { vault: null, ratings: {}, job: null, last: null };
let cancelRequested = false;
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function save() {
  if (!state.vault) return;
  try {
    localStorage.setItem(`${KEY}:${state.vault}`, JSON.stringify(state.ratings));
  } catch (e) {
    console.error(e);
  }
}

/** Point the store at a vault, loading its saved ratings. */
export function useVaultRatings(vault: string): State {
  if (state.vault !== vault) {
    let ratings: Record<string, Rating> = {};
    try {
      ratings = JSON.parse(localStorage.getItem(`${KEY}:${vault}`) ?? "{}");
    } catch {
      ratings = {};
    }
    // Switching vaults mid-run: the old run's results go to the old vault.
    state = { vault, ratings, job: null, last: null };
    cancelRequested = true;
  }
  return useSyncExternalStore(subscribe, () => state);
}

/** What a run would do, for the confirmation: how many notes, how many changed. */
export async function planRun(paths: string[]): Promise<{ total: number; toRate: string[] }> {
  const sigs = await noteSignatures(paths);
  const toRate = sigs.filter((s) => state.ratings[s.path]?.sig !== s.sig).map((s) => s.path);
  return { total: sigs.length, toRate };
}

/**
 * Rate `toRate` in batches. Notes no longer in the vault lose their rating;
 * `allPaths` is every note now present.
 */
export async function runTaming(toRate: string[], allPaths: string[]) {
  if (state.job) return;
  const vault = state.vault;
  const present = new Set(allPaths);
  const kept = Object.fromEntries(Object.entries(state.ratings).filter(([p]) => present.has(p)));
  set({ ratings: kept, job: { total: toRate.length, done: 0 }, last: null });
  save();
  cancelRequested = false;

  let rated = 0;
  let error: string | undefined;
  for (let i = 0; i < toRate.length; i += BATCH) {
    if (cancelRequested || state.vault !== vault) break;
    const batch = toRate.slice(i, i + BATCH);
    let results: RatedNote[];
    try {
      results = await rateNotes(batch);
    } catch (e) {
      error = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      break;
    }
    if (state.vault !== vault) break;
    const ratings = { ...state.ratings };
    for (const r of results) {
      ratings[r.path] = { score: r.score, verdict: r.verdict, reason: r.reason, sig: r.sig };
    }
    rated += results.length;
    set({ ratings, job: { total: toRate.length, done: Math.min(i + batch.length, toRate.length) } });
    save();
  }

  if (state.vault !== vault) return;
  const stubs = allPaths.filter((p) => state.ratings[p]?.verdict === "stub").length;
  set({
    job: null,
    last: { rated, stubs, total: allPaths.length, error, cancelled: cancelRequested && !error },
  });
}

export function cancelTaming() {
  cancelRequested = true;
}

export function dismissResult() {
  set({ last: null });
}

/** Follow a rename or move; drop the rating of a deleted note or folder. */
export function remapRatings(oldPath: string, newPath: string | null) {
  const affects = (p: string) => p === oldPath || p.startsWith(`${oldPath}/`);
  const entries = Object.entries(state.ratings);
  if (!entries.some(([p]) => affects(p))) return;
  const ratings: Record<string, Rating> = {};
  for (const [p, r] of entries) {
    if (!affects(p)) ratings[p] = r;
    else if (newPath) ratings[p === oldPath ? newPath : newPath + p.slice(oldPath.length)] = r;
  }
  set({ ratings });
  save();
}

/**
 * A note was saved: its rating describes a version that no longer exists.
 * Drop it, so an edited "stub" doesn't keep its marker until the next run.
 */
export function forgetRating(path: string) {
  if (!state.ratings[path]) return;
  const { [path]: _gone, ...ratings } = state.ratings;
  set({ ratings });
  save();
}
