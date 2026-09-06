//! Clipboard helpers for the macOS MySpace app.
//!
//! The UI's "Copy MySpace Link" and "Copy File Path" actions write plain text to
//! the system pasteboard. We drive `NSPasteboard` directly (via `objc2-app-kit`,
//! already a transitive dependency of Tauri on macOS) rather than the web
//! Clipboard API, because WKWebView's `navigator.clipboard` requires a
//! permissions/secure-context dance that is flaky outside a user gesture.

/// Copies a plain-text string to the system clipboard.
#[cfg(target_os = "macos")]
pub fn copy_text(text: &str) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard: Retained<NSPasteboard> = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let string = NSString::from_str(text);
    let written = unsafe { pasteboard.setString_forType(&string, NSPasteboardTypeString) };
    if written {
        Ok(())
    } else {
        Err("clipboard write was rejected by the pasteboard".to_string())
    }
}

/// Copies a plain-text string to the system clipboard.
#[cfg(not(target_os = "macos"))]
pub fn copy_text(_text: &str) -> Result<(), String> {
    Err("clipboard copy is only implemented on macOS".to_string())
}

/// Tauri command wrapper for `copy_text`.
#[tauri::command]
pub fn copy_text_command(text: String) -> Result<(), String> {
    copy_text(&text)
}

/// Copies one or more image files to the system pasteboard as file references,
/// so they can be pasted into Finder (as copies), chat/agents, or any app that
/// accepts dragged/copied file URLs.
#[cfg(target_os = "macos")]
pub fn copy_image_files(paths: &[std::path::PathBuf]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let pasteboard: Retained<NSPasteboard> = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();

    let urls: Vec<Retained<NSURL>> = paths
        .iter()
        .map(|p| {
            let s = NSString::from_str(&p.to_string_lossy());
            NSURL::fileURLWithPath(&s)
        })
        .collect();

    // `writeObjects` expects `NSArray<ProtocolObject<dyn NSPasteboardWriting>>`.
    // NSURL conforms to NSPasteboardWriting; wrap each retained URL as a
    // protocol object and collect into an array.
    let mut objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
    for url in urls.into_iter() {
        objects.push(ProtocolObject::from_retained(url));
    }
    let array = NSArray::from_retained_slice(&objects);

    let ok = pasteboard.writeObjects(&array);
    if ok {
        Ok(())
    } else {
        Err("clipboard write was rejected by the pasteboard".to_string())
    }
}

/// Non-macOS stub.
#[cfg(not(target_os = "macos"))]
pub fn copy_image_files(_paths: &[std::path::PathBuf]) -> Result<(), String> {
    Err("clipboard copy is only implemented on macOS".to_string())
}

/// Reads an image from the system clipboard, returning `(bytes, mime_type,
/// file_name)`. Handles PNG image data (screenshots / "Copy Image") and copied
/// image files (Finder). Returns `Ok(None)` when the clipboard has no image.
#[cfg(target_os = "macos")]
pub fn read_clipboard_image() -> Result<Option<(Vec<u8>, String, String)>, String> {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG};

    let pasteboard: Retained<NSPasteboard> = NSPasteboard::generalPasteboard();

    // 1. PNG image data (screenshots and most "Copy Image" paths).
    if let Some(data) = pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
        let bytes = nsdata_to_vec(&data);
        if !bytes.is_empty() {
            return Ok(Some((
                bytes,
                "image/png".to_string(),
                "clipboard.png".to_string(),
            )));
        }
    }

    // 2. A copied image file (Finder) exposes a file URL.
    if let Some(url_str) = pasteboard.stringForType(unsafe { NSPasteboardTypeFileURL }) {
        let s = url_str.to_string();
        if let Some(bytes) = read_file_url_bytes(&s) {
            let file_name = file_name_from_url(&s);
            let mime = crate::mime_for_asset_name(&file_name).to_string();
            return Ok(Some((bytes, mime, file_name)));
        }
    }

    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub fn read_clipboard_image() -> Result<Option<(Vec<u8>, String, String)>, String> {
    Err("clipboard read is only implemented on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn nsdata_to_vec(data: &objc2_foundation::NSData) -> Vec<u8> {
    use core::ffi::c_void;
    use core::ptr::NonNull;
    let len = data.length();
    let mut buf = vec![0u8; len];
    if len > 0 {
        unsafe {
            data.getBytes_length(
                NonNull::new(buf.as_mut_ptr() as *mut c_void).unwrap(),
                data.length(),
            );
        }
    }
    buf
}

#[cfg(target_os = "macos")]
fn read_file_url_bytes(url_str: &str) -> Option<Vec<u8>> {
    let url = url::Url::parse(url_str).ok()?;
    let path = url.to_file_path().ok()?;
    std::fs::read(path).ok()
}

#[cfg(target_os = "macos")]
fn file_name_from_url(url_str: &str) -> String {
    url::Url::parse(url_str)
        .ok()
        .and_then(|u| {
            let mut segs = u.path_segments()?;
            segs.next_back().map(str::to_string)
        })
        .unwrap_or_else(|| "clipboard-image".to_string())
}
