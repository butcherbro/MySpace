use std::fs;
use myspace_lib::domain::filesystem_alias_service::{FolderLocator, LocatorError, ResolvedFolder, list_preview};
use myspace_lib::domain::models::FolderPreviewStatus;

struct Fake;
impl FolderLocator for Fake {
    fn create(&self, path: &std::path::Path) -> Result<Vec<u8>, LocatorError> { Ok(path.as_os_str().as_encoded_bytes().to_vec()) }
    fn resolve(&self, bytes: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        Ok(ResolvedFolder { path: std::path::PathBuf::from(String::from_utf8_lossy(bytes).to_string()), refreshed_locator: None })
    }
}

#[test]
fn preview_sorts_folders_first_and_bounds_the_scan() {
    let root = std::env::temp_dir().join(format!("myspace-folder-preview-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(root.join("Zoo")).unwrap();
    fs::write(root.join("apple.txt"), b"x").unwrap();
    let locator = Fake;
    let preview = list_preview(&locator, root.to_string_lossy().as_bytes(), "hint", "Root", 1);
    assert_eq!(preview.status, FolderPreviewStatus::Ready);
    assert_eq!(preview.entries[0].name, "Zoo");
    assert!(preview.has_more);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn preview_missing_bookmark_does_not_use_path_hint_as_fallback() {
    let preview = list_preview(&Fake, b"/definitely/missing", "/tmp/display-only", "Missing", 50);
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
