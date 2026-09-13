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
    assert_eq!(embed.description_origin.as_deref(), Some("user"));

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn enrich_marks_a_fetched_description_as_site_origin() {
    let mut conn = open_in_memory().unwrap();
    let revision = create_pending_embed(&mut conn, "https://example.com/page");
    let tmp = std::env::temp_dir().join(format!("myspace-site-desc-{}", uuid::Uuid::now_v7()));
    let asset_dir = tmp.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();

    // No user comment: enrichment fills the description from the site.
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

    let embed =
        enrich_embed_with_metadata(&mut conn, &asset_dir, &fetcher, "link-card", revision).unwrap();

    assert_eq!(embed.description_plain_text, "Site Description");
    assert_eq!(embed.description_origin.as_deref(), Some("site"));

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

/// Embed cards with their own favicon files on disk, for the collapse tests.
struct FaviconFixture {
    conn: rusqlite::Connection,
    asset_dir: std::path::PathBuf,
    tmp: std::path::PathBuf,
}

impl FaviconFixture {
    fn new() -> Self {
        let mut conn = open_in_memory().unwrap();
        bootstrap::bootstrap(&mut conn).unwrap();
        let tmp = std::env::temp_dir().join(format!("myspace-favicon-{}", uuid::Uuid::now_v7()));
        let asset_dir = tmp.join("assets");
        std::fs::create_dir_all(&asset_dir).unwrap();
        Self {
            conn,
            asset_dir,
            tmp,
        }
    }

    /// Registers an Embed card whose own favicon asset holds `bytes`.
    fn add_card(&mut self, card: &str, favicon: &str, page_url: &str, bytes: &[u8]) {
        let home: String = self
            .conn
            .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        self.conn
            .execute(
                "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES (?1, ?2, 'embed', 0, 0, 320, 240, 0, 1, 0, 0)",
                rusqlite::params![card, home],
            )
            .unwrap();
        self.conn
            .execute(
                "INSERT INTO embed_cards (card_id, source_url, display_url, title, description_json, description_plain_text, metadata_status) VALUES (?1, ?2, ?2, 'c', '{}', '', 'ready')",
                rusqlite::params![card, page_url],
            )
            .unwrap();
        self.conn
            .execute(
                "INSERT INTO assets (id, file_path, mime_type, file_name, width, height, size_bytes, created_at) VALUES (?1, ?2, 'image/png', 'favicon_32x32.png', NULL, NULL, ?3, 0)",
                rusqlite::params![favicon, format!("{favicon}.png"), bytes.len() as i64],
            )
            .unwrap();
        self.conn
            .execute(
                "UPDATE embed_cards SET favicon_asset_id = ?1 WHERE card_id = ?2",
                rusqlite::params![favicon, card],
            )
            .unwrap();
        std::fs::write(self.asset_dir.join(format!("{favicon}.png")), bytes).unwrap();
    }

    fn collapse(&mut self) -> i64 {
        myspace_lib::domain::link_metadata::collapse_favicon_duplicates(
            &mut self.conn,
            &self.asset_dir,
        )
        .unwrap()
    }

    fn favicon_of(&self, card: &str) -> String {
        self.conn
            .query_row(
                "SELECT favicon_asset_id FROM embed_cards WHERE card_id = ?1",
                [card],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn cache_asset_for(&self, key: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT asset_id FROM favicon_cache WHERE source_url = ?1",
                [key],
                |r| r.get(0),
            )
            .ok()
    }
}

impl Drop for FaviconFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.tmp).ok();
    }
}

