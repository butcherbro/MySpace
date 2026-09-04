pub mod commands;
pub mod db;
pub mod domain;
pub mod repositories;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

type DbHandle = Mutex<Connection>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_uri_scheme_protocol("myspace-asset", |app, request| {
            // `myspace-asset://localhost/<file-path>` serves an imported file
            // from the asset directory, keyed by the relative path stored in
            // SQLite. The path is constrained to the asset dir, so the frontend
            // cannot reach arbitrary files through this scheme.
            let relative = request.uri().path().trim_start_matches('/').to_string();
            let asset_dir = app
                .app_handle()
                .path()
                .app_data_dir()
                .unwrap_or_default()
                .join("assets");
            let path = asset_dir.join(relative);
            match std::fs::read(&path) {
                Ok(bytes) => tauri::http::Response::builder().body(bytes).unwrap(),
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

            let conn = db::open_and_bootstrap(&db_path)
                .expect("failed to open and bootstrap workspace database");

            app.manage(DbHandle::new(conn));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::assets::import_asset,
            commands::boards::load_board_snapshot,
            commands::boards::get_home_board,
            commands::boards::save_viewport,
            commands::boards::create_child_board,
            commands::boards::rename_board,
            commands::cards::create_note,
            commands::cards::create_image_card,
            commands::cards::update_note,
            commands::cards::update_image_caption,
            commands::cards::move_card,
            commands::cards::move_cards,
            commands::trash::trash_note,
            commands::trash::trash_board,
            commands::trash::restore_trash_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
