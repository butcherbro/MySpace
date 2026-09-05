//! Asset path-boundary safety checks for the `myspace-asset` URI protocol.

use myspace_lib::{is_safe_asset_name, mime_for_asset_name};

#[test]
fn safe_names_are_accepted() {
    for name in ["abc.png", "a1-2.jpg", "asset.webp", "0.svg"] {
        assert!(is_safe_asset_name(name), "should be safe: {name}");
    }
}

#[test]
fn traversal_names_are_rejected() {
    for name in [
        "../outside.png",
        "..\\..\\x.png",
        "a/../b.png",
        "a/b.png",
        "",
        " ",
        "a\u{00}b.png",
        "a b.png",
        "...x",
    ] {
        assert!(!is_safe_asset_name(name), "should be rejected: {name:?}");
    }
}

#[test]
fn mime_is_mapped_from_extension() {
    assert_eq!(mime_for_asset_name("a.png"), "image/png");
    assert_eq!(mime_for_asset_name("a.jpg"), "image/jpeg");
    assert_eq!(mime_for_asset_name("a.gif"), "image/gif");
    assert_eq!(mime_for_asset_name("a.webp"), "image/webp");
    assert_eq!(mime_for_asset_name("favicon.ico"), "image/x-icon");
    assert_eq!(
        mime_for_asset_name("a.unknownext"),
        "application/octet-stream"
    );
}