#[test]
fn collapse_favicon_duplicates_matches_distinct_videos_sharing_a_favicon() {
    // The real case the collapse exists for: distinct videos have distinct page
    // URLs but one favicon, and each card stored its own byte-identical copy
    // before the runtime cache existed. The card on another host keeps its own.
    let mut fixture = FaviconFixture::new();
    fixture.add_card("v1", "f1", "https://www.youtube.com/watch?v=aaa", b"ICON");
    fixture.add_card("v2", "f2", "https://www.youtube.com/watch?v=bbb", b"ICON");
    fixture.add_card("v3", "f3", "https://www.youtube.com/watch?v=ccc", b"ICON");
    fixture.add_card("other", "f4", "https://example.com/article", b"OTHER");

    assert_eq!(fixture.collapse(), 2, "three copies of one icon become one");

    assert_eq!(fixture.favicon_of("v1"), "f1");
    assert_eq!(fixture.favicon_of("v2"), "f1");
    assert_eq!(fixture.favicon_of("v3"), "f1");
    assert_eq!(
        fixture.favicon_of("other"),
        "f4",
        "a different icon survives"
    );

    // The collapse only re-points; removing the orphaned rows and files is the
    // asset GC's job, and it runs right after this at startup.
    let assets: i64 = fixture
        .conn
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap();
    assert_eq!(assets, 4, "no asset row is deleted by the collapse");
}

#[test]
fn collapse_favicon_duplicates_keeps_same_host_icons_that_differ() {
    // Identity is the stored bytes, never the page host: two icons served from
    // one host can be different images, so they must not be merged.
    let mut fixture = FaviconFixture::new();
    fixture.add_card("a", "f1", "https://example.com/one", b"ICON-A");
    fixture.add_card("b", "f2", "https://example.com/two", b"ICON-B");

    assert_eq!(fixture.collapse(), 0, "different bytes stay separate");
    assert_eq!(fixture.favicon_of("a"), "f1");
    assert_eq!(fixture.favicon_of("b"), "f2");
}

#[test]
fn collapse_favicon_duplicates_repoints_the_runtime_cache() {
    // The runtime cache is keyed by favicon URL; the old collapse wrote page URLs
    // into it, which made every lookup miss. Those rows are not identity, so they
    // are dropped, and rows that point at a merged asset follow the merge.
    let mut fixture = FaviconFixture::new();
    fixture.add_card("a", "f1", "https://www.youtube.com/watch?v=aaa", b"ICON");
    fixture.add_card("b", "f2", "https://www.youtube.com/watch?v=bbb", b"ICON");
    for (key, asset) in [
        ("https://www.youtube.com/watch?v=bbb", "f2"),
        ("https://www.youtube.com/favicon.ico", "f2"),
    ] {
        fixture
            .conn
            .execute(
                "INSERT INTO favicon_cache (source_url, asset_id) VALUES (?1, ?2)",
                rusqlite::params![key, asset],
            )
            .unwrap();
    }

    assert_eq!(fixture.collapse(), 1);

    assert_eq!(
        fixture.cache_asset_for("https://www.youtube.com/watch?v=bbb"),
        None,
        "a page URL is not a favicon identity and must not stay in the cache"
    );
    assert_eq!(
        fixture.cache_asset_for("https://www.youtube.com/favicon.ico"),
        Some("f1".to_string()),
        "a real favicon URL follows the merge"
    );
}

#[test]
fn collapse_favicon_duplicates_skips_assets_missing_from_disk() {
    // A missing file is reported by the GC, not by the collapse: skipping it must
    // never merge two assets on the strength of an unreadable file.
    let mut fixture = FaviconFixture::new();
    fixture.add_card("a", "f1", "https://www.youtube.com/watch?v=aaa", b"ICON");
    fixture.add_card("b", "f2", "https://www.youtube.com/watch?v=bbb", b"ICON");
    for missing in ["f1", "f2"] {
        fs::remove_file(fixture.asset_dir.join(format!("{missing}.png"))).unwrap();
    }

    assert_eq!(fixture.collapse(), 0, "nothing is merged without bytes");
    assert_eq!(fixture.favicon_of("a"), "f1");
    assert_eq!(fixture.favicon_of("b"), "f2");
}
