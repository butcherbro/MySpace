use std::fs;

use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::asset_service;
use myspace_lib::domain::link_metadata::{
    enrich_embed_with_metadata, extract_html_metadata, extract_youtube_feed_metadata,
    validate_public_http_url, youtube_channel_feed_url, FetchError, FetchResponse, MetadataFetcher,
};
use myspace_lib::domain::models::{
    ConvertNoteToEmbedInput, CreateNoteInput, Frame, UpdateEmbedDescriptionInput,
};
use myspace_lib::repositories::workspace_repository;

fn root_board_id(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
        r.get(0)
    })
    .unwrap()
}

fn create_pending_embed(conn: &mut rusqlite::Connection, url: &str) -> i64 {
    bootstrap::bootstrap(conn).unwrap();
    let board_id = root_board_id(conn);
    workspace_repository::create_note(
        conn,
        &CreateNoteInput {
            id: "link-card".to_string(),
            board_id,
            frame: Frame {
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 180.0,
            },
            z_index: 1,
            document_json: serde_json::json!({"type":"doc"}),
            plain_text: url.to_string(),
        },
    )
    .unwrap();
    let embed = workspace_repository::convert_note_to_embed(
        conn,
        &ConvertNoteToEmbedInput {
            id: "link-card".to_string(),
            expected_revision: 1,
            source_url: url.to_string(),
            display_url: url.to_string(),
            title: url.to_string(),
            description_json: serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]}),
            description_plain_text: String::new(),
        },
    )
    .unwrap();
    embed.revision
}

struct StubFetcher {
    page: Result<FetchResponse, FetchError>,
    image: Option<FetchResponse>,
}

impl MetadataFetcher for StubFetcher {
    fn fetch_text(&self, _url: &str) -> Result<FetchResponse, FetchError> {
        self.page.clone()
    }

    fn fetch_image(&self, _url: &str) -> Result<FetchResponse, FetchError> {
        self.image
            .clone()
            .ok_or_else(|| FetchError::Network("missing image".to_string()))
    }
}

#[test]
fn extract_html_metadata_prefers_open_graph_and_resolves_assets() {
    let html = r#"
      <html><head>
        <title>Fallback Title</title>
        <meta property="og:site_name" content="Readable Site">
        <meta property="og:title" content="Open Graph Title">
        <meta property="og:description" content="Open Graph Description">
        <meta property="og:image" content="/preview.jpg">
        <link rel="icon" href="/favicon.png">
      </head></html>
    "#;

    let metadata = extract_html_metadata("https://example.com/articles/1", html).unwrap();

    assert_eq!(metadata.site_name.as_deref(), Some("Readable Site"));
    assert_eq!(metadata.title.as_deref(), Some("Open Graph Title"));
    assert_eq!(
        metadata.description.as_deref(),
        Some("Open Graph Description")
    );
    assert_eq!(
        metadata.preview_url.as_deref(),
        Some("https://example.com/preview.jpg")
    );
    assert_eq!(
        metadata.favicon_url.as_deref(),
        Some("https://example.com/favicon.png")
    );
}

#[test]
fn validate_public_http_url_rejects_local_addresses() {
    for url in [
        "http://127.0.0.1/page",
        "http://localhost/page",
        "http://10.0.0.2/page",
        "http://169.254.1.1/page",
        "file:///Users/bro/image.png",
    ] {
        assert!(
            validate_public_http_url(url).is_err(),
            "{url} must be rejected"
        );
    }

    assert!(validate_public_http_url("https://example.com/page").is_ok());
}

#[test]
fn youtube_channel_feed_provides_channel_title_and_preview() {
    let source = "https://www.youtube.com/channel/UCL2KQd0XAP2XgtjbQOsMQ3w";
    assert_eq!(
        youtube_channel_feed_url(source).as_deref(),
        Some("https://www.youtube.com/feeds/videos.xml?channel_id=UCL2KQd0XAP2XgtjbQOsMQ3w")
    );

    let feed = r#"
      <feed>
        <title>The Evolution of Life</title>
        <entry><media:thumbnail url="https://i2.ytimg.com/vi/example/hqdefault.jpg"/></entry>
      </feed>
    "#;
    let metadata = extract_youtube_feed_metadata(source, feed).unwrap();

    assert_eq!(metadata.title.as_deref(), Some("The Evolution of Life"));
    assert_eq!(metadata.site_name.as_deref(), Some("YouTube"));
    assert_eq!(
        metadata.preview_url.as_deref(),
        Some("https://i2.ytimg.com/vi/example/hqdefault.jpg")
    );
}

