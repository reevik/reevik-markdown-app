import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import CodeMirrorEditor, { type EditorHandle, type EditSpec } from "./CodeMirrorEditor";
import InsertToolbar from "./InsertToolbar";
import StatusBar from "./StatusBar";
import type { OpenDoc } from "../App";

export type Mode = "live" | "source";

interface Props {
  docs: OpenDoc[];
  activePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseOtherTabs: (keep: string) => void;
  onCloseAllTabs: () => void;
  onChange: (next: string) => void;
  showToolbar: boolean;
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}

/** Imperative surface used by the command palette. */
export interface EditorApi {
  applyEdit(spec: EditSpec): void;
  rephrase(): void;
}

const Editor = forwardRef<EditorApi, Props>(function Editor(
  {
    docs,
    activePath,
    onSelectTab,
    onCloseTab,
    onCloseOtherTabs,
    onCloseAllTabs,
    onChange,
    showToolbar,
    mode,
    setMode,
    leftCollapsed,
    rightCollapsed,
    onToggleLeft,
    onToggleRight,
  },
  ref,
) {
  const editorRef = useRef<EditorHandle>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      applyEdit: (spec) => editorRef.current?.applyEdit(spec),
      rephrase: () => editorRef.current?.rephrase(),
    }),
    [],
  );
  const active = docs.find((d) => d.path === activePath) ?? null;

  const rightControls = (
    <div
      className="flex h-9 shrink-0 items-center self-end gap-1.5 border-b border-black/10 pl-2 pr-1"
      data-tauri-drag-region
    >
      {active && <ModeToggle mode={mode} setMode={setMode} />}
      <PanelToggle side="left" collapsed={leftCollapsed} onToggle={onToggleLeft} />
      <PanelToggle side="right" collapsed={rightCollapsed} onToggle={onToggleRight} />
    </div>
  );

  return (
    <div className="content-pane flex min-w-0 flex-1 flex-col">
      {/* Safari-style tab bar with a small top margin; tabs align to the bottom so
          the active tab's open bottom edge flows into the document. Empty regions
          are the window drag handle. The right controls are always shown. */}
      <div className="flex h-11 shrink-0 items-end px-2 pt-2" data-tauri-drag-region>
        {docs.length > 0 ? (
          <TabStrip
            docs={docs}
            activePath={activePath}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onCloseOthers={onCloseOtherTabs}
            onCloseAll={onCloseAllTabs}
          />
        ) : (
          <div className="h-9 min-w-[12px] flex-1 border-b border-black/10" data-tauri-drag-region />
        )}
        {rightControls}
      </div>

      <div ref={paneRef} className="relative min-h-0 flex-1 overflow-hidden">
        {!active ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-[14px] text-[var(--text-secondary)]">No note open</p>
            <p className="text-[12px] text-[var(--text-tertiary)]">Pick a document from the sidebar to open it.</p>
          </div>
        ) : active.loading ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-tertiary)]">
            Loading…
          </div>
        ) : (
          <>
            <CodeMirrorEditor
              ref={editorRef}
              key={`${active.path}#${active.rev}`}
              initial={active.content}
              notePath={active.path}
              livePreview={mode === "live"}
              onChange={onChange}
            />
            {showToolbar && (
              <InsertToolbar anchorRef={paneRef} onInsert={(spec) => editorRef.current?.applyEdit(spec)} />
            )}
          </>
        )}
      </div>

      <StatusBar doc={active} />
    </div>
  );
});

export default Editor;

// --- Live / Source mode toggle (inline with the tabs) ---

function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="flex overflow-hidden rounded-[7px] border border-black/12">
      <button
        onClick={() => setMode("live")}
        title="Live preview"
        aria-label="Live preview"
        className={`flex items-center justify-center px-2 py-1 transition-colors ${
          mode === "live" ? "bg-black/15 text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-black/10"
        }`}
      >
        <TypeIcon />
      </button>
      <button
        onClick={() => setMode("source")}
        title="Source Markdown (⌘/)"
        aria-label="Source Markdown"
        className={`flex items-center justify-center px-2 py-1 transition-colors ${
          mode === "source" ? "bg-black/15 text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-black/10"
        }`}
      >
        <CodeIcon />
      </button>
    </div>
  );
}

