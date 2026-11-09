import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CliLoginHint from "./CliLoginHint";
import EditorialChat from "./EditorialChat";
import {
  aiBackend,
  CLI_NOT_LOGGED_IN,
  COPILOT_CLI_MISSING,
  findReferences,
  openExternal,
  suggestImprovements,
} from "../lib/api";
import { parsePartialJson } from "../lib/partialJson";
import type { Quality, Reference, ReferenceResult, Review, Suggestion } from "../lib/types";

interface Props {
  width: number;
  /** Scopes the Editorial conversation: one thread per vault. */
  vaultPath: string;
  path: string | null;
  content: string;
  onApply: (next: string) => void;
  /** Insert markdown at the cursor (used to drop a citation into the note). */
  onInsertText: (markdown: string) => void;
}

/**
 * The three faces of the panel. Editorial is the conversation; Analyze is the
 * automatic review (what used to be called Editorial); References is the web
 * search. ⌘⇧E / ⌘⇧A / ⌘⇧F switch between them.
 */
type Mode = "chat" | "analyze" | "references";

const TABS: { id: Mode; label: string; hint: string }[] = [
  { id: "chat", label: "Editorial", hint: "\u2318\u21e7E" },
  { id: "analyze", label: "Analyze", hint: "\u2318\u21e7A" },
  { id: "references", label: "References", hint: "\u2318\u21e7F" },
];

