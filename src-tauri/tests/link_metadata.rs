use std::fs;
use std::path::PathBuf;

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::db::{bootstrap, open_in_memory};
use myspace_lib::domain::asset_service;
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::link_metadata::{
    commit_embed_enrichment, enrich_embed_blocking, extract_html_metadata,
    extract_youtube_feed_metadata, plan_embed_enrichment, validate_public_http_url,
    youtube_channel_feed_url, EmbedEnrichmentPlan, FetchError, FetchResponse, MetadataFetcher,
};
use myspace_lib::domain::models::{
    ConvertNoteToEmbedInput, CreateNoteInput, Frame, TrashItem, TrashSelectionInput,
    UpdateCardFrameInput, UpdateEmbedDescriptionInput,
};
use myspace_lib::domain::mutation::Mutation;

/// A file-backed workspace in a unique temp dir, removed on drop.
struct TestWorkspace {
    ws: Workspace,
    root: PathBuf,
}

impl TestWorkspace {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "myspace-link-metadata-{tag}-{}",
            uuid::Uuid::now_v7()
        ));
        let ws = Workspace::open(WorkspacePaths::new(&root)).unwrap();
        Self { ws, root }
    }

    fn asset_dir(&self) -> PathBuf {
        self.ws.paths().assets_dir()
    }

    /// Creates a Note `id` holding `url` and converts it to a pending Embed.
    /// Returns the Embed's revision.
    fn create_pending_embed(&self, id: &str, url: &str) -> i64 {
        let board_id: String = self
            .ws
            .read_blocking(|conn| {
                Ok(
                    conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .unwrap();
        self.ws
            .apply_blocking(Mutation::CreateNote(CreateNoteInput {
                id: id.to_string(),
                board_id,
                frame: Frame {
                    x: 0.0,
                    y: 0.0,
                    width: 320.0,
                    height: 180.0,
                },
                z_index: 1,
                document_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": url.to_string()}]}]}),
            }))
            .unwrap();
        let embed = self
            .ws
            .apply_blocking(Mutation::ConvertNoteToEmbed(ConvertNoteToEmbedInput {
                id: id.to_string(),
                expected_revision: 1,
                source_url: url.to_string(),
                display_url: url.to_string(),
                title: url.to_string(),
                description_json: serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]}),
            }))
            .unwrap()
            .into_embed()
            .unwrap();
        embed.revision
    }

    fn count(&self, sql: &'static str) -> i64 {
        self.ws
            .read_blocking(|conn| Ok(conn.query_row(sql, [], |r| r.get(0))?))
            .unwrap()
    }

    fn asset_files(&self) -> usize {
        fs::read_dir(self.asset_dir())
            .map(|entries| entries.count())
            .unwrap_or(0)
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

struct StubFetcher {
    page: Result<FetchResponse, FetchError>,
    image: Option<FetchResponse>,
    image_calls: std::sync::atomic::AtomicUsize,
}

impl StubFetcher {
    fn new(page: Result<FetchResponse, FetchError>, image: Option<FetchResponse>) -> Self {
        Self {
            page,
            image,
            image_calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn image_calls(&self) -> usize {
        self.image_calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl MetadataFetcher for StubFetcher {
    fn fetch_text(&self, _url: &str) -> Result<FetchResponse, FetchError> {
        self.page.clone()
    }

    fn fetch_image(&self, _url: &str) -> Result<FetchResponse, FetchError> {
        self.image_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.image
            .clone()
            .ok_or_else(|| FetchError::Network("missing image".to_string()))
    }
}

fn html_page(body: &[u8]) -> Result<FetchResponse, FetchError> {
    Ok(FetchResponse {
        final_url: "https://example.com/page".to_string(),
        mime_type: "text/html".to_string(),
        bytes: body.to_vec(),
    })
}

fn png(bytes: &[u8]) -> Option<FetchResponse> {
    Some(FetchResponse {
        final_url: "https://example.com/preview.png".to_string(),
        mime_type: "image/png".to_string(),
        bytes: bytes.to_vec(),
    })
}

const FULL_PAGE: &[u8] = br#"
  <meta property="og:site_name" content="Example">
  <meta property="og:title" content="Example Title">
  <meta property="og:description" content="Example Description">
  <meta property="og:image" content="https://example.com/preview.png">
  <link rel="icon" href="https://example.com/favicon.png">
"#;

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
    let t = TestWorkspace::new("ready");
    t.create_pending_embed("link-card", "https://example.com/page");
    let fetcher = StubFetcher::new(html_page(FULL_PAGE), png(b"image-bytes"));

    let embed = enrich_embed_blocking(&t.ws, &fetcher, "link-card").unwrap();

    assert_eq!(embed.metadata_status, "ready");
    assert_eq!(embed.title, "Example Title");
    assert_eq!(embed.description_plain_text, "Example Description");
    assert_eq!(embed.site_name.as_deref(), Some("Example"));
    assert_eq!(embed.preview_origin.as_deref(), Some("fetched"));
    assert!(embed.preview_asset.is_some());
    assert!(embed.favicon_asset.is_some());

    let preview = embed.preview_asset.unwrap();
    assert_eq!(
        fs::read(t.asset_dir().join(preview.file_path)).unwrap(),
        b"image-bytes"
    );
    // Preview and favicon have identical bytes in this stub, so hash dedup
    // (P1.2) stores one asset for both; the favicon is cached by its URL.
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 1);
    assert_eq!(
        embed.favicon_asset.as_ref().map(|a| a.id.clone()),
        Some(preview.id.clone())
    );
    let cached: String = t
        .ws
        .read_blocking(|conn| {
            Ok(conn.query_row(
                "SELECT asset_id FROM favicon_cache WHERE source_url = 'https://example.com/favicon.png'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(Some(cached), embed.favicon_asset.map(|a| a.id));
}

#[test]
fn enrich_embed_persists_failed_status_without_losing_source() {
    let t = TestWorkspace::new("failed");
    t.create_pending_embed("link-card", "https://example.com/page");
    let fetcher = StubFetcher::new(Err(FetchError::Network("offline".to_string())), None);

    let embed = enrich_embed_blocking(&t.ws, &fetcher, "link-card").unwrap();

    assert_eq!(embed.metadata_status, "failed");
    assert_eq!(embed.source_url, "https://example.com/page");
    assert_eq!(embed.title, "https://example.com/page");
    assert!(embed.metadata_error.unwrap().contains("offline"));
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 0);
    assert_eq!(t.asset_files(), 0, "a failed fetch stages nothing");
}

#[test]
fn enrich_reuses_a_cached_favicon_without_fetching_it_again() {
    let t = TestWorkspace::new("favicon-cache");
    t.create_pending_embed("first", "https://example.com/page");
    t.create_pending_embed("second", "https://example.com/page");
    let page = br#"<meta property="og:title" content="T"><link rel="icon" href="https://example.com/favicon.png">"#;

    let fetcher = StubFetcher::new(html_page(page), png(b"ICON"));
    let first = enrich_embed_blocking(&t.ws, &fetcher, "first").unwrap();
    assert_eq!(fetcher.image_calls(), 1);

    // The second card hits the cache: nothing is fetched or staged.
    let plan = plan_embed_enrichment(&t.ws, &fetcher, "second").unwrap();
    assert!(plan.staged_assets.is_empty());
    assert!(plan.favicon_cache_entries.is_empty());
    assert_eq!(fetcher.image_calls(), 1, "a cache hit does not fetch");
    let second =
        t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)))
            .unwrap()
            .into_embed()
            .unwrap();

    let first_icon = first.favicon_asset.expect("first favicon").id;
    assert_eq!(second.favicon_asset.map(|a| a.id), Some(first_icon));
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 1);
    assert_eq!(t.count("SELECT COUNT(*) FROM favicon_cache"), 1);
}

impl TestWorkspace {
    /// Runs the network half of enrichment for `id` and returns the plan with
    /// the paths of its staged files.
    fn plan(&self, fetcher: &StubFetcher, id: &str) -> (EmbedEnrichmentPlan, Vec<PathBuf>) {
        let plan = plan_embed_enrichment(&self.ws, fetcher, id).unwrap();
        let staged = plan
            .staged_assets
            .iter()
            .map(|s| s.file_abs.clone())
            .collect();
        (plan, staged)
    }

    /// Writes through a separate connection: pooled readers never write and
    /// no local mutation changes a Link's source URL (a sync replay can).
    fn raw_execute(&self, sql: &str) {
        rusqlite::Connection::open(self.ws.paths().db_path())
            .unwrap()
            .execute(sql, [])
            .unwrap();
    }
}

#[test]
fn enrichment_applies_after_the_card_was_resized_during_the_fetch() {
    let t = TestWorkspace::new("resized");
    let revision = t.create_pending_embed("link-card", "https://example.com/page");
    let fetcher = StubFetcher::new(html_page(FULL_PAGE), png(b"image-bytes"));
    let (plan, staged) = t.plan(&fetcher, "link-card");
    assert_eq!(staged.len(), 1);

    // The auto-fit resize lands while the fetch is in flight.
    let frame = Frame {
        x: 0.0,
        y: 0.0,
        width: 320.0,
        height: 260.0,
    };
    t.ws.apply_blocking(Mutation::MoveCard(UpdateCardFrameInput {
        id: "link-card".to_string(),
        expected_revision: revision,
        frame,
    }))
    .unwrap();

    let embed =
        t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)))
            .unwrap()
            .into_embed()
            .unwrap();
    assert_eq!(embed.metadata_status, "ready");
    assert_eq!(embed.title, "Example Title");
    assert_eq!(embed.frame, frame, "the concurrent resize is kept");
    assert_eq!(embed.revision, revision + 2);
    assert!(staged.iter().all(|p| p.exists()));
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 1);
}

