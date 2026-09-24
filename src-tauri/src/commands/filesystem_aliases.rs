//! Tauri boundary for folder shortcuts and file cards. Resolved paths never
//! cross into JS.
//!
//! Every command is `async` and touches the database only through the
//! [`Workspace`] handle: reads on the pool, writes as a [`Mutation`] on the
//! writer thread. The writer thread does no file I/O: copies, previews, Quick
//! Look thumbnails, locator resolution and opening/revealing in the system file
//! manager (via `tauri-plugin-opener`) all run in `spawn_blocking`, completed before a mutation is queued (or after a read
//! returns).
use crate::{
    app::Workspace,
    domain::{
        asset_service,
        errors::WorkspaceError,
        filesystem_alias_service::{self, FolderLocator, LocatorError},
        models::{
            CardDto, CreateFileCardInput, CreateFilesystemAliasInput, FileCardDto,
            FilesystemAliasDto, FolderPreviewDto, FolderPreviewStatus,
        },
        mutation::{CommitFileCard, Mutation},
    },
    repositories::workspace_repository,
    telemetry::instrument_async,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

#[cfg(target_os = "macos")]
type PlatformLocator = filesystem_alias_service::MacosBookmarkLocator;
#[cfg(not(target_os = "macos"))]
type PlatformLocator = filesystem_alias_service::PathLocator;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderAliasCommandInput {
    pub id: String,
    pub board_id: String,
    pub frame: crate::domain::models::Frame,
    pub z_index: i64,
    pub source_path: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileCardCommandInput {
    pub id: String,
    pub board_id: String,
    pub frame: crate::domain::models::Frame,
    pub z_index: i64,
    pub source_path: String,
    pub mime_type: String,
    pub file_name: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedDrop {
    pub path: String,
    pub kind: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
}

#[tauri::command]
pub async fn create_folder_alias(
    ws: State<'_, Workspace>,
    input: CreateFolderAliasCommandInput,
) -> Result<FilesystemAliasDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_folder_alias", async move {
        let (path, locator_blob, display_name) = create_folder_locator(input.source_path).await?;

        let model = CreateFilesystemAliasInput {
            id: input.id,
            board_id: input.board_id,
            frame: input.frame,
            z_index: input.z_index,
            target_kind: "folder".into(),
            locator_blob,
            path_hint: path.to_string_lossy().into_owned(),
            display_name,
        };
        let card = ws
            .apply(Mutation::CreateFilesystemAlias(model))
            .await?
            .into_card()?;
        into_alias(card)
    })
    .await
}

/// Validates `source_path` as an existing directory and creates this
/// platform's locator for it, off the async runtime. Returns the path, the
/// locator bytes and the folder's display name.
async fn create_folder_locator(
    source_path: String,
) -> Result<(PathBuf, Vec<u8>, String), WorkspaceError> {
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&source_path);
        if !path.is_dir() {
            return Err(WorkspaceError::ConstraintViolation(
                "folder alias target must be an existing directory".into(),
            ));
        }
        let display_name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("Folder")
            .to_string();
        let locator = PlatformLocator::default();
        let locator_blob = locator.create(&path).map_err(|error| {
            WorkspaceError::ConstraintViolation(format!("could not create folder locator: {error}"))
        })?;
        Ok((path, locator_blob, display_name))
    })
    .await
    .map_err(|e| WorkspaceError::Database(format!("locator task failed: {e}")))?
}

fn into_alias(card: CardDto) -> Result<FilesystemAliasDto, WorkspaceError> {
    match card {
        CardDto::FilesystemAlias(alias) => Ok(alias),
        _ => Err(WorkspaceError::Database(
            "card is not a folder shortcut".into(),
        )),
    }
}

/// "Point to a folder on this computer…" (ADR-0012 §5). Creates THIS device's
/// locator for `path` and stores it for the shortcut; the origin device's
/// locator, the path hint and the display name are left as they are. A
/// device-local write (`Mutation::is_local_only`), so it bumps no revision
/// and will never be journaled. Returns the updated projection (`local: true`).
#[tauri::command]
pub async fn set_filesystem_alias_local_target(
    ws: State<'_, Workspace>,
    card_id: String,
    path: String,
) -> Result<FilesystemAliasDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("set_filesystem_alias_local_target", async move {
        let (_, locator_blob, _) = create_folder_locator(path).await?;
        let card = ws
            .apply(Mutation::SetFilesystemAliasLocalTarget {
                card_id,
                locator_blob,
            })
            .await?
            .into_card()?;
        into_alias(card)
    })
    .await
}