export default function AiPanel({ width, vaultPath, path, content, onApply, onInsertText }: Props) {
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<Mode>("analyze");
  /** Partial review decoded from the CLI's streaming output, shown while it runs. */
  const [streaming, setStreaming] = useState<Partial<Review> | null>(null);
  const [refsStreaming, setRefsStreaming] = useState<Partial<ReferenceResult> | null>(null);
  /** What the agent is doing right now, e.g. `Searching: transformer scaling laws`. */
  const [activity, setActivity] = useState("");

  const { data: backend } = useQuery({ queryKey: ["ai-backend"], queryFn: aiBackend });

  const review = useMutation<Review, Error, string>({
    mutationFn: (text: string) => suggestImprovements(text),
  });
  const refs = useMutation<ReferenceResult, Error, string>({
    mutationFn: (text: string) => findReferences(text),
  });

  // Read the latest text at fire time without re-running effects on every keystroke.
  const contentRef = useRef(content);
  contentRef.current = content;

  // Logged out counts as no backend: nothing will run until the author signs in,
  // and auto-review shouldn't fire into a guaranteed failure.
  const loggedOut = backend === "cli-logged-out";
  const copilotMissing = backend === "copilot-missing";
  const noBackend = backend === "none" || loggedOut || copilotMissing;
  // Copilot has no web search to ground citations in, so References stays
  // with Claude rather than listing sources from memory.
  const refsUnsupported = backend === "copilot";

  // A run that fails on login means the badge and notice are stale: re-ask the
  // backend so the whole panel reflects it, not just this one error.
  const qc = useQueryClient();
  useEffect(() => {
    if (errorText(review.error) === CLI_NOT_LOGGED_IN || errorText(refs.error) === CLI_NOT_LOGGED_IN) {
      qc.invalidateQueries({ queryKey: ["ai-backend"] });
    }
  }, [review.error, refs.error, qc]);
  const hasText = !!path && content.trim().length > 0 && !noBackend;
  const canReview = hasText && !review.isPending;
  const canSearch = hasText && !refs.isPending && !refsUnsupported;

  // Clear stale results when switching to a different note. The conversation is
  // deliberately left alone — it spans notes, so opening another one mid-thread
  // must not throw the author out of it.
  useEffect(() => {
    review.reset();
    refs.reset();
    setMode((m) => (m === "references" ? "analyze" : m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    setApplied(new Set());
  }, [review.data]);

  // The backend streams the raw reply as it is generated; decode whatever keys
  // have fully arrived so the score/suggestions show up before the rewrite ends.
  useEffect(() => {
    const un = listen<string>("ai:review-progress", (e) => {
      setStreaming(parsePartialJson<Review>(e.payload));
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  // Drop the partial as soon as the authoritative result lands (or fails).
  useEffect(() => {
    if (!review.isPending) setStreaming(null);
  }, [review.isPending]);

  // The reference search streams too, plus a note of which query is running —
  // web round-trips would otherwise leave the panel silent for a minute.
  useEffect(() => {
    const un = listen<{ text: string; activity: string }>("ai:references-progress", (e) => {
      setRefsStreaming(parsePartialJson<ReferenceResult>(e.payload.text));
      setActivity(e.payload.activity);
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!refs.isPending) {
      setRefsStreaming(null);
      setActivity("");
    }
  }, [refs.isPending]);

  // Editorial runs on its own when a note is opened — but only once per note, so
  // typing (or flipping between tabs) doesn't fire a burst of paid AI calls.
  const reviewed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!path || noBackend || !hasText || reviewed.current.has(path)) return;
    const id = window.setTimeout(() => {
      if (reviewed.current.has(path)) return;
      reviewed.current.add(path);
      // Run it, but don't pull the author off the conversation to show it.
      setMode((m) => (m === "chat" ? m : "analyze"));
      review.mutate(contentRef.current);
    }, 800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, noBackend, hasText]);

  // ⌘⇧A / ⌘⇧F (and the palette) arrive as window events.
  useEffect(() => {
    const runReview = () => {
      setMode("analyze");
      if (canReview) {
        if (path) reviewed.current.add(path);
        review.mutate(contentRef.current);
      }
    };
    const runRefs = () => {
      setMode("references");
      if (canSearch) refs.mutate(contentRef.current);
    };
    const openChat = () => setMode("chat");
    window.addEventListener("reevik:ai-suggest", runReview);
    window.addEventListener("reevik:ai-references", runRefs);
    window.addEventListener("reevik:ai-chat", openChat);
    return () => {
      window.removeEventListener("reevik:ai-suggest", runReview);
      window.removeEventListener("reevik:ai-references", runRefs);
      window.removeEventListener("reevik:ai-chat", openChat);
    };
  }, [canReview, canSearch, path, review, refs]);

  function applySuggestion(index: number, s: Suggestion) {
    if (!s.original) return;
    const at = content.indexOf(s.original);
    if (at === -1) return;
    const next = content.slice(0, at) + s.replacement + content.slice(at + s.original.length);
    onApply(next);
    setApplied((prev) => new Set(prev).add(index));
  }

  const busy = mode === "analyze" ? review.isPending : mode === "references" && refs.isPending;
  const reviewMs = useElapsed(review.isPending);
  const refsMs = useElapsed(refs.isPending);
  const elapsed = mode === "analyze" ? reviewMs : refsMs;
  const hasRun = mode === "analyze" ? !!review.data || review.isError : !!refs.data || refs.isError;

  // Prefer the finished review; fall back to whatever has streamed in so far.
  const shown: Partial<Review> | null = review.data ?? streaming;
  // A suggestion arriving mid-stream can be missing fields — only show whole ones.
  const shownSuggestions = (shown?.suggestions ?? []).filter(
    (s) => s && typeof s.title === "string" && typeof s.replacement === "string",
  );

  return (
    <aside className="agent-pane flex shrink-0 flex-col" style={{ width }}>
      <header className="flex h-10 shrink-0 items-center gap-2 px-4" data-tauri-drag-region>
        <SparkIcon />
        <h2 className="flex-1 text-[13px] font-semibold text-[var(--text-primary)]" data-tauri-drag-region>
          {TABS.find((t) => t.id === mode)?.label}
        </h2>
        <BackendBadge backend={backend} />
      </header>

      {/* One dock, three panels. Each is also a keyboard shortcut away. */}
      <div className="mx-3 mb-2 flex shrink-0 gap-0.5 rounded-lg bg-black/[0.06] p-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setMode(t.id)}
            title={`${t.label} (${t.hint})`}
            className={`flex-1 rounded-[6px] px-2 py-1 text-[11.5px] transition-colors ${
              mode === t.id
                ? "bg-white/80 font-medium text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-secondary)] hover:bg-white/40"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === "chat" ? (
        <>
          {loggedOut ? (
            <CliLoginHint className="mx-4 mb-3" />
          ) : copilotMissing ? (
            <CopilotInstallHint className="mx-4 mb-3" />
          ) : (
            noBackend && (
              <p className="mx-4 mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2.5 text-[11px] leading-relaxed text-yellow-800">
                No AI backend available. Install the <code className="rounded bg-black/10 px-1">claude</code> CLI, or
                add an Anthropic API key in Settings.
              </p>
            )
          )}
          <EditorialChat
            vaultPath={vaultPath}
            path={path}
            content={content}
            noBackend={noBackend}
            loggedOut={loggedOut}
            onInsertText={onInsertText}
          />
        </>
      ) : (
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {loggedOut ? (
          <CliLoginHint className="mb-3" />
        ) : copilotMissing ? (
          <CopilotInstallHint className="mb-3" />
        ) : (
          noBackend && (
            <p className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2.5 text-[11px] leading-relaxed text-yellow-800">
              No AI backend available. Install the <code className="rounded bg-black/10 px-1">claude</code> CLI, or add
              an Anthropic API key in Settings.
            </p>
          )
        )}
        {!path && !noBackend && (
          <p className="text-[12px] text-[var(--text-tertiary)]">Open a note to get started.</p>
        )}

        {(busy || (hasRun && elapsed > 0)) && (
          <p className="mb-3 flex items-baseline gap-2 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
            <span className="min-w-0 flex-1">
              {busy
                ? mode === "analyze"
                  ? "Reviewing the document…"
                  : activity || "Searching the web…"
                : mode === "analyze"
                  ? "Reviewed"
                  : "Searched"}
            </span>
            <span className={`shrink-0 tabular-nums ${busy ? "text-[var(--accent)]" : ""}`}>
              {formatElapsed(elapsed)}
            </span>
          </p>
        )}

        {mode === "analyze" ? (
          <>
            {review.isError && !loggedOut && <ErrorNote error={review.error} />}

            {shown && (
              <div className="rise flex flex-col gap-3">
                {/* Mid-stream `quality` can be an empty object — wait for a score. */}
                {shown.quality?.score ? <QualityCard q={shown.quality} /> : null}

                {shown.summary && (
                  <p className="text-[12px] italic leading-relaxed text-[var(--text-secondary)]">
                    {shown.summary}
                  </p>
                )}

                {shownSuggestions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                      Click a suggestion to apply it
                    </p>
                    {shownSuggestions.map((s, i) => {
                      const isApplied = applied.has(i);
                      const canApply = !!s.original && content.includes(s.original);
                      return (
                        <button
                          key={i}
                          onClick={() => applySuggestion(i, s)}
                          disabled={isApplied || !canApply}
                          title={
                            isApplied
                              ? "Applied"
                              : canApply
                                ? "Apply this suggestion"
                                : "The original text was not found in the current document"
                          }
                          className={`card p-2.5 text-left transition-colors ${
                            isApplied
                              ? "opacity-55"
                              : canApply
                                ? "cursor-pointer hover:border-[var(--accent)]"
                                : "cursor-not-allowed opacity-55"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-[12px] font-semibold text-[var(--text-primary)]">{s.title}</p>
                            <span
                              className={`shrink-0 text-[10px] font-semibold ${
                                isApplied
                                  ? "text-green-600"
                                  : canApply
                                    ? "text-[var(--accent)]"
                                    : "text-[var(--text-tertiary)]"
                              }`}
                            >
                              {isApplied ? "Applied ✓" : canApply ? "Apply →" : "n/a"}
                            </span>
                          </div>
                          {s.detail && (
                            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                              {s.detail}
                            </p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

              </div>
            )}

            {!review.data && !busy && hasText && (
              <button onClick={() => review.mutate(content)} className="btn-bezel w-full py-1.5 text-[12px]">
                Review again
              </button>
            )}
          </>
        ) : (
          <ReferencesView
            refs={refs}
            partial={refsStreaming}
            content={content}
            canSearch={canSearch}
            hasNote={!!path}
            busy={busy}
            loggedOut={loggedOut}
            unsupported={refsUnsupported}
            onInsertText={onInsertText}
          />
        )}
      </div>
      )}
    </aside>
  );
}

function ReferencesView({
  refs,
  partial,
  content,
  canSearch,
  hasNote,
  busy,
  loggedOut,
  unsupported,
  onInsertText,
}: {
  refs: ReturnType<typeof useMutation<ReferenceResult, Error, string>>;
  partial: Partial<ReferenceResult> | null;
  content: string;
  canSearch: boolean;
  hasNote: boolean;
  busy: boolean;
  /** The panel already shows the login hint; don't repeat it as an error. */
  loggedOut: boolean;
  /** The selected provider can't search the web (Copilot). */
  unsupported: boolean;
  onInsertText: (markdown: string) => void;
}) {
  const [addedAll, setAddedAll] = useState(false);

  // Prefer the settled result; otherwise show whatever has streamed in. Entries
  // still mid-write lack a URL, so only render the complete ones.
  const data = refs.data ?? partial;
  const list = (data?.references ?? []).filter(
    (r): r is Reference => !!r && typeof r.title === "string" && typeof r.url === "string",
  );

  const citation = (r: Reference) => {
    const bits = [r.source, r.year].filter(Boolean).join(", ");
    return `- [${r.title}](${r.url})${bits ? ` — ${bits}` : ""}`;
  };

  return (
    <>
      {refs.isError && !loggedOut && <ErrorNote error={refs.error} />}

      {data && (list.length > 0 || !busy) && (
        <div className="rise flex flex-col gap-3">
          {list.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
              No solid sources found for this topic. Try adding more detail to the note first.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                  {list.length} found{data.query ? ` · ${data.query}` : ""}
                </p>
                <button
                  onClick={() => {
                    onInsertText(`## References\n\n${list.map(citation).join("\n")}\n`);
                    setAddedAll(true);
                    setTimeout(() => setAddedAll(false), 1400);
                  }}
                  className="btn-bezel shrink-0 px-2 py-0.5 text-[11px]"
                >
                  {addedAll ? "Inserted ✓" : "Insert all"}
                </button>
              </div>

              {list.map((r, i) => (
                <div key={i} className="card p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      onClick={() => openExternal(r.url).catch((e) => console.error(e))}
                      title={r.url}
                      className="min-w-0 flex-1 text-left text-[12px] font-semibold text-[var(--accent-strong)] hover:underline"
                    >
                      {r.title}
                    </button>
                    {r.kind && (
                      <span className="shrink-0 rounded bg-black/8 px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                        {r.kind}
                      </span>
                    )}
                  </div>

                  {(r.source || r.year) && (
                    <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                      {[r.source, r.year].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {r.summary && (
                    <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{r.summary}</p>
                  )}
                  {r.relevance && (
                    <p className="mt-1 text-[11.5px] italic leading-relaxed text-[var(--text-tertiary)]">
                      {r.relevance}
                    </p>
                  )}

                  <div className="mt-2 flex gap-1.5">
                    <button
                      onClick={() => openExternal(r.url).catch((e) => console.error(e))}
                      className="btn-bezel px-2 py-0.5 text-[11px]"
                    >
                      Open
                    </button>
                    <button onClick={() => onInsertText(`${citation(r)}\n`)} className="btn-bezel px-2 py-0.5 text-[11px]">
                      Cite
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {unsupported && !data && !busy && (
        <p className="mb-3 rounded-lg border border-black/10 bg-black/[0.04] p-2.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Reference search needs live web search so every citation comes from a real result. GitHub Copilot can't
          do that here yet — switch the provider to Claude in Settings to use it.
        </p>
      )}

      {!data && !busy && !unsupported && (
        <button
          onClick={() => refs.mutate(content)}
          disabled={!canSearch}
          className="btn-accent w-full py-2 text-[13px]"
        >
          {hasNote ? "Search the web for references" : "Open a note first"}
        </button>
      )}
    </>
  );
}

/** Document quality: 5 stars (partial-filled to the exact score) + a percentage. */
function QualityCard({ q }: { q: Quality }) {
  const tone =
    q.score >= 75 ? "text-green-600" : q.score >= 50 ? "text-yellow-600" : "text-red-500";
  const bar = q.score >= 75 ? "bg-green-500" : q.score >= 50 ? "bg-yellow-500" : "bg-red-400";

  return (
    <div className="card p-2.5">
      <div className="flex items-center gap-2">
        <Stars score={q.score} />
        <span className={`text-[15px] font-semibold tabular-nums ${tone}`}>{q.score}%</span>
      </div>
      {q.verdict && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{q.verdict}</p>
      )}

      <div className="mt-2 flex flex-col gap-1">
        {([
          ["Clarity", q.clarity],
          ["Structure", q.structure],
          ["Grammar", q.grammar],
          ["Tone", q.tone],
        ] as const)
          .filter(([, v]) => v > 0)
          .map(([label, v]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[10px] text-[var(--text-tertiary)]">{label}</span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-black/10">
                <span className={`block h-full rounded-full ${bar}`} style={{ width: `${v}%` }} />
              </span>
              <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-[var(--text-tertiary)]">
                {v}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Outline stars with a solid row clipped to the score, so 78% shows ~3.9 stars. */
function Stars({ score }: { score: number }) {
  const row = (fill: string) => (
    <span className="flex gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24" width="14" height="14" className={fill}>
          <path
            d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4 6.2 20.5l1.1-6.5L2.6 9.4l6.5-.9z"
            fill="currentColor"
          />
        </svg>
      ))}
    </span>
  );
  return (
    <span className="relative inline-flex" title={`${score} / 100`}>
      {row("text-black/12")}
      <span
        className="absolute left-0 top-0 overflow-hidden"
        style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
      >
        {row("text-yellow-500")}
      </span>
    </span>
  );
}

/**
 * Milliseconds since the current run started. Ticks while `running`, then freezes
 * on the exact final duration so the last figure stays on screen.
 */
function useElapsed(running: boolean): number {
  const [ms, setMs] = useState(0);
  const startedAt = useRef(0);
  useEffect(() => {
    if (!running) return;
    startedAt.current = Date.now();
    setMs(0);
    const id = window.setInterval(() => setMs(Date.now() - startedAt.current), 100);
    return () => {
      window.clearInterval(id);
      setMs(Date.now() - startedAt.current);
    };
  }, [running]);
  return ms;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Tauri rejects a failed command with a plain string, not an `Error`, so
 *  `.message` alone comes back undefined and the note renders empty. */
function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function ErrorNote({ error }: { error: unknown }) {
  const text = errorText(error).trim();
  if (text === CLI_NOT_LOGGED_IN) return <CliLoginHint className="mb-3" />;
  if (text === COPILOT_CLI_MISSING) return <CopilotInstallHint className="mb-3" />;
  return (
    <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-700">
      {text || "The request failed without an explanation. Try again, or check the Claude CLI in a terminal."}
    </p>
  );
}

function BackendBadge({ backend }: { backend?: string }) {
  if (!backend) return null;
  const label =
    backend === "cli"
      ? "Claude CLI"
      : backend === "api"
        ? "API key"
        : backend === "copilot"
          ? "Copilot"
          : backend === "cli-logged-out"
            ? "Not logged in"
            : backend === "copilot-missing"
              ? "Copilot missing"
              : "offline";
  const tone =
    backend === "none"
      ? "bg-black/10 text-[var(--text-tertiary)]"
      : backend === "cli-logged-out" || backend === "copilot-missing"
        ? "bg-yellow-400/20 text-yellow-800"
        : "bg-green-400/15 text-green-700";
  return <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium ${tone}`}>{label}</span>;
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6z" />
    </svg>
  );
}

/** Copilot is the selected provider but its CLI isn't on this machine. */
function CopilotInstallHint({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2.5 text-[11px] leading-relaxed text-yellow-900 ${className}`}
    >
      <p>
        <span className="font-semibold">The GitHub Copilot CLI isn't installed.</span> Install it and sign in from a
        terminal, or switch the provider back to Claude in Settings:
      </p>
      <code className="mt-1.5 block rounded bg-black/10 px-1.5 py-0.5 font-mono text-[11px]">
        npm install -g @github/copilot
      </code>
      <code className="mt-1 block rounded bg-black/10 px-1.5 py-0.5 font-mono text-[11px]">copilot login</code>
    </div>
  );
}