#[test]
fn a_description_edited_during_the_fetch_survives_enrichment() {
    let t = TestWorkspace::new("edited");
    let revision = t.create_pending_embed("link-card", "https://example.com/page");
    let fetcher = StubFetcher::new(html_page(FULL_PAGE), png(b"image-bytes"));
    // The plan sees an empty description, so it would fill the site one.
    let (plan, _) = t.plan(&fetcher, "link-card");

    t.ws.apply_blocking(Mutation::UpdateEmbedDescription(
        UpdateEmbedDescriptionInput {
            id: "link-card".to_string(),
            expected_revision: revision,
            description_json: serde_json::json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "edited"}]}]}),
            acknowledge_corrupt: false,
        },
    ))
    .unwrap();

    let embed =
        t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)))
            .unwrap()
            .into_embed()
            .unwrap();
    assert_eq!(embed.metadata_status, "ready");
    assert_eq!(embed.title, "Example Title");
    assert_eq!(embed.description_plain_text, "edited");
    assert_eq!(embed.description_origin.as_deref(), Some("user"));
    assert_eq!(embed.revision, revision + 2);
}

#[test]
fn metadata_fetched_for_a_replaced_url_is_dropped_without_error() {
    let t = TestWorkspace::new("url-changed");
    let revision = t.create_pending_embed("link-card", "https://example.com/page");
    let fetcher = StubFetcher::new(html_page(FULL_PAGE), png(b"image-bytes"));
    let (plan, staged) = t.plan(&fetcher, "link-card");
    assert!(staged.iter().all(|p| p.exists()));

    t.raw_execute(
        "UPDATE embed_cards SET source_url = 'https://other.example/' WHERE card_id = 'link-card'",
    );

    let embed =
        t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)))
            .unwrap()
            .into_embed()
            .unwrap();
    assert_eq!(embed.source_url, "https://other.example/");
    assert_eq!(embed.metadata_status, "pending");
    assert_eq!(
        embed.revision, revision,
        "an obsolete result writes nothing"
    );
    assert!(staged.iter().all(|p| !p.exists()), "staged files discarded");
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM favicon_cache"), 0);
}

