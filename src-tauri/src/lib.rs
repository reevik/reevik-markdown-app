mod commands;
mod fs_vault;
mod llm;

use std::sync::Mutex;
use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{Emitter, Manager};

/// A folder the user has registered as a vault (an Obsidian-style document root).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VaultRef {
    pub path: String,
    pub name: String,
}

pub struct AppState {
    pub vaults: Mutex<Vec<VaultRef>>,
    pub vaults_path: std::path::PathBuf,
    /// Chosen AI model id; empty means "let the backend decide".
    pub model: Mutex<String>,
    pub settings_path: std::path::PathBuf,
}

fn load_model(path: &std::path::Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_default()
}

fn load_vaults(path: &std::path::Path) -> Vec<VaultRef> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Native menu bar: the app menu ("Reevik") holds Preferences…, plus a
        // "Vault" menu whose "Open Vault…" item returns to the vault chooser.
        .menu(|handle| {
            let preferences =
                MenuItem::with_id(handle, "vault.settings", "Preferences…", true, Some("CmdOrCtrl+,"))?;
            // Explicit text so the label reads "About Reevik" even in dev (the auto
            // label otherwise uses the executable/crate name). The panel shows the
            // app icon plus an author credit.
            let about_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")).ok();
            let about = PredefinedMenuItem::about(
                handle,
                Some("About Reevik"),
                Some(
                    AboutMetadataBuilder::new()
                        .name(Some("Reevik"))
                        // Manifests must stay valid semver ("1.0.0"); the pre-release
                        // suffix is display-only.
                        .version(Some(concat!(env!("CARGO_PKG_VERSION"), ".beta")))
                        .comments(Some("A glossy Markdown editor.\nDeveloped by Erhan Bağdemir."))
                        .authors(Some(vec!["Erhan Bağdemir".to_string()]))
                        .copyright(Some("© 2026 Erhan Bağdemir"))
                        .icon(about_icon)
                        .build(),
                ),
            )?;
            let app_menu = SubmenuBuilder::new(handle, "Reevik")
                .item(&about)
                .separator()
                .item(&preferences)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            // Menu item ids are the command-palette ids, so the frontend can run a
            // menu pick and a palette pick through exactly the same action.
            let new_note =
                MenuItem::with_id(handle, "file.new-note", "New Note", true, Some("CmdOrCtrl+N"))?;
            let new_folder = MenuItem::with_id(
                handle,
                "file.new-folder",
                "New Folder",
                true,
                Some("CmdOrCtrl+Shift+N"),
            )?;
            // ⌘W closes the tab and ⌘⇧W the window, as in Safari — so the Window menu
            // below uses a custom item instead of the predefined ⌘W "Close Window".
            let close_tab =
                MenuItem::with_id(handle, "file.close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
            let export_pdf = MenuItem::with_id(
                handle,
                "file.export-pdf",
                "Export as PDF…",
                true,
                Some("CmdOrCtrl+P"),
            )?;
            let add_to_vault = MenuItem::with_id(
                handle,
                "file.add-to-vault",
                "Add to Vault…",
                true,
                Some("CmdOrCtrl+Shift+I"),
            )?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&new_note)
                .item(&new_folder)
                .separator()
                .item(&add_to_vault)
                .separator()
                .item(&close_tab)
                .separator()
                .item(&export_pdf)
                .build()?;

            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let palette = MenuItem::with_id(
                handle,
                "view.palette",
                "Command Palette…",
                true,
                Some("CmdOrCtrl+K"),
            )?;
            let view_source = MenuItem::with_id(
                handle,
                "view.mode",
                "Toggle Markdown Source",
                true,
                Some("CmdOrCtrl+/"),
            )?;
            let view_sidebar = MenuItem::with_id(
                handle,
                "view.left",
                "Toggle Sidebar",
                true,
                Some("CmdOrCtrl+Alt+1"),
            )?;
            let view_ai = MenuItem::with_id(
                handle,
                "view.right",
                "Toggle AI Panel",
                true,
                Some("CmdOrCtrl+Alt+2"),
            )?;
            let toolbar_item = CheckMenuItem::with_id(
                handle,
                "view.toolbar",
                "Toolbar",
                true,
                true,
                Some("CmdOrCtrl+Alt+3"),
            )?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&palette)
                .separator()
                .item(&view_source)
                .separator()
                .item(&view_sidebar)
                .item(&view_ai)
                .item(&toolbar_item)
                .build()?;

            let ai_suggest = MenuItem::with_id(
                handle,
                "ai.suggest",
                "Suggest Improvements",
                true,
                Some("CmdOrCtrl+Shift+A"),
            )?;
            let ai_rephrase = MenuItem::with_id(
                handle,
                "ai.rephrase",
                "Rephrase Selection",
                true,
                Some("CmdOrCtrl+Shift+R"),
            )?;
            let ai_references = MenuItem::with_id(
                handle,
                "ai.references",
                "Find References",
                true,
                Some("CmdOrCtrl+Shift+F"),
            )?;
            let ai_menu = SubmenuBuilder::new(handle, "AI")
                .item(&ai_suggest)
                .item(&ai_rephrase)
                .separator()
                .item(&ai_references)
                .build()?;

            let open_vault = MenuItem::with_id(
                handle,
                "vault.open",
                "Open Vault…",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?;
            let vault_menu = SubmenuBuilder::new(handle, "Vault").item(&open_vault).build()?;

            let close_window = MenuItem::with_id(
                handle,
                "window.close",
                "Close Window",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .separator()
                .item(&close_window)
                .build()?;

            Menu::with_items(
                handle,
                &[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &ai_menu,
                    &vault_menu,
                    &window_menu,
                ],
            )
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if id == "window.close" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
                return;
            }
            // Everything else is a palette command id the frontend knows how to run.
            let _ = app.emit("menu:command", id);
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let window = app.get_webview_window("main").expect("main window exists");
                // Force light appearance so the vibrancy material renders its light
                // variant regardless of the user's system Light/Dark setting.
                let _ = window.set_theme(Some(tauri::Theme::Light));
                apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::Sidebar,
                    Some(NSVisualEffectState::Active),
                    None,
                )
                .expect("failed to apply macOS window vibrancy");
            }

            let config_dir = app
                .path()
                .app_config_dir()
                .expect("failed to resolve app config dir");
            let vaults_path = config_dir.join("vaults.json");
            let vaults = load_vaults(&vaults_path);
            let settings_path = config_dir.join("settings.json");
            let model = load_model(&settings_path);
            // Apply the saved model before any AI call can be made.
            llm::set_model_override(Some(model.clone()));

            app.manage(AppState {
                vaults: Mutex::new(vaults),
                vaults_path,
                model: Mutex::new(model),
                settings_path,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_vaults,
            commands::add_vault,
            commands::create_vault,
            commands::remove_vault,
            commands::read_vault_tree,
            commands::read_note,
            commands::file_stat,
            commands::write_note,
            commands::create_note,
            commands::create_folder,
            commands::rename_path,
            commands::move_path,
            commands::import_files,
            commands::delete_path,
            commands::set_toolbar_checked,
            commands::print_page,
            commands::reveal_in_finder,
            commands::open_external,
            commands::read_image_data_url,
            commands::save_attachment,
            commands::is_llm_configured,
            commands::ai_backend,
            commands::set_llm_api_key,
            commands::get_model,
            commands::set_model,
            commands::suggest_improvements,
            commands::find_references,
            commands::rephrase,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
