import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import CliLoginHint from "./CliLoginHint";
import Markdown from "./Markdown";
import Spinner from "./Spinner";
import { preview, splitReply, type AgentEdit, type EditOutcome } from "../lib/agentEdits";
import { chat, CLI_NOT_LOGGED_IN } from "../lib/api";
import type { ChatMessage } from "../lib/types";

interface Props {
  /** Storage key scope: one conversation per vault. */
  vaultPath: string;
  path: string | null;
  content: string;
  noBackend: boolean;
  /** The panel shows the login hint itself; the chat only adjusts its prompt. */
  loggedOut: boolean;
  /** Apply the agent's edits to the note it was asked about. */
  onApplyEdits: (notePath: string, edits: AgentEdit[]) => EditOutcome;
  /** Insert markdown at the cursor, so a reply can go straight into the note. */
  onInsertText: (markdown: string) => void;
}

const STORE_KEY = "ai.chat";

/** How many turns travel with each send. The backend is stateless, so the whole
 *  transcript is replayed every time — an unbounded thread would eventually cost
 *  a fortune and overflow the context window, so only the recent tail goes. */
const SEND_WINDOW = 24;

/** Keep the on-disk thread from growing without limit; the user still sees far
 *  more history than is ever sent. */
const KEEP_MESSAGES = 200;

function loadThread(vault: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`${STORE_KEY}:${vault}`);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        typeof (m as ChatMessage).content === "string" &&
        ((m as ChatMessage).role === "user" || (m as ChatMessage).role === "assistant"),
    );
  } catch {
    return [];
  }
}

function saveThread(vault: string, messages: ChatMessage[]) {
  try {
    localStorage.setItem(`${STORE_KEY}:${vault}`, JSON.stringify(messages.slice(-KEEP_MESSAGES)));
  } catch (e) {
    // The thread stays usable for this session; it just won't survive a restart.
    console.error(e);
  }
}

export default function EditorialChat({
  vaultPath,
  path,
  content,
  noBackend,
  loggedOut,
  onApplyEdits,
  onInsertText,
}: Props) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadThread(vaultPath));
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  /** The reply as it streams in, before it becomes a settled message. */
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => saveThread(vaultPath, messages), [vaultPath, messages]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // The note is read at send time rather than captured in a callback, so a reply
  // never answers against text the author has since changed.
  const noteRef = useRef({ path, content });
  noteRef.current = { path, content };

  useEffect(() => {
    const un = listen<string>("ai:chat-progress", (e) => setStreaming(e.payload));
    return () => {
      un.then((off) => off());
    };
  }, []);

  // Stick to the bottom as the reply grows, the way a chat log should.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, pending]);

  // ⌘⇧E (menu, palette) lands here: put the cursor in the box ready to type.
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener("reevik:ai-chat", focus);
    return () => window.removeEventListener("reevik:ai-chat", focus);
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || pending || noBackend) return;

    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setError(null);
    setStreaming("");
    setPending(true);
    try {
      // The note the request is about. Edits go to it even if the author has
      // moved to another tab by the time the reply lands.
      const { path: notePath, content: noteText } = noteRef.current;
      const reply = await chat(forBackend(next.slice(-SEND_WINDOW)), notePath, noteText);
      const { text, edits } = splitReply(reply);
      let edit: EditOutcome | undefined;
      if (edits.length > 0) {
        edit = notePath
          ? onApplyEdits(notePath, edits)
          : { note: "", applied: 0, failed: [], reason: "no note was open" };
      }
      setMessages((prev) => [...prev, { role: "assistant", content: text || (edit ? "Done." : reply), edit }]);
    } catch (e) {
      // The author's turn stays in the thread so they can retry without retyping.
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // Let the whole panel switch to the login notice, not just this reply.
      if (message === CLI_NOT_LOGGED_IN) qc.invalidateQueries({ queryKey: ["ai-backend"] });
    } finally {
      setPending(false);
      setStreaming("");
    }
  }

  function clearThread() {
    setMessages([]);
    setError(null);
    setStreaming("");
    setConfirmClear(false);
    try {
      localStorage.removeItem(`${STORE_KEY}:${vaultPath}`);
    } catch (e) {
      console.error(e);
    }
  }

  async function copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      setTimeout(() => setCopied((c) => (c === index ? null : c)), 1400);
    } catch (e) {
      console.error(e);
    }
  }

  const empty = messages.length === 0 && !pending;
  const liveReply = splitReply(streaming);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={logRef} className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        {empty && (
          <div className="flex h-full flex-col justify-center gap-2 text-center">
            <p className="text-[12px] text-[var(--text-secondary)]">Talk through the note.</p>
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              Ask for a tighter opening, a counter-argument, a summary — whatever you'd ask an editor.
              Ask it to add, change or remove something and it edits the note directly; ⌘Z undoes it.
              The conversation is kept until you clear it.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                className="self-end max-w-[88%] whitespace-pre-wrap break-words rounded-[10px] rounded-br-[3px] bg-[var(--accent-soft)] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--accent-strong)]"
              >
                {m.content}
              </div>
            ) : (
              <div key={i} className="group self-start w-full">
                <Markdown text={m.content} />
                {m.edit && <EditStatus edit={m.edit} />}
                <div className="mt-1 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button onClick={() => copy(m.content, i)} className="btn-bezel px-2 py-0.5 text-[10.5px]">
                    {copied === i ? "Copied ✓" : "Copy"}
                  </button>
                  <button
                    onClick={() => onInsertText(`${m.content}\n`)}
                    title="Insert this reply into the note at the cursor"
                    className="btn-bezel px-2 py-0.5 text-[10.5px]"
                  >
                    Insert
                  </button>
                </div>
              </div>
            ),
          )}

          {pending && (
            <div className="self-start w-full">
              {streaming ? (
                <>
                  <Markdown text={liveReply.text} />
                  {liveReply.editing ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--accent-strong)]">
                      <PencilIcon /> Editing the note…
                    </p>
                  ) : (
                    <span className="mt-0.5 inline-block h-3 w-[2px] animate-pulse bg-[var(--accent)]" />
                  )}
                </>
              ) : (
                <p className="text-[11.5px] text-[var(--text-tertiary)]">Thinking…</p>
              )}
            </div>
          )}

          {error &&
            (error === CLI_NOT_LOGGED_IN ? (
              // Once the panel re-checks, its own notice takes over above.
              !loggedOut && <CliLoginHint />
            ) : (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-700">
                {error}
              </p>
            ))}
        </div>
      </div>

      <div className="shrink-0 px-3 pb-3 pt-2">
        {confirmClear && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-lg bg-black/[0.05] px-2.5 py-1.5">
            <span className="min-w-0 flex-1 text-[11px] text-[var(--text-secondary)]">
              Clear the whole conversation?
            </span>
            <button onClick={clearThread} className="btn-bezel px-2 py-0.5 text-[11px] text-red-700">
              Clear
            </button>
            <button onClick={() => setConfirmClear(false)} className="btn-bezel px-2 py-0.5 text-[11px]">
              Keep
            </button>
          </div>
        )}

        <div
          className={`flex flex-col rounded-xl border bg-white/60 transition-colors ${
            noBackend ? "border-black/10 opacity-60" : "border-black/12 focus-within:border-[var(--accent)]"
          }`}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline, as in every chat box.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={noBackend}
            placeholder={
              loggedOut ? "Log in to the Claude CLI to chat" : noBackend ? "No AI backend configured" : "Ask about this note…"
            }
            className="max-h-40 w-full resize-none bg-transparent px-3 pt-2 text-[12px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <button
              onClick={() => setConfirmClear(true)}
              disabled={messages.length === 0 || confirmClear}
              title="Clear conversation"
              aria-label="Clear conversation"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-black/[0.06] hover:text-red-600 disabled:pointer-events-none disabled:opacity-35"
            >
              <TrashIcon />
            </button>

            <button
              onClick={() => void send()}
              disabled={pending || noBackend || input.trim() === ""}
              title={pending ? "Waiting for the reply…" : "Send (Enter)"}
              aria-label="Send"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow-sm transition-opacity hover:opacity-90 disabled:bg-black/15 disabled:shadow-none"
            >
              {pending ? <Spinner /> : <SendIcon />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 002 2h7a2 2 0 002-2l1-12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
    </svg>
  );
}