#[test]
fn metadata_for_a_card_trashed_during_the_fetch_is_not_found() {
    let t = TestWorkspace::new("trashed");
    t.create_pending_embed("link-card", "https://example.com/page");
    let fetcher = StubFetcher::new(html_page(FULL_PAGE), png(b"image-bytes"));
    let (plan, staged) = t.plan(&fetcher, "link-card");

    t.ws.apply_blocking(Mutation::TrashSelection(TrashSelectionInput {
        items: vec![TrashItem {
            id: "link-card".to_string(),
            kind: "embed".to_string(),
        }],
    }))
    .unwrap();

    let result =
        t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)));
    assert!(matches!(result, Err(WorkspaceError::NotFound(_))));
    assert!(staged.iter().all(|p| !p.exists()), "staged files discarded");
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM favicon_cache"), 0);
}

#[test]
fn enrich_preserves_a_user_authored_description() {
    let t = TestWorkspace::new("user-desc");
    let revision = t.create_pending_embed("link-card", "https://example.com/page");

    // A user-authored comment is set before enrichment.
    t.ws
        .apply_blocking(Mutation::UpdateEmbedDescription(UpdateEmbedDescriptionInput {
            id: "link-card".to_string(),
            expected_revision: revision,
            description_json: serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"мой комментарий"}]}]}),
            acknowledge_corrupt: false,
        }))
        .unwrap();

    let fetcher = StubFetcher::new(
        html_page(
            br#"
              <html><head>
                <meta property="og:title" content="Site Title">
                <meta property="og:description" content="Site Description">
              </head></html>
            "#,
        ),
        None,
    );

    let embed = enrich_embed_blocking(&t.ws, &fetcher, "link-card").unwrap();

    assert_eq!(embed.metadata_status, "ready");
    assert_eq!(embed.title, "Site Title");
    // The user's comment wins over the fetched site description.
    assert_eq!(embed.description_plain_text, "мой комментарий");
    assert_eq!(embed.description_origin.as_deref(), Some("user"));
}

