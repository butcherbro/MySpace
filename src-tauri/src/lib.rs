pub mod commands;
pub mod db;
pub mod domain;
pub mod repositories;
pub mod services;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

type DbHandle = Mutex<Connection>;

/// Application data paths, managed so commands can reach the DB/assets/backup
/// locations for destructive operations (e.g. the pre-empty backup gate).
#[derive(Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_uri_scheme_protocol("myspace-asset", |app, request| {
            // `myspace-asset://localhost/<file-name>` serves an imported file
            // from the asset directory. The incoming path is treated strictly as
            // a single filename component: any `/`, `\`, `..` or empty segment
            // is rejected, and the canonical resolved path must stay inside the
            // asset dir (path boundary).
            let relative = request.uri().path().trim_start_matches('/').to_string();
            if !is_safe_asset_name(&relative) {
                return tauri::http::Response::builder()
                    .status(400)
                    .body(Vec::new())
                    .unwrap();
            }
            let asset_dir = app
                .app_handle()
                .path()
                .app_data_dir()
                .unwrap_or_default()
                .join("assets");
            let path = asset_dir.join(&relative);
            // Reject if canonicalization escapes the asset dir.
            let canonical_asset_dir = asset_dir.canonicalize().unwrap_or(asset_dir.clone());
            let resolved = path.canonicalize();
            let allowed = match &resolved {
                Ok(p) => p.starts_with(&canonical_asset_dir),
                // A file that doesn't exist yet simply yields 404 below.
                Err(_) => true,
            };
            if !allowed {
                return tauri::http::Response::builder()
                    .status(403)
                    .body(Vec::new())
                    .unwrap();
            }
            let mime = mime_for_asset_name(&relative);
            match std::fs::read(&path) {
                Ok(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", mime)
                    .body(bytes)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");
            let db_path = data_dir.join("workspace.sqlite3");
            let assets_dir = data_dir.join("assets");
            let backup_dir = data_dir.join("backups");

            // Take a recoverable snapshot BEFORE migrations/mutations run, so the
            // pre-upgrade state is always inspectable even if a future migration
            // misbehaves. Best-effort: it never blocks startup.
            db::backup::snapshot_on_startup(&db_path, &assets_dir, &backup_dir);

            let mut conn = db::open_and_bootstrap(&db_path)
                .expect("failed to open and bootstrap workspace database");

            // Converge any interrupted asset GC: delete orphaned files + rows.
            // Best-effort; a failure never blocks startup.
            let _ = domain::asset_service::collect_orphaned_assets(&mut conn, &assets_dir);

            app.manage(DbHandle::new(conn));
            app.manage(AppPaths {
                data_dir: data_dir.clone(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::assets::import_asset,
            commands::assets::resolve_asset_path,
            commands::assets::copy_image_cards,
            commands::assets::import_clipboard_image,
            commands::boards::load_board_snapshot,
            commands::boards::get_home_board,
            commands::boards::save_viewport,
            commands::boards::get_data_version,
            commands::boards::create_child_board,
            commands::boards::rename_board,
            commands::boards::move_board,
            commands::boards::set_board_cover,
            commands::boards::remove_board_cover,
            commands::cards::create_note,
            commands::cards::read_card,
            commands::cards::create_image_card,
            commands::cards::update_note,
            commands::cards::set_note_color,
            commands::cards::update_image_caption,
            commands::cards::move_card,
            commands::cards::move_cards,
            commands::cards::move_card_to_board,
            commands::cards::move_cards_to_board_unsorted,
            commands::cards::place_unsorted_card,
            commands::cards::convert_note_to_embed,
            commands::link_metadata::enrich_embed_metadata,
            commands::cards::update_embed_description,
            commands::trash::trash_note,
            commands::trash::trash_board,
            commands::trash::trash_selection,
            commands::trash::restore_trash_batch,
            commands::trash::list_trash,
            commands::trash::empty_trash,
            commands::clipboard::copy_text_command,
            commands::search::search_workspace,
            commands::quick_boards::list_quick_boards,
            commands::quick_boards::add_quick_board,
            commands::quick_boards::remove_quick_board,
            commands::quick_boards::reorder_quick_boards,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// A safe asset name is a single non-empty filename component: no path
/// separators, no `..`, no leading dots, no control characters.
pub fn is_safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name == name.trim()
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-')
}

/// Maps a stored asset filename extension back to a Content-Type header.
pub fn mime_for_asset_name(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        _ => "application/octet-stream",
    }
}
