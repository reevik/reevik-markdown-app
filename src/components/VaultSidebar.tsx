import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createFolder,
  createNote,
  deletePath,
  importFiles,
  movePath,
  readVaultTree,
  renamePath,
} from "../lib/api";
import { notifyVaultChanged } from "../lib/contentIndex";
import { deletePath as deleteOne, movePath as moveOne } from "../lib/api";
import {
  applyReorganization,
  CLI_NOT_LOGGED_IN,
  COPILOT_CLI_MISSING,
  getAiSettings,
  proposeReorganization,
  type Move,
  type ReorgProposal,
  type ReorgReport,
} from "../lib/api";
import ReorganizeModal from "./ReorganizeModal";
import { createPortal } from "react-dom";
import { colorOf, normalizeLabel, PALETTE, remapLabels, setLabelColor, useLabels } from "../lib/labels";
import { setVaultIndex } from "../lib/links";
import {
  cancelTaming,
  dismissResult,
  planRun,
  remapRatings,
  runTaming,
  useVaultRatings,
  type Rating,
} from "../lib/vaultTamer";
import type { TreeNode, Vault } from "../lib/types";

interface Props {
  width: number;
  activeVault: Vault;
  selectedPath: string | null;
  onOpenNote: (path: string) => void;
  onPathChanged: (oldPath: string, newPath: string | null) => void;
  /** Write unsaved edits before notes are moved in bulk. */
  onBeforeBulkMove: () => Promise<void>;
  /** Let open tabs follow moved notes and reload rewritten ones. */
  onAfterBulkMove: (moves: Move[]) => Promise<void>;
  /** Set a note's labels (its frontmatter `tags:`). */
  onSetLabels: (path: string, labels: string[]) => Promise<void>;
}

type Creating = { kind: "note" | "folder"; dir: string } | null;
type SortDir = "asc" | "desc";

/** Collapsed folders are remembered per vault, so reopening one restores the
 *  shape of the tree instead of expanding everything. Storing the *collapsed*
 *  set (rather than the expanded one) keeps a freshly-opened vault fully
 *  expanded, which is what it did before. */
const COLLAPSED_KEY = "tree.collapsed";