#[test]
fn enrich_marks_a_fetched_description_as_site_origin() {
    let t = TestWorkspace::new("site-desc");
    t.create_pending_embed("link-card", "https://example.com/page");

    // No user comment: enrichment fills the description from the site.
    let fetcher = StubFetcher::new(
        html_page(
            br#"
              <html><head>
                <meta property="og:title" content="Site Title">
                <meta property="og:description" content="Site Description">
              </head></html>
            "#,
        ),
        None,
    );

    let embed = enrich_embed_blocking(&t.ws, &fetcher, "link-card").unwrap();

    assert_eq!(embed.description_plain_text, "Site Description");
    assert_eq!(embed.description_origin.as_deref(), Some("site"));
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

#[test]
fn enrich_reuses_an_existing_asset_with_the_same_bytes() {
    // P1.2: with the URL-keyed favicon cache missing (e.g. a different favicon
    // URL serving the same icon), the downloaded bytes are matched by hash and
    // the existing asset is reused; nothing new is staged or left on disk.
    let t = TestWorkspace::new("hash-dedup");
    t.create_pending_embed("first", "https://example.com/page");
    t.create_pending_embed("second", "https://example.com/page");
    let fetcher = StubFetcher::new(html_page(FULL_PAGE), png(b"same-bytes"));

    let first = enrich_embed_blocking(&t.ws, &fetcher, "first").unwrap();
    let first_asset = first.preview_asset.expect("preview").id;
    assert_eq!(t.asset_files(), 1);

    // Drop the URL cache from a separate connection (pooled readers never write).
    rusqlite::Connection::open(t.ws.paths().db_path())
        .unwrap()
        .execute("DELETE FROM favicon_cache", [])
        .unwrap();
    let plan = plan_embed_enrichment(&t.ws, &fetcher, "second").unwrap();
    assert!(plan.staged_assets.is_empty(), "hash hit stages nothing");
    assert_eq!(t.asset_files(), 1, "the fresh download was discarded");

    let second =
        t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)))
            .unwrap()
            .into_embed()
            .unwrap();
    assert_eq!(
        second.preview_asset.map(|a| a.id),
        Some(first_asset.clone())
    );
    assert_eq!(second.favicon_asset.map(|a| a.id), Some(first_asset));
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 1);
}

/// Blocks every page fetch until `release`, reporting each entry on `entered`.
struct GatedFetcher {
    entered: std::sync::Mutex<std::sync::mpsc::Sender<()>>,
    gate: (std::sync::Mutex<bool>, std::sync::Condvar),
}

