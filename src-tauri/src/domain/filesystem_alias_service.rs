//! Filesystem alias resolution is deliberately behind this narrow boundary.
//! SQLite holds opaque locator bytes; a path hint is display-only metadata.

use crate::domain::models::{FolderEntryDto, FolderPreviewDto, FolderPreviewStatus};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocatorError {
    Missing,
    PermissionLost,
    /// A platform-level failure, carrying a short system diagnostic (NSError
    /// domain/code/description). Keeping the reason stops a broken locator from
    /// collapsing into an opaque "could not create folder locator" and makes a
    /// future regression diagnosable from the error text alone.
    Io(String),
    /// The stored blob is a locator format this build cannot resolve: a macOS
    /// bookmark read on Windows/Linux, or a [`PATH_LOCATOR_PREFIX`] blob read
    /// on macOS (e.g. a database moved between machines). Surfaced like a
    /// missing target — the shortcut is broken here and must be dropped again —
    /// but kept distinct so the reason is never confused with a deleted folder.
    ForeignFormat(&'static str),
}

/// Tag that starts every path-based locator blob ([`PathLocator`]). macOS
/// bookmark data starts with its own `book` magic, so the two formats are
/// distinguishable by prefix alone. Every locator-format constant lives here so
/// device-scoped locators can extend the scheme in one place.
pub const PATH_LOCATOR_PREFIX: &[u8] = b"path:v1:";

/// True when `blob` was written by [`PathLocator`].
pub fn is_path_locator(blob: &[u8]) -> bool {
    blob.starts_with(PATH_LOCATOR_PREFIX)
}

impl std::fmt::Display for LocatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocatorError::Missing => write!(f, "bookmark not found"),
            LocatorError::PermissionLost => write!(f, "permission lost"),
            LocatorError::Io(message) => write!(f, "{message}"),
            LocatorError::ForeignFormat(format) => write!(
                f,
                "folder shortcut was created on another platform ({format}); drop the folder again"
            ),
        }
    }
}

/// A folder resolved from a stored bookmark. The app is not sandboxed, so the
/// bookmark is a plain one and there is no security scope to hold open.
pub struct ResolvedFolder {
    pub path: PathBuf,
    pub refreshed_locator: Option<Vec<u8>>,
}

/// Platform-specific bookmark implementation. Tests inject a fake locator so
/// directory semantics remain cross-platform and do not require Objective-C.
pub trait FolderLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError>;
    /// The optional bytes replace stale bookmark data transactionally by caller.
    fn resolve(&self, locator: &[u8]) -> Result<ResolvedFolder, LocatorError>;
}

pub fn list_preview(
    locator: &dyn FolderLocator,
    locator_blob: &[u8],
    path_hint: &str,
    display_name: &str,
    limit: usize,
) -> FolderPreviewDto {
    list_preview_with_refresh(locator, locator_blob, path_hint, display_name, limit).0
}

/// Returns a replacement locator only after successful resolution; callers persist it
/// with refreshed display metadata in the same SQLite transaction.
pub fn list_preview_with_refresh(
    locator: &dyn FolderLocator,
    locator_blob: &[u8],
    path_hint: &str,
    display_name: &str,
    limit: usize,
) -> (FolderPreviewDto, Option<Vec<u8>>, Option<PathBuf>) {
    let base = || FolderPreviewDto {
        status: FolderPreviewStatus::IoError,
        entries: vec![],
        has_more: false,
        display_name: display_name.into(),
        path_hint: path_hint.into(),
    };
    let resolved = match locator.resolve(locator_blob) {
        Ok(value) => value,
        Err(LocatorError::Missing | LocatorError::ForeignFormat(_)) => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::Missing,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(LocatorError::PermissionLost) => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::PermissionLost,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(LocatorError::Io(_)) => return (base(), None, None),
    };
    let path = resolved.path;
    let read = match std::fs::read_dir(&path) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::Missing,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::PermissionLost,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(_) => return (base(), None, None),
    };
    let mut entries = Vec::new();
    for item in read.take(201) {
        let Ok(item) = item else {
            return (base(), None, None);
        };
        let Ok(metadata) = item.metadata() else {
            return (base(), None, None);
        };
        let is_dir = metadata.is_dir();
        entries.push(FolderEntryDto {
            name: item.file_name().to_string_lossy().into_owned(),
            kind: if is_dir { "folder" } else { "file" }.into(),
            size_bytes: (!is_dir).then_some(metadata.len() as i64),
            child_count: None,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "folder", a.name.to_lowercase())
            .cmp(&(b.kind != "folder", b.name.to_lowercase()))
    });
    let has_more = entries.len() > limit || entries.len() == 201;
    entries.truncate(limit.min(50));
    // Reflect the freshly resolved identity, not the pre-refresh values.
    let refreshed_display = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(display_name);
    let refreshed_hint = path.to_string_lossy().into_owned();
    (
        FolderPreviewDto {
            status: if entries.is_empty() {
                FolderPreviewStatus::Empty
            } else {
                FolderPreviewStatus::Ready
            },
            entries,
            has_more,
            display_name: refreshed_display.to_owned(),
            path_hint: refreshed_hint,
        },
        resolved.refreshed_locator,
        Some(path),
    )
}