function loadCollapsed(vault: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${COLLAPSED_KEY}:${vault}`);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(stored) ? stored.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(vault: string, paths: Set<string>) {
  try {
    localStorage.setItem(`${COLLAPSED_KEY}:${vault}`, JSON.stringify([...paths]));
  } catch (e) {
    // Nothing to recover here: the tree just opens expanded next time.
    console.error(e);
  }
}

/** Files in the order the tree shows them, skipping collapsed folders — the
 *  sequence a shift-click range runs along. */
function visibleFilePaths(nodes: TreeNode[], collapsed: Set<string>, forceExpand: boolean, out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n.path);
    else if (forceExpand || !collapsed.has(n.path)) visibleFilePaths(n.children ?? [], collapsed, forceExpand, out);
  }
  return out;
}

/** Every row the tree shows, folders included, in order — so a selected row
 *  knows whether the rows around it are selected too. */
function visibleRowPaths(nodes: TreeNode[], collapsed: Set<string>, forceExpand: boolean, out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(n.path);
    if (n.kind === "dir" && (forceExpand || !collapsed.has(n.path))) {
      visibleRowPaths(n.children ?? [], collapsed, forceExpand, out);
    }
  }
  return out;
}

export type SelPos = "single" | "first" | "mid" | "last";

/** Paths carried by a drag: the whole selection when several were dragged. */
const MULTI_DRAG = "application/x-reevik-paths";
function draggedPaths(dt: DataTransfer): string[] {
  try {
    const many = dt.getData(MULTI_DRAG);
    if (many) return JSON.parse(many) as string[];
  } catch {
    /* fall back to the single path */
  }
  const one = dt.getData("text/plain");
  return one ? [one] : [];
}

/** Every note's path in the tree. */
function collectNotePaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n.path);
    else collectNotePaths(n.children ?? [], out);
  }
  return out;
}

/** Keep the notes in `keep`, plus the folders that lead to them. */
function filterByPaths(nodes: TreeNode[], keep: Set<string>): TreeNode[] {
  const walk = (node: TreeNode): TreeNode | null => {
    if (node.kind === "file") return keep.has(node.path) ? node : null;
    const children = (node.children ?? []).map(walk).filter((n): n is TreeNode => n !== null);
    return children.length > 0 ? { ...node, children } : null;
  };
  return nodes.map(walk).filter((n): n is TreeNode => n !== null);
}

/** All folder paths in the tree (used by expand/collapse-all). */
function collectFolderPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "dir") {
      out.push(n.path);
      collectFolderPaths(n.children ?? [], out);
    }
  }
  return out;
}

/** Sort recursively: folders before files, then by name in the given direction. */
function sortTree(nodes: TreeNode[], dir: SortDir): TreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted.map((n) =>
    n.kind === "dir" ? { ...n, children: sortTree(n.children ?? [], dir) } : n,
  );
}

/** Keep files whose name matches `q`, plus the folders that contain a match. */
function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const lower = q.toLowerCase();
  const walk = (node: TreeNode): TreeNode | null => {
    if (node.kind === "file") {
      return node.name.toLowerCase().includes(lower) ? node : null;
    }
    const children = (node.children ?? []).map(walk).filter((n): n is TreeNode => n !== null);
    if (children.length > 0 || node.name.toLowerCase().includes(lower)) {
      return { ...node, children };
    }
    return null;
  };
  return nodes.map(walk).filter((n): n is TreeNode => n !== null);
}

export default function VaultSidebar({
  width,
  activeVault,
  selectedPath,
  onOpenNote,
  onPathChanged,
  onBeforeBulkMove,
  onAfterBulkMove,
  onSetLabels,
}: Props) {
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(activeVault.path));
  const [creating, setCreating] = useState<Creating>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const { data: tree } = useQuery({
    queryKey: ["tree", activeVault.path],
    queryFn: () => readVaultTree(activeVault.path),
  });

  // Every Content Index in every open note describes this same hierarchy, so a
  // change here has to reach them too.
  const refreshTree = () => {
    notifyVaultChanged();
    return qc.invalidateQueries({ queryKey: ["tree", activeVault.path] });
  };
  const rootDir = activeVault.path;

  // "Tame my vault": completeness ratings, and the filter that shows only the
  // notes that look safe to delete.
  const tamer = useVaultRatings(rootDir);
  const [plan, setPlan] = useState<{ total: number; toRate: string[] } | null>(null);
  const [showStubs, setShowStubs] = useState(false);
  const notePaths = useMemo(() => collectNotePaths(tree ?? []), [tree]);
  // The editor resolves and completes links against this list of notes.
  useEffect(() => setVaultIndex(rootDir, notePaths), [rootDir, notePaths]);
  const stubPaths = useMemo(
    () => new Set(notePaths.filter((p) => tamer.ratings[p]?.verdict === "stub")),
    [notePaths, tamer.ratings],
  );
  // Nothing left to show (all deleted or edited): drop back to the full tree.
  useEffect(() => {
    if (showStubs && stubPaths.size === 0) setShowStubs(false);
  }, [showStubs, stubPaths]);

  // Labels: colours per vault, filter chips, and the picker for one note.
  const labels = useLabels(rootDir);
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  // The label picker, for one note or for a whole selection.
  const [picker, setPicker] = useState<{ paths: string[]; x: number; y: number } | null>(null);
  const inUse = useMemo(() => {
    const present = new Set(notePaths);
    const counts = new Map<string, number>();
    for (const [path, tags] of Object.entries(labels.notes)) {
      if (!present.has(path)) continue;
      for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  }, [labels.notes, notePaths]);
  // A label that's no longer on any note drops out of the filter.
  useEffect(() => {
    setLabelFilter((f) => (f.every((l) => inUse.some(([u]) => u === l)) ? f : f.filter((l) => inUse.some(([u]) => u === l))));
  }, [inUse]);
  const labelMatches = useMemo(
    () =>
      new Set(
        Object.entries(labels.notes)
          .filter(([, tags]) => labelFilter.every((l) => tags.includes(l)))
          .map(([p]) => p),
      ),
    [labels.notes, labelFilter],
  );

  // "Reorganize the vault": propose → review before/after → apply → undo.
  const [reorg, setReorg] = useState<Reorg>(null);

  async function onReorganize() {
    if (reorg?.phase === "analyzing" || reorg?.phase === "applying") return;
    setReorg({ phase: "analyzing", count: notePaths.length });
    try {
      const proposal = await proposeReorganization(rootDir);
      setReorg((cur) =>
        cur?.phase !== "analyzing"
          ? cur // dismissed while waiting
          : proposal.moves.length === 0
            ? { phase: "info", message: "Your vault already looks well organized — nothing to move." }
            : { phase: "review", proposal },
      );
    } catch (e) {
      setReorg({ phase: "error", message: errorText(e) });
    }
  }

  async function moveNotes(moves: Move[], undo: boolean) {
    setReorg({ phase: "applying" });
    try {
      await onBeforeBulkMove();
      const report = await applyReorganization(rootDir, moves);
      for (const m of moves) {
        remapRatings(m.from, m.to);
        remapLabels(m.from, m.to);
      }
      await onAfterBulkMove(moves);
      await refreshTree();
      setReorg(undo ? { phase: "info", message: "Undone — every note is back where it was." } : { phase: "done", moves, report });
    } catch (e) {
      await refreshTree();
      setReorg({ phase: "error", message: errorText(e) });
    }
  }

  async function onTame() {
    if (tamer.job) {
      cancelTaming();
      return;
    }
    dismissResult();
    try {
      setPlan(await planRun(notePaths));
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => saveCollapsed(rootDir, collapsed), [rootDir, collapsed]);

  // A renamed or moved folder keeps its collapse state, and a deleted one drops
  // it. `oldPath` may itself be a folder, so remap by exact match or prefix.
  const pathChanged = (oldPath: string, newPath: string | null) => {
    const affects = (p: string) => p === oldPath || p.startsWith(`${oldPath}/`);
    setCollapsed((prev) => {
      if (![...prev].some(affects)) return prev;
      const next = new Set<string>();
      for (const p of prev) {
        if (!affects(p)) next.add(p);
        else if (newPath) next.add(p === oldPath ? newPath : newPath + p.slice(oldPath.length));
      }
      return next;
    });
    remapRatings(oldPath, newPath);
    remapLabels(oldPath, newPath);
    onPathChanged(oldPath, newPath);
  };

  const filtering = filter.trim() !== "";
  const displayed = useMemo(() => {
    let nodes = sortTree(tree ?? [], sortDir);
    if (showStubs) nodes = filterByPaths(nodes, stubPaths);
    if (labelFilter.length > 0) nodes = filterByPaths(nodes, labelMatches);
    return filtering ? filterTree(nodes, filter.trim()) : nodes;
  }, [tree, sortDir, filter, filtering, showStubs, stubPaths, labelFilter, labelMatches]);

  // Multi-selection, Finder-style: shift-click selects a range, ⌘-click
  // toggles one, a plain click opens a single note. Files only.
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const forceExpand = filtering || showStubs || labelFilter.length > 0;
  const visibleFiles = useMemo(
    () => visibleFilePaths(displayed, collapsed, forceExpand),
    [displayed, collapsed, forceExpand],
  );
  // Keep the selection to what's on screen: acting on hidden notes surprises.
  useEffect(() => {
    setMulti((prev) => {
      const visible = new Set(visibleFiles);
      const kept = [...prev].filter((p) => visible.has(p));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [visibleFiles]);
  const selecting = multi.size > 1;

  // Where each selected row sits in its block of adjacent selected rows.
  const selPositions = useMemo(() => {
    const out = new Map<string, SelPos>();
    if (!selecting) return out;
    const rows = visibleRowPaths(displayed, collapsed, forceExpand);
    rows.forEach((p, i) => {
      if (!multi.has(p)) return;
      const above = i > 0 && multi.has(rows[i - 1]);
      const below = i < rows.length - 1 && multi.has(rows[i + 1]);
      out.set(p, above && below ? "mid" : above ? "last" : below ? "first" : "single");
    });
    return out;
  }, [selecting, multi, displayed, collapsed, forceExpand]);

  function selectFile(path: string, e: React.MouseEvent) {
    if (e.shiftKey) {
      const anchor = anchorRef.current ?? selectedPath;
      const a = anchor ? visibleFiles.indexOf(anchor) : -1;
      const b = visibleFiles.indexOf(path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setMulti(new Set(visibleFiles.slice(lo, hi + 1)));
        return;
      }
    }
    if (e.metaKey) {
      setMulti((prev) => {
        // ⌘-click adds to what's selected — including the open note.
        const next = new Set(prev.size > 0 ? prev : selectedPath ? [selectedPath] : []);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      anchorRef.current = path;
      return;
    }
    setMulti(new Set());
    anchorRef.current = path;
    onOpenNote(path);
  }

  // Escape clears a multi-selection (but leaves text fields their Escape).
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "Escape" && !t.closest("input, textarea, [contenteditable=true]")) setMulti(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  async function moveMany(paths: string[], dir: string) {
    for (const from of paths) {
      // Skip a folder dropped into itself or its own descendant, and no-op moves.
      if (from === dir || dir.startsWith(`${from}/`) || from.slice(0, from.lastIndexOf("/")) === dir) continue;
      try {
        const to = await moveOne(from, dir);
        pathChanged(from, to);
      } catch (e) {
        console.error(e);
      }
    }
    setMulti(new Set());
    await refreshTree();
  }

  async function deleteMany(paths: string[]) {
    const names = paths.map((p) => p.slice(p.lastIndexOf("/") + 1));
    const list = names.slice(0, 6).join("\n") + (names.length > 6 ? `\n…and ${names.length - 6} more` : "");
    if (!window.confirm(`Delete ${paths.length} notes?\n\n${list}`)) return;
    for (const p of paths) {
      try {
        await deleteOne(p);
        pathChanged(p, null);
      } catch (e) {
        console.error(e);
      }
    }
    setMulti(new Set());
    await refreshTree();
  }

  const allFolders = useMemo(() => collectFolderPaths(tree ?? []), [tree]);
  const allCollapsed = allFolders.length > 0 && allFolders.every((p) => collapsed.has(p));
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(allFolders));

  const createMutation = useMutation({
    mutationFn: ({ kind, dir, name }: { kind: "note" | "folder"; dir: string; name: string }) =>
      kind === "note" ? createNote(dir, name) : createFolder(dir, name),
    onSuccess: (newPath, vars) => {
      setCreating(null);
      refreshTree();
      if (vars.kind === "note") onOpenNote(newPath);
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ from, name }: { from: string; name: string }) => renamePath(from, name),
    onSuccess: (newPath, vars) => {
      setRenaming(null);
      refreshTree();
      pathChanged(vars.from, newPath);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (path: string) => deletePath(path),
    onSuccess: (_r, path) => {
      refreshTree();
      pathChanged(path, null);
    },
  });

  // Drag a file/folder onto a folder (or the empty area = vault root) to move it.
  const [dragOver, setDragOver] = useState<string | null>(null);
  const moveMutation = useMutation({
    mutationFn: ({ from, dir }: { from: string; dir: string }) => movePath(from, dir),
    onSuccess: (newPath, vars) => {
      refreshTree();
      pathChanged(vars.from, newPath);
    },
  });
  const doMove = (from: string, dir: string) => {
    if (from) moveMutation.mutate({ from, dir });
  };

  // "Add to Vault": copy external Markdown/text files in, then open the first one.
  const importMutation = useMutation({
    mutationFn: (sources: string[]) => importFiles(rootDir, sources),
    onSuccess: (paths) => {
      refreshTree();
      if (paths[0]) onOpenNote(paths[0]);
    },
  });

  async function addToVault() {
    const picked = await open({
      multiple: true,
      title: "Add files to vault",
      filters: [{ name: "Markdown & text", extensions: ["md", "markdown", "txt", "text"] }],
    });
    const sources = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (sources.length > 0) importMutation.mutate(sources);
  }

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  function beginDelete(node: TreeNode) {
    const what = node.kind === "dir" ? "folder and everything in it" : "note";
    if (window.confirm(`Delete this ${what}?\n\n${node.name}`)) deleteMutation.mutate(node.path);
  }

  // The command palette has no handle on this component's state, so it asks for
  // new notes/folders via window events.
  useEffect(() => {
    const note = () => setCreating({ kind: "note", dir: rootDir });
    const folder = () => setCreating({ kind: "folder", dir: rootDir });
    const add = () => void addToVault();
    window.addEventListener("reevik:new-note", note);
    window.addEventListener("reevik:new-folder", folder);
    window.addEventListener("reevik:add-to-vault", add);
    return () => {
      window.removeEventListener("reevik:new-note", note);
      window.removeEventListener("reevik:new-folder", folder);
      window.removeEventListener("reevik:add-to-vault", add);
    };
  }, [rootDir]);

  // Menu and palette entries for the vault-wide actions and labels. The
  // handlers close over current state, so read them through a ref rather than
  // re-subscribing on every render.
  const actionsRef = useRef<{ tame: () => void; reorganize: () => void; labels: () => void }>({
    tame: () => {},
    reorganize: () => {},
    labels: () => {},
  });
  actionsRef.current = {
    tame: () => void onTame(),
    reorganize: () => void onReorganize(),
    labels: () => {
      if (!selectedPath) return;
      // Under the open note's row when it's in view; else the top of the sidebar.
      const row = document.querySelector(".nav-row-active")?.getBoundingClientRect();
      const nav = document.querySelector("aside nav")?.getBoundingClientRect();
      setPicker({
        paths: selecting ? [...multi] : [selectedPath],
        x: row ? row.left + 24 : (nav?.left ?? 0) + 16,
        y: row ? row.bottom + 4 : (nav?.top ?? 80) + 8,
      });
    },
  };
  useEffect(() => {
    const tame = () => actionsRef.current.tame();
    const reorganize = () => actionsRef.current.reorganize();
    const labels = () => actionsRef.current.labels();
    window.addEventListener("reevik:tame", tame);
    window.addEventListener("reevik:reorganize", reorganize);
    window.addEventListener("reevik:edit-labels", labels);
    return () => {
      window.removeEventListener("reevik:tame", tame);
      window.removeEventListener("reevik:reorganize", reorganize);
      window.removeEventListener("reevik:edit-labels", labels);
    };
  }, []);

  return (
    <aside className="flex shrink-0 flex-col" style={{ width }} data-tauri-drag-region>
      {/* space for the traffic lights */}
      <div className="h-10" data-tauri-drag-region />

      <div className="flex items-center px-3 pb-2" data-tauri-drag-region>
        <span
          title={activeVault.name}
          className="min-w-0 flex-1 truncate pr-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]"
        >
          {activeVault.name}
        </span>
      </div>

      {/* Filter + sort + expand/collapse-all */}
      <div className="flex items-center gap-1 px-3 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter("");
          }}
          placeholder="Filter…"
          className="field min-w-0 flex-1 px-2 py-1 text-[12px]"
        />
        <ToolbarButton
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          title={`Sort by name (${sortDir === "asc" ? "A–Z" : "Z–A"})`}
        >
          <SortIcon dir={sortDir} />
        </ToolbarButton>
        <ToolbarButton onClick={toggleAll} title={allCollapsed ? "Expand all" : "Collapse all"}>
          <ExpandIcon collapsed={allCollapsed} />
        </ToolbarButton>
      </div>

      {inUse.length > 0 && (
        <LabelBar
          labels={inUse}
          colors={labels.colors}
          selected={labelFilter}
          onToggle={(label) =>
            setLabelFilter((f) => (f.includes(label) ? f.filter((l) => l !== label) : [...f, label]))
          }
          onClear={() => setLabelFilter([])}
        />
      )}

      {/* Document tree — dropping on empty space moves the item to the vault root */}
      <nav
        className="min-h-0 flex-1 select-none overflow-auto pl-3 pr-0.5 pb-3 [scrollbar-gutter:stable]"
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes("text/plain")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(null);
          const paths = draggedPaths(e.dataTransfer);
          if (paths.length > 1) void moveMany(paths, rootDir);
          else if (paths[0]) doMove(paths[0], rootDir);
        }}
      >
        {creating && creating.dir === rootDir && (
          <NewItemInput
            kind={creating.kind}
            onCancel={() => setCreating(null)}
            onSubmit={(name) => createMutation.mutate({ ...creating, name })}
          />
        )}

        {tree && tree.length === 0 && !creating && (
          <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            This vault has no notes yet. Use the new-note button above to create one.
          </p>
        )}

        {tree && tree.length > 0 && filtering && displayed.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-[var(--text-tertiary)]">
            No notes match “{filter.trim()}”.
          </p>
        )}

        {displayed.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            collapsed={collapsed}
            forceExpand={forceExpand}
            multi={selecting ? multi : EMPTY_SET}
            selPositions={selPositions}
            onSelectFile={selectFile}
            onMoveMany={(paths, dir) => void moveMany(paths, dir)}
            ratings={tamer.ratings}
            labels={labels.notes}
            labelColors={labels.colors}
            onEditLabels={(path, x, y) => setPicker({ paths: selecting && multi.has(path) ? [...multi] : [path], x, y })}
            renaming={renaming}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onMove={doMove}
            onToggle={toggle}
            onOpenNote={onOpenNote}
            onBeginRename={setRenaming}
            onSubmitRename={(from, name) => renameMutation.mutate({ from, name })}
            onCancelRename={() => setRenaming(null)}
            onDelete={beginDelete}
          />
        ))}
      </nav>

      {selecting && (
        <Strip>
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 flex-1 font-medium text-[var(--text-primary)]">{multi.size} notes selected</p>
            <button
              onClick={() => setMulti(new Set())}
              title="Clear selection (Esc)"
              className="rounded px-1 text-[var(--text-tertiary)] hover:bg-black/[0.06] hover:text-[var(--text-primary)]"
            >
              ✕
            </button>
          </div>
          <p className="mt-0.5 text-[10.5px] text-[var(--text-tertiary)]">Drag any of them onto a folder to move them all.</p>
          <Actions>
            <StripButton
              onClick={(e) => {
                // Open just above the button; the picker keeps itself on screen.
                const r = e.currentTarget.getBoundingClientRect();
                setPicker({ paths: [...multi], x: r.left, y: Math.max(60, r.top - 300) });
              }}
            >
              Labels…
            </StripButton>
            <StripButton onClick={() => void deleteMany([...multi])}>Delete</StripButton>
          </Actions>
        </Strip>
      )}

      <TameStatus
        plan={plan}
        job={tamer.job}
        last={tamer.last}
        showStubs={showStubs}
        onStart={(paths) => {
          setPlan(null);
          void runTaming(paths, notePaths);
        }}
        onRerateAll={() => {
          setPlan(null);
          void runTaming(notePaths, notePaths);
        }}
        onCancelPlan={() => setPlan(null)}
        onToggleStubs={() => setShowStubs((v) => !v)}
      />

      {picker && (
        <LabelPicker
          {...picker}
          notes={labels.notes}
          all={[...new Set([...inUse.map(([l]) => l), ...Object.keys(labels.colors)])].sort()}
          colors={labels.colors}
          onSet={(path, next) => onSetLabels(path, next)}
          onClose={() => setPicker(null)}
        />
      )}

      <ReorgStatus
        reorg={reorg}
        onUndo={(moves) => void moveNotes(moves.map((m) => ({ from: m.to, to: m.from })), true)}
        onDismiss={() => setReorg(null)}
      />
      {reorg?.phase === "review" && (
        <ReorganizeModal
          root={rootDir}
          proposal={reorg.proposal}
          onApply={(moves) => void moveNotes(moves, false)}
          onCancel={() => setReorg(null)}
        />
      )}

      {/* Bottom toolbar: create actions, left-aligned */}
      <div className="flex shrink-0 items-center gap-0.5 px-3 py-2">
        <ToolbarButton onClick={() => setCreating({ kind: "note", dir: rootDir })} title="New note">
          <FilePlusIcon />
        </ToolbarButton>
        <ToolbarButton onClick={() => setCreating({ kind: "folder", dir: rootDir })} title="New folder">
          <FolderPlusIcon />
        </ToolbarButton>
        <ToolbarButton onClick={() => void addToVault()} title="Add existing files to this vault (⌘⇧I)">
          <ImportIcon />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => void onTame()}
          title={tamer.job ? "Stop rating notes" : "Tame vault — rate every note for completeness"}
        >
          {tamer.job ? <SpinnerIcon /> : <BroomIcon />}
        </ToolbarButton>
        <ToolbarButton
          onClick={() => void onReorganize()}
          title="Reorganize the vault — propose folders, review before and after"
        >
          {reorg?.phase === "analyzing" || reorg?.phase === "applying" ? <SpinnerIcon /> : <ReorganizeIcon />}
        </ToolbarButton>

        {/* Once the result line is dismissed, keep a way back to the review. */}
        {!tamer.job && !tamer.last && !plan && stubPaths.size > 0 && (
          <button
            onClick={() => setShowStubs((v) => !v)}
            title="Notes rated as barely started — probably safe to delete"
            className={`ml-auto rounded-md px-1.5 py-0.5 text-[11px] transition-colors ${
              showStubs
                ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                : "text-[var(--text-tertiary)] hover:bg-black/[0.06] hover:text-[var(--text-secondary)]"
            }`}
          >
            {showStubs ? "Show all" : `${stubPaths.size} to review`}
          </button>
        )}
      </div>
    </aside>
  );
}

// --- Recursive tree row ---

interface RowProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  collapsed: Set<string>;
  forceExpand: boolean;
  /** Completeness ratings; a "stub" note gets a marker. */
  ratings: Record<string, Rating>;
  labels: Record<string, string[]>;
  labelColors: Record<string, string>;
  onEditLabels: (path: string, x: number, y: number) => void;
  renaming: string | null;
  dragOver: string | null;
  setDragOver: (p: string | null) => void;
  onMove: (from: string, dir: string) => void;
  onToggle: (path: string) => void;
  onOpenNote: (path: string) => void;
  onBeginRename: (path: string) => void;
  onSubmitRename: (from: string, name: string) => void;
  onCancelRename: () => void;
  onDelete: (node: TreeNode) => void;
  /** The multi-selection (empty unless two or more files are selected). */
  multi: Set<string>;
  /** Each selected row's place in its block, for drawing the block as one. */
  selPositions: Map<string, SelPos>;
  onSelectFile: (path: string, e: React.MouseEvent) => void;
  onMoveMany: (paths: string[], dir: string) => void;
}

const EMPTY_SET: Set<string> = new Set();

function TreeRow(props: RowProps) {
  const { node, depth, selectedPath, collapsed, forceExpand, renaming } = props;
  const isDir = node.kind === "dir";
  // While filtering, folders are force-expanded so matches stay visible.
  const isOpen = isDir && (forceExpand || !collapsed.has(node.path));
  const active = selectedPath === node.path;
  const sel = props.selPositions.get(node.path);
  const pad = 8 + depth * 14;

  if (renaming === node.path) {
    return (
      <div style={{ paddingLeft: pad }} className="py-0.5 pr-2">
        <RenameInput
          initial={node.name}
          onCancel={props.onCancelRename}
          onSubmit={(name) => props.onSubmitRename(node.path, name)}
        />
      </div>
    );
  }

  return (
    <>
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData("text/plain", node.path);
          // Dragging one of several selected notes drags them all.
          if (props.multi.has(node.path)) e.dataTransfer.setData(MULTI_DRAG, JSON.stringify([...props.multi]));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => props.setDragOver(null)}
        onDragOver={
          isDir
            ? (e) => {
                if (![...e.dataTransfer.types].includes("text/plain")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                props.setDragOver(node.path);
              }
            : undefined
        }
        onDrop={
          isDir
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                props.setDragOver(null);
                const paths = draggedPaths(e.dataTransfer);
                if (paths.length > 1) {
                  props.onMoveMany(paths, node.path);
                  return;
                }
                const from = paths[0];
                // Don't drop a folder onto itself or its own descendant.
                if (from && from !== node.path && !node.path.startsWith(`${from}/`)) {
                  props.onMove(from, node.path);
                }
              }
            : undefined
        }
        onClick={(e) => (isDir ? props.onToggle(node.path) : props.onSelectFile(node.path, e))}
        onContextMenu={
          isDir
            ? undefined
            : (e) => {
                e.preventDefault();
                props.onEditLabels(node.path, e.clientX, e.clientY);
              }
        }
        style={{ paddingLeft: pad }}
        className={`group nav-row flex items-center gap-1.5 py-1 pr-1.5 text-[13px] ${
          sel
            ? // Inside a selection the open note keeps only its accent colour, no outline.
              `nav-row-sel sel-${sel} ${active ? "text-[var(--accent-strong)]" : "text-[var(--text-primary)]"}`
            : active
              ? "nav-row-active"
              : "text-[var(--text-primary)]"
        } ${
          isDir && props.dragOver === node.path
            ? "bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]/50"
            : ""
        }`}
      >
        {isDir ? <Chevron open={isOpen} /> : <span className="w-3 shrink-0" />}
        {isDir ? <FolderIcon /> : <FileIcon />}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {!isDir && props.labels[node.path] && <LabelDots labels={props.labels[node.path]} colors={props.labelColors} />}
        {!isDir && props.ratings[node.path]?.verdict === "stub" && <StubMark rating={props.ratings[node.path]} />}

        <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {!isDir && (
            <IconButton
              title="Labels"
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                props.onEditLabels(node.path, r.left, r.bottom + 4);
              }}
            >
              <TagIcon />
            </IconButton>
          )}
          <IconButton
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              props.onBeginRename(node.path);
            }}
          >
            <PencilIcon />
          </IconButton>
          <IconButton
            title="Delete"
            danger
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete(node);
            }}
          >
            <TrashIcon />
          </IconButton>
        </span>
      </div>

      {isDir &&
        isOpen &&
        node.children?.map((child) => <TreeRow key={child.path} {...props} node={child} depth={depth + 1} />)}
    </>
  );
}

// --- Inline inputs ---

function NewItemInput({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: "note" | "folder";
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <input
      autoFocus
      value={value}
      placeholder={kind === "note" ? "note-name" : "folder-name"}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (value.trim() ? onSubmit(value.trim()) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
        if (e.key === "Escape") onCancel();
      }}
      className="field mb-1 w-full px-2 py-1 text-[13px]"
    />
  );
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => (value.trim() && value !== initial ? onSubmit(value.trim()) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
        if (e.key === "Escape") onCancel();
      }}
      className="field w-full px-2 py-1 text-[13px]"
    />
  );
}

// --- Icons ---

/** A compact square icon button used in the vault/document toolbars. */
function ToolbarButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] ${
        danger ? "hover:bg-red-500/20 hover:text-red-400" : "hover:bg-black/10"
      }`}
    >
      {children}
    </button>
  );
}

function IconButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded p-0.5 text-current/70 transition-colors ${
        danger ? "hover:bg-red-500/25 hover:text-red-600" : "hover:bg-black/15"
      }`}
    >
      {children}
    </button>
  );
}

function svgProps(size = 14) {
  return {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

function SortIcon({ dir }: { dir: SortDir }) {
  return (
    <svg {...svgProps(16)}>
      <path d="M7 4v16" />
      <path d={dir === "asc" ? "M4 8l3-4 3 4" : "M4 16l3 4 3-4"} />
      <path d="M12 6h8M12 11h6M12 16h4" />
    </svg>
  );
}

function ExpandIcon({ collapsed }: { collapsed: boolean }) {
  // Collapsed → show "expand" (double chevron down); expanded → "collapse" (up).
  return collapsed ? (
    <svg {...svgProps(16)}>
      <path d="M5 7l7 6 7-6" />
      <path d="M5 13l7 6 7-6" />
    </svg>
  ) : (
    <svg {...svgProps(16)}>
      <path d="M5 11l7-6 7 6" />
      <path d="M5 17l7-6 7 6" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg {...svgProps(12)} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg {...svgProps()} className="shrink-0 opacity-70">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg {...svgProps()} className="shrink-0 opacity-70">
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
function FilePlusIcon() {
  return (
    <svg {...svgProps(16)}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M12 12v6M9 15h6" />
    </svg>
  );
}
function ImportIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v10" />
      <path d="M8.5 9.5L12 13l3.5-3.5" />
      <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg {...svgProps(16)}>
      <path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13a2 2 0 002 2z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg {...svgProps(13)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg {...svgProps(13)}>
      <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </svg>
  );
}

// --- Tame my vault ---

/** The strip above the toolbar: confirm a run, show progress, then the result. */
function TameStatus({
  plan,
  job,
  last,
  showStubs,
  onStart,
  onRerateAll,
  onCancelPlan,
  onToggleStubs,
}: {
  plan: { total: number; toRate: string[] } | null;
  job: { total: number; done: number } | null;
  last: { rated: number; stubs: number; total: number; error?: string; cancelled?: boolean } | null;
  showStubs: boolean;
  onStart: (paths: string[]) => void;
  onRerateAll: () => void;
  onCancelPlan: () => void;
  onToggleStubs: () => void;
}) {
  const { data: ai } = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const provider = ai?.provider === "copilot" ? "GitHub Copilot" : "Claude";
  const notes = (n: number) => `${n} note${n === 1 ? "" : "s"}`;

  if (plan) {
    const skipped = plan.total - plan.toRate.length;
    return (
      <Strip>
        {plan.toRate.length === 0 ? (
          <>
            <p>All {notes(plan.total)} are rated, and none has changed since.</p>
            <Actions>
              <StripButton onClick={onRerateAll}>Rate all again</StripButton>
              <StripButton onClick={onCancelPlan}>OK</StripButton>
            </Actions>
          </>
        ) : (
          <>
            <p>
              Rate {notes(plan.toRate.length)} for completeness?
              {skipped > 0 && ` ${notes(skipped)} unchanged since the last run are skipped.`} Their text is sent to{" "}
              {provider}.
            </p>
            <Actions>
              <StripButton primary onClick={() => onStart(plan.toRate)}>
                Rate
              </StripButton>
              <StripButton onClick={onCancelPlan}>Cancel</StripButton>
            </Actions>
          </>
        )}
      </Strip>
    );
  }

  if (job) {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    return (
      <Strip>
        <div className="flex items-baseline justify-between gap-2">
          <p>Rating notes…</p>
          <span className="tabular-nums text-[var(--text-tertiary)]">
            {job.done} / {job.total}
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/10">
          <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 text-[10.5px] text-[var(--text-tertiary)]">
          Keep writing — this runs in the background. Click the broom to stop.
        </p>
      </Strip>
    );
  }

  if (last) {
    let message: string;
    if (last.error) {
      const why =
        last.error === CLI_NOT_LOGGED_IN
          ? "the Claude CLI isn't logged in — run `claude auth login`, then try again"
          : last.error === COPILOT_CLI_MISSING
            ? "the GitHub Copilot CLI isn't installed"
            : last.error;
      message = `Stopped: ${why}. Ratings made so far are kept.`;
    } else if (last.cancelled) {
      message = `Stopped after rating ${notes(last.rated)}. Run it again to finish; rated notes are skipped.`;
    } else if (last.stubs > 0) {
      message = `${last.stubs} of ${notes(last.total)} look safe to delete.`;
    } else {
      message = `No notes look safe to delete — ${notes(last.total)} checked.`;
    }
    return (
      <Strip tone={last.error ? "warn" : "plain"}>
        <p>{message}</p>
        <Actions>
          {!last.error && last.stubs > 0 && (
            <StripButton primary={!showStubs} onClick={onToggleStubs}>
              {showStubs ? "Show all notes" : "Show them"}
            </StripButton>
          )}
          <StripButton onClick={dismissResult}>{last.error ? "OK" : "Done"}</StripButton>
        </Actions>
      </Strip>
    );
  }
  return null;
}

function Strip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "warn" }) {
  return (
    <div
      className={`mx-2.5 mb-1 rounded-lg px-2.5 py-2 text-[11.5px] leading-snug ${
        tone === "warn" ? "bg-yellow-500/15 text-yellow-900" : "bg-black/[0.05] text-[var(--text-secondary)]"
      }`}
    >
      {children}
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-1.5 flex gap-1.5">{children}</div>;
}

function StripButton({
  children,
  onClick,
  primary = false,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  primary?: boolean;
}) {
  return (
    <button onClick={onClick} className={`${primary ? "btn-accent" : "btn-bezel"} px-2 py-0.5 text-[11px]`}>
      {children}
    </button>
  );
}

/**
 * Next to a note rated as barely started. Just a marker — deleting stays a
 * deliberate act through the row's own Delete button.
 */
function StubMark({ rating }: { rating: Rating }) {
  return (
    <span
      className="flex shrink-0 items-center text-amber-500"
      title={`Probably safe to delete — ${rating.reason || "barely started."} (completeness ${rating.score}%)`}
    >
      <svg {...svgProps(12)} strokeDasharray="2.6 2.6">
        <circle cx="12" cy="12" r="8" />
      </svg>
    </span>
  );
}

/** Tame vault ("clean up"): the broom from svgrepo.com, filled in the
 *  toolbar's current colour rather than the original black. */
function BroomIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden="true">
      <path d="M6.44977 8.50008C6.38977 8.50008 6.32978 8.49006 6.26978 8.48006C6.07978 8.43006 5.90977 8.3101 5.80977 8.1401L4.24978 5.5801C3.86978 4.9601 3.74977 4.22008 3.92977 3.50008C4.09977 2.79008 4.53977 2.18007 5.16977 1.80007C5.78977 1.42007 6.52978 1.30006 7.24978 1.48006C7.96978 1.65006 8.56977 2.09005 8.94977 2.72005L10.5098 5.28011C10.7298 5.63011 10.6098 6.09008 10.2598 6.31008L6.83977 8.3901C6.71977 8.4601 6.58977 8.50008 6.44977 8.50008ZM6.58977 2.90011C6.35977 2.90011 6.13977 2.9601 5.94977 3.0801C5.66977 3.2501 5.46978 3.53006 5.38978 3.85006C5.30978 4.18006 5.35977 4.51006 5.52977 4.79006L6.69977 6.7101L8.83977 5.41005L7.66977 3.49007C7.49977 3.21007 7.21977 3.01007 6.89977 2.93007C6.78977 2.91007 6.68977 2.90011 6.58977 2.90011Z" />
      <path d="M11.4198 22.61C11.1198 22.61 10.8198 22.57 10.5298 22.48C9.64985 22.22 8.93985 21.6201 8.52985 20.7701L6.47985 16.5901C5.38984 14.3701 6.15985 11.7301 8.26985 10.4401L11.4298 8.52007C13.5398 7.23008 16.2499 7.76006 17.7199 9.75006L20.4899 13.49C21.0499 14.25 21.2598 15.16 21.0898 16.05C20.9198 16.94 20.3799 17.7101 19.5699 18.2001L13.1398 22.11C12.5998 22.44 12.0098 22.61 11.4198 22.61ZM13.8998 9.32006C13.3198 9.32006 12.7398 9.48004 12.1998 9.80004L9.03984 11.72C7.58984 12.6 7.06985 14.41 7.80985 15.93L9.85985 20.11C10.0898 20.57 10.4699 20.9 10.9399 21.04C11.4099 21.18 11.9098 21.1001 12.3398 20.8401L18.7699 16.93C19.2099 16.66 19.4999 16.2501 19.5999 15.7701C19.6899 15.2901 19.5799 14.8001 19.2699 14.3901L16.4998 10.6501C15.8698 9.78008 14.8998 9.32006 13.8998 9.32006Z" />
      <path d="M7.67992 12.4299C7.61992 12.4299 7.55993 12.4199 7.49993 12.4099C7.30993 12.3599 7.13992 12.2399 7.03992 12.0699L4.95994 8.64995C4.73994 8.29995 4.85994 7.83993 5.20994 7.61993L10.3299 4.49993C10.6799 4.28993 11.1499 4.39993 11.3599 4.74993L13.4399 8.16991C13.5399 8.33991 13.5799 8.53992 13.5299 8.73992C13.4799 8.92992 13.3599 9.09994 13.1899 9.19994L8.06994 12.3199C7.94994 12.3999 7.80992 12.4299 7.67992 12.4299ZM6.62994 8.51995L7.92992 10.6599L11.7699 8.31994L10.4699 6.17992L6.62994 8.51995Z" />
      <path d="M15.9599 20.27C15.7099 20.27 15.4599 20.14 15.3199 19.91L13.6699 17.2C13.4499 16.85 13.5699 16.39 13.9199 16.17C14.2699 15.96 14.7399 16.07 14.9499 16.42L16.5999 19.13C16.8199 19.48 16.6999 19.94 16.3499 20.16C16.2299 20.23 16.0899 20.27 15.9599 20.27Z" />
      <path d="M13.3998 21.8299C13.1498 21.8299 12.8998 21.6999 12.7598 21.4699L11.1098 18.7599C10.8898 18.4099 11.0098 17.9499 11.3598 17.7299C11.7098 17.5199 12.1798 17.6299 12.3898 17.9799L14.0398 20.6899C14.2598 21.0399 14.1398 21.4999 13.7898 21.7199C13.6698 21.7899 13.5298 21.8299 13.3998 21.8299Z" />
      <path d="M18.52 18.7101C18.27 18.7101 18.02 18.58 17.88 18.35L16.23 15.6401C16.01 15.2901 16.13 14.83 16.48 14.61C16.83 14.4 17.3 14.51 17.51 14.86L19.16 17.5701C19.38 17.9201 19.26 18.38 18.91 18.6C18.79 18.67 18.66 18.7101 18.52 18.7101Z" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg {...svgProps(15)} className="animate-spin">
      <path d="M12 3a9 9 0 019 9" />
    </svg>
  );
}

// --- Reorganize the vault ---

type Reorg =
  | { phase: "analyzing"; count: number }
  | { phase: "review"; proposal: ReorgProposal }
  | { phase: "applying" }
  | { phase: "done"; moves: Move[]; report: ReorgReport }
  | { phase: "info"; message: string }
  | { phase: "error"; message: string }
  | null;

function errorText(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (text === CLI_NOT_LOGGED_IN) return "The Claude CLI isn't logged in — run `claude auth login`, then try again.";
  if (text === COPILOT_CLI_MISSING) return "The GitHub Copilot CLI isn't installed.";
  return text;
}

function ReorgStatus({
  reorg,
  onUndo,
  onDismiss,
}: {
  reorg: Reorg;
  onUndo: (moves: Move[]) => void;
  onDismiss: () => void;
}) {
  if (!reorg || reorg.phase === "review") return null;
  if (reorg.phase === "analyzing") {
    return (
      <Strip>
        <p>Analyzing {reorg.count} notes to propose folders… This can take a minute; nothing moves until you approve.</p>
        <Actions>
          <StripButton onClick={onDismiss}>Cancel</StripButton>
        </Actions>
      </Strip>
    );
  }
  if (reorg.phase === "applying") {
    return (
      <Strip>
        <p>Moving notes and updating their links…</p>
      </Strip>
    );
  }
  if (reorg.phase === "done") {
    const folders = new Set(reorg.moves.map((m) => m.to.slice(0, m.to.lastIndexOf("/")))).size;
    const { moved, relinked } = reorg.report;
    return (
      <Strip>
        <p>
          Moved {moved} note{moved === 1 ? "" : "s"} into {folders} folder{folders === 1 ? "" : "s"}
          {relinked > 0 && `; links updated in ${relinked} note${relinked === 1 ? "" : "s"}`}.
        </p>
        <Actions>
          <StripButton onClick={() => onUndo(reorg.moves)}>Undo</StripButton>
          <StripButton onClick={onDismiss}>Done</StripButton>
        </Actions>
      </Strip>
    );
  }
  return (
    <Strip tone={reorg.phase === "error" ? "warn" : "plain"}>
      <p>{reorg.phase === "error" ? `Couldn't reorganize: ${reorg.message}` : reorg.message}</p>
      <Actions>
        <StripButton onClick={onDismiss}>OK</StripButton>
      </Actions>
    </Strip>
  );
}