/**
 * The transcript as the backend should see it. A reply that edited the note
 * carries a note of what actually happened, so the agent knows next turn when
 * an edit missed rather than assuming it landed.
 */
function forBackend(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(({ role, content, edit }) => {
    if (!edit) return { role, content };
    const what = edit.reason
      ? `None of the edits were applied: ${edit.reason}.`
      : `Reevik applied ${edit.applied} edit(s) to ${edit.note}` +
        (edit.failed.length ? `; ${edit.failed.length} could not be applied because their <find> text was not in the note.` : ".");
    return { role, content: `${content}\n\n[${what}]` };
  });
}

/** What happened to the note, under the reply that changed it. */
function EditStatus({ edit }: { edit: EditOutcome }) {
  const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;
  const missed = edit.failed.length;

  let tone = "text-green-700 bg-green-500/10";
  let message: string;
  if (edit.reason) {
    tone = "text-yellow-800 bg-yellow-500/15";
    message = `Not applied — ${edit.reason}.`;
  } else if (edit.applied > 0 && missed === 0) {
    message = `Applied ${changes(edit.applied)} to ${edit.note}${edit.undoable ? " · ⌘Z to undo" : ""}`;
  } else if (edit.applied > 0) {
    tone = "text-yellow-800 bg-yellow-500/15";
    message = `Applied ${edit.applied} of ${edit.applied + missed} changes to ${edit.note}. ${missed} couldn't find its text: “${preview(edit.failed[0])}”`;
  } else {
    tone = "text-red-700 bg-red-500/10";
    message = `Couldn't apply the change — this text isn't in ${edit.note} any more: “${preview(edit.failed[0] ?? "")}”`;
  }

  return (
    <p className={`mt-1.5 flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px] leading-snug ${tone}`}>
      <span className="mt-[1px] shrink-0">
        <PencilIcon />
      </span>
      <span className="min-w-0">{message}</span>
    </p>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}