function PanelToggle({
  side,
  collapsed,
  onToggle,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={`${collapsed ? "Show" : "Hide"} ${side} panel`}
      aria-label={`${collapsed ? "Show" : "Hide"} ${side} panel`}
      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-black/10 ${
        collapsed ? "text-[var(--text-tertiary)]" : "text-[var(--text-primary)]"
      }`}
    >
      <PanelIcon side={side} filled={!collapsed} />
    </button>
  );
}

function PanelIcon({ side, filled }: { side: "left" | "right"; filled: boolean }) {
  const lineX = side === "left" ? 9 : 15;
  const fill = side === "left" ? { x: 4, w: 4 } : { x: 16, w: 4 };
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1={lineX} y1="4" x2={lineX} y2="20" />
      {filled && <rect x={fill.x} y="5" width={fill.w} height="14" fill="currentColor" stroke="none" opacity="0.35" />}
    </svg>
  );
}

// --- Tab strip (scrollable list of open notes) ---

function TabStrip({
  docs,
  activePath,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
}: {
  docs: OpenDoc[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (keep: string) => void;
  onCloseAll: () => void;
}) {
  // Keep the active tab reachable: the strip scrolls but shows no scrollbar.
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  // Right-clicked tab + where to pop its menu, or null when no menu is open.
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  return (
    // Empty space after the tabs doubles as the window drag handle. The height is
    // pinned to one tab so an overflowing strip never grows the tab row.
    <div className="tab-strip flex h-9 min-w-0 flex-1 select-none items-end overflow-x-auto" data-tauri-drag-region>
      {docs.map((d) => {
        const active = d.path === activePath;
        const dirty = d.saveState !== "saved";
        return (
          <div
            key={d.path}
            ref={active ? activeRef : undefined}
            onClick={() => onSelect(d.path)}
            // Middle-click closes the tab, like a browser.
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(d.path);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ path: d.path, x: e.clientX, y: e.clientY });
            }}
            title={d.path}
            // Active tab: top/side border with an OPEN bottom, so it breaks the
            // baseline and merges into the document below. Inactive tabs keep the
            // bottom border (baseline) plus a faint right divider.
            className={`group flex h-9 shrink-0 cursor-default items-center gap-1.5 rounded-t-[8px] border pl-2.5 pr-2 text-[12px] transition-colors ${
              active
                ? "border-b-0 border-black/12 text-[var(--text-primary)]"
                : "border-transparent border-b-black/10 border-r-black/[0.06] text-[var(--text-secondary)] hover:bg-black/[0.04]"
            }`}
          >
            <FileIcon className={active ? "opacity-80" : "opacity-50"} />
            <span className="max-w-[150px] truncate">{d.name}</span>
            <span className="relative flex h-4 w-4 items-center justify-center">
              {dirty && (
                <span className="h-1.5 w-1.5 rounded-full bg-yellow-400 group-hover:hidden" title="Unsaved" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(d.path);
                }}
                title="Close tab"
                className={`absolute inset-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-black/15 hover:text-[var(--text-primary)] ${
                  dirty ? "hidden group-hover:flex" : "flex"
                }`}
              >
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </span>
          </div>
        );
      })}
      {/* Empty region after the tabs: carries the baseline + drag handle. */}
      <div className="h-9 min-w-[12px] flex-1 border-b border-black/10" data-tauri-drag-region />

      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
          items={[
            { label: "Close", run: () => onClose(menu.path) },
            { label: "Close Others", disabled: docs.length < 2, run: () => onCloseOthers(menu.path) },
            { label: "Close All", run: onCloseAll },
          ]}
        />
      )}
    </div>
  );
}

// --- Tab context menu ---

interface MenuItem {
  label: string;
  disabled?: boolean;
  run: () => void;
}

/** Right-click menu for a tab. Rendered in a portal so the scrolling tab strip
 *  can't clip it, and nudged back inside the window near the right/bottom edge. */
function TabMenu({
  x,
  y,
  items,
  onDismiss,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss]);

  return createPortal(
    // Full-screen catcher: any click outside (either button) dismisses.
    <div className="fixed inset-0 z-50" onMouseDown={onDismiss} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
        className="content-pane fixed min-w-[160px] select-none overflow-hidden rounded-lg py-1 shadow-xl"
      >
        {items.map((item) => (
          <button
            key={item.label}
            disabled={item.disabled}
            onClick={() => {
              onDismiss();
              item.run();
            }}
            className={`flex w-full items-center px-3 py-1.5 text-left text-[13px] ${
              item.disabled
                ? "text-[var(--text-tertiary)]"
                : "text-[var(--text-primary)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// --- Icons ---

function TypeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7V4h16v3" />
      <path d="M9 20h6" />
      <path d="M12 4v16" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 18l6-6-6-6" />
      <path d="M8 6l-6 6 6 6" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ""}`}
    >
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
