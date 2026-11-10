import { invoke } from "@tauri-apps/api/core";
import type {
  AiBackend,
  AiProvider,
  AiSettings,
  ChatMessage,
  ContentIndexEntry,
  ReferenceResult,
  Review,
  TreeNode,
  Vault,
} from "./types";

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

/**
 * The latest write issued for each note. File commands run off the main thread,
 * so they no longer finish in the order they were sent: an autosave stalled by
 * iCloud could land after the next one and leave older text on disk. Each write
 * to a note waits for the previous one, and a read waits for both.
 */
const pendingWrites = new Map<string, Promise<void>>();

export async function readNote(path: string): Promise<string> {
  await pendingWrites.get(path)?.catch(() => {});
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
  const prev = pendingWrites.get(path);
  const write = prev
    ? prev.catch(() => {}).then(() => invoke<void>("write_note", { path, contents }))
    : invoke<void>("write_note", { path, contents });
  pendingWrites.set(path, write);
  const settle = () => {
    if (pendingWrites.get(path) === write) pendingWrites.delete(path);
  };
  write.then(settle, settle);
  return write;
}

/** Settles once every write to `path`, or to a note under it, has finished, so
 *  a rename, move or delete can't be overtaken by one and recreate the file. */
function writesUnder(path: string): Promise<unknown> {
  const prefix = `${path}/`;
  const waits: Promise<void>[] = [];
  for (const [p, write] of pendingWrites) {
    if (p === path || p.startsWith(prefix)) waits.push(write);
  }
  return Promise.allSettled(waits);
}

export function createNote(dir: string, name: string): Promise<string> {
  return invoke("create_note", { dir, name });
}

export function createFolder(dir: string, name: string): Promise<string> {
  return invoke("create_folder", { dir, name });
}

export async function renamePath(from: string, name: string): Promise<string> {
  await writesUnder(from);
  return invoke("rename_path", { from, name });
}

/** Copy external files into `dir`; returns the paths of the new copies. */
export function importFiles(dir: string, sources: string[]): Promise<string[]> {
  return invoke("import_files", { dir, sources });
}

/** Move a file/folder into `dir`; returns the new path. */
export async function movePath(from: string, dir: string): Promise<string> {
  await writesUnder(from);
  return invoke("move_path", { from, dir });
}

export async function deletePath(path: string): Promise<void> {
  await writesUnder(path);
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

/** The AI provider and the model chosen for each; "" means that backend's own default. */
export function getAiSettings(): Promise<AiSettings> {
  return invoke("get_ai_settings");
}

export function setProvider(provider: AiProvider): Promise<AiSettings> {
  return invoke("set_provider", { provider });
}

/** Sets the model for one provider; each keeps its own choice. */
export function setModel(provider: AiProvider, model: string): Promise<AiSettings> {
  return invoke("set_model", { provider, model });
}

export interface ModelOption {
  id: string;
  label: string;
  note: string;
}

/** Models offered in Settings, per provider. "" keeps that CLI's own default. */
export const MODEL_OPTIONS: Record<AiProvider, ModelOption[]> = {
  claude: [
    { id: "", label: "Default", note: "Use the backend's configured model" },
    { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Balanced" },
    { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "Fastest, cheapest" },
  ],
  // Filled in from the installed Copilot CLI once its exact model ids are
  // confirmed; until then it runs on the default from your Copilot plan.
  copilot: [{ id: "", label: "Default", note: "Your Copilot plan's default model" }],
};

export const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "copilot", label: "GitHub Copilot" },
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

/**
 * One turn of the Editorial chat. `messages` is the full transcript (the backend
 * keeps no session), and the open note travels alongside it so the agent always
 * sees the current text rather than a stale copy from earlier in the thread.
 */
export function chat(
  messages: ChatMessage[],
  notePath: string | null,
  noteText: string,
): Promise<string> {
  return invoke("chat", { messages, notePath, noteText });
}

/** The error a backend call returns, instead of a raw message, when the Claude
 *  CLI has no usable login. Panels show the fix rather than the failure. */
export const CLI_NOT_LOGGED_IN = "claude-cli-not-logged-in";

/** Returned instead of a raw error when Copilot is selected but its CLI isn't installed. */
export const COPILOT_CLI_MISSING = "copilot-cli-missing";

/** The version as shown to people, e.g. "1.1.0.beta" (manifests hold plain semver). */
export function appVersion(): Promise<string> {
  return invoke("app_version");
}