/// Preview for a shortcut this device holds no locator for: shown as
/// belonging to another device, without touching the filesystem.
fn foreign_device_preview(path_hint: String, display_name: String) -> FolderPreviewDto {
    FolderPreviewDto {
        status: FolderPreviewStatus::ForeignDevice,
        entries: vec![],
        has_more: false,
        display_name,
        path_hint,
    }
}
#[tauri::command]
pub async fn list_folder_preview(
    ws: State<'_, Workspace>,
    card_id: String,
    limit: usize,
) -> Result<FolderPreviewDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("list_folder_preview", async move {
        // Load the locator on the read pool, then run filesystem I/O off the
        // async runtime: it must never block snapshot reads on the shared
        // SQLite connection.
        let lookup_id = card_id.clone();
        let (blob, hint, name) = ws
            .read(move |conn| workspace_repository::load_filesystem_alias_locator(conn, &lookup_id))
            .await?;
        let Some(blob) = blob else {
            return Ok(foreign_device_preview(hint, name));
        };

        let name_fallback = name.clone();
        let (preview, refreshed, path) = tokio::task::spawn_blocking(move || {
            let locator = PlatformLocator::default();
            filesystem_alias_service::list_preview_with_refresh(
                &locator, &blob, &hint, &name, limit,
            )
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("preview task failed: {e}")))?;

        if let (Some(blob), Some(path)) = (refreshed, path) {
            let path_hint = path.to_string_lossy().into_owned();
            let display_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&name_fallback)
                .to_owned();
            ws.apply(Mutation::RefreshFilesystemAliasLocator {
                card_id,
                locator_blob: blob,
                path_hint,
                display_name,
            })
            .await?
            .into_unit()?;
        }
        Ok(preview)
    })
    .await
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathClassification {
    pub kind: String,
    pub expanded_path: String,
}

/// Classifies one pasted clipboard path for the Cmd+V-on-empty-canvas flow
/// (todo.md №23). `~` expansion happens here (HOME is a backend concern, not
/// something the WebView should resolve), so the returned `expandedPath` is
/// what the frontend must use for the follow-up create call.
#[tauri::command]
pub fn classify_path(path: String) -> PathClassification {
    crate::telemetry::instrument_infallible("classify_path", move || {
        let home = home_dir();
        let (kind, expanded) = filesystem_alias_service::classify_path(&path, home.as_deref());
        PathClassification {
            kind,
            expanded_path: expanded.to_string_lossy().into_owned(),
        }
    })
}

/// `HOME` everywhere; on Windows (where `HOME` is usually unset) fall back to
/// `USERPROFILE`, so a pasted `~\\Docs` still expands.
fn home_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|v| !v.is_empty());
    #[cfg(windows)]
    let home = home.or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()));
    home.map(PathBuf::from)
}

/// Opens `path` with the system default handler (Finder on macOS — the opener
/// plugin shells out to `open` there — Explorer or the associated app on
/// Windows, `xdg-open` on Linux).
fn open_with_system(path: &Path) -> Result<(), WorkspaceError> {
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|e| WorkspaceError::Database(format!("could not open {}: {e}", path.display())))
}

/// Shows `path` selected in the system file manager (Finder / Explorer / the
/// FileManager1 D-Bus service on Linux).
fn reveal_with_system(path: &Path) -> Result<(), WorkspaceError> {
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|e| WorkspaceError::Database(format!("could not reveal {}: {e}", path.display())))
}