#[test]
fn enrich_embed_with_html_metadata_persists_ready_card_and_assets() {
    let mut conn = open_in_memory().unwrap();
    let revision = create_pending_embed(&mut conn, "https://example.com/page");
    let tmp = std::env::temp_dir().join(format!("myspace-link-metadata-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();

    let fetcher = StubFetcher {
        page: Ok(FetchResponse {
            final_url: "https://example.com/page".to_string(),
            mime_type: "text/html".to_string(),
            bytes: br#"
              <meta property="og:site_name" content="Example">
              <meta property="og:title" content="Example Title">
              <meta property="og:description" content="Example Description">
              <meta property="og:image" content="https://example.com/preview.png">
              <link rel="icon" href="https://example.com/favicon.png">
            "#
            .to_vec(),
        }),
        image: Some(FetchResponse {
            final_url: "https://example.com/preview.png".to_string(),
            mime_type: "image/png".to_string(),
            bytes: b"image-bytes".to_vec(),
        }),
    };

    let embed =
        enrich_embed_with_metadata(&mut conn, &asset_dir, &fetcher, "link-card", revision).unwrap();

    assert_eq!(embed.metadata_status, "ready");
    assert_eq!(embed.title, "Example Title");
    assert_eq!(embed.description_plain_text, "Example Description");
    assert_eq!(embed.site_name.as_deref(), Some("Example"));
    assert_eq!(embed.preview_origin.as_deref(), Some("fetched"));
    assert!(embed.preview_asset.is_some());
    assert!(embed.favicon_asset.is_some());

    let preview = embed.preview_asset.unwrap();
    assert_eq!(
        fs::read(asset_dir.join(preview.file_path)).unwrap(),
        b"image-bytes"
    );

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn enrich_embed_persists_failed_status_without_losing_source() {
    let mut conn = open_in_memory().unwrap();
    let revision = create_pending_embed(&mut conn, "https://example.com/page");
    let tmp = std::env::temp_dir().join(format!("myspace-link-failed-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");

    let fetcher = StubFetcher {
        page: Err(FetchError::Network("offline".to_string())),
        image: None,
    };

    let embed =
        enrich_embed_with_metadata(&mut conn, &asset_dir, &fetcher, "link-card", revision).unwrap();

    assert_eq!(embed.metadata_status, "failed");
    assert_eq!(embed.source_url, "https://example.com/page");
    assert_eq!(embed.title, "https://example.com/page");
    assert!(embed.metadata_error.unwrap().contains("offline"));
}

#[test]
fn enrich_preserves_a_user_authored_description() {
    let mut conn = open_in_memory().unwrap();
    let revision = create_pending_embed(&mut conn, "https://example.com/page");
    let tmp = std::env::temp_dir().join(format!("myspace-user-desc-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();

    // A user-authored comment is set before enrichment.
    workspace_repository::update_embed_description(
        &mut conn,
        &UpdateEmbedDescriptionInput {
            id: "link-card".to_string(),
            expected_revision: revision,
            description_json: serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"мой комментарий"}]}]}),
            description_plain_text: "мой комментарий".to_string(),
        },
    )
    .unwrap();

    let fetcher = StubFetcher {
        page: Ok(FetchResponse {
            final_url: "https://example.com/page".to_string(),
            mime_type: "text/html".to_string(),
            bytes: br#"
              <html><head>
                <meta property="og:title" content="Site Title">
                <meta property="og:description" content="Site Description">
              </head></html>
            "#
            .to_vec(),
        }),
        image: None,
    };

    // Enrichment runs against revision 2 (the description bump).
    let embed =
        enrich_embed_with_metadata(&mut conn, &asset_dir, &fetcher, "link-card", revision + 1)
            .unwrap();

    assert_eq!(embed.metadata_status, "ready");
    assert_eq!(embed.title, "Site Title");
    // The user's comment wins over the fetched site description.
    assert_eq!(embed.description_plain_text, "мой комментарий");

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn downloaded_asset_bytes_are_stored_as_managed_assets() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let tmp = std::env::temp_dir().join(format!("myspace-byte-asset-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");

    let asset = asset_service::store_asset_bytes(
        &mut conn,
        &asset_dir,
        "cover.png",
        "image/png",
        b"png-bytes",
    )
    .unwrap();

    assert_eq!(asset.mime_type, "image/png");
    assert_eq!(asset.size_bytes, 9);
    assert_eq!(
        fs::read(asset_dir.join(asset.file_path)).unwrap(),
        b"png-bytes"
    );

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn downloaded_favicon_keeps_an_ico_extension() {
    let mut conn = open_in_memory().unwrap();
    bootstrap::bootstrap(&mut conn).unwrap();
    let tmp = std::env::temp_dir().join(format!("myspace-favicon-{}", uuid::Uuid::now_v7()));

    let asset = asset_service::store_asset_bytes(
        &mut conn,
        &tmp,
        "favicon.ico",
        "image/x-icon",
        b"icon-bytes",
    )
    .unwrap();

    assert!(asset.file_path.ends_with(".ico"));
    fs::remove_dir_all(&tmp).ok();
}
