use crate::fs_vault::{self, TreeNode};
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

#[tauri::command]
pub fn read_vault_tree(vault: String, state: State<'_, AppState>) -> Result<Vec<TreeNode>, String> {
    let root = PathBuf::from(&vault);
    ensure_within_vaults(&root, &state)?;
    fs_vault::read_tree(&root).map_err(|e| e.to_string())
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn write_note(path: String, contents: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    ensure_within_vaults(&p, &state)?;
    fs_vault::write_note(&p, &contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_note(dir: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    ensure_within_vaults(&d, &state)?;
    fs_vault::create_note(&d, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_folder(dir: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    ensure_within_vaults(&d, &state)?;
    fs_vault::create_folder(&d, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, name: String, state: State<'_, AppState>) -> Result<String, String> {
    let f = PathBuf::from(&from);
    ensure_within_vaults(&f, &state)?;
    fs_vault::rename_path(&f, &name)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Copy external files into the vault. Only the destination is path-guarded —
/// the sources are deliberately outside the vault, which is the whole point.
#[tauri::command]
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

#[tauri::command]
pub fn move_path(from: String, dir: String, state: State<'_, AppState>) -> Result<String, String> {
    let f = PathBuf::from(&from);
    let d = PathBuf::from(&dir);
    ensure_within_vaults(&f, &state)?;
    ensure_within_vaults(&d, &state)?;
    fs_vault::move_into(&f, &d)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
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
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".to_string());
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
#[tauri::command]
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
#[tauri::command]
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

/// Reports which AI backend is active: "cli", "api", or "none".
#[tauri::command]
pub fn ai_backend() -> String {
    if llm::find_claude_cli().is_some() {
        "cli".to_string()
    } else if llm::get_api_key().is_some() {
        "api".to_string()
    } else {
        "none".to_string()
    }
}

#[tauri::command]
pub fn set_llm_api_key(key: String) -> Result<(), String> {
    llm::set_api_key(&key).map_err(|e| e.to_string())
}

/// Rephrases a selected span of text, preferring the local `claude` CLI and
/// falling back to the Anthropic HTTP API when a key is stored.
#[tauri::command]
pub async fn rephrase(text: String) -> Result<String, String> {
    if let Some(cli) = llm::find_claude_cli() {
        match llm::rephrase_via_cli(&cli, &text).await {
            Ok(out) => return Ok(out),
            Err(err) => eprintln!("claude CLI rephrase failed: {err}"),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::rephrase_via_api(&api_key, &text).await.map_err(|e| e.to_string());
    }
    Err("No AI backend available. Install the Claude CLI or add an API key in Settings.".to_string())
}

/// The AI model chosen in Settings; empty string means the backend's default.
#[tauri::command]
pub fn get_model(state: State<'_, AppState>) -> String {
    state.model.lock().map(|m| m.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn set_model(model: String, state: State<'_, AppState>) -> Result<(), String> {
    let model = model.trim().to_string();
    if let Ok(mut m) = state.model.lock() {
        *m = model.clone();
    }
    llm::set_model_override(Some(model.clone()));
    if let Some(dir) = state.settings_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::json!({ "model": model });
    std::fs::write(
        &state.settings_path,
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Research the note's topic and return real, web-searched sources.
#[tauri::command]
pub async fn find_references(text: String, app: tauri::AppHandle) -> Result<llm::ReferenceResult, String> {
    if let Some(cli) = llm::find_claude_cli() {
        let emit = |acc: &str, activity: &str| {
            let _ = app.emit(
                "ai:references-progress",
                serde_json::json!({ "text": acc, "activity": activity }),
            );
        };
        match llm::find_references_via_cli_streamed(&cli, &text, emit).await {
            Ok(refs) => return Ok(refs),
            Err(err) => eprintln!("claude CLI reference search failed: {err}"),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::find_references_via_api(&api_key, &text)
            .await
            .map_err(|e| e.to_string());
    }
    Err("No AI backend available. Install the Claude CLI or add an API key in Settings.".to_string())
}

/// Reviews the given note text, preferring the local `claude` CLI (no API key
/// needed) and falling back to the Anthropic HTTP API when a key is stored.
#[tauri::command]
pub async fn suggest_improvements(text: String, app: tauri::AppHandle) -> Result<Review, String> {
    if let Some(cli) = llm::find_claude_cli() {
        // Stream partial output so the panel can show the score and suggestions
        // while the full rewrite is still being generated.
        let emit = |acc: &str| {
            let _ = app.emit("ai:review-progress", acc.to_string());
        };
        match llm::suggest_via_cli_streamed(&cli, &text, emit).await {
            Ok(review) => return Ok(review),
            Err(err) => eprintln!("claude CLI review failed: {err}"),
        }
    }
    if let Some(api_key) = llm::get_api_key() {
        return llm::suggest_via_api(&api_key, &text)
            .await
            .map_err(|e| e.to_string());
    }
    Err("No AI backend available. Install the Claude CLI or add an API key in Settings.".to_string())
}
