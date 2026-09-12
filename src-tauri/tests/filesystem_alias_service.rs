use myspace_lib::domain::filesystem_alias_service::{
    list_preview, list_preview_with_refresh, FolderLocator, LocatorError, ResolvedFolder,
};
use myspace_lib::domain::models::FolderPreviewStatus;
use std::fs;

struct Fake;
impl FolderLocator for Fake {
    fn create(&self, path: &std::path::Path) -> Result<Vec<u8>, LocatorError> {
        Ok(path.as_os_str().as_encoded_bytes().to_vec())
    }
    fn resolve(&self, bytes: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        Ok(ResolvedFolder {
            path: std::path::PathBuf::from(String::from_utf8_lossy(bytes).to_string()),
            refreshed_locator: None,
            _scope: None,
        })
    }
}

#[test]
fn preview_sorts_folders_first_and_bounds_the_scan() {
    let root =
        std::env::temp_dir().join(format!("myspace-folder-preview-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(root.join("Zoo")).unwrap();
    fs::write(root.join("apple.txt"), b"x").unwrap();
    let locator = Fake;
    let preview = list_preview(
        &locator,
        root.to_string_lossy().as_bytes(),
        "hint",
        "Root",
        1,
    );
    assert_eq!(preview.status, FolderPreviewStatus::Ready);
    assert_eq!(preview.entries[0].name, "Zoo");
    assert!(preview.has_more);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn preview_missing_bookmark_does_not_use_path_hint_as_fallback() {
    let preview = list_preview(
        &Fake,
        b"/definitely/missing",
        "/tmp/display-only",
        "Missing",
        50,
    );
    assert_eq!(preview.status, FolderPreviewStatus::Missing);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_locator_persists_bookmark_data_not_source_path_bytes() {
    use myspace_lib::domain::filesystem_alias_service::MacosBookmarkLocator;
    let root = std::env::temp_dir().join(format!("myspace-bookmark-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&root).unwrap();
    let blob = MacosBookmarkLocator.create(&root).unwrap();
    assert_ne!(blob, root.as_os_str().as_encoded_bytes());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn macos_locator_round_trips_regular_bookmark() {
    use myspace_lib::domain::filesystem_alias_service::{FolderLocator, MacosBookmarkLocator};
    let root = std::env::temp_dir().join(format!("myspace-bookmark-rt-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&root).unwrap();
    let blob = MacosBookmarkLocator.create(&root).unwrap();
    let resolved = MacosBookmarkLocator.resolve(&blob).unwrap();
    // The temp dir may live behind /var -> /private/var, so compare canonical paths.
    let expected = root.canonicalize().unwrap();
    assert_eq!(resolved.path.canonicalize().unwrap(), expected);
    fs::remove_dir_all(root).unwrap();
}

struct StaleFake {
    path: std::path::PathBuf,
}
impl FolderLocator for StaleFake {
    fn create(&self, path: &std::path::Path) -> Result<Vec<u8>, LocatorError> {
        Ok(path.as_os_str().as_encoded_bytes().to_vec())
    }
    fn resolve(&self, _bytes: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        Ok(ResolvedFolder {
            path: self.path.clone(),
            refreshed_locator: Some(b"new-locator".to_vec()),
            _scope: None,
        })
    }
}

#[test]
fn preview_returns_refreshed_identity_not_stale_values() {
    let root = std::env::temp_dir().join(format!("myspace-refresh-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&root).unwrap();
    // StaleFake resolves to `root` with a refreshed locator, so the returned
    // identity must reflect `root`, not the pre-refresh display_name/path_hint.
    let fake = StaleFake { path: root.clone() };
    let (preview, refreshed, path) =
        list_preview_with_refresh(&fake, b"old", "old-hint", "OldName", 50);
    assert_eq!(preview.status, FolderPreviewStatus::Empty);
    assert_eq!(
        preview.display_name,
        root.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(preview.path_hint, root.to_string_lossy());
    assert!(refreshed.is_some());
    assert!(path.is_some());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn create_filesystem_alias_replays_idempotently() {
    use myspace_lib::db::{bootstrap, open_in_memory};
    use myspace_lib::domain::models::{CreateFilesystemAliasInput, Frame};
    use myspace_lib::repositories::workspace_repository;
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home: String = conn
        .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    let input = CreateFilesystemAliasInput {
        id: "fa-replay".into(),
        board_id: home,
        frame: Frame {
            x: 0.0,
            y: 0.0,
            width: 280.0,
            height: 180.0,
        },
        z_index: 0,
        target_kind: "folder".into(),
        locator_blob: b"blob".to_vec(),
        path_hint: "/tmp/x".into(),
        display_name: "x".into(),
    };
    workspace_repository::create_filesystem_alias(&mut conn, &input).unwrap();
    // Replay with the same id returns Ok and does not create a second row.
    workspace_repository::create_filesystem_alias(&mut conn, &input).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id = 'fa-replay'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn create_filesystem_alias_rejects_conflicting_card_kind() {
    use myspace_lib::db::{bootstrap, open_in_memory};
    use myspace_lib::domain::models::{CreateFilesystemAliasInput, CreateNoteInput, Frame};
    use myspace_lib::repositories::workspace_repository;
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let home: String = conn
        .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    workspace_repository::create_note(
        &mut conn,
        &CreateNoteInput {
            id: "taken".into(),
            board_id: home.clone(),
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
            },
            z_index: 0,
            document_json: serde_json::json!({ "type": "doc" }),
            plain_text: "".into(),
        },
    )
    .unwrap();
    let result = workspace_repository::create_filesystem_alias(
        &mut conn,
        &CreateFilesystemAliasInput {
            id: "taken".into(),
            board_id: home,
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 280.0,
                height: 180.0,
            },
            z_index: 0,
            target_kind: "folder".into(),
            locator_blob: b"blob".to_vec(),
            path_hint: "/tmp/x".into(),
            display_name: "x".into(),
        },
    );
    assert!(result.is_err());
}

#[test]
fn classify_drop_returns_mime_and_svg() {
    use myspace_lib::domain::filesystem_alias_service::classify_drop;
    use std::path::Path;
    assert_eq!(classify_drop(Path::new("/a/b.png")).0, "image");
    assert_eq!(
        classify_drop(Path::new("/a/b.png")).2.as_deref(),
        Some("image/png")
    );
    assert_eq!(classify_drop(Path::new("/a/b.svg")).0, "image");
    assert_eq!(
        classify_drop(Path::new("/a/b.svg")).2.as_deref(),
        Some("image/svg+xml")
    );
    assert_eq!(classify_drop(Path::new("/a/b.txt")).0, "text_file");
}

#[test]
fn classify_drop_marks_text_files() {
    use myspace_lib::domain::filesystem_alias_service::classify_drop;
    use std::path::Path;
    assert_eq!(classify_drop(Path::new("/a/notes.txt")).0, "text_file");
    assert_eq!(classify_drop(Path::new("/a/README.md")).0, "text_file");
    assert_eq!(classify_drop(Path::new("/a/data.json")).0, "text_file");
    assert_eq!(classify_drop(Path::new("/a/table.csv")).0, "text_file");
    assert_eq!(classify_drop(Path::new("/a/doc.docx")).0, "office_file");
    assert_eq!(classify_drop(Path::new("/a/sheet.xlsx")).0, "office_file");
    assert_eq!(classify_drop(Path::new("/a/report.pdf")).0, "office_file");
}
