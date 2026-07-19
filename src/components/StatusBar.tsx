import { useEffect, useState } from "react";
import { fileStat } from "../lib/api";
import type { OpenDoc, SaveState } from "../App";

const SAVE_LABEL: Record<SaveState, string> = {
  saved: "Saved",
  dirty: "Editing…",
  saving: "Saving…",
  error: "Save failed",
};

const DOT_COLOR: Record<SaveState, string> = {
  saved: "bg-green-400",
  dirty: "bg-yellow-400",
  saving: "bg-yellow-400",
  error: "bg-red-400",
};

function fileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "Markdown";
  return ext ? ext.toUpperCase() : "File";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEdited(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The bottom status bar: active note on the left; type/size/edited/save on the right. */
export default function StatusBar({ doc }: { doc: OpenDoc | null }) {
  const [modified, setModified] = useState(0);

  // Refresh the last-modified time on open and whenever a save completes.
  useEffect(() => {
    if (!doc || doc.saveState !== "saved") return;
    let cancelled = false;
    fileStat(doc.path)
      .then((s) => !cancelled && setModified(s.modified_ms))
      .catch(() => !cancelled && setModified(0));
    return () => {
      cancelled = true;
    };
  }, [doc?.path, doc?.saveState]);

  const size = doc ? new TextEncoder().encode(doc.content).length : 0;

  return (
    <footer className="status-bar flex h-6 shrink-0 items-center gap-3 px-3 text-[11px] text-[var(--text-tertiary)]">
      <span className="min-w-0 flex-1 truncate">{doc?.name ?? ""}</span>

      {doc && (
        <>
          <span>{fileType(doc.name)}</span>
          <span className="text-[var(--separator)]">·</span>
          <span>{formatSize(size)}</span>
          {modified > 0 && (
            <>
              <span className="text-[var(--separator)]">·</span>
              <span title="Last edited">Edited {formatEdited(modified)}</span>
            </>
          )}
          <span className="text-[var(--separator)]">·</span>
          <span className={`flex items-center gap-1.5 ${doc.saveState === "error" ? "text-red-400" : ""}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${DOT_COLOR[doc.saveState]}`} />
            {SAVE_LABEL[doc.saveState]}
          </span>
        </>
      )}
    </footer>
  );
}
