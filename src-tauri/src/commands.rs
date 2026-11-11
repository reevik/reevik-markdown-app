use crate::fs_vault::{self, IndexEntry, TreeNode};
use crate::llm::{self, Review};
use crate::{AppState, VaultRef};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;

// ---------------------------------------------------------------------------
// Vault management
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_vaults(state: State<'_, AppState>) -> Vec<VaultRef> {
    state.vaults.lock().unwrap().clone()
}

/// Registers a folder as a vault. Validates it is a real directory, de-duplicates
/// against the existing list, persists the updated list, and returns it.
#[tauri::command]
pub fn add_vault(path: String, state: State<'_, AppState>) -> Result<Vec<VaultRef>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let mut vaults = state.vaults.lock().unwrap();
    if !vaults.iter().any(|v| v.path == path) {
        vaults.push(VaultRef { path, name });
    }
    let snapshot = vaults.clone();
    drop(vaults);
    save_vaults(&state.vaults_path, &snapshot)?;
    Ok(snapshot)
}

/// Creates a brand-new vault: makes a folder called `name` inside `parent`, then
/// registers it. Unlike `create_folder`, `parent` need not already be inside a
/// registered vault — this is how a first/independent vault root is established.
#[tauri::command]
pub fn create_vault(parent: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let parent_dir = PathBuf::from(&parent);
    if !parent_dir.is_dir() {
        return Err(format!("{parent} is not a directory"));
    }
    let new_path = fs_vault::create_folder(&parent_dir, &name).map_err(|e| e.to_string())?;
    let path_str = new_path.to_string_lossy().to_string();
    let vault_name = new_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(name);

    let mut vaults = state.vaults.lock().unwrap();
    if !vaults.iter().any(|v| v.path == path_str) {
        vaults.push(VaultRef {
            path: path_str.clone(),
            name: vault_name,
        });
    }
    let snapshot = vaults.clone();
    drop(vaults);
    save_vaults(&state.vaults_path, &snapshot)?;
    Ok(path_str)
}

#[tauri::command]
pub fn remove_vault(path: String, state: State<'_, AppState>) -> Result<Vec<VaultRef>, String> {
    let mut vaults = state.vaults.lock().unwrap();
    vaults.retain(|v| v.path != path);
    let snapshot = vaults.clone();
    drop(vaults);
    save_vaults(&state.vaults_path, &snapshot)?;
    Ok(snapshot)
}

