import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import VaultChooser from "./components/VaultChooser";
import VaultSidebar from "./components/VaultSidebar";
import Editor, { type EditorApi, type Mode } from "./components/Editor";
import CommandPalette, { type Command } from "./components/CommandPalette";
import { INSERT_ACTIONS } from "./components/InsertToolbar";
import AiPanel from "./components/AiPanel";
import Resizer from "./components/Resizer";
import SettingsModal from "./components/SettingsView";
import { readNote, setToolbarChecked, writeNote } from "./lib/api";
import { notifyVaultChanged } from "./lib/contentIndex";
import { printNote } from "./lib/exportPdf";
import { applyEditorFont, loadEditorFont } from "./lib/editorFont";
import type { Vault } from "./lib/types";
import "./App.css";

const LEFT_DEFAULT = 256;
const RIGHT_DEFAULT = 320;

function numFromStorage(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export type SaveState = "saved" | "dirty" | "saving" | "error";

/** One open note, kept as an in-memory buffer so unsaved edits survive tab switches.
 *  `rev` bumps only when the buffer is replaced from outside the editor (e.g. an AI
 *  suggestion is applied), forcing the uncontrolled Milkdown editor to remount. */
export interface OpenDoc {
  path: string;
  name: string;
  content: string;
  saveState: SaveState;
  loading: boolean;
  rev: number;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** The `title:` a note declares in its frontmatter — what a Content Index lists
 *  it under. Null when it has none and the file name stands in instead. */
function frontmatterTitle(markdown: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!block) return null;
  const title = /^title:(.*)$/m.exec(block[1]);
  return title ? title[1].trim().replace(/^["']|["']$/g, "") : null;
}

function App() {
  const [activeVault, setActiveVault] = useState<Vault | null>(null);
  const [openDocs, setOpenDocsState] = useState<OpenDoc[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [mode, setMode] = useState<Mode>("live");
  const editorApi = useRef<EditorApi>(null);
  const [showToolbar, setShowToolbar] = useState(() => localStorage.getItem("view.toolbar") !== "0");

  // Sync the native View ▸ Toolbar checkmark to the persisted preference on start.
  useEffect(() => {
    setToolbarChecked(showToolbar).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Editor typography, applied as CSS variables before the first paint.
  useEffect(() => {
    const { family, size } = loadEditorFont();
    applyEditorFont(family, size);
  }, []);

  // Panel layout (persisted): widths + collapsed state for the side panels.
  const [leftWidth, setLeftWidth] = useState(() => numFromStorage("layout.leftWidth", LEFT_DEFAULT));
  const [rightWidth, setRightWidth] = useState(() => numFromStorage("layout.rightWidth", RIGHT_DEFAULT));
  const [leftCollapsed, setLeftCollapsed] = useState(() => localStorage.getItem("layout.leftCollapsed") === "1");
  const [rightCollapsed, setRightCollapsed] = useState(() => localStorage.getItem("layout.rightCollapsed") === "1");

  useEffect(() => localStorage.setItem("layout.leftWidth", String(leftWidth)), [leftWidth]);
  useEffect(() => localStorage.setItem("layout.rightWidth", String(rightWidth)), [rightWidth]);
  useEffect(() => localStorage.setItem("layout.leftCollapsed", leftCollapsed ? "1" : ""), [leftCollapsed]);
  useEffect(() => localStorage.setItem("layout.rightCollapsed", rightCollapsed ? "1" : ""), [rightCollapsed]);

  // Mirror of openDocs for synchronous reads inside callbacks, plus per-note
  // debounce timers keyed by path (each tab saves independently).
  const docsRef = useRef<OpenDoc[]>([]);
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = activePath;
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** Frontmatter title each open note last hit disk with, keyed by path. */
  const savedTitles = useRef<Map<string, string | null>>(new Map());

  const setDocs = useCallback((updater: (prev: OpenDoc[]) => OpenDoc[]) => {
    setOpenDocsState((prev) => {
      const next = updater(prev);
      docsRef.current = next;
      return next;
    });
  }, []);

  const patchDoc = useCallback(
    (path: string, patch: Partial<OpenDoc>) => {
      setDocs((prev) => prev.map((d) => (d.path === path ? { ...d, ...patch } : d)));
    },
    [setDocs],
  );

  // Update a note's buffer and debounce a write to disk.
  const scheduleSave = useCallback(
    (path: string, next: string) => {
      patchDoc(path, { content: next, saveState: "dirty" });
      const timers = saveTimers.current;
      const existing = timers.get(path);
      if (existing) clearTimeout(existing);
      timers.set(
        path,
        setTimeout(async () => {
          patchDoc(path, { saveState: "saving" });
          try {
            await writeNote(path, next);
            patchDoc(path, { saveState: "saved" });
            // A Content Index lists this note under its frontmatter title, so a
            // changed title has to reach the indexes in other open notes. Only
            // when it actually changed — autosave fires far too often to re-walk
            // the vault on every write.
            const title = frontmatterTitle(next);
            if (savedTitles.current.get(path) !== title) {
              savedTitles.current.set(path, title);
              notifyVaultChanged();
            }
          } catch (e) {
            console.error(e);
            patchDoc(path, { saveState: "error" });
          }
          timers.delete(path);
        }, 600),
      );
    },
    [patchDoc],
  );

  // Open a note in a tab. If already open, just activate it (preserving its
  // buffer); otherwise add a loading tab and read the file from disk.
  const openNote = useCallback(
    async (path: string) => {
      setActivePath(path);
      if (docsRef.current.some((d) => d.path === path)) return;
      setDocs((prev) => [
        ...prev,
        { path, name: basename(path), content: "", saveState: "saved", loading: true, rev: 0 },
      ]);
      try {
        const text = await readNote(path);
        savedTitles.current.set(path, frontmatterTitle(text));
        patchDoc(path, { content: text, loading: false, saveState: "saved" });
      } catch (e) {
        console.error(e);
        patchDoc(path, { content: "", loading: false, saveState: "error" });
      }
    },
    [setDocs, patchDoc],
  );

  // A Content Index link lives inside CodeMirror, well out of reach of the tab
  // state, so it asks for a note by event.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (path) void openNote(path);
    };
    window.addEventListener("reevik:open-note", handler);
    return () => window.removeEventListener("reevik:open-note", handler);
  }, [openNote]);

  // Live edits coming from the editor for the active note.
  const onEditorChange = useCallback(
    (next: string) => {
      if (activePath) scheduleSave(activePath, next);
    },
    [activePath, scheduleSave],
  );

  // Replace the active note's content from outside the editor (AI "Apply"); bump
  // `rev` so the uncontrolled editor remounts with the new text.
  const applyContent = useCallback(
    (next: string) => {
      const path = activePath;
      if (!path) return;
      const doc = docsRef.current.find((d) => d.path === path);
      patchDoc(path, { rev: (doc?.rev ?? 0) + 1 });
      scheduleSave(path, next);
    },
    [activePath, patchDoc, scheduleSave],
  );

  // Remove one or more tabs. `save` flushes unsaved buffers first (skip it when
  // the file was deleted on disk, so we don't recreate it). If the active tab is
  // among them, the neighbour that slid into its slot becomes active.
  const removeTabs = useCallback(
    (paths: string[], save: boolean) => {
      const doomed = new Set(paths);
      const timers = saveTimers.current;
      const docs = docsRef.current;
      const closing = docs.filter((d) => doomed.has(d.path));
      if (closing.length === 0) return;
      const activeIdx = docs.findIndex((d) => d.path === activePathRef.current);

      for (const doc of closing) {
        const timer = timers.get(doc.path);
        if (timer) {
          clearTimeout(timer);
          timers.delete(doc.path);
        }
        savedTitles.current.delete(doc.path);
        if (save && doc.saveState !== "saved") {
          writeNote(doc.path, doc.content).catch((e) => console.error(e));
        }
      }

      const next = docs.filter((d) => !doomed.has(d.path));
      setDocs(() => next);
      setActivePath((cur) => {
        if (cur && !doomed.has(cur)) return cur;
        if (next.length === 0) return null;
        return next[Math.min(Math.max(activeIdx, 0), next.length - 1)].path;
      });
    },
    [setDocs],
  );

  const removeTab = useCallback((path: string, save: boolean) => removeTabs([path], save), [removeTabs]);

  const closeTab = useCallback((path: string) => removeTab(path, true), [removeTab]);

  // Tab context menu: close every other tab, or all of them.
  const closeOtherTabs = useCallback(
    (keep: string) => removeTabs(docsRef.current.filter((d) => d.path !== keep).map((d) => d.path), true),
    [removeTabs],
  );

  const closeAllTabs = useCallback(
    () => removeTabs(docsRef.current.map((d) => d.path), true),
    [removeTabs],
  );

  // Follow a sidebar rename/move (migrate the affected tabs) or delete (drop the
  // tab). `oldPath` may be a folder, so remap by exact match or path prefix.
  const onPathChanged = useCallback(
    (oldPath: string, newPath: string | null) => {
      if (!newPath) {
        removeTab(oldPath, false);
        return;
      }
      const affects = (p: string) => p === oldPath || p.startsWith(`${oldPath}/`);
      const remap = (p: string) => (p === oldPath ? newPath : newPath + p.slice(oldPath.length));

      // Flush any pending save to the NEW location, then drop the stale timer, so
      // an in-flight save never recreates the file at the old path.
      const timers = saveTimers.current;
      for (const key of [...timers.keys()]) {
        if (!affects(key)) continue;
        clearTimeout(timers.get(key)!);
        timers.delete(key);
        const doc = docsRef.current.find((d) => d.path === key);
        if (doc && doc.saveState !== "saved") writeNote(remap(key), doc.content).catch((e) => console.error(e));
      }

      setDocs((prev) =>
        prev.map((d) => (affects(d.path) ? { ...d, path: remap(d.path), name: basename(remap(d.path)) } : d)),
      );
      setActivePath((cur) => (cur && affects(cur) ? remap(cur) : cur));
    },
    [setDocs, removeTab],
  );

  // Enter a vault (or return to the chooser with `null`). Flushes unsaved buffers
  // and closes every tab so nothing carries across vaults.
  const switchVault = useCallback(
    (vault: Vault | null) => {
      saveTimers.current.forEach((t) => clearTimeout(t));
      saveTimers.current.clear();
      savedTitles.current.clear();
      docsRef.current.forEach((d) => {
        if (d.saveState !== "saved") writeNote(d.path, d.content).catch((e) => console.error(e));
      });
      setDocs(() => []);
      setActivePath(null);
      setActiveVault(vault);
    },
    [setDocs],
  );

  const exportPdf = useCallback(() => {
    const doc = docsRef.current.find((d) => d.path === activePathRef.current);
    if (!doc || doc.loading) return;
    printNote(doc.content, doc.path, doc.name).catch((e) => console.error("export pdf failed", e));
  }, []);

  const toggleToolbar = useCallback(() => {
    setShowToolbar((v) => {
      const next = !v;
      localStorage.setItem("view.toolbar", next ? "1" : "0");
      setToolbarChecked(next).catch(() => {});
      return next;
    });
  }, []);

  // Every action the app exposes, in one list for the palette.
  const commands: Command[] = useMemo(() => {
    const hasNote = !!activePath;
    const noNote = "Open a note first";
    const list: Command[] = [
      { id: "file.new-note", group: "File", title: "New note", hint: "⌘N", run: () => window.dispatchEvent(new Event("reevik:new-note")) },
      { id: "file.new-folder", group: "File", title: "New folder", hint: "⌘⇧N", run: () => window.dispatchEvent(new Event("reevik:new-folder")) },
      {
        id: "file.add-to-vault",
        group: "File",
        title: "Add to vault…",
        hint: "⌘⇧I",
        run: () => window.dispatchEvent(new Event("reevik:add-to-vault")),
      },
      {
        id: "file.export-pdf",
        group: "File",
        title: "Export as PDF…",
        hint: "⌘P",
        disabled: !hasNote,
        disabledReason: noNote,
        run: exportPdf,
      },
      {
        id: "file.close-tab",
        group: "File",
        title: "Close tab",
        hint: "⌘W",
        disabled: !hasNote,
        disabledReason: noNote,
        run: () => activePathRef.current && closeTab(activePathRef.current),
      },
      {
        id: "view.mode",
        group: "View",
        title: mode === "live" ? "Switch to Markdown source" : "Switch to live preview",
        hint: "⌘/",
        run: () => setMode((m) => (m === "live" ? "source" : "live")),
      },
      { id: "view.toolbar", group: "View", title: showToolbar ? "Hide insert toolbar" : "Show insert toolbar", hint: "⌘⌥3", run: toggleToolbar },
      {
        id: "view.left",
        group: "View",
        title: leftCollapsed ? "Show sidebar" : "Hide sidebar",
        hint: "⌘⌥1",
        run: () => setLeftCollapsed((v) => !v),
      },
      {
        id: "view.right",
        group: "View",
        title: rightCollapsed ? "Show AI panel" : "Hide AI panel",
        hint: "⌘⌥2",
        run: () => setRightCollapsed((v) => !v),
      },
      {
        id: "ai.rephrase",
        group: "AI",
        title: "Rephrase selection",
        hint: "⌘⇧R",
        disabled: !hasNote,
        disabledReason: noNote,
        run: () => editorApi.current?.rephrase(),
      },
      {
        id: "ai.suggest",
        group: "AI",
        title: "Editorial review",
        hint: "⌘⇧A",
        disabled: !hasNote,
        disabledReason: noNote,
        run: () => {
          // The panel is unmounted while collapsed, so let it mount (and register
          // its listener) before asking it to run.
          setRightCollapsed(false);
          setTimeout(() => window.dispatchEvent(new Event("reevik:ai-suggest")), 60);
        },
      },
      {
        id: "ai.references",
        group: "AI",
        title: "Find references",
        hint: "⌘⇧F",
        disabled: !hasNote,
        disabledReason: noNote,
        run: () => {
          setRightCollapsed(false);
          setTimeout(() => window.dispatchEvent(new Event("reevik:ai-references")), 60);
        },
      },
      { id: "vault.open", group: "Vault", title: "Open vault…", hint: "⌘⇧O", run: () => switchVault(null) },
      { id: "vault.settings", group: "Vault", title: "Preferences…", hint: "⌘,", run: () => setShowSettings(true) },
      // Reachable from the menu/⌘K; hidden from the palette's own list.
      { id: "view.palette", group: "View", title: "Command palette", hint: "⌘K", run: () => setShowPalette((v) => !v) },
    ];

    for (const a of INSERT_ACTIONS) {
      list.push({
        id: `insert.${a.key}`,
        group: "Insert",
        title: a.title,
        disabled: !hasNote,
        disabledReason: noNote,
        run: () => editorApi.current?.applyEdit(a.spec),
      });
    }
    return list;
  }, [activePath, mode, showToolbar, leftCollapsed, rightCollapsed, exportPdf, toggleToolbar, switchVault, closeTab]);

  // Native menu picks arrive as palette command ids, so a menu item and a palette
  // entry run exactly the same action.
  const commandsRef = useRef<Command[]>([]);
  commandsRef.current = commands;
  useEffect(() => {
    const un = listen<string>("menu:command", (e) => {
      const c = commandsRef.current.find((x) => x.id === e.payload);
      if (c && !c.disabled) c.run();
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  // ⌘⇧P is a second way into the palette. A macOS menu item can only carry one
  // accelerator (⌘K), and since ⌘⇧P isn't a menu key the webview still sees it —
  // so this can't double-fire against the menu.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Vault launcher — shown on startup and whenever no vault is open.
  if (!activeVault) {
    return <VaultChooser onOpen={switchVault} />;
  }

  const activeDoc = openDocs.find((d) => d.path === activePath) ?? null;

  return (
    <div className="flex h-screen overflow-hidden">
      {!leftCollapsed && (
        <>
          <VaultSidebar
            width={leftWidth}
            activeVault={activeVault}
            selectedPath={activePath}
            onOpenNote={openNote}
            onPathChanged={onPathChanged}
          />
          <Resizer width={leftWidth} setWidth={setLeftWidth} dir={1} min={180} max={480}
                   onReset={() => setLeftWidth(LEFT_DEFAULT)} />
        </>
      )}

      <Editor
        docs={openDocs}
        activePath={activePath}
        onSelectTab={openNote}
        onCloseTab={closeTab}
        onCloseOtherTabs={closeOtherTabs}
        onCloseAllTabs={closeAllTabs}
        onChange={onEditorChange}
        showToolbar={showToolbar}
        ref={editorApi}
        mode={mode}
        setMode={setMode}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        onToggleLeft={() => setLeftCollapsed((v) => !v)}
        onToggleRight={() => setRightCollapsed((v) => !v)}
      />

      {!rightCollapsed && (
        <>
          <Resizer width={rightWidth} setWidth={setRightWidth} dir={-1} min={240} max={560}
                   onReset={() => setRightWidth(RIGHT_DEFAULT)} />
          <AiPanel
            width={rightWidth}
            path={activeDoc?.path ?? null}
            content={activeDoc?.content ?? ""}
            onApply={applyContent}
            onInsertText={(md) => editorApi.current?.applyEdit({ before: md, block: true })}
          />
        </>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showPalette && (
        <CommandPalette
          commands={commands.filter((c) => c.id !== "view.palette")}
          onClose={() => setShowPalette(false)}
        />
      )}
    </div>
  );
}

export default App;