#[cfg(target_os = "macos")]
pub struct MacosBookmarkLocator;

/// Bookmark creation options for folder locators.
///
/// Kept as a named constant so a regression guard can assert it stays a *plain*
/// bookmark: this app is not sandboxed, and requesting a security scope fails
/// outside App Sandbox (see ADR-0006).
#[cfg(target_os = "macos")]
pub const FOLDER_BOOKMARK_CREATION_OPTIONS: objc2_foundation::NSURLBookmarkCreationOptions =
    objc2_foundation::NSURLBookmarkCreationOptions::empty();
#[cfg(target_os = "macos")]
impl Default for MacosBookmarkLocator {
    fn default() -> Self {
        Self
    }
}
/// Short, stable description of a Foundation error for diagnostics.
#[cfg(target_os = "macos")]
fn describe_ns_error(error: &objc2_foundation::NSError) -> String {
    format!(
        "{} {}: {}",
        error.domain(),
        error.code(),
        error.localizedDescription()
    )
}

/// True when a Foundation error means the bookmarked item no longer exists. Such
/// a failure keeps the user-facing `Missing` status; anything else is surfaced as
/// an IO error carrying the real reason instead of being swallowed.
#[cfg(target_os = "macos")]
fn is_missing_target_error(error: &objc2_foundation::NSError) -> bool {
    /// `NSFileNoSuchFileError`.
    const NO_SUCH_FILE: isize = 4;
    /// `NSFileReadNoSuchFileError`.
    const READ_NO_SUCH_FILE: isize = 260;
    let code = error.code();
    (code == NO_SUCH_FILE || code == READ_NO_SUCH_FILE)
        && error.domain().to_string() == "NSCocoaErrorDomain"
}

#[cfg(target_os = "macos")]
impl FolderLocator for MacosBookmarkLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError> {
        use objc2_foundation::{NSString, NSURL};
        let value = path
            .to_str()
            .ok_or_else(|| LocatorError::Io("path is not valid UTF-8".into()))?;
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(value), true);
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            FOLDER_BOOKMARK_CREATION_OPTIONS,
            None,
            None,
        )
        .map(|data| data.to_vec())
        .map_err(|error| LocatorError::Io(describe_ns_error(&error)))
    }
    fn resolve(&self, bytes: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        use objc2::runtime::Bool;
        use objc2_foundation::{NSData, NSURLBookmarkResolutionOptions, NSURL};
        if is_path_locator(bytes) {
            return Err(LocatorError::ForeignFormat("path locator"));
        }
        let data = NSData::with_bytes(bytes);
        let mut stale = Bool::default();
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithoutUI,
                None,
                &mut stale,
            )
        }
        .map_err(|error| {
            if is_missing_target_error(&error) {
                LocatorError::Missing
            } else {
                LocatorError::Io(describe_ns_error(&error))
            }
        })?;
        let path = url.path().ok_or(LocatorError::Missing)?.to_string();
        let refreshed_locator = if stale.as_bool() {
            Some(
                url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                    FOLDER_BOOKMARK_CREATION_OPTIONS,
                    None,
                    None,
                )
                .map_err(|error| LocatorError::Io(describe_ns_error(&error)))?
                .to_vec(),
            )
        } else {
            None
        };
        Ok(ResolvedFolder {
            path: PathBuf::from(path),
            refreshed_locator,
        })
    }
}

/// Path-based folder locator for Windows and Linux (and any non-macOS build).
///
/// Stores `PATH_LOCATOR_PREFIX` + the canonical absolute path as UTF-8. Unlike a
/// macOS bookmark it does not follow the folder across renames or moves: a
/// moved folder resolves as [`LocatorError::Missing`] (the "broken shortcut"
/// state) until it is dropped again. Compiled on every platform so its tests
/// run everywhere; only non-macOS builds use it as the platform locator.
#[derive(Debug, Default, Clone, Copy)]
pub struct PathLocator;

