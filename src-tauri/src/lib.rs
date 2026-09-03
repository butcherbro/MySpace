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
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            commands::boards::load_board_snapshot,
            commands::boards::get_home_board,
            commands::boards::save_viewport,
            commands::boards::create_child_board,
            commands::boards::rename_board,
            commands::cards::create_note,
            commands::cards::update_note,
            commands::cards::move_card,
            commands::cards::move_cards,
            commands::trash::trash_note,
            commands::trash::trash_board,
            commands::trash::restore_trash_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