#[tauri::command]
pub fn classify_drop_paths(paths: Vec<String>) -> Vec<ClassifiedDrop> {
    crate::telemetry::instrument_infallible("classify_drop_paths", move || {
        paths
            .into_iter()
            .map(|path| {
                let (kind, file_name, mime_type) =
                    filesystem_alias_service::classify_drop(Path::new(&path));
                ClassifiedDrop {
                    path,
                    kind,
                    file_name,
                    mime_type,
                }
            })
            .collect()
    })
}
#[tauri::command]
pub async fn open_folder_in_finder(
    ws: State<'_, Workspace>,
    card_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("open_folder_in_finder", async move {
        let lookup_id = card_id.clone();
        let blob = ws
            .read(move |conn| {
                let (blob, _, _) =
                    workspace_repository::load_filesystem_alias_locator(conn, &lookup_id)?;
                Ok(blob)
            })
            .await?;
        let Some(blob) = blob else {
            return Err(WorkspaceError::ConstraintViolation(
                "this folder shortcut was created on another device; point it to a folder on this computer first".into(),
            ));
        };

        tokio::task::spawn_blocking(move || {
            let locator = PlatformLocator::default();
            let resolved = locator.resolve(&blob).map_err(|error| match error {
                LocatorError::Missing => WorkspaceError::NotFound(card_id.clone()),
                LocatorError::PermissionLost => WorkspaceError::ConstraintViolation(
                    "folder shortcut permission was lost; drop the folder again".into(),
                ),
                LocatorError::Io(message) => {
                    WorkspaceError::Database(format!("could not open folder shortcut: {message}"))
                }
                foreign @ LocatorError::ForeignFormat(_) => {
                    WorkspaceError::ConstraintViolation(foreign.to_string())
                }
            })?;
            open_with_system(&resolved.path)
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("open task failed: {e}")))?
    })
    .await
}

/// Copies a dropped text-like file into the managed asset store, reads a bounded
/// preview, and creates the File Card. All slow work (copy, preview, Quick Look)
/// happens off the writer thread; the writer runs a single short transaction
/// that writes the asset rows and the card rows together.
#[tauri::command]
pub async fn create_file_card(
    ws: State<'_, Workspace>,
    input: CreateFileCardCommandInput,
) -> Result<FileCardDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_file_card", async move {
        let asset_dir = ws.paths().assets_dir();

        let id = input.id.clone();
        let file_name = input.file_name.clone();
        let mime_type = input.mime_type.clone();
        let source_path = input.source_path.clone();

        // Stage 1: idempotent replay lookup on the read pool, no I/O.
        let replay_id = id.clone();
        let replay = ws
            .read(move |conn| asset_service::load_asset(conn, &replay_id))
            .await?;

        // Stage 2: copy the bytes, read the preview and (maybe) the Quick Look
        // thumbnail off the async runtime. A replay (the asset row already
        // exists) stages nothing: that file is already managed and must never
        // be treated as ours to delete.
        let dir = asset_dir.clone();
        let id_for_stage = id.clone();
        let file_name_for_stage = file_name.clone();
        let mime_type_for_stage = mime_type.clone();
        let source_path_for_stage = source_path.clone();
        let replay_for_stage = replay.clone();
        let (asset, new_asset, preview, thumbnail) = tokio::task::spawn_blocking(move || {
            let new_asset = match &replay_for_stage {
                Some(_) => None,
                None => Some(asset_service::stage_file_card_asset(
                    &dir,
                    &id_for_stage,
                    &file_name_for_stage,
                    &mime_type_for_stage,
                    &source_path_for_stage,
                )?),
            };
            let asset = match (&replay_for_stage, &new_asset) {
                (Some(existing), _) => existing.clone(),
                (None, Some(staged)) => staged.asset.clone(),
                (None, None) => unreachable!("staging produces an asset when there is no replay"),
            };

            let preview = if file_name_for_stage.to_ascii_lowercase().ends_with(".zip") {
                "(zip archive)".to_string()
            } else if matches!(
                file_name_for_stage
                    .rsplit('.')
                    .next()
                    .map(|e| e.to_ascii_lowercase())
                    .as_deref(),
                Some(
                    "doc"
                        | "docx"
                        | "xls"
                        | "xlsx"
                        | "ppt"
                        | "pptx"
                        | "pdf"
                        | "pages"
                        | "numbers"
                        | "key"
                        | "odt"
                        | "ods"
                        | "odp"
                )
            ) {
                "(office document)".to_string()
            } else {
                asset_service::read_text_preview(&dir, &asset, 8 * 1024)
            };

            // Quick Look thumbnail, also off the async runtime (it is a
            // subprocess).
            let thumbnail = if new_asset.is_some()
                && matches!(
                    file_name_for_stage
                        .rsplit('.')
                        .next()
                        .map(|e| e.to_ascii_lowercase())
                        .as_deref(),
                    Some(
                        "pdf"
                            | "doc"
                            | "docx"
                            | "xls"
                            | "xlsx"
                            | "ppt"
                            | "pptx"
                            | "pages"
                            | "numbers"
                            | "key"
                    )
                ) {
                asset_service::stage_thumbnail(&dir, &source_path_for_stage)?
            } else {
                None
            };

            Ok::<_, WorkspaceError>((asset, new_asset, preview, thumbnail))
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("stage task failed: {e}")))??;

        // Dedup by hash (P1.2): when the freshly staged bytes already exist as
        // an asset, drop the new copy and point the card at the existing row.
        let (asset, new_asset) = match new_asset {
            Some(staged) => {
                let sha256 = staged.asset.sha256.clone();
                let existing = ws
                    .read(move |conn| match sha256 {
                        Some(sha256) => asset_service::find_asset_by_sha256(conn, &sha256),
                        None => Ok(None),
                    })
                    .await;
                match existing {
                    Ok(Some(existing)) => {
                        asset_service::discard_staged(&staged);
                        (existing, None)
                    }
                    Ok(None) => (asset, Some(staged)),
                    Err(error) => {
                        asset_service::discard_staged(&staged);
                        if let Some(thumbnail) = &thumbnail {
                            asset_service::discard_staged(thumbnail);
                        }
                        return Err(error);
                    }
                }
            }
            None => (asset, None),
        };

        // Stage 3: one short transaction for the asset rows and the card rows.
        // A failure rolls the rows back; `commit_file_card` removes only the
        // files staged above (never a pre-existing asset file, never the
        // source).
        let model = CreateFileCardInput {
            id: id.clone(),
            board_id: input.board_id.clone(),
            frame: input.frame,
            z_index: input.z_index,
            source_path: source_path.clone(),
            mime_type: mime_type.clone(),
            file_name: file_name.clone(),
        };
        let card = ws
            .apply(Mutation::CommitFileCard(Box::new(CommitFileCard {
                input: model,
                asset,
                new_asset,
                preview_text: preview,
                thumbnail,
            })))
            .await?
            .into_card()?;
        match card {
            CardDto::File(file) => Ok(file),
            _ => Err(WorkspaceError::Database(
                "created card is not a File Card".into(),
            )),
        }
    })
    .await
}

