import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Shown wherever an AI feature can't run because the Claude CLI has no usable
 * login. Says what's wrong, what to type, and lets the author re-check once
 * they've signed in — the backend status is otherwise only refreshed when the
 * window regains focus.
 */
export default function CliLoginHint({ className = "" }: { className?: string }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const command = "claude auth login";

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div
      className={`rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2.5 text-[11px] leading-relaxed text-yellow-900 ${className}`}
    >
      <p>
        <span className="font-semibold">The Claude CLI isn't logged in.</span> Its session may have expired.
        Sign in from a terminal, then come back here:
      </p>

      <div className="mt-1.5 flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded bg-black/10 px-1.5 py-0.5 font-mono text-[11px]">
          {command}
        </code>
        <button onClick={() => void copy()} className="btn-bezel shrink-0 px-2 py-0.5 text-[10.5px]">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>

      <button
        onClick={() => qc.invalidateQueries({ queryKey: ["ai-backend"] })}
        className="btn-bezel mt-2 w-full py-1 text-[11px]"
      >
        I've logged in — check again
      </button>
    </div>
  );
}