/** Reorganize the vault: Feather's "grid". */
function ReorganizeIcon() {
  return (
    <svg {...svgProps(16)} strokeWidth={2} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

// --- Labels ---

function LabelDots({ labels, colors }: { labels: string[]; colors: Record<string, string> }) {
  const shown = labels.slice(0, 3);
  return (
    <span className="flex shrink-0 items-center gap-[3px]" title={labels.join(", ")}>
      {shown.map((l) => (
        <span key={l} className="h-[7px] w-[7px] rounded-full" style={{ background: colorOf(l, colors) }} />
      ))}
      {labels.length > shown.length && (
        <span className="text-[10px] text-[var(--text-tertiary)]">+{labels.length - shown.length}</span>
      )}
    </span>
  );
}

/**
 * Pick labels for one note or several. With several, a label on all of them
 * is ticked, on some half-ticked; ticking applies it to all, unticking removes
 * it from all. Enter in the box creates a label; a dot recolours one.
 */
function LabelPicker({
  paths,
  x,
  y,
  notes,
  all,
  colors,
  onSet,
  onClose,
}: {
  paths: string[];
  x: number;
  y: number;
  notes: Record<string, string[]>;
  all: string[];
  colors: Record<string, string>;
  onSet: (path: string, labels: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [recolor, setRecolor] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const of = (p: string) => notes[p] ?? [];
  const count = (label: string) => paths.filter((p) => of(p).includes(label)).length;

  // Notes are updated one after another: each may be open in the editor.
  const apply = async (label: string, add: boolean) => {
    for (const p of paths) {
      const cur = of(p);
      if (add && !cur.includes(label)) await onSet(p, [...cur, label]);
      if (!add && cur.includes(label)) await onSet(p, cur.filter((l) => l !== label));
    }
  };
  const toggle = (label: string) => void apply(label, count(label) < paths.length);

  const create = () => {
    const label = normalizeLabel(name);
    if (!label) return;
    if (!colors[label] && !all.includes(label)) {
      // A new label takes the first palette colour nobody uses yet.
      const used = new Set(all.map((l) => colorOf(l, colors)));
      void setLabelColor(label, PALETTE.find((c) => !used.has(c)) ?? colorOf(label, colors));
    }
    void apply(label, true);
    setName("");
  };

  // Keep the picker inside the window.
  const left = Math.min(x, window.innerWidth - 236);
  const top = Math.min(y, window.innerHeight - 320);

  return createPortal(
    <div
      ref={ref}
      style={{ left, top }}
      className="dialog-surface fixed z-50 w-[228px] rounded-xl p-2 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="px-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        {paths.length > 1 ? `Labels · ${paths.length} notes` : "Labels"}
      </p>
      <div className="max-h-48 overflow-auto">
        {all.length === 0 && (
          <p className="px-1 pb-1 text-[11.5px] text-[var(--text-tertiary)]">No labels yet — create one below.</p>
        )}
        {all.map((label) => (
          <div key={label}>
            <div className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-black/[0.04]">
              <input
                type="checkbox"
                checked={count(label) === paths.length}
                // On some of the selected notes but not all.
                ref={(el) => {
                  if (el) el.indeterminate = count(label) > 0 && count(label) < paths.length;
                }}
                onChange={() => toggle(label)}
                className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
              />
              <button
                onClick={() => setRecolor((r) => (r === label ? null : label))}
                title="Change colour"
                className="h-3 w-3 shrink-0 rounded-full ring-offset-1 hover:ring-2 hover:ring-black/15"
                style={{ background: colorOf(label, colors) }}
              />
              <button onClick={() => toggle(label)} className="min-w-0 flex-1 truncate text-left text-[12.5px] text-[var(--text-primary)]">
                {label}
              </button>
            </div>
            {recolor === label && (
              <div className="flex gap-1.5 px-7 pb-1.5 pt-0.5">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      void setLabelColor(label, c);
                      setRecolor(null);
                    }}
                    className={`h-4 w-4 rounded-full ${colorOf(label, colors) === c ? "ring-2 ring-black/30 ring-offset-1" : ""}`}
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            create();
          }
        }}
        placeholder="New label…"
        className="field mt-1.5 w-full px-2 py-1 text-[12px]"
      />
    </div>,
    document.body,
  );
}

function TagIcon() {
  return (
    <svg {...svgProps(13)}>
      <path d="M3 12V4a1 1 0 011-1h8l9 9-9 9z" />
      <circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The label filter: one line of chips that scrolls sideways. The scrollbar is
 * hidden (the app's classic scrollbars would add height), so the edges fade
 * where chips are cut off, and a plain mouse wheel scrolls it too. Labels in
 * use as a filter come first, and Clear sits outside the scroll, so an active
 * filter is never out of sight.
 */
function LabelBar({
  labels,
  colors,
  selected,
  onToggle,
  onClear,
}: {
  labels: [string, number][];
  colors: Record<string, string>;
  selected: string[];
  onToggle: (label: string) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    setFade({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [labels, selected]);

  const ordered = [...labels].sort((a, b) => Number(selected.includes(b[0])) - Number(selected.includes(a[0])));
  const mask =
    fade.left || fade.right
      ? `linear-gradient(to right, ${fade.left ? "transparent, black 18px" : "black"}, ${
          fade.right ? "black calc(100% - 18px), transparent" : "black"
        })`
      : undefined;

  return (
    <div className="flex items-center gap-1 px-3 pb-2">
      <div
        ref={ref}
        onScroll={measure}
        onWheel={(e) => {
          // A mouse wheel only scrolls vertically; turn it sideways here.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && ref.current) ref.current.scrollLeft += e.deltaY;
        }}
        className="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {ordered.map(([label, n]) => {
          const on = selected.includes(label);
          return (
            <button
              key={label}
              onClick={() => onToggle(label)}
              title={on ? `Showing notes labelled “${label}” — click to stop` : `Show only notes labelled “${label}”`}
              className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-[1px] text-[11px] transition-colors ${
                on
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                  : "border-black/10 text-[var(--text-secondary)] hover:bg-black/[0.05]"
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(label, colors) }} />
              <span className="max-w-[110px] truncate">{label}</span>
              <span className="text-[var(--text-tertiary)]">{n}</span>
            </button>
          );
        })}
      </div>
      {selected.length > 0 && (
        <button
          onClick={onClear}
          className="shrink-0 px-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        >
          Clear
        </button>
      )}
    </div>
  );
}
