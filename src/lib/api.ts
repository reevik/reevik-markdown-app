import { invoke } from "@tauri-apps/api/core";
import type { AiBackend, ContentIndexEntry, ReferenceResult, Review, TreeNode, Vault } from "./types";

// --- Vaults ---
export function listVaults(): Promise<Vault[]> {
  return invoke("list_vaults");
}

export function addVault(path: string): Promise<Vault[]> {
  return invoke("add_vault", { path });
}

/** Creates a new vault folder `name` inside `parent`, registers it, returns its path. */
export function createVault(parent: string, name: string): Promise<string> {
  return invoke("create_vault", { parent, name });
}

export function removeVault(path: string): Promise<Vault[]> {
  return invoke("remove_vault", { path });
}

// --- Documents ---
export function readVaultTree(vault: string): Promise<TreeNode[]> {
  return invoke("read_vault_tree", { vault });
}

export function readNote(path: string): Promise<string> {
  return invoke("read_note", { path });
}

/**
 * Every Markdown note at or below `dir`, flattened for a contents list. Titles
 * come from each note's frontmatter, falling back to its file name.
 *
 * `maxDepth` of 0 means the whole hierarchy; `includeHeaders` pulls in each
 * note's own headings down to that `#` level (0 = none); `exclude` drops one
 * file (the note that hosts the index).
 */
export function readContentIndex(
  dir: string,
  maxDepth: number,
  includeHeaders: number,
  exclude: string | null,
): Promise<ContentIndexEntry[]> {
  return invoke("read_content_index", { dir, maxDepth, includeHeaders, exclude });
}

export interface FileStat {
  size: number;
  modified_ms: number;
}

export function fileStat(path: string): Promise<FileStat> {
  return invoke("file_stat", { path });
}

export function writeNote(path: string, contents: string): Promise<void> {
  return invoke("write_note", { path, contents });
}

export function createNote(dir: string, name: string): Promise<string> {
  return invoke("create_note", { dir, name });
}

export function createFolder(dir: string, name: string): Promise<string> {
  return invoke("create_folder", { dir, name });
}

export function renamePath(from: string, name: string): Promise<string> {
  return invoke("rename_path", { from, name });
}

/** Copy external files into `dir`; returns the paths of the new copies. */
export function importFiles(dir: string, sources: string[]): Promise<string[]> {
  return invoke("import_files", { dir, sources });
}

/** Move a file/folder into `dir`; returns the new path. */
export function movePath(from: string, dir: string): Promise<string> {
  return invoke("move_path", { from, dir });
}

export function deletePath(path: string): Promise<void> {
  return invoke("delete_path", { path });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

// --- Images / attachments ---
/** Resolve an image `src` (relative to the note) to a data: URL for display. */
export function readImageDataUrl(notePath: string, src: string): Promise<string> {
  return invoke("read_image_data_url", { notePath, src });
}

/** Save a pasted/dropped image beside the note; returns the note-relative path. */
export function saveAttachment(notePath: string, dataBase64: string, ext: string): Promise<string> {
  return invoke("save_attachment", { notePath, dataBase64, ext });
}

// --- AI agent ---
export function isLlmConfigured(): Promise<boolean> {
  return invoke("is_llm_configured");
}

export function aiBackend(): Promise<AiBackend> {
  return invoke("ai_backend");
}

export function setLlmApiKey(key: string): Promise<void> {
  return invoke("set_llm_api_key", { key });
}

/** Chosen model id; "" means let the backend pick its own default. */
export function getModel(): Promise<string> {
  return invoke("get_model");
}

export function setModel(model: string): Promise<void> {
  return invoke("set_model", { model });
}

/** Models offered in Settings. "" keeps the CLI's own configured default. */
export const MODEL_OPTIONS: { id: string; label: string; note: string }[] = [
  { id: "", label: "Default", note: "Use the backend's configured model" },
  { id: "claude-opus-4-8", label: "Opus 4.8", note: "Most capable, slowest" },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Fastest, cheapest" },
];

/** Open the native print panel for the main window (macOS offers "Save as PDF"). */
export function printPage(): Promise<void> {
  return invoke("print_page");
}

/** Sync the native "View ▸ Toolbar" checkmark to the frontend's state. */
export function setToolbarChecked(checked: boolean): Promise<void> {
  return invoke("set_toolbar_checked", { checked });
}

export function suggestImprovements(text: string): Promise<Review> {
  return invoke("suggest_improvements", { text });
}

/** Research the note's topic and return real, web-searched sources. */
export function findReferences(text: string): Promise<ReferenceResult> {
  return invoke("find_references", { text });
}

/** Open an http(s) link in the default browser. */
export function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url });
}

/** Rephrase a selected span; returns the rephrased text. */
export function rephrase(text: string): Promise<string> {
  return invoke("rephrase", { text });
}