fn io_to_locator_error(error: std::io::Error) -> LocatorError {
    match error.kind() {
        std::io::ErrorKind::NotFound => LocatorError::Missing,
        std::io::ErrorKind::PermissionDenied => LocatorError::PermissionLost,
        _ => LocatorError::Io(error.to_string()),
    }
}

impl FolderLocator for PathLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError> {
        // `dunce` strips the `\\?\` verbatim prefix `std::fs::canonicalize`
        // adds on Windows (it keeps it when the path cannot be expressed
        // without one); elsewhere it is plain `std::fs::canonicalize`.
        let canonical = dunce::canonicalize(path).map_err(io_to_locator_error)?;
        let value = canonical
            .to_str()
            .ok_or_else(|| LocatorError::Io("path is not valid UTF-8".into()))?;
        let mut blob = Vec::with_capacity(PATH_LOCATOR_PREFIX.len() + value.len());
        blob.extend_from_slice(PATH_LOCATOR_PREFIX);
        blob.extend_from_slice(value.as_bytes());
        Ok(blob)
    }
    fn resolve(&self, bytes: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        let Some(raw) = bytes.strip_prefix(PATH_LOCATOR_PREFIX) else {
            return Err(LocatorError::ForeignFormat("macOS bookmark"));
        };
        let value = std::str::from_utf8(raw)
            .map_err(|_| LocatorError::Io("path locator is not valid UTF-8".into()))?;
        if value.is_empty() {
            return Err(LocatorError::Io("path locator is empty".into()));
        }
        let path = PathBuf::from(value);
        match path.try_exists() {
            Ok(true) => Ok(ResolvedFolder {
                path,
                refreshed_locator: None,
            }),
            Ok(false) => Err(LocatorError::Missing),
            Err(error) => Err(io_to_locator_error(error)),
        }
    }
}

/// Classifies a dropped native path into a drop kind plus display metadata.
/// `folder` -> shortcut, `image` -> existing image-card path, else unsupported.
pub fn classify_drop(path: &Path) -> (String, Option<String>, Option<String>) {
    let file_name = path.file_name().and_then(|v| v.to_str()).map(str::to_owned);
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_owned);
    let ext_lower = ext.as_deref().map(|e| e.to_ascii_lowercase());
    let kind = if path.is_dir() {
        "folder"
    } else if matches!(
        ext_lower.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg")
    ) {
        "image"
    } else if matches!(
        ext_lower.as_deref(),
        Some("txt" | "md" | "markdown" | "json" | "csv" | "rtf" | "log" | "html" | "htm")
    ) {
        "text_file"
    } else if ext_lower.as_deref() == Some("zip") {
        "archive"
    } else if matches!(
        ext_lower.as_deref(),
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
                | "odp",
        )
    ) {
        "office_file"
    } else {
        "unsupported"
    };
    let mime = if kind == "image" {
        mime_for_ext(ext.as_deref())
    } else {
        None
    };
    (kind.to_string(), file_name, mime)
}

fn mime_for_ext(ext: Option<&str>) -> Option<String> {
    ext.and_then(|e| {
        match e.to_ascii_lowercase().as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "heic" => Some("image/heic"),
            "svg" => Some("image/svg+xml"),
            _ => None,
        }
        .map(str::to_owned)
    })
}

/// Classifies a single pasted path (todo.md №23, Cmd+V on the empty canvas):
/// `~`/`~/...` is expanded against `home_dir` first (so it resolves the same
/// way Finder/the shell would), then the expanded path is checked against the
/// filesystem. Returns `("folder" | "file" | "missing", expanded_path)` — a
/// missing path is the signal for the caller to fall back to a plain-text
/// note paste instead of creating a shortcut/file card.
///
/// Windows paths (`C:\Users\x\Docs`, UNC `\\server\share\dir`) go through
/// unchanged apart from the unquoting below; `~\...` is also expanded there.
pub fn classify_path(raw: &str, home_dir: Option<&Path>) -> (String, PathBuf) {
    let expanded = expand_home(strip_wrapping_quotes(raw.trim()), home_dir);
    let path = PathBuf::from(&expanded);
    let kind = if path.is_dir() {
        "folder"
    } else if path.is_file() {
        "file"
    } else {
        "missing"
    };
    (kind.to_string(), path)
}

/// Explorer's "Copy as path" wraps the path in double quotes
/// (`"C:\Users\x\file.txt"`); a quoted path is never meant literally.
fn strip_wrapping_quotes(raw: &str) -> &str {
    raw.strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(raw)
}

