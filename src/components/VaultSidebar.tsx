import { useEffect, useMemo, useState } from "react";
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
import type { TreeNode, Vault } from "../lib/types";

interface Props {
  width: number;
  activeVault: Vault;
  selectedPath: string | null;
  onOpenNote: (path: string) => void;
  onPathChanged: (oldPath: string, newPath: string | null) => void;
}

type Creating = { kind: "note" | "folder"; dir: string } | null;
type SortDir = "asc" | "desc";

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
}: Props) {
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<Creating>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const { data: tree } = useQuery({
    queryKey: ["tree", activeVault.path],
    queryFn: () => readVaultTree(activeVault.path),
  });

  const refreshTree = () => qc.invalidateQueries({ queryKey: ["tree", activeVault.path] });
  const rootDir = activeVault.path;

  const filtering = filter.trim() !== "";
  const displayed = useMemo(() => {
    const sorted = sortTree(tree ?? [], sortDir);
    return filtering ? filterTree(sorted, filter.trim()) : sorted;
  }, [tree, sortDir, filter, filtering]);

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
      onPathChanged(vars.from, newPath);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (path: string) => deletePath(path),
    onSuccess: (_r, path) => {
      refreshTree();
      onPathChanged(path, null);
    },
  });

  // Drag a file/folder onto a folder (or the empty area = vault root) to move it.
  const [dragOver, setDragOver] = useState<string | null>(null);
  const moveMutation = useMutation({
    mutationFn: ({ from, dir }: { from: string; dir: string }) => movePath(from, dir),
    onSuccess: (newPath, vars) => {
      refreshTree();
      onPathChanged(vars.from, newPath);
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

      {/* Document tree — dropping on empty space moves the item to the vault root */}
      <nav
        className="min-h-0 flex-1 overflow-auto pl-3 pr-0.5 pb-3 [scrollbar-gutter:stable]"
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes("text/plain")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(null);
          doMove(e.dataTransfer.getData("text/plain"), rootDir);
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
            forceExpand={filtering}
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
}

function TreeRow(props: RowProps) {
  const { node, depth, selectedPath, collapsed, forceExpand, renaming } = props;
  const isDir = node.kind === "dir";
  // While filtering, folders are force-expanded so matches stay visible.
  const isOpen = isDir && (forceExpand || !collapsed.has(node.path));
  const active = selectedPath === node.path;
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
                const from = e.dataTransfer.getData("text/plain");
                // Don't drop a folder onto itself or its own descendant.
                if (from && from !== node.path && !node.path.startsWith(`${from}/`)) {
                  props.onMove(from, node.path);
                }
              }
            : undefined
        }
        onClick={() => (isDir ? props.onToggle(node.path) : props.onOpenNote(node.path))}
        style={{ paddingLeft: pad }}
        className={`group nav-row flex items-center gap-1.5 py-1 pr-1.5 text-[13px] ${
          active ? "nav-row-active" : "text-[var(--text-primary)]"
        } ${
          isDir && props.dragOver === node.path
            ? "bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]/50"
            : ""
        }`}
      >
        {isDir ? <Chevron open={isOpen} /> : <span className="w-3 shrink-0" />}
        {isDir ? <FolderIcon /> : <FileIcon />}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>

        <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
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
