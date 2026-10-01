pub mod app;
pub mod commands;
pub mod db;
pub mod domain;
pub mod repositories;
pub mod services;
pub mod sync;
pub mod telemetry;

use std::time::Duration;

use tauri::Manager;

/// How long after setup the startup maintenance (backup snapshot, favicon
/// collapse, asset GC) waits before it is queued, so the first board load and
/// the user's first edits are never behind it.
const STARTUP_MAINTENANCE_DELAY: Duration = Duration::from_secs(2);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // In-app updates: the frontend (`src/updates/`) calls `check()` /
        // `downloadAndInstall()` and then `relaunch()`. Config (endpoint,
        // pubkey, Windows install mode) lives in `plugins.updater` of
        // tauri.conf.json. Only registered here, so `cargo test` never loads it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Decorations are deliberately NOT persisted: Windows/Linux run
        // undecorated (tauri.windows.conf.json / tauri.linux.conf.json) with
        // our own window controls, and a state file saved by an older build
        // (decorated: true) must not bring the native title bar back.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
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
            // .md/.markdown — рендерим в HTML на лету (как уже отдаём .html
            // файлы "как есть"), карточка показывает тот же sandboxed iframe.
            let ext = relative
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "md" || ext == "markdown" {
                return match domain::markdown_preview::render_markdown_file(
                    &path,
                    domain::markdown_preview::MARKDOWN_RENDER_LIMIT,
                ) {
                    Some(html) => tauri::http::Response::builder()
                        .header("Content-Type", "text/html")
                        .body(html.into_bytes())
                        .unwrap(),
                    None => tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap(),
                };
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

            // Installed before any other startup work so every step is
            // observable. Never panics; a failed install just means no log
            // output, and app startup proceeds.
            let log_guard = telemetry::init(&data_dir);
            app.manage(telemetry::LogGuard(log_guard));

            // A restore requested from the backup dialog (`request_restore`)
            // runs here, before anything opens the database. A failure is
            // logged and startup continues with the current database.
            match db::backup::apply_pending_restore(&data_dir) {
                Ok(Some(preserved)) => tracing::info!(
                    preserved = %preserved.display(),
                    "backup: restored from snapshot; prior state preserved"
                ),
                Ok(None) => {}
                Err(error) => tracing::error!(%error, "backup: pending restore failed"),
            }

            let paths = app::WorkspacePaths::new(data_dir);
            let db_path = paths.db_path();
            let assets_dir = paths.assets_dir();
            let backup_dir = paths.backups_dir();

            // The pre-upgrade snapshot only matters when this build is about to
            // migrate the schema: then it runs synchronously, before
            // migrations, so the pre-upgrade state is always recoverable. On
            // an ordinary start it is deferred to a background thread so the
            // window is not held back by copying the database and assets.
            let upgrade_pending = db_path.exists()
                && db::migrations::schema_status_at(&db_path)
                    .map(|status| matches!(status, db::migrations::SchemaStatus::Pending(_)))
                    .unwrap_or(false);
            if upgrade_pending {
                db::backup::snapshot_on_startup(&db_path, &assets_dir, &backup_dir);
            }

            // The backup commands read the paths, not the `Workspace`, so they
            // also work in recovery mode.
            app.manage(paths.clone());

            // A database that cannot be opened no longer panics: the app
            // starts in recovery mode (P1.7) with no `Workspace` managed, and
            // the frontend, seeing `get_startup_failure`, shows only the
            // restore-from-backup dialog. No maintenance (and no snapshot of
            // the broken database, which would rotate out good backups) runs.
            let workspace = match app::open_workspace(paths) {
                Ok(workspace) => workspace,
                Err(failure) => {
                    app.manage(app::StartupState(Some(failure)));
                    app.manage(commands::sync::LanState {
                        lan: None,
                        error: Some("the workspace is not open".into()),
                    });
                    return Ok(());
                }
            };
            app.manage(app::StartupState(None));
            app.manage(workspace.clone());

            // LAN sync (ADR-0011 S3): server on a random port, mDNS, pull
            // loop. A failure never blocks the app: it runs without sync and
            // the Devices dialog shows why.
            let events = std::sync::Arc::new(commands::sync::TauriSyncEvents(
                app.handle().clone(),
            ));
            let lan_workspace = workspace.clone();
            let lan = tauri::async_runtime::block_on(async move {
                sync::lan::LanSync::start(lan_workspace, sync::lan::LanConfig::default(), events)
                    .await
            });
            app.manage(match lan {
                Ok(lan) => commands::sync::LanState {
                    lan: Some(lan),
                    error: None,
                },
                Err(error) => {
                    tracing::error!(%error, error_code = "sync_start_failed", "sync: LAN service did not start");
                    commands::sync::LanState {
                        lan: None,
                        error: Some(error.to_string()),
                    }
                }
            });

            // Startup maintenance runs after the window is up, on the writer
            // thread (so it can never race a user write) and the backup
            // thread. Failures are logged by the writer with their error code.
            std::thread::Builder::new()
                .name("myspace-startup".into())
                .spawn(move || {
                    std::thread::sleep(STARTUP_MAINTENANCE_DELAY);
                    if !upgrade_pending {
                        db::backup::snapshot_on_startup(&db_path, &assets_dir, &backup_dir);
                    }
                    // Collapse duplicate favicons (10 YouTube links -> 1 asset)
                    // first, so the GC can then remove the orphaned copies.
                    workspace.apply_detached(domain::mutation::Mutation::CollapseFaviconDuplicates);
                    workspace.apply_detached(domain::mutation::Mutation::CollectOrphanedAssets);
                    // Fill `assets.sha256` for rows imported before migration
                    // 0020 (no-op once every readable file is hashed).
                    workspace.apply_detached(domain::mutation::Mutation::HashExistingAssets);
                    // Journal compaction (ADR-0011 amendment, R4): first the
                    // VACUUM a previous compaction asked for, then the chunks
                    // new rows need. Failures are logged by the writer.
                    workspace.apply_detached(domain::mutation::Mutation::VacuumIfDue);
                    let _ = sync::compact::run_blocking(&workspace);
                })
                .expect("failed to spawn startup maintenance thread");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::assets::import_asset,
            commands::assets::resolve_asset_path,
            commands::assets::copy_image_cards,
            commands::assets::import_clipboard_image,
            commands::startup::get_startup_failure,
            commands::backup::list_backups,
            commands::backup::request_restore,
            commands::error_reports::record_error_report,
            commands::boards::load_board_snapshot,
            commands::boards::get_home_board,
            commands::boards::save_viewport,
            commands::boards::get_board_change_seq,
            commands::boards::create_child_board,
            commands::boards::rename_board,
            commands::boards::move_board,
            commands::boards::set_board_cover,
            commands::boards::remove_board_cover,
            commands::boards::duplicate_board,
            commands::cards::create_note,
            commands::cards::read_card,
            commands::cards::create_image_card,
            commands::cards::create_board_shortcut,
            commands::cards::update_note,
            commands::cards::set_note_color,
            commands::cards::update_image_caption,
            commands::cards::move_card,
            commands::cards::move_cards,
            commands::cards::move_card_to_board,
            commands::cards::move_cards_to_board_unsorted,
            commands::cards::move_selection_to_board,
            commands::cards::undo_move_selection,
            commands::cards::place_unsorted_card,
            commands::cards::convert_note_to_embed,
            commands::link_metadata::enrich_embed_metadata,
            commands::cards::update_embed_description,
            commands::filesystem_aliases::create_folder_alias,
            commands::filesystem_aliases::list_folder_preview,
            commands::filesystem_aliases::classify_path,
            commands::filesystem_aliases::classify_drop_paths,
            commands::filesystem_aliases::open_folder_in_finder,
            commands::filesystem_aliases::set_filesystem_alias_local_target,
            commands::device::get_device_identity,
            commands::device::rename_device,
            commands::filesystem_aliases::create_file_card,
            commands::filesystem_aliases::open_file_card,
            commands::filesystem_aliases::reveal_file_card,
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
            commands::sync::sync_export_changes,
            commands::sync::sync_apply_changes,
            commands::sync::sync_status,
            commands::sync::get_sync_state,
            commands::sync::sync_list_peers,
            commands::sync::sync_list_discovered,
            commands::sync::sync_begin_pairing,
            commands::sync::sync_cancel_pairing,
            commands::sync::sync_pair_with,
            commands::sync::sync_unpair,
            commands::sync::sync_now,
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
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}