impl GatedFetcher {
    fn release(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}

impl MetadataFetcher for GatedFetcher {
    fn fetch_text(&self, _url: &str) -> Result<FetchResponse, FetchError> {
        self.entered.lock().unwrap().send(()).unwrap();
        let mut open = self.gate.0.lock().unwrap();
        while !*open {
            open = self.gate.1.wait(open).unwrap();
        }
        html_page(FULL_PAGE)
    }

    fn fetch_image(&self, _url: &str) -> Result<FetchResponse, FetchError> {
        Err(FetchError::Network("no images".to_string()))
    }
}

#[test]
fn reads_complete_while_enrichments_wait_on_the_network() {
    // P1.1: the network phase must not hold a pooled reader. With every pool
    // slot's worth of enrichments stuck in a fetch, an ordinary read still runs.
    use myspace_lib::app::workspace::READ_POOL_SIZE;
    use std::time::Duration;

    let t = TestWorkspace::new("network-no-conn");
    let ids: Vec<String> = (0..READ_POOL_SIZE).map(|i| format!("link-{i}")).collect();
    for id in &ids {
        t.create_pending_embed(id, "https://example.com/page");
    }
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let fetcher = GatedFetcher {
        entered: std::sync::Mutex::new(entered_tx),
        gate: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
    };

    let (t, fetcher) = (&t, &fetcher);
    std::thread::scope(|scope| {
        let enrichments: Vec<_> = ids
            .iter()
            .map(|id| scope.spawn(move || enrich_embed_blocking(&t.ws, fetcher, id)))
            .collect();
        let all_entered = ids
            .iter()
            .all(|_| entered_rx.recv_timeout(Duration::from_secs(5)).is_ok());

        let (read_tx, read_rx) = std::sync::mpsc::channel();
        if all_entered {
            scope.spawn(move || {
                let cards = t.count("SELECT COUNT(*) FROM cards");
                read_tx.send(cards).ok();
            });
        }
        let read = read_rx.recv_timeout(Duration::from_secs(2));
        // Release before asserting: on failure the scoped threads would hang.
        fetcher.release();
        let statuses: Vec<_> = enrichments
            .into_iter()
            .map(|e| e.join().unwrap().map(|embed| embed.metadata_status))
            .collect();
        assert!(
            all_entered,
            "an enrichment never reached the network phase: {statuses:?}"
        );
        assert!(
            read.is_ok(),
            "a read was blocked by enrichments in their network phase"
        );
        for status in statuses {
            assert_eq!(status.unwrap(), "ready");
        }
    });
}

#[test]
fn concurrent_enrichments_sharing_a_favicon_store_it_once() {
    // Enrichments in flight at once all miss the favicon cache and the hash
    // lookup before any of them commits; the commit must still store one copy.
    let t = TestWorkspace::new("favicon-race");
    let page = br#"<meta property="og:title" content="T"><link rel="icon" href="https://example.com/favicon.png">"#;
    let fetcher = StubFetcher::new(html_page(page), png(b"ICON"));
    let ids: Vec<String> = (0..5).map(|i| format!("link-{i}")).collect();
    for id in &ids {
        t.create_pending_embed(id, "https://example.com/page");
    }

    let plans: Vec<_> = ids
        .iter()
        .map(|id| plan_embed_enrichment(&t.ws, &fetcher, id).unwrap())
        .collect();
    assert_eq!(t.asset_files(), ids.len(), "each plan staged its own copy");
    let favicons: Vec<String> = plans
        .into_iter()
        .map(|plan| {
            t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)))
                .unwrap()
                .into_embed()
                .unwrap()
                .favicon_asset
                .expect("favicon")
                .id
        })
        .collect();

    assert!(favicons.iter().all(|id| *id == favicons[0]), "{favicons:?}");
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 1);
    assert_eq!(t.count("SELECT COUNT(*) FROM favicon_cache"), 1);
    assert_eq!(t.asset_files(), 1, "redundant staged copies were removed");
}