/// Opens a File Card's stored copy in the default external app.
#[tauri::command]
pub async fn open_file_card(
    ws: State<'_, Workspace>,
    card_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("open_file_card", async move {
        let lookup_id = card_id.clone();
        let asset_file = ws
            .read(move |conn| workspace_repository::load_file_card_asset(conn, &lookup_id))
            .await?;
        let asset_dir = ws.paths().assets_dir();

        tokio::task::spawn_blocking(move || {
            let asset_path = asset_service::asset_abs_path(&asset_dir, &asset_file);
            open_with_system(&asset_path)
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("open task failed: {e}")))?
    })
    .await
}

/// Reveals the File Card's original source file in the system file manager
/// (Finder / Explorer), selected. Falls back
/// to the managed copy when the source path is unknown.
#[tauri::command]
pub async fn reveal_file_card(
    ws: State<'_, Workspace>,
    card_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("reveal_file_card", async move {
        let lookup_id = card_id.clone();
        let (source, asset_file) = ws
            .read(move |conn| {
                let source = workspace_repository::load_file_card_source_path(conn, &lookup_id)?;
                let asset_file = workspace_repository::load_file_card_asset(conn, &lookup_id)?;
                Ok((source, asset_file))
            })
            .await?;
        let asset_dir = ws.paths().assets_dir();

        tokio::task::spawn_blocking(move || {
            let target = if !source.is_empty() && Path::new(&source).exists() {
                PathBuf::from(source)
            } else {
                asset_service::asset_abs_path(&asset_dir, &asset_file)
            };
            reveal_with_system(&target)
        })
        .await
        .map_err(|e| WorkspaceError::Database(format!("reveal task failed: {e}")))?
    })
    .await
}
