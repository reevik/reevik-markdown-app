import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { appVersion, openExternal } from "../lib/api";

/** One third-party package that ships inside Reevik (scripts/generate-licenses.mjs). */
interface Pkg {
  name: string;
  version: string;
  ecosystem: "npm" | "rust";
  license: string;
  url: string | null;
  /** Key into `texts`, or null when the package publishes no licence file. */
  text: string | null;
}

interface LicenseData {
  packages: Pkg[];
  texts: Record<string, string>;
}

const APACHE_URL = "https://www.apache.org/licenses/LICENSE-2.0";

/**
 * Reevik ▸ About Reevik. Deliberately small: what it is, its version, and two
 * links — the Apache licence, and the open-source libraries it is built on,
 * which open in their own scrollable window.
 */
export default function AboutModal({ onClose }: { onClose: () => void }) {
  const { data: version } = useQuery({ queryKey: ["app-version"], queryFn: appVersion });
  const [showLibraries, setShowLibraries] = useState(false);

  return (
    <>
      <Dialog onClose={onClose} label="About Reevik" className="max-w-sm" active={!showLibraries}>
        <div className="px-8 pb-7 pt-8 text-center">
          <img src="/app-logo.png" width={92} height={92} alt="" className="mx-auto" draggable={false} />
          <h2 className="mt-2 text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">Reevik</h2>
          <p className="mt-0.5 text-[12px] tabular-nums text-[var(--text-tertiary)]">Version {version ?? "…"}</p>
          <p className="mt-3 text-[13px] text-[var(--text-secondary)]">An agentic markdown editor by Reevik.</p>
          <p className="mt-1 text-[11.5px] text-[var(--text-tertiary)]">© 2026 Erhan Bağdemir</p>

          <div className="mt-5 flex flex-col items-center gap-1.5 text-[12px]">
            <TextLink onClick={() => openExternal(APACHE_URL).catch((e) => console.error(e))}>
              Licensed under the Apache License 2.0 ↗
            </TextLink>
            <TextLink onClick={() => setShowLibraries(true)}>Open-source libraries used in the editor</TextLink>
          </div>
        </div>
      </Dialog>

      {showLibraries && <LibrariesModal onClose={() => setShowLibraries(false)} />}
    </>
  );
}

/** The open-source libraries Reevik ships, each with its licence text. */
function LibrariesModal({ onClose }: { onClose: () => void }) {
  // ~1.6 MB with the licence texts; loaded only when this window opens, so it
  // stays out of the bundle the app needs at startup.
  const { data } = useQuery({
    queryKey: ["third-party-licenses"],
    queryFn: async () => (await import("../generated/licenses.json")).default as LicenseData,
    staleTime: Infinity,
  });

  return (
    <Dialog onClose={onClose} label="Open-source libraries" className="h-[78vh] max-w-xl">
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-5 pt-6">
        <h2 className="pr-8 text-[15px] font-semibold text-[var(--text-primary)]">Open-source libraries</h2>
        {data ? <Libraries data={data} /> : <p className="mt-2 text-[12px] text-[var(--text-tertiary)]">Loading…</p>}
      </div>
    </Dialog>
  );
}

function Libraries({ data }: { data: LicenseData }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const counts = useMemo(() => {
    const byLicense = new Map<string, number>();
    for (const p of data.packages) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1);
    return [...byLicense].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.packages;
    return data.packages.filter((p) => p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q));
  }, [data, query]);

  const npm = data.packages.filter((p) => p.ecosystem === "npm").length;

  return (
    <>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        Reevik is built on {data.packages.length} open-source packages — {npm} from npm and{" "}
        {data.packages.length - npm} Rust crates. Thank you to everyone who maintains them. Select one to read its
        licence.
      </p>

      <div className="mt-2.5 flex flex-wrap gap-1">
        {counts.slice(0, 6).map(([license, n]) => (
          <button
            key={license}
            onClick={() => setQuery((q) => (q === license ? "" : license))}
            className={`rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors ${
              query === license
                ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                : "bg-black/[0.05] text-[var(--text-secondary)] hover:bg-black/[0.09]"
            }`}
          >
            {license} · {n}
          </button>
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by library or licence…"
        className="field mt-2.5 w-full px-2.5 py-1.5 text-[12px]"
      />

      {/* The list scrolls on its own, so the filter stays in reach. */}
      <ul className="mt-2 min-h-0 flex-1 divide-y divide-black/[0.06] overflow-auto rounded-lg border border-black/[0.08] bg-white">
        {shown.map((p) => {
          const key = `${p.ecosystem}:${p.name}@${p.version}`;
          const isOpen = open === key;
          return (
            <li key={key}>
              <button
                onClick={() => setOpen(isOpen ? null : key)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-black/[0.03]"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                  {p.name} <span className="text-[var(--text-tertiary)]">{p.version}</span>
                </span>
                <span className="shrink-0 rounded bg-black/[0.05] px-1 text-[9.5px] uppercase tracking-wide text-[var(--text-tertiary)]">
                  {p.ecosystem === "rust" ? "Rust" : "npm"}
                </span>
                <span className="max-w-[40%] shrink-0 truncate text-[11px] text-[var(--text-secondary)]" title={p.license}>
                  {p.license}
                </span>
              </button>
              {isOpen && (
                <div className="px-2.5 pb-2.5">
                  {p.text && data.texts[p.text] ? (
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-2.5 font-mono text-[10.5px] leading-relaxed text-[var(--text-secondary)]">
                      {data.texts[p.text].trim()}
                    </pre>
                  ) : (
                    <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                      This package declares {p.license} but publishes no licence file; its source has the full terms.
                    </p>
                  )}
                  {p.url && (
                    <button
                      onClick={() => openExternal(p.url!).catch((e) => console.error(e))}
                      className="mt-1.5 text-[11px] text-[var(--accent-strong)] hover:underline"
                    >
                      Source ↗
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-2.5 py-3 text-center text-[11.5px] text-[var(--text-tertiary)]">No matching libraries.</li>
        )}
      </ul>
    </>
  );
}

/**
 * A modal with a solid surface. `active` decides who answers Escape when two
 * are stacked: only the top one closes.
 */
function Dialog({
  onClose,
  label,
  className = "",
  active = true,
  children,
}: {
  onClose: () => void;
  label: string;
  className?: string;
  active?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, active]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className={`dialog-surface rise relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl shadow-2xl ${className}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-black/[0.06] hover:text-[var(--text-primary)]"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        {children}
      </div>
    </div>
  );
}

function TextLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-[var(--accent-strong)] underline decoration-[var(--accent-soft)] underline-offset-2 transition-colors hover:decoration-[var(--accent-strong)]"
    >
      {children}
    </button>
  );
}
