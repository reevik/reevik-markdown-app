import { forwardRef, useImperativeHandle, useRef, type Dispatch, type SetStateAction } from "react";
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
          <TabStrip docs={docs} activePath={activePath} onSelect={onSelectTab} onClose={onCloseTab} />
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
}: {
  docs: OpenDoc[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    // Empty space after the tabs doubles as the window drag handle.
    <div className="flex min-w-0 flex-1 items-end overflow-x-auto" data-tauri-drag-region>
      {docs.map((d) => {
        const active = d.path === activePath;
        const dirty = d.saveState !== "saved";
        return (
          <div
            key={d.path}
            onClick={() => onSelect(d.path)}
            // Middle-click closes the tab, like a browser.
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(d.path);
              }
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
    </div>
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
