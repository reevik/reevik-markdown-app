import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import CliLoginHint from "./CliLoginHint";
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

export default function EditorialChat({ vaultPath, path, content, noBackend, loggedOut, onInsertText }: Props) {
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
      const { path: notePath, content: noteText } = noteRef.current;
      const reply = await chat(next.slice(-SEND_WINDOW), notePath, noteText);
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={logRef} className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        {empty && (
          <div className="flex h-full flex-col justify-center gap-2 text-center">
            <p className="text-[12px] text-[var(--text-secondary)]">Talk through the note.</p>
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              Ask for a tighter opening, a counter-argument, a summary — whatever you'd ask an editor.
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
                <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-primary)]">
                  {m.content}
                </div>
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
                <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-primary)]">
                  {streaming}
                  <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-[var(--accent)] align-middle" />
                </div>
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

      <div className="shrink-0 border-t border-black/10 px-3 pb-3 pt-2">
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
          placeholder={loggedOut ? "Log in to the Claude CLI to chat" : noBackend ? "No AI backend configured" : "Ask about this note…"}
          className="w-full resize-none rounded-lg border border-black/12 bg-white/55 px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] disabled:opacity-60"
        />

        <div className="mt-1.5 flex items-center gap-2">
          {confirmClear ? (
            <>
              <span className="text-[10.5px] text-[var(--text-tertiary)]">Clear the conversation?</span>
              <button onClick={clearThread} className="btn-bezel px-2 py-0.5 text-[11px] text-red-700">
                Clear
              </button>
              <button onClick={() => setConfirmClear(false)} className="btn-bezel px-2 py-0.5 text-[11px]">
                Keep
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              disabled={messages.length === 0}
              title="Forget this conversation"
              className="btn-bezel px-2 py-0.5 text-[11px] disabled:opacity-40"
            >
              Clear
            </button>
          )}

          <span className="flex-1" />

          <button
            onClick={() => void send()}
            disabled={pending || noBackend || input.trim() === ""}
            className="btn-accent px-3 py-1 text-[12px] disabled:opacity-45"
          >
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
