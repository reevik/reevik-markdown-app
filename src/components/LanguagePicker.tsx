import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LANGUAGES, recentLanguages } from "../lib/languages";

/**
 * Where ⌘⇧T asks "into which language?". Recent choices come first and the
 * last one is preselected, so Enter repeats it. Typing filters; a name that
 * isn't listed is used as typed.
 */
export default function LanguagePicker({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (language: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recent = useMemo(() => recentLanguages(), []);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ordered = [...recent, ...LANGUAGES.filter((l) => !recent.includes(l))];
    const hits = q ? ordered.filter((l) => l.toLowerCase().includes(q)) : ordered;
    // A language that isn't listed can still be typed in full.
    const typed = query.trim();
    if (typed && !hits.some((l) => l.toLowerCase() === typed.toLowerCase())) hits.push(typed);
    return hits;
  }, [query, recent]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - 228));
  const top = Math.max(8, Math.min(y, window.innerHeight - 300));

  return createPortal(
    <div ref={ref} style={{ left, top }} className="dialog-surface fixed z-50 w-[220px] rounded-xl p-1.5 shadow-xl">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (options[active]) onPick(options[active]);
          }
        }}
        placeholder="Translate into…"
        className="field w-full px-2 py-1 text-[12.5px]"
      />
      <div ref={listRef} className="mt-1 max-h-60 overflow-auto">
        {options.map((lang, i) => (
          <button
            key={lang}
            data-active={i === active}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(lang)}
            className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12.5px] ${
              i === active ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-primary)]"
            }`}
          >
            <span className="truncate">{lang}</span>
            {recent.includes(lang) && !query && <span className="text-[10px] text-[var(--text-tertiary)]">recent</span>}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
