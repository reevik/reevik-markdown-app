import { useEffect, useMemo, useState } from "react";
import type { Move, ReorgProposal } from "../lib/api";

/**
 * Before / after for a proposed reorganization. Nothing moves until the author
 * approves, and each move can be left out: an unticked note shows where it
 * stays, still unticked, so the choice can be changed back.
 */
export default function ReorganizeModal({
  root,
  proposal,
  onApply,
  onCancel,
}: {
  root: string;
  proposal: ReorgProposal;
  onApply: (moves: Move[]) => void;
  onCancel: () => void;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const rel = (abs: string) => (abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs);

  const chosen = proposal.moves.filter((m) => !excluded.has(m.from));
  const purposes = useMemo(() => new Map(proposal.folders.map((f) => [f.path, f.purpose])), [proposal]);

  // Before: today's tree, with the notes that will move dimmed.
  const movingFrom = new Set(chosen.map((m) => rel(m.from)));
  const before = useMemo(() => buildTree(proposal.notes.map((p) => ({ path: p }))), [proposal]);

  // After: every note at its destination, moves marked with their checkbox.
  const after = useMemo(() => {
    const byFrom = new Map(proposal.moves.map((m) => [rel(m.from), m]));
    return buildTree(
      proposal.notes.map((p) => {
        const m = byFrom.get(p);
        if (!m) return { path: p };
        const on = !excluded.has(m.from);
        return { path: on ? rel(m.to) : p, move: m, on, from: p };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, excluded, root]);

  const folders = new Set(chosen.map((m) => rel(m.to).split("/").slice(0, -1).join("/")).filter(Boolean));

  const toggle = (from: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(from) ? next.delete(from) : next.add(from);
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onCancel}>
      <div
        className="dialog-surface rise flex h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Reorganize the vault"
      >
        <header className="shrink-0 px-6 pb-3 pt-5">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Reorganize the vault</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Moves <strong>{chosen.length}</strong> of {proposal.notes.length} notes into {folders.size} folder
            {folders.size === 1 ? "" : "s"}. Links and images inside your notes are updated to match, and you can undo
            it right after. Untick any note to keep it where it is.
          </p>
          <div className="mt-2 flex gap-3 text-[11px]">
            <button className="text-[var(--accent-strong)] hover:underline" onClick={() => setExcluded(new Set())}>
              Include all
            </button>
            <button
              className="text-[var(--accent-strong)] hover:underline"
              onClick={() => setExcluded(new Set(proposal.moves.map((m) => m.from)))}
            >
              Include none
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 px-6">
          <Column title="Now">
            <TreeView nodes={before} dim={movingFrom} />
          </Column>
          <Column title="After">
            <TreeView nodes={after} purposes={purposes} onToggle={toggle} />
          </Column>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 px-6 py-4">
          <button onClick={onCancel} className="btn-bezel px-3.5 py-1.5 text-[12.5px]">
            Cancel
          </button>
          <button
            onClick={() => onApply(chosen)}
            disabled={chosen.length === 0}
            className="btn-accent px-3.5 py-1.5 text-[12.5px] disabled:opacity-45"
          >
            Move {chosen.length} note{chosen.length === 1 ? "" : "s"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col">
      <h3 className="mb-1.5 shrink-0 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        {title}
      </h3>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-black/[0.08] bg-white px-1.5 py-1.5">
        {children}
      </div>
    </section>
  );
}

// --- A small read-only tree built from relative paths ---

interface Leaf {
  path: string;
  move?: Move;
  on?: boolean;
  /** Where the note is today, for a moved note's tooltip. */
  from?: string;
}

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: (Leaf & { name: string })[];
}

function buildTree(leaves: Leaf[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const leaf of leaves) {
    const parts = leaf.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.folders.find((f) => f.name === parts[i]);
      if (!child) {
        child = { name: parts[i], path, folders: [], files: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.files.push({ ...leaf, name: parts[parts.length - 1] });
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.files.sort((a, b) => a.name.localeCompare(b.name));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function TreeView({
  nodes,
  depth = 0,
  dim,
  purposes,
  onToggle,
}: {
  nodes: Folder;
  depth?: number;
  dim?: Set<string>;
  purposes?: Map<string, string>;
  onToggle?: (from: string) => void;
}) {
  const pad = { paddingLeft: 6 + depth * 14 };
  return (
    <>
      {nodes.folders.map((f) => (
        <div key={f.path}>
          <div className="flex items-baseline gap-1.5 py-0.5 text-[12px] text-[var(--text-primary)]" style={pad}>
            <FolderGlyph />
            <span className="font-medium">{f.name}</span>
            {purposes?.get(f.path) && (
              <span className="min-w-0 truncate text-[10.5px] text-[var(--text-tertiary)]">— {purposes.get(f.path)}</span>
            )}
          </div>
          <TreeView nodes={f} depth={depth + 1} dim={dim} purposes={purposes} onToggle={onToggle} />
        </div>
      ))}
      {nodes.files.map((f) => {
        const leaving = dim?.has(f.path);
        return (
          <div
            key={f.path + (f.move ? ":m" : "")}
            className={`flex items-center gap-1.5 py-0.5 text-[12px] ${
              leaving
                ? "text-[var(--text-tertiary)] line-through decoration-black/20"
                : f.move && f.on
                  ? "font-medium text-[var(--accent-strong)]"
                  : "text-[var(--text-secondary)]"
            }`}
            style={pad}
            title={f.move ? (f.on ? `Moves here from ${f.from}` : "Stays where it is") : undefined}
          >
            {f.move && onToggle ? (
              <input
                type="checkbox"
                checked={!!f.on}
                onChange={() => onToggle(f.move!.from)}
                className="h-3 w-3 shrink-0 accent-[var(--accent)]"
              />
            ) : (
              <FileGlyph />
            )}
            <span className="min-w-0 truncate">{f.name}</span>
          </div>
        );
      })}
    </>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 self-center opacity-60">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" className="shrink-0 opacity-50">
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