/// Expands a leading `~` against `home_dir`. Anything else — an absolute unix
/// path, a Windows drive or UNC path — is returned unchanged. `~\` is only a
/// separator on Windows; elsewhere a backslash is a legal filename character.
pub fn expand_home(raw: &str, home_dir: Option<&Path>) -> String {
    let Some(home) = home_dir else {
        return raw.to_string();
    };
    if raw == "~" {
        return home.to_string_lossy().into_owned();
    }
    let rest = raw.strip_prefix("~/");
    #[cfg(windows)]
    let rest = rest.or_else(|| raw.strip_prefix("~\\"));
    if let Some(rest) = rest {
        return home.join(rest).to_string_lossy().into_owned();
    }
    raw.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("myspace-{tag}-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn path_locator_round_trips_an_existing_folder() {
        let dir = temp_dir("path-locator");
        let blob = PathLocator.create(&dir).unwrap();
        assert!(is_path_locator(&blob));
        assert!(blob.starts_with(PATH_LOCATOR_PREFIX));
        let resolved = PathLocator.resolve(&blob).unwrap();
        assert_eq!(resolved.path, dunce::canonicalize(&dir).unwrap());
        assert!(resolved.refreshed_locator.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn path_locator_reports_a_deleted_folder_as_missing() {
        let dir = temp_dir("path-locator-gone");
        let blob = PathLocator.create(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            PathLocator.resolve(&blob).err(),
            Some(LocatorError::Missing)
        );
        // Creating a locator for a path that does not exist is also `Missing`.
        assert_eq!(PathLocator.create(&dir).err(), Some(LocatorError::Missing));
    }

    #[test]
    fn path_locator_rejects_foreign_and_malformed_blobs() {
        // Real macOS bookmark data starts with the `book` magic.
        let bookmark = b"book\x00\x02\x00\x00mac-bookmark-bytes";
        assert_eq!(
            PathLocator.resolve(bookmark).err(),
            Some(LocatorError::ForeignFormat("macOS bookmark"))
        );
        assert!(!is_path_locator(bookmark));
        assert!(matches!(
            PathLocator.resolve(PATH_LOCATOR_PREFIX).err(),
            Some(LocatorError::Io(_))
        ));
        let mut invalid_utf8 = PATH_LOCATOR_PREFIX.to_vec();
        invalid_utf8.extend_from_slice(&[0xff, 0xfe]);
        assert!(matches!(
            PathLocator.resolve(&invalid_utf8).err(),
            Some(LocatorError::Io(_))
        ));
    }

    #[test]
    fn foreign_format_preview_is_the_broken_shortcut_state() {
        let preview = list_preview(&PathLocator, b"bookdata", "/hint", "Name", 50);
        assert_eq!(preview.status, FolderPreviewStatus::Missing);
    }

    #[test]
    fn expand_home_leaves_non_tilde_absolute_paths_unchanged() {
        let home = Path::new("/home/me");
        for raw in [
            "/usr/local",
            "C:\\Users\\x\\Docs",
            "\\\\server\\share\\dir",
            "~user/x",
        ] {
            assert_eq!(expand_home(raw, Some(home)), raw);
        }
        assert_eq!(expand_home("~", Some(home)), "/home/me");
        assert_eq!(expand_home("~/Docs", None), "~/Docs");
    }

    #[test]
    fn classify_path_strips_explorer_quotes() {
        let dir = temp_dir("quoted-path");
        let quoted = format!("\"{}\"", dir.display());
        let (kind, expanded) = classify_path(&quoted, None);
        assert_eq!(kind, "folder");
        assert_eq!(expanded, dir);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn expand_home_treats_backslash_tilde_literally_off_windows() {
        assert_eq!(
            expand_home("~\\Docs", Some(Path::new("/home/me"))),
            "~\\Docs"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_expand_and_classify() {
        let home = Path::new("C:\\Users\\me");
        assert_eq!(expand_home("~\\Docs", Some(home)), "C:\\Users\\me\\Docs");
        assert_eq!(expand_home("~/Docs", Some(home)), "C:\\Users\\me\\Docs");
        let unc = "\\\\server\\share\\dir";
        assert_eq!(expand_home(unc, Some(home)), unc);
        let dir = temp_dir("win-classify");
        let as_text = dir.to_string_lossy().into_owned();
        assert!(as_text.contains('\\'));
        let (kind, expanded) = classify_path(&as_text, Some(home));
        assert_eq!(kind, "folder");
        assert_eq!(expanded, dir);
        let (kind, name, _) = classify_drop(&dir.join("report.PDF"));
        assert_eq!(kind, "office_file");
        assert_eq!(name.as_deref(), Some("report.PDF"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