pub fn save_vaults(path: &Path, vaults: &[VaultRef]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(vaults).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Documents (filesystem)
// ---------------------------------------------------------------------------
//
// Every command that touches vault files is `#[tauri::command(async)]`. A plain
// sync command runs on the main thread, and in an iCloud vault any file access
// can stall for seconds while macOS downloads an evicted file — freezing the
// whole window. `(async)` runs the same body on Tauri's async runtime instead.

#[tauri::command(async)]
pub fn read_vault_tree(vault: String, state: State<'_, AppState>) -> Result<Vec<TreeNode>, String> {
    let root = PathBuf::from(&vault);
    ensure_within_vaults(&root, &state)?;
    fs_vault::read_tree(&root).map_err(|e| e.to_string())
}

/// Backs the Content Index block: every Markdown note at or below `dir`, titled
/// from its frontmatter, ready to render as a contents list.
#[tauri::command(async)]
pub fn read_content_index(
    dir: String,
    max_depth: usize,
    include_headers: usize,
    exclude: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<IndexEntry>, String> {
    let root = PathBuf::from(&dir);
    ensure_within_vaults(&root, &state)?;
    let skip = exclude.map(PathBuf::from);
    fs_vault::read_index(&root, max_depth, include_headers, skip.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn read_note(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    ensure_within_vaults(&p, &state)?;
    fs_vault::read_note(&p).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct FileStat {
    pub size: u64,
    /// Last-modified time as epoch milliseconds (0 if unavailable).
    pub modified_ms: i64,
}

#[tauri::command(async)]
pub fn file_stat(path: String, state: State<'_, AppState>) -> Result<FileStat, String> {
    let p = PathBuf::from(&path);
    ensure_within_vaults(&p, &state)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(FileStat {
        size: meta.len(),
        modified_ms,
    })
}

#[tauri::command(async)]
pub fn write_note(path: String, contents: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    ensure_within_vaults(&p, &state)?;
    fs_vault::write_note(&p, &contents).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_note(dir: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    ensure_within_vaults(&d, &state)?;
    fs_vault::create_note(&d, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_folder(dir: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    ensure_within_vaults(&d, &state)?;
    fs_vault::create_folder(&d, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn rename_path(from: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let f = PathBuf::from(&from);
    ensure_within_vaults(&f, &state)?;
    fs_vault::rename_path(&f, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Copy external files into the vault. Only the destination is path-guarded —
/// the sources are deliberately outside the vault, which is the whole point.
#[tauri::command(async)]
pub fn import_files(
    dir: String,
    sources: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let d = PathBuf::from(&dir);
    ensure_within_vaults(&d, &state)?;
    let mut added = Vec::new();
    for s in sources {
        let path = fs_vault::import_into(Path::new(&s), &d).map_err(|e| e.to_string())?;
        added.push(path.to_string_lossy().to_string());
    }
    Ok(added)
}

#[tauri::command(async)]
pub fn move_path(from: String, dir: String, state: State<'_, AppState>) -> Result<String, String> {
    let f = PathBuf::from(&from);
    let d = PathBuf::from(&dir);
    ensure_within_vaults(&f, &state)?;
    ensure_within_vaults(&d, &state)?;
    fs_vault::move_into(&f, &d)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_path(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    ensure_within_vaults(&p, &state)?;
    fs_vault::delete_path(&p).map_err(|e| e.to_string())
}

/// Open the native print panel for the main window. The frontend first swaps the
/// rendered document into `#print-root`, which the print stylesheet shows in place
/// of the app UI; macOS's panel then offers "PDF ▸ Save as PDF".
#[tauri::command]
pub fn print_page(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    win.print().map_err(|e| e.to_string())
}

/// Set the native "View ▸ Toolbar" checkmark to match the frontend's state
/// (called on startup so the menu reflects the persisted preference).
#[tauri::command]
pub fn set_toolbar_checked(checked: bool, app: tauri::AppHandle) {
    use tauri::menu::MenuItemKind;
    let Some(menu) = app.menu() else { return };
    let Ok(items) = menu.items() else { return };
    for item in items {
        if let MenuItemKind::Submenu(sub) = item {
            if let Ok(subs) = sub.items() {
                for s in subs {
                    if let MenuItemKind::Check(c) = s {
                        if c.id().0 == "view.toolbar" {
                            let _ = c.set_checked(checked);
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn reveal_in_finder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

/// Open a reference in the user's default browser. Restricted to http(s) so a
/// bad AI reply can't turn this into "open an arbitrary file/scheme".
#[tauri::command]
pub fn open_external(url: String, app: tauri::AppHandle) -> Result<(), String> {
    // Web pages and email only — never `file:` or app schemes from a note.
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("only http(s) and mailto links can be opened".to_string());
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Guards every filesystem command: the target (or, for not-yet-created targets,
/// its nearest existing ancestor) must live inside one of the registered vault
/// roots. Prevents a compromised frontend from reading/writing arbitrary files.
fn ensure_within_vaults(target: &Path, state: &AppState) -> Result<(), String> {
    let roots: Vec<PathBuf> = state
        .vaults
        .lock()
        .unwrap()
        .iter()
        .filter_map(|v| std::fs::canonicalize(&v.path).ok())
        .collect();
    if roots.is_empty() {
        return Err("no vaults are registered".to_string());
    }

    // Canonicalize the nearest existing ancestor so create-targets resolve too.
    let mut probe = target;
    let canonical = loop {
        if let Ok(c) = std::fs::canonicalize(probe) {
            break c;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err("path could not be resolved".to_string()),
        }
    };

    if roots.iter().any(|r| canonical.starts_with(r)) {
        Ok(())
    } else {
        Err(format!("{} is outside every registered vault", target.display()))
    }
}

// ---------------------------------------------------------------------------
// Images / attachments
// ---------------------------------------------------------------------------

fn mime_for(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Reads an image referenced by a note and returns it as a `data:` URL. `src` is
/// resolved relative to the note's directory (or used as-is when absolute), and
/// must resolve inside a registered vault.
#[tauri::command(async)]
pub fn read_image_data_url(
    note_path: String,
    src: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let note = PathBuf::from(&note_path);
    let base = note.parent().unwrap_or_else(|| Path::new("."));
    let src_path = PathBuf::from(&src);
    let candidate = if src_path.is_absolute() { src_path } else { base.join(&src_path) };

    ensure_within_vaults(&candidate, &state)?;
    let bytes = std::fs::read(&candidate).map_err(|e| e.to_string())?;
    let ext = candidate.extension().and_then(|e| e.to_str()).unwrap_or("");
    Ok(format!("data:{};base64,{}", mime_for(ext), B64.encode(bytes)))
}

/// Saves a pasted/dropped image into an `assets/` folder beside the note and
/// returns the note-relative path to embed, e.g. `assets/image-….png`.
#[tauri::command(async)]
pub fn save_attachment(
    note_path: String,
    data_base64: String,
    ext: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let note = PathBuf::from(&note_path);
    let dir = note.parent().ok_or("note has no parent directory")?.to_path_buf();
    let assets = dir.join("assets");
    ensure_within_vaults(&assets, &state)?;
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;

    let bytes = B64.decode(data_base64.as_bytes()).map_err(|e| e.to_string())?;
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    let name = format!("image-{}.{ext}", chrono::Local::now().format("%Y%m%d-%H%M%S-%3f"));
    std::fs::write(assets.join(&name), &bytes).map_err(|e| e.to_string())?;

    Ok(format!("assets/{name}"))
}

// ---------------------------------------------------------------------------
// AI agent
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn is_llm_configured() -> bool {
    llm::is_available()
}

/// Reports which AI backend is active: "cli", "api", "none", or
/// "cli-logged-out" when the CLI is installed but has no usable login (and
/// there is no API key to fall back to).
#[tauri::command]
pub async fn ai_backend() -> String {
    if llm::provider() == llm::Provider::Copilot {
        return if llm::find_copilot_cli().is_some() { "copilot" } else { "copilot-missing" }.to_string();
    }
    let has_key = llm::get_api_key().is_some();
    if let Some(cli) = llm::find_claude_cli() {
        return match llm::cli_logged_in(&cli).await {
            Some(false) if has_key => "api",
            Some(false) => "cli-logged-out",
            // Logged in, or the CLI couldn't say: let the real call decide.
            _ => "cli",
        }
        .to_string();
    }
    if has_key { "api" } else { "none" }.to_string()
}

/// The Copilot CLI, or the error the panel turns into an install hint.
fn copilot_cli() -> Result<std::path::PathBuf, String> {
    llm::find_copilot_cli().ok_or_else(|| llm::COPILOT_CLI_MISSING.to_string())
}

const NO_BACKEND: &str = "No AI backend available. Install the Claude CLI or add an API key in Settings.";

/// The message for a failed CLI run. An expired or missing login is the usual
/// cause, and the CLI doesn't say so in a form worth parsing, so ask it
/// directly. `{:#}` keeps the whole context chain rather than its last link.
async fn cli_failure(cli: &std::path::Path, what: &str, err: anyhow::Error) -> String {
    eprintln!("claude CLI {what} failed: {err:#}");
    if llm::cli_logged_in(cli).await == Some(false) {
        return llm::CLI_NOT_LOGGED_IN.to_string();
    }
    format!("{err:#}")
}

#[tauri::command]
pub fn set_llm_api_key(key: String) -> Result<(), String> {
    llm::set_api_key(&key).map_err(|e| e.to_string())
}

/// Rephrases a selected span of text, preferring the local `claude` CLI and
/// falling back to the Anthropic HTTP API when a key is stored.
#[tauri::command]
pub async fn rephrase(text: String) -> Result<String, String> {
    if llm::provider() == llm::Provider::Copilot {
        let cli = copilot_cli()?;
        return llm::rephrase_via_copilot(&cli, &text).await.map_err(|e| format!("{e:#}"));
    }
    let mut cli_err = None;
    if let Some(cli) = llm::find_claude_cli() {
        match llm::rephrase_via_cli(&cli, &text).await {
            Ok(out) => return Ok(out),
            Err(err) => cli_err = Some(cli_failure(&cli, "rephrase", err).await),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::rephrase_via_api(&api_key, &text).await.map_err(|e| e.to_string());
    }
    Err(cli_err.unwrap_or_else(|| NO_BACKEND.to_string()))
}

/// The AI provider and the model chosen for each (empty means the backend's
/// own default).
#[tauri::command]
pub fn get_ai_settings(state: State<'_, AppState>) -> llm::AiSettings {
    state.ai.lock().map(|a| a.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn set_provider(provider: llm::Provider, state: State<'_, AppState>) -> Result<llm::AiSettings, String> {
    update_ai_settings(&state, |a| a.provider = provider)
}

/// Sets the model for one provider. Each provider keeps its own, so switching
/// back and forth doesn't lose the choice or send one provider another's id.
#[tauri::command]
pub fn set_model(provider: llm::Provider, model: String, state: State<'_, AppState>) -> Result<llm::AiSettings, String> {
    let model = model.trim().to_string();
    update_ai_settings(&state, |a| match provider {
        llm::Provider::Claude => a.claude_model = model,
        llm::Provider::Copilot => a.copilot_model = model,
    })
}

/// Applies a change to the AI settings in memory, in the LLM layer, and on disk.
fn update_ai_settings(
    state: &State<'_, AppState>,
    change: impl FnOnce(&mut llm::AiSettings),
) -> Result<llm::AiSettings, String> {
    let updated = {
        let mut ai = state.ai.lock().map_err(|e| e.to_string())?;
        change(&mut ai);
        ai.clone()
    };
    llm::apply_settings(&updated);
    if let Some(dir) = state.settings_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &state.settings_path,
        serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(updated)
}

/// Research the note's topic and return real, web-searched sources.
#[tauri::command]
pub async fn find_references(text: String, app: tauri::AppHandle) -> Result<llm::ReferenceResult, String> {
    if llm::provider() == llm::Provider::Copilot {
        // Citations must come from real search results. Until it's confirmed
        // the Copilot CLI can search the web, refuse rather than let it list
        // sources from memory.
        return Err("Reference search needs live web search, which isn't available through GitHub Copilot yet. \
                    Switch the provider to Claude in Settings to search for references."
            .to_string());
    }
    let mut cli_err = None;
    if let Some(cli) = llm::find_claude_cli() {
        let emit = |acc: &str, activity: &str| {
            let _ = app.emit(
                "ai:references-progress",
                serde_json::json!({ "text": acc, "activity": activity }),
            );
        };
        match llm::find_references_via_cli_streamed(&cli, &text, emit).await {
            Ok(refs) => return Ok(refs),
            Err(err) => cli_err = Some(cli_failure(&cli, "reference search", err).await),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::find_references_via_api(&api_key, &text)
            .await
            .map_err(|e| e.to_string());
    }
    Err(cli_err.unwrap_or_else(|| NO_BACKEND.to_string()))
}

/// Reviews the given note text, preferring the local `claude` CLI (no API key
/// needed) and falling back to the Anthropic HTTP API when a key is stored.
#[tauri::command]
pub async fn suggest_improvements(text: String, app: tauri::AppHandle) -> Result<Review, String> {
    if llm::provider() == llm::Provider::Copilot {
        let cli = copilot_cli()?;
        let emit = |acc: &str| {
            let _ = app.emit("ai:review-progress", acc.to_string());
        };
        return llm::suggest_via_copilot(&cli, &text, emit).await.map_err(|e| format!("{e:#}"));
    }
    let mut cli_err = None;
    if let Some(cli) = llm::find_claude_cli() {
        // Stream partial output so the panel can show the score and suggestions
        // while the full rewrite is still being generated.
        let emit = |acc: &str| {
            let _ = app.emit("ai:review-progress", acc.to_string());
        };
        match llm::suggest_via_cli_streamed(&cli, &text, emit).await {
            Ok(review) => return Ok(review),
            Err(err) => cli_err = Some(cli_failure(&cli, "review", err).await),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::suggest_via_api(&api_key, &text)
            .await
            .map_err(|e| e.to_string());
    }
    Err(cli_err.unwrap_or_else(|| NO_BACKEND.to_string()))
}

/// One turn of the editorial chat. `messages` is the whole transcript the panel
/// is holding (the backend keeps no session of its own), and the open note is
/// passed alongside it so each turn sees the document as it stands now.
#[tauri::command]
pub async fn chat(
    messages: Vec<llm::ChatMessage>,
    note_path: Option<String>,
    note_text: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if messages.is_empty() {
        return Err("Nothing to send.".to_string());
    }
    if llm::provider() == llm::Provider::Copilot {
        let cli = copilot_cli()?;
        let emit = |acc: &str| {
            let _ = app.emit("ai:chat-progress", acc.to_string());
        };
        return llm::chat_via_copilot(&cli, &messages, note_path.as_deref(), note_text.as_deref(), emit)
            .await
            .map_err(|e| format!("{e:#}"));
    }
    let mut cli_err = None;
    if let Some(cli) = llm::find_claude_cli() {
        let emit = |acc: &str| {
            let _ = app.emit("ai:chat-progress", acc.to_string());
        };
        match llm::chat_via_cli_streamed(
            &cli,
            &messages,
            note_path.as_deref(),
            note_text.as_deref(),
            emit,
        )
        .await
        {
            Ok(reply) => return Ok(reply),
            Err(err) => cli_err = Some(cli_failure(&cli, "chat", err).await),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::chat_via_api(&api_key, &messages, note_path.as_deref(), note_text.as_deref())
            .await
            .map_err(|e| e.to_string());
    }
    Err(cli_err.unwrap_or_else(|| NO_BACKEND.to_string()))
}

/// The version as shown to people, e.g. "1.1.0.beta".
#[tauri::command]
pub fn app_version() -> &'static str {
    crate::DISPLAY_VERSION
}

// --- Taming the vault ----------------------------------------------------------

/// A note's signature: size and modification time. A rating is reused until
/// this changes, so re-running only spends AI calls on notes that were edited.
#[derive(serde::Serialize)]
pub struct NoteSignature {
    pub path: String,
    pub sig: String,
}

fn signature(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!("{}:{modified}", meta.len()))
}

#[tauri::command]
pub fn note_signatures(paths: Vec<String>, state: State<'_, AppState>) -> Vec<NoteSignature> {
    paths
        .into_iter()
        .filter_map(|path| {
            let p = PathBuf::from(&path);
            ensure_within_vaults(&p, &state).ok()?;
            Some(NoteSignature { sig: signature(&p)?, path })
        })
        .collect()
}

/// A note's completeness rating, as stored by the panel.
#[derive(serde::Serialize)]
pub struct RatedNote {
    pub path: String,
    pub score: u8,
    /// "keep" | "unfinished" | "stub" (probably safe to delete).
    pub verdict: String,
    pub reason: String,
    pub sig: String,
}

/// The note's text with any YAML frontmatter removed: a note that is only
/// frontmatter is an empty template, whatever its fields say.
fn body_of(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            return rest[end + 4..].trim_start_matches('\n');
        }
    }
    text
}

fn word_count(text: &str) -> usize {
    text.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count()
}

/// Rates one batch of notes for completeness. The panel sends a handful at a
/// time; notes with no content to speak of are rated here without asking the
/// AI at all.
#[tauri::command]
pub async fn rate_notes(paths: Vec<String>, state: State<'_, AppState>) -> Result<Vec<RatedNote>, String> {
    let mut out = Vec::new();
    let mut to_ask: Vec<(usize, String, usize, String)> = Vec::new();
    let mut pending: Vec<(String, String)> = Vec::new(); // (path, sig), indexed by id - 1

    for path in paths {
        let p = PathBuf::from(&path);
        if ensure_within_vaults(&p, &state).is_err() {
            continue;
        }
        let (Ok(text), Some(sig)) = (std::fs::read_to_string(&p), signature(&p)) else {
            continue;
        };
        let body = body_of(&text);
        let words = word_count(body);
        if words <= 3 {
            let has_title = body.lines().any(|l| l.trim_start().starts_with('#'));
            out.push(RatedNote {
                path,
                score: 0,
                verdict: "stub".to_string(),
                reason: if has_title { "Empty apart from its title." } else { "Empty." }.to_string(),
                sig,
            });
            continue;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        pending.push((path, sig));
        to_ask.push((pending.len(), name, words, body.to_string()));
    }

    if !to_ask.is_empty() {
        let reply = complete(llm::RATE_SYSTEM, &llm::rate_user_prompt(&to_ask), 4096).await?;
        let ratings = llm::parse_ratings(&reply).map_err(|e| format!("{e:#}"))?;
        for r in ratings {
            let Some((path, sig)) = pending.get(r.id.wrapping_sub(1)) else { continue };
            out.push(RatedNote {
                path: path.clone(),
                score: r.score,
                verdict: r.verdict,
                reason: r.reason,
                sig: sig.clone(),
            });
        }
    }
    Ok(out)
}

/// One prompt through whichever backend is active, as plain text.
async fn complete(system: &str, user: &str, max_tokens: u32) -> Result<String, String> {
    if llm::provider() == llm::Provider::Copilot {
        let cli = copilot_cli()?;
        return llm::copilot_run(&cli, &format!("{system}\n\n---\n\n{user}"), 300, |_| {})
            .await
            .map_err(|e| format!("{e:#}"));
    }
    let mut cli_err = None;
    if let Some(cli) = llm::find_claude_cli() {
        match llm::complete_via_cli(&cli, &format!("{system}\n\n---\n\n{user}"), 300).await {
            Ok(reply) => return Ok(reply),
            Err(err) => cli_err = Some(cli_failure(&cli, "rating", err).await),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::complete_via_api(&api_key, system, user, max_tokens)
            .await
            .map_err(|e| format!("{e:#}"));
    }
    Err(cli_err.unwrap_or_else(|| NO_BACKEND.to_string()))
}

// --- Reorganize the vault ------------------------------------------------------

/// The registered vault `vault` names, canonicalized; anything else is refused.
fn vault_root(vault: &str, state: &AppState) -> Result<PathBuf, String> {
    let root = PathBuf::from(vault);
    let known = state.vaults.lock().unwrap().iter().any(|v| Path::new(&v.path) == root);
    if !known {
        return Err("that folder isn't a registered vault".to_string());
    }
    ensure_within_vaults(&root, state)?;
    Ok(root)
}

/// Asks the AI for a folder per note. Read-only: nothing moves until the
/// author approves the proposal and the panel calls `apply_reorganization`.
#[tauri::command]
pub async fn propose_reorganization(
    vault: String,
    exclude: Vec<String>,
    state: State<'_, AppState>,
) -> Result<crate::reorganize::Proposal, String> {
    let root = vault_root(&vault, &state)?;
    // Hidden notes are never sent to the AI, and so stay where they are.
    let skip: std::collections::HashSet<PathBuf> = exclude.iter().map(PathBuf::from).collect();
    let notes: Vec<PathBuf> = crate::reorganize::walk_notes(&root)
        .into_iter()
        .filter(|p| !skip.contains(p))
        .collect();
    if notes.is_empty() {
        return Err("This vault has no notes to organize.".to_string());
    }
    let prompt = crate::reorganize::user_prompt(&root, &notes);
    // A move per note; leave room for large vaults.
    let reply = complete(crate::reorganize::SYSTEM, &prompt, 32_000).await?;
    crate::reorganize::build_proposal(&root, &notes, &reply).map_err(|e| format!("{e:#}"))
}

/// Applies approved moves, rewriting links so images and note links keep
/// working. Also used, with the moves reversed, to undo.
#[tauri::command]
pub fn apply_reorganization(
    vault: String,
    moves: Vec<crate::reorganize::Move>,
    state: State<'_, AppState>,
) -> Result<crate::reorganize::ApplyReport, String> {
    let root = vault_root(&vault, &state)?;
    let pairs: Vec<(PathBuf, PathBuf)> = moves
        .into_iter()
        .map(|m| (PathBuf::from(m.from), PathBuf::from(m.to)))
        .collect();
    for (from, to) in &pairs {
        ensure_within_vaults(from, &state)?;
        ensure_within_vaults(to, &state)?;
    }
    let report = crate::reorganize::apply(&root, &pairs).map_err(|e| format!("{e:#}"))?;
    Ok(report)
}

// --- Labels ----------------------------------------------------------------------

/// The frontmatter of every note that has one, keyed by path — the frontend
/// parses the labels out of it, so there is a single parser. Same rule as the
/// editor: first line `---`, ending at the next `---` line.
#[tauri::command]
pub fn read_frontmatters(
    vault: String,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    use std::io::{BufRead, BufReader};
    let root = vault_root(&vault, &state)?;
    let mut out = std::collections::HashMap::new();
    for note in crate::reorganize::walk_notes(&root) {
        let Ok(file) = std::fs::File::open(&note) else { continue };
        let mut lines = BufReader::new(file).lines().map_while(Result::ok);
        if lines.next().is_none_or(|l| l.trim() != "---") {
            continue;
        }
        let mut body = Vec::new();
        // Frontmatter is short; don't read a whole note hunting for a fence.
        for line in lines.take(200) {
            if line.trim() == "---" {
                out.insert(note.to_string_lossy().into_owned(), body.join("\n"));
                break;
            }
            body.push(line);
        }
    }
    Ok(out)
}

fn label_colors_path(root: &Path) -> PathBuf {
    root.join(".reevik").join("labels.json")
}

/// Label colours for this vault, kept in `.reevik/labels.json` so they sync
/// with it; Obsidian ignores dot-folders.
#[tauri::command]
pub fn read_label_colors(
    vault: String,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let root = vault_root(&vault, &state)?;
    let Ok(text) = std::fs::read_to_string(label_colors_path(&root)) else {
        return Ok(Default::default());
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("colors")
        .and_then(|c| serde_json::from_value(c.clone()).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub fn write_label_colors(
    vault: String,
    colors: std::collections::HashMap<String, String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = vault_root(&vault, &state)?;
    let path = label_colors_path(&root);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "colors": colors });
    std::fs::write(&path, serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Puts missing accents back into a selection (⌘⇧D). The editor checks the
/// reply changed nothing but accents before applying it.
#[tauri::command]
pub async fn restore_diacritics(text: String) -> Result<String, String> {
    // Truncating would silently drop the end of the selection, so refuse instead.
    if text.chars().count() > 40_000 {
        return Err("The selection is too long — restore accents a section at a time.".to_string());
    }
    complete(llm::DIACRITICS_PROMPT, &format!("Text:\n{text}"), 16_000).await
}

/// Translates a selection into `language` (⌘⇧T).
#[tauri::command]
pub async fn translate(text: String, language: String) -> Result<String, String> {
    let language = language.trim();
    if language.is_empty() {
        return Err("No target language.".to_string());
    }
    if text.chars().count() > 40_000 {
        return Err("The selection is too long — translate a section at a time.".to_string());
    }
    complete(llm::TRANSLATE_PROMPT, &format!("Target language: {language}\n\nText:\n{text}"), 16_000).await
}

// --- Hidden notes -------------------------------------------------------------------

fn hidden_path(root: &Path) -> PathBuf {
    root.join(".reevik").join("hidden.json")
}

/// Notes the author has hidden, as absolute paths. Stored relative to the vault
/// in `.reevik/hidden.json`, since the vault sits at a different path on each Mac.
#[tauri::command]
pub fn read_hidden(vault: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let root = vault_root(&vault, &state)?;
    let Ok(text) = std::fs::read_to_string(hidden_path(&root)) else {
        return Ok(Vec::new());
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("hidden")
        .and_then(|h| h.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| p.as_str())
        // Relative only: an absolute or `..` entry would point outside the vault.
        .filter(|p| !p.starts_with('/') && !p.split('/').any(|seg| seg == ".."))
        .map(|p| root.join(p).to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub fn write_hidden(vault: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let root = vault_root(&vault, &state)?;
    let mut rel: Vec<String> = paths
        .iter()
        .filter_map(|p| Path::new(p).strip_prefix(&root).ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    rel.sort();
    rel.dedup();
    let path = hidden_path(&root);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "hidden": rel });
    std::fs::write(&path, serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