#[test]
fn at_most_four_enrichments_fetch_at_once() {
    use myspace_lib::domain::link_metadata::enrich_embed;
    use std::time::Duration;

    let t = TestWorkspace::new("enrich-limit");
    let ids: Vec<String> = (0..6).map(|i| format!("link-{i}")).collect();
    for id in &ids {
        t.create_pending_embed(id, "https://example.com/page");
    }
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let fetcher = std::sync::Arc::new(GatedFetcher {
        entered: std::sync::Mutex::new(entered_tx),
        gate: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
    });

    let runtime = tokio::runtime::Runtime::new().unwrap();
    let tasks: Vec<_> = ids
        .iter()
        .map(|id| {
            let (ws, fetcher, id) = (t.ws.clone(), fetcher.clone(), id.clone());
            runtime.spawn(async move { enrich_embed(&ws, fetcher, id).await })
        })
        .collect();
    let mut entered = 0;
    while entered_rx.recv_timeout(Duration::from_secs(1)).is_ok() {
        entered += 1;
    }
    fetcher.release();
    for task in tasks {
        let embed = runtime.block_on(task).unwrap().unwrap();
        assert_eq!(embed.metadata_status, "ready");
    }
    assert_eq!(entered, 4, "enrichments fetching at once");
}

/// Serves every image except favicons, so a plan stages only its preview.
struct PreviewOnlyFetcher {
    page: Result<FetchResponse, FetchError>,
}

impl MetadataFetcher for PreviewOnlyFetcher {
    fn fetch_text(&self, _url: &str) -> Result<FetchResponse, FetchError> {
        self.page.clone()
    }

    fn fetch_image(&self, url: &str) -> Result<FetchResponse, FetchError> {
        if url.contains("favicon") {
            return Err(FetchError::Network("no favicon".to_string()));
        }
        Ok(png(b"SAME-PREVIEW").unwrap())
    }
}

fn preview_page(image_url: &str) -> PreviewOnlyFetcher {
    let body = format!(
        r#"<meta property="og:title" content="T"><meta property="og:image" content="{image_url}">"#
    );
    PreviewOnlyFetcher {
        page: html_page(body.as_bytes()),
    }
}

#[test]
fn concurrent_previews_with_the_same_bytes_store_them_once() {
    // Different preview URLs, identical bytes, both planned before either
    // commits: the hash check at commit time keeps one asset and one file.
    let t = TestWorkspace::new("preview-race");
    t.create_pending_embed("first", "https://example.com/page");
    t.create_pending_embed("second", "https://example.com/page");
    let first_plan = plan_embed_enrichment(
        &t.ws,
        &preview_page("https://a.example.com/one.png"),
        "first",
    )
    .unwrap();
    let second_plan = plan_embed_enrichment(
        &t.ws,
        &preview_page("https://b.example.com/two.png"),
        "second",
    )
    .unwrap();
    assert_eq!(t.asset_files(), 2);

    let previews: Vec<String> = [first_plan, second_plan]
        .into_iter()
        .map(|plan| {
            let embed =
                t.ws.apply_blocking(Mutation::ApplyEmbedMetadata(Box::new(plan)))
                    .unwrap()
                    .into_embed()
                    .unwrap();
            assert!(embed.favicon_asset.is_none());
            embed.preview_asset.expect("preview").id
        })
        .collect();

    assert_eq!(previews[0], previews[1]);
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 1);
    assert_eq!(t.count("SELECT COUNT(*) FROM favicon_cache"), 0);
    assert_eq!(t.asset_files(), 1);
}

#[test]
fn committing_the_same_plan_twice_keeps_its_files() {
    // A busy retry after the commit runs the commit again with the same plan:
    // the rows it finds are its own, not duplicates to drop.
    let t = TestWorkspace::new("commit-retry");
    t.create_pending_embed("link-card", "https://example.com/page");
    let fetcher = StubFetcher::new(html_page(FULL_PAGE), png(b"image-bytes"));
    let (plan, staged) = t.plan(&fetcher, "link-card");
    assert_eq!(staged.len(), 1);

    let mut conn = rusqlite::Connection::open(t.ws.paths().db_path()).unwrap();
    let first = commit_embed_enrichment(&mut conn, &plan).unwrap();
    let second = commit_embed_enrichment(&mut conn, &plan).unwrap();

    assert_eq!(
        first.preview_asset.map(|a| a.id),
        second.preview_asset.map(|a| a.id)
    );
    assert!(staged[0].exists(), "the committed asset's file was deleted");
    assert_eq!(t.count("SELECT COUNT(*) FROM assets"), 1);
}
