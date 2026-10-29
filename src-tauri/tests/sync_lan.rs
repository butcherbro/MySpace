//! ADR-0011 S3: the LAN transport end to end, without mDNS. Real workspaces
//! in temp dirs, real HTTPS servers on 127.0.0.1 with random ports, pairing
//! through the HTTP flow with a code, sync passes driven by hand.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use myspace_lib::app::{Workspace, WorkspacePaths};
use myspace_lib::domain::asset_service;
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{
    AssetDto, CreateChildBoardInput, CreateImageCardInput, CreateNoteInput, Frame,
    UpdateViewportInput,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::domain::plain_text::plain_text_to_document;
use myspace_lib::repositories::workspace_repository;
use myspace_lib::sync::lan::{LanConfig, LanSync, NoEvents, SyncEvents, SyncState};
use myspace_lib::sync::pairing::{self, PairMessage};
use myspace_lib::sync::peer_client::PeerClient;
use myspace_lib::sync::peers::{self, PeerOutcome, PeerWrite, TransportIdentity};
use myspace_lib::sync::server::{PairBeginAnswer, PairBeginRequest, PairEnvelope};
use myspace_lib::sync::spake2::{Role, Spake2};
use myspace_lib::sync::tls;

struct Node {
    ws: Workspace,
    lan: Arc<LanSync>,
    dir: PathBuf,
}

impl Node {
    async fn start(tag: &str) -> Self {
        Self::start_with(tag, false).await
    }

    async fn start_with(tag: &str, run_loop: bool) -> Self {
        Self::start_with_events(tag, run_loop, Arc::new(NoEvents)).await
    }

    async fn start_with_events(tag: &str, run_loop: bool, events: Arc<dyn SyncEvents>) -> Self {
        let dir = std::env::temp_dir().join(format!("myspace-lan-{tag}-{}", uuid::Uuid::now_v7()));
        let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
        let lan = LanSync::start(
            ws.clone(),
            LanConfig {
                bind: SocketAddr::from(([127, 0, 0, 1], 0)),
                discovery: false,
                run_loop,
                compact: false,
            },
            events,
        )
        .await
        .unwrap();
        Self { ws, lan, dir }
    }

    fn addr(&self) -> String {
        format!("127.0.0.1:{}", self.lan.port())
    }

    fn socket(&self) -> SocketAddr {
        self.addr().parse().unwrap()
    }

    async fn identity(&self) -> TransportIdentity {
        match self
            .ws
            .apply(Mutation::SyncPeers(PeerWrite::EnsureTransportIdentity))
            .await
            .unwrap()
            .into_peer_outcome()
            .unwrap()
        {
            PeerOutcome::Identity(identity) => identity,
            PeerOutcome::Unit => unreachable!(),
        }
    }

    async fn home(&self) -> String {
        self.ws
            .read(|c| Ok(c.query_row("SELECT root_board_id FROM workspaces", [], |r| r.get(0))?))
            .await
            .unwrap()
    }

    async fn peer_ids(&self) -> Vec<String> {
        self.ws
            .read(peers::list_peers)
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.device_id)
            .collect()
    }

    async fn scalar(&self, sql: &str, arg: &str) -> Option<String> {
        let (sql, arg) = (sql.to_string(), arg.to_string());
        self.ws
            .read(move |c| {
                use rusqlite::OptionalExtension;
                Ok(c.query_row(&sql, [&arg], |r| r.get(0)).optional()?)
            })
            .await
            .unwrap()
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.lan.stop();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn frame(x: f64) -> Frame {
    Frame {
        x,
        y: 40.0,
        width: 240.0,
        height: 160.0,
    }
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

async fn pair(a: &Node, b: &Node) {
    let code = a.lan.begin_pairing().unwrap().code;
    b.lan.pair_with(None, Some(&a.addr()), &code).await.unwrap();
}

/// A board with a note and an image (real file) on `node`.
async fn populate(node: &Node) -> (String, String, String) {
    let board = new_id();
    node.ws
        .apply(Mutation::CreateChildBoard(CreateChildBoardInput {
            parent_board_id: node.home().await,
            board_id: board.clone(),
            portal_card_id: new_id(),
            frame: Frame {
                x: 100.0,
                y: 100.0,
                width: 120.0,
                height: 112.0,
            },
            title: "From A".into(),
        }))
        .await
        .unwrap();
    node.ws
        .apply(Mutation::CreateNote(CreateNoteInput {
            id: new_id(),
            board_id: board.clone(),
            frame: frame(10.0),
            z_index: 1,
            document_json: plain_text_to_document("hello over the LAN"),
        }))
        .await
        .unwrap();
    let bytes = b"\x89PNG not really, but bytes".to_vec();
    let staged = asset_service::stage_asset_bytes(
        &node.ws.paths().assets_dir(),
        "photo.png",
        "image/png",
        &bytes,
    )
    .unwrap();
    let asset = staged.asset.clone();
    node.ws
        .apply(Mutation::InsertAsset(asset.clone()))
        .await
        .unwrap();
    node.ws
        .apply(Mutation::CreateImageCard(CreateImageCardInput {
            id: new_id(),
            board_id: board.clone(),
            frame: frame(300.0),
            z_index: 2,
            asset_id: asset.id.clone(),
            caption_json: plain_text_to_document("caption"),
        }))
        .await
        .unwrap();
    (board, asset.file_path, asset.sha256.unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pairing_then_one_pass_moves_rows_and_blobs() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    pair(&a, &b).await;
    assert_eq!(a.peer_ids().await, vec![b.lan.device_id().to_string()]);
    assert_eq!(b.peer_ids().await, vec![a.lan.device_id().to_string()]);

    let (board, file, sha) = populate(&a).await;
    let report = b.lan.sync_now().await;
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(report.peers_synced, 1);
    assert!(report.rows_received >= 4, "{report:?}");
    assert_eq!(report.blobs_fetched, 1);
    assert!(report.touched_boards.contains(&board), "{report:?}");

    assert_eq!(
        b.scalar("SELECT title FROM boards WHERE id = ?1", &board)
            .await
            .as_deref(),
        Some("From A")
    );
    assert_eq!(
        b.scalar(
            "SELECT n.plain_text FROM note_cards n JOIN cards c ON c.id = n.card_id WHERE c.board_id = ?1",
            &board
        )
        .await
        .as_deref(),
        Some("hello over the LAN")
    );
    let blob = std::fs::read(b.ws.paths().assets_dir().join(&file)).unwrap();
    assert_eq!(asset_service::sha256_hex(&blob), sha);
    // No temp files left behind.
    let leftovers: Vec<_> = std::fs::read_dir(b.ws.paths().assets_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("part"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // Peer bookkeeping.
    let state = b.lan.state().await.unwrap();
    assert_eq!(state.peers.len(), 1);
    assert!(state.peers[0].online);
    assert!(state.peers[0].last_sync_at.is_some());
    assert_eq!(state.peers[0].last_error, None);

    // Symmetric: a write on B reaches A by A's own pull.
    let note = new_id();
    b.ws.apply(Mutation::CreateNote(CreateNoteInput {
        id: note.clone(),
        board_id: board.clone(),
        frame: frame(600.0),
        z_index: 3,
        document_json: plain_text_to_document("reply from B"),
    }))
    .await
    .unwrap();
    let report = a.lan.sync_now().await;
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(
        a.scalar(
            "SELECT plain_text FROM note_cards WHERE card_id = ?1",
            &note
        )
        .await
        .as_deref(),
        Some("reply from B")
    );
    // Nothing left to pull: a second pass is empty.
    assert_eq!(b.lan.sync_now().await.rows_received, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_blob_transfers_and_verifies() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    pair(&a, &b).await;

    let bytes: Vec<u8> = (0..40usize << 20).map(|i| (i % 253) as u8).collect();
    let staged = asset_service::stage_asset_bytes(
        &a.ws.paths().assets_dir(),
        "video.bin",
        "application/octet-stream",
        &bytes,
    )
    .unwrap();
    let sha = staged.asset.sha256.clone().unwrap();
    a.ws.apply(Mutation::InsertAsset(staged.asset))
        .await
        .unwrap();
    drop(bytes);

    let client = PeerClient::pinned(&b.identity().await, a.lan.fingerprint(), a.socket()).unwrap();
    let dest = b.dir.join("big.part");
    assert!(client.fetch_blob(&sha, &dest).await.unwrap());
    let got = std::fs::read(&dest).unwrap();
    assert_eq!(got.len(), 40 << 20);
    assert_eq!(asset_service::sha256_hex(&got), sha);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpaired_and_impostor_clients_are_refused() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    let c = Node::start("c").await;
    pair(&a, &b).await;

    // C is not paired: its (valid, self-signed) client cert gets 403.
    let c_client =
        PeerClient::pinned(&c.identity().await, a.lan.fingerprint(), a.socket()).unwrap();
    let err = c_client.changes(&Default::default(), 10).await.unwrap_err();
    assert!(
        matches!(&err, WorkspaceError::Sync(m) if m.contains("403")),
        "{err:?}"
    );
    assert!(c_client.info().await.is_err());
    assert!(c_client
        .fetch_blob(&"0".repeat(64), &c.dir.join("x"))
        .await
        .is_err());

    // C claims to be B (header) with its own certificate: 403.
    let mut impostor = c.identity().await;
    impostor.device_id = b.lan.device_id().to_string();
    let spoof = PeerClient::pinned(&impostor, a.lan.fingerprint(), a.socket()).unwrap();
    let err = spoof.info().await.unwrap_err();
    assert!(
        matches!(&err, WorkspaceError::Sync(m) if m.contains("403")),
        "{err:?}"
    );

    // B, paired, is served.
    let b_client =
        PeerClient::pinned(&b.identity().await, a.lan.fingerprint(), a.socket()).unwrap();
    assert_eq!(b_client.info().await.unwrap().device_id, a.lan.device_id());

    // A client pinning the wrong server fingerprint refuses to talk.
    let wrong_pin =
        PeerClient::pinned(&b.identity().await, c.lan.fingerprint(), a.socket()).unwrap();
    assert!(wrong_pin.info().await.is_err());

    // No client certificate at all: the TLS handshake fails.
    let config = rustls::ClientConfig::builder_with_provider(tls::provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(tls::PinnedServerVerifier::new(a.lan.fingerprint()))
        .with_no_client_auth();
    let anonymous = reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .no_proxy()
        .build()
        .unwrap();
    assert!(anonymous
        .get(format!("https://{}/pair", a.addr()))
        .send()
        .await
        .is_err());

    // After A unpairs B, B is refused too; B's pass reports the refusal.
    a.lan.unpair(b.lan.device_id()).await.unwrap();
    let err = b_client.cursors().await.unwrap_err();
    assert!(
        matches!(&err, WorkspaceError::Sync(m) if m.contains("403")),
        "{err:?}"
    );
    let report = b.lan.sync_now().await;
    assert_eq!(report.peers_synced, 0);
    assert_eq!(report.errors.len(), 1, "{report:?}");
    let state = b.lan.state().await.unwrap();
    assert!(!state.peers[0].online);
    assert!(state.peers[0]
        .last_error
        .as_deref()
        .unwrap()
        .contains("403"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_code_is_refused_and_five_failures_burn_it() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;

    // No code shown on A.
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), "12345678")
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("not showing"), "{err}");

    let code = a.lan.begin_pairing().unwrap().code;
    let wrong = if code == "00000000" {
        "00000001"
    } else {
        "00000000"
    };
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), wrong)
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("wrong code"), "{err}");
    assert!(a.peer_ids().await.is_empty());
    assert!(b.peer_ids().await.is_empty());
    // Malformed codes never reach the network; a 6-digit one (shown by a
    // build before SPAKE2) says to update the other device.
    assert!(matches!(
        b.lan.pair_with(None, Some(&a.addr()), "1234567").await,
        Err(WorkspaceError::ConstraintViolation(_))
    ));
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), "123 456")
        .await
        .unwrap_err();
    assert!(
        matches!(&err, WorkspaceError::ConstraintViolation(m) if m.contains("update MySpace on the other device")),
        "{err}"
    );

    // The right code still works (attempt 2 of 5)...
    b.lan.pair_with(None, Some(&a.addr()), &code).await.unwrap();
    assert_eq!(a.peer_ids().await.len(), 1);
    // ...and is burnt once used.
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), &code)
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("not showing"), "{err}");

    // Five wrong answers burn a code: the right one is refused afterwards.
    let code = a.lan.begin_pairing().unwrap().code;
    let wrong = if code == "00000000" {
        "00000001"
    } else {
        "00000000"
    };
    for _ in 0..4 {
        let err = b
            .lan
            .pair_with(None, Some(&a.addr()), wrong)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("wrong code"), "{err}");
    }
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), wrong)
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("too many attempts"), "{err}");
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), &code)
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("not showing"), "{err}");

    // Pairing with oneself is refused.
    let code = a.lan.begin_pairing().unwrap().code;
    assert!(a.lan.pair_with(None, Some(&a.addr()), &code).await.is_err());
}

/// An asset row on `node` named `file_path`, with its file.
async fn insert_raw_asset(node: &Node, file_path: &str, bytes: &[u8]) -> String {
    let dir = node.ws.paths().assets_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(file_path), bytes).unwrap();
    let sha = asset_service::sha256_hex(bytes);
    node.ws
        .apply(Mutation::InsertAsset(AssetDto {
            id: new_id(),
            file_name: file_path.into(),
            mime_type: "application/octet-stream".into(),
            width: None,
            height: None,
            size_bytes: bytes.len() as i64,
            file_path: file_path.into(),
            sha256: Some(sha.clone()),
        }))
        .await
        .unwrap();
    sha
}

/// Ряды ассетов с именами временных файлов прежних сборок (и любыми не
/// `<id>.<ext>`) пир не принимает: передача их не качает по кругу и не
/// пишет в одноимённые файлы (их может держать жёсткой ссылкой бэкап).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn asset_rows_not_named_after_their_id_are_refused() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    pair(&a, &b).await;

    let looped = b"named like a download temp file".to_vec();
    let looped_name = format!("sync-{}.part", asset_service::sha256_hex(&looped));
    insert_raw_asset(&a, &looped_name, &looped).await;
    insert_raw_asset(&a, "pic.png.sync-part", b"forged bytes").await;
    let (_, file, sha) = populate(&a).await;

    // B already holds `pic.png.sync-part`, hard-linked by a backup.
    let kept = b"a file a snapshot links".to_vec();
    let b_assets = b.ws.paths().assets_dir();
    std::fs::create_dir_all(&b_assets).unwrap();
    std::fs::write(b_assets.join("pic.png.sync-part"), &kept).unwrap();
    let link = b.dir.join("snapshot-link");
    std::fs::hard_link(b_assets.join("pic.png.sync-part"), &link).unwrap();

    let report = b.lan.sync_now().await;
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(report.blobs_fetched, 1, "{report:?}");
    let blob = std::fs::read(b_assets.join(&file)).unwrap();
    assert_eq!(asset_service::sha256_hex(&blob), sha);
    assert!(!b_assets.join(&looped_name).exists());
    assert_eq!(
        std::fs::read(b_assets.join("pic.png.sync-part")).unwrap(),
        kept
    );
    assert_eq!(std::fs::read(&link).unwrap(), kept, "the linked file");
    let refused: i64 =
        b.ws.read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM assets WHERE file_path IN ('pic.png.sync-part')
                    OR file_path LIKE 'sync-%'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(refused, 0);

    // Nothing is missing any more: no download repeats.
    let report = b.lan.sync_now().await;
    assert_eq!(report.blobs_fetched, 0, "{report:?}");
    let dir = b_assets.clone();
    let missing =
        b.ws.read(move |c| myspace_lib::sync::journal::missing_blobs(c, &dir))
            .await
            .unwrap();
    assert!(missing.is_empty(), "{missing:?}");
    assert!(!b_assets
        .join(myspace_lib::sync::lan::SYNC_TEMP_DIR)
        .exists());
}

/// Files an interrupted transfer left in the temp dir are removed by the
/// next pass and never block it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_transfer_files_are_cleaned_up() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    pair(&a, &b).await;
    let (_, file, sha) = populate(&a).await;

    let temp =
        b.ws.paths()
            .assets_dir()
            .join(myspace_lib::sync::lan::SYNC_TEMP_DIR);
    std::fs::create_dir_all(&temp).unwrap();
    std::fs::write(temp.join(format!("blob-{sha}")), b"half a download").unwrap();
    std::fs::write(temp.join(format!("file-{file}")), b"half a copy").unwrap();

    let report = b.lan.sync_now().await;
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(report.blobs_fetched, 1);
    let blob = std::fs::read(b.ws.paths().assets_dir().join(&file)).unwrap();
    assert_eq!(asset_service::sha256_hex(&blob), sha);
    assert!(!temp.exists());
}

/// Остаток, который очистка не может удалить (здесь каталог под именем
/// временного файла), не блокирует загрузку: у каждой передачи свежее имя.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unremovable_leftover_never_blocks_a_transfer() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    pair(&a, &b).await;
    let (_, file, sha) = populate(&a).await;

    let temp =
        b.ws.paths()
            .assets_dir()
            .join(myspace_lib::sync::lan::SYNC_TEMP_DIR);
    std::fs::create_dir_all(temp.join(format!("blob-{sha}"))).unwrap();
    std::fs::create_dir_all(temp.join(format!("file-{file}"))).unwrap();

    let report = b.lan.sync_now().await;
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(report.blobs_fetched, 1);
    let blob = std::fs::read(b.ws.paths().assets_dir().join(&file)).unwrap();
    assert_eq!(asset_service::sha256_hex(&blob), sha);
    let left: Vec<_> = std::fs::read_dir(&temp)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_transport_identity_is_stable_and_follows_the_device_id() {
    let a = Node::start("a").await;
    let first = a.identity().await;
    assert_eq!(first.fingerprint, a.lan.fingerprint());
    assert_eq!(a.identity().await.fingerprint, first.fingerprint);
    assert_eq!(
        tls::fingerprint_of_pem(&first.cert_pem).unwrap(),
        first.fingerprint
    );
    assert!(!format!("{first:?}").contains("PRIVATE"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_the_loop_running_a_local_write_reaches_the_peer_by_itself() {
    let a = Node::start_with("a", true).await;
    let b = Node::start_with("b", true).await;
    pair(&a, &b).await;
    // Let the post-pairing passes settle.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let (board, _, _) = populate(&a).await;
    // A's write → debounce → A pokes B → B pulls. Well under B's 5 s tick.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        if b.scalar("SELECT title FROM boards WHERE id = ?1", &board)
            .await
            .is_some()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "B never pulled A's write"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Creates a child board titled `title` under `home` through `ws`.
async fn create_board(ws: &Workspace, home: String, title: &str) -> String {
    let board = new_id();
    ws.apply(Mutation::CreateChildBoard(CreateChildBoardInput {
        parent_board_id: home,
        board_id: board.clone(),
        portal_card_id: new_id(),
        frame: frame(10.0),
        title: title.into(),
    }))
    .await
    .unwrap();
    board
}

/// Waits until `node` holds `board`; `None` once `within` has passed.
async fn arrival(
    node: &Node,
    board: &str,
    within: std::time::Duration,
) -> Option<std::time::Duration> {
    let start = std::time::Instant::now();
    while start.elapsed() < within {
        if node
            .scalar("SELECT title FROM boards WHERE id = ?1", board)
            .await
            .is_some()
        {
            return Some(start.elapsed());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_the_loop_running_another_process_write_reaches_the_peer_by_itself() {
    let a = Node::start_with("a", true).await;
    let b = Node::start_with("b", true).await;
    pair(&a, &b).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // A write on B makes B's loop pass and poke A: once A holds it, B's loop
    // has just restarted its TICK wait, so B will not pull by itself for ~5 s.
    let marker = create_board(&b.ws, b.home().await, "From B").await;
    arrival(&a, &marker, std::time::Duration::from_secs(4))
        .await
        .expect("A never pulled B's write");

    // The MCP server: a second workspace on A's database, with its own writer
    // connection and its own `local_writes` that A's loop never hears.
    let mcp = Workspace::open_existing(WorkspacePaths::new(&a.dir)).unwrap();
    let board = create_board(&mcp, a.home().await, "From MCP").await;
    arrival(&b, &board, std::time::Duration::from_secs(4))
        .await
        .expect("B did not pull the other process's write well under the 5 s tick");
}

/// Counts user-visible passes: the rising edges of `syncing`. Only a forced
/// pass (a local or foreign write, a wake) shows as syncing; a tick does not.
#[derive(Default)]
struct PassCounter {
    syncing: std::sync::Mutex<bool>,
    passes: std::sync::atomic::AtomicUsize,
}

impl PassCounter {
    fn get(&self) -> usize {
        self.passes.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl SyncEvents for PassCounter {
    fn state(&self, state: &SyncState) {
        let mut syncing = self.syncing.lock().unwrap();
        if state.syncing && !*syncing {
            self.passes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        *syncing = state.syncing;
    }

    fn applied(&self, _: &[String]) {}
}

/// A with its loop and a pass counter, paired with B (no loop), settled.
async fn counted_pair() -> (Node, Node, Arc<PassCounter>) {
    let counter = Arc::new(PassCounter::default());
    let a = Node::start_with_events("a", true, counter.clone()).await;
    let b = Node::start("b").await;
    pair(&a, &b).await;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    (a, b, counter)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_by_this_process_is_announced_once() {
    let (a, _b, counter) = counted_pair().await;
    let before = counter.get();
    create_board(&a.ws, a.home().await, "Own").await;
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    // The local-write pass only; the foreign-write poll does not fire too.
    assert_eq!(counter.get() - before, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_non_journaled_write_by_another_process_triggers_no_pass() {
    let (a, _b, counter) = counted_pair().await;
    let mcp = Workspace::open_existing(WorkspacePaths::new(&a.dir)).unwrap();
    let home = a.home().await;
    let revision = {
        let home = home.clone();
        a.ws.read(move |c| {
            workspace_repository::load_board_snapshot(c, &home).map(|s| s.viewport.revision)
        })
        .await
        .unwrap()
    };
    let before = counter.get();
    mcp.apply(Mutation::SaveViewport(UpdateViewportInput {
        board_id: home,
        expected_revision: revision,
        x: 10.0,
        y: 20.0,
        zoom: 1.5,
    }))
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(counter.get() - before, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_journaled_write_by_another_process_triggers_a_pass() {
    // Writes land at different phases of the poll; each must be seen by the
    // next poll or the one after, whatever else committed around it.
    let (a, _b, counter) = counted_pair().await;
    let mcp = Workspace::open_existing(WorkspacePaths::new(&a.dir)).unwrap();
    for step in 0..5u64 {
        tokio::time::sleep(std::time::Duration::from_millis(step * 110)).await;
        let before = counter.get();
        create_board(&mcp, a.home().await, "From MCP").await;
        if step % 2 == 1 {
            // An own write right behind it: its pass may announce both.
            create_board(&a.ws, a.home().await, "Own").await;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        while counter.get() == before {
            assert!(
                std::time::Instant::now() < deadline,
                "write {step} by another process triggered no pass"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // Let the triggered pass (and any own-write pass) finish.
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    }
}

// ---- pairing protocol v2 (SPAKE2) ------------------------------------------

/// A pairing-style client presenting `identity`, accepting any server cert.
fn raw_client(identity: &TransportIdentity) -> reqwest::Client {
    let config = tls::client_config(identity, tls::PairingServerVerifier::new(None)).unwrap();
    reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .no_proxy()
        .build()
        .unwrap()
}

async fn post_json(
    http: &reqwest::Client,
    node: &Node,
    path: &str,
    body: &impl serde::Serialize,
) -> reqwest::Response {
    http.post(format!("https://{}{path}", node.addr()))
        .json(body)
        .send()
        .await
        .unwrap()
}

/// Runs `/pair/begin` against `server` as `client` (Bob) with `code`.
async fn begin_as(
    http: &reqwest::Client,
    client_fp: &str,
    server: &Node,
    code: &str,
) -> reqwest::Response {
    let (_run, msg) = Spake2::start(Role::Bob, client_fp, server.lan.fingerprint(), code).unwrap();
    post_json(
        http,
        server,
        "/pair/begin",
        &PairBeginRequest {
            msg: pairing::hex_lower(&msg),
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pairing_works_in_both_directions_and_stores_both_sides() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    pair(&a, &b).await;
    assert_eq!(a.peer_ids().await, vec![b.lan.device_id().to_string()]);
    assert_eq!(b.peer_ids().await, vec![a.lan.device_id().to_string()]);

    let c = Node::start("c").await;
    let d = Node::start("d").await;
    // D shows the code, C types it.
    pair(&d, &c).await;
    assert_eq!(c.peer_ids().await, vec![d.lan.device_id().to_string()]);
    assert_eq!(d.peer_ids().await, vec![c.lan.device_id().to_string()]);
    let c_client =
        PeerClient::pinned(&c.identity().await, d.lan.fingerprint(), d.socket()).unwrap();
    assert_eq!(c_client.info().await.unwrap().device_id, d.lan.device_id());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pairing_endpoint_advertises_protocol_two() {
    let a = Node::start("a").await;
    let c = Node::start("c").await;
    let hello: serde_json::Value = raw_client(&c.identity().await)
        .get(format!("https://{}/pair", a.addr()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hello["pairing"], 2, "{hello}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_begin_without_confirm_uses_up_an_attempt() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    let m = Node::start("m").await;
    let http = raw_client(&m.identity().await);
    let code = a.lan.begin_pairing().unwrap().code;
    // Each begin is one guess, confirmed or not.
    for _ in 0..5 {
        let resp = begin_as(&http, m.lan.fingerprint(), &a, "00000000").await;
        assert_eq!(resp.status(), 200);
    }
    let resp = begin_as(&http, m.lan.fingerprint(), &a, "00000000").await;
    assert_eq!(resp.status(), 429);
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), &code)
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("too many attempts"), "{err}");
    assert!(a.peer_ids().await.is_empty());

    // An undecodable message also counts: after it only four begins pass.
    a.lan.begin_pairing().unwrap();
    let resp = post_json(
        &http,
        &a,
        "/pair/begin",
        &PairBeginRequest { msg: "zz".into() },
    )
    .await;
    assert_eq!(resp.status(), 400);
    for _ in 0..4 {
        let resp = begin_as(&http, m.lan.fingerprint(), &a, "00000000").await;
        assert_eq!(resp.status(), 200);
    }
    let resp = begin_as(&http, m.lan.fingerprint(), &a, "00000000").await;
    assert_eq!(resp.status(), 429);
}

/// `POST /pair` from `http` for `session` with `proof`.
async fn confirm_as(
    http: &reqwest::Client,
    server: &Node,
    session: String,
    device_id: &str,
    client_fp: &str,
    proof: String,
) -> reqwest::Response {
    post_json(
        http,
        server,
        "/pair",
        &PairEnvelope {
            message: PairMessage {
                device_id: device_id.to_string(),
                name: "M".into(),
                fingerprint: client_fp.to_string(),
                proof,
            },
            session: Some(session),
            port: None,
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_cannot_be_confirmed_under_another_certificate() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    let m = Node::start("m").await;
    let code = a.lan.begin_pairing().unwrap().code;
    let b_fp = b.lan.fingerprint().to_string();
    // B begins honestly with the right code...
    let (run, msg_b) = Spake2::start(Role::Bob, &b_fp, a.lan.fingerprint(), &code).unwrap();
    let b_http = raw_client(&b.identity().await);
    let resp = post_json(
        &b_http,
        &a,
        "/pair/begin",
        &PairBeginRequest {
            msg: pairing::hex_lower(&msg_b),
        },
    )
    .await;
    let begun: PairBeginAnswer = resp.json().await.unwrap();
    let key = run
        .finish(&pairing::decode_hex(&begun.msg).unwrap())
        .unwrap();
    let proof = pairing::proof(&key[..], &b_fp, a.lan.fingerprint());
    // ...M replays the confirmation over its own TLS (its own fingerprint, as
    // A checks): the session is not M's.
    let m_http = raw_client(&m.identity().await);
    let resp = confirm_as(
        &m_http,
        &a,
        begun.session.clone(),
        m.lan.device_id(),
        m.lan.fingerprint(),
        proof.clone(),
    )
    .await;
    assert_eq!(resp.status(), 409);
    assert!(a.peer_ids().await.is_empty());
    // B's own confirmation still works.
    let resp = confirm_as(&b_http, &a, begun.session, b.lan.device_id(), &b_fp, proof).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(a.peer_ids().await, vec![b.lan.device_id().to_string()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_relay_that_does_not_know_the_code_completes_neither_side() {
    let a = Node::start("a").await;
    let b = Node::start("b").await;
    let m = Node::start("m").await;
    let (b_fp, m_fp) = (
        b.lan.fingerprint().to_string(),
        m.lan.fingerprint().to_string(),
    );
    let code = a.lan.begin_pairing().unwrap().code;

    // M sits between B and A. B sees M's certificate where A's should be and
    // runs SPAKE2 with the right code; M relays B's message to A unchanged.
    let (b_run, msg_b) = Spake2::start(Role::Bob, &b_fp, &m_fp, &code).unwrap();
    let http = raw_client(&m.identity().await);
    let resp = post_json(
        &http,
        &a,
        "/pair/begin",
        &PairBeginRequest {
            msg: pairing::hex_lower(&msg_b),
        },
    )
    .await;
    assert_eq!(resp.status(), 200);
    let begun: PairBeginAnswer = resp.json().await.unwrap();
    let msg_a = pairing::decode_hex(&begun.msg).unwrap();
    let key_b = b_run.finish(&msg_a).unwrap();
    // M forwards B's confirmation (it has nothing better): A refuses it.
    let resp = post_json(
        &http,
        &a,
        "/pair",
        &PairEnvelope {
            message: PairMessage {
                device_id: b.lan.device_id().to_string(),
                name: "B".into(),
                fingerprint: m_fp.clone(),
                proof: pairing::proof(&key_b[..], &b_fp, &m_fp),
            },
            session: Some(begun.session),
            port: None,
        },
    )
    .await;
    assert_eq!(resp.status(), 403);
    assert!(a.peer_ids().await.is_empty());

    // Without the code, M can only guess one and run SPAKE2 with it on both
    // sides. Its guess is the code its own server shows.
    let guess = m.lan.begin_pairing().unwrap().code;
    assert_ne!(guess, code);
    // Towards A: a correct run with the guess, a correct proof for it; refused.
    let (run, msg) = Spake2::start(Role::Bob, &m_fp, a.lan.fingerprint(), &guess).unwrap();
    let resp = post_json(
        &http,
        &a,
        "/pair/begin",
        &PairBeginRequest {
            msg: pairing::hex_lower(&msg),
        },
    )
    .await;
    let begun: PairBeginAnswer = resp.json().await.unwrap();
    let key = run
        .finish(&pairing::decode_hex(&begun.msg).unwrap())
        .unwrap();
    let resp = confirm_as(
        &http,
        &a,
        begun.session,
        m.lan.device_id(),
        &m_fp,
        pairing::proof(&key[..], &m_fp, a.lan.fingerprint()),
    )
    .await;
    assert_eq!(resp.status(), 403);
    assert!(a.peer_ids().await.is_empty());
    // Towards B (who typed A's code at M's address): M answers with the
    // guess; B's proof fails at M, so M never sends its own.
    let err = b
        .lan
        .pair_with(None, Some(&m.addr()), &code)
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("wrong code"), "{err}");
    assert!(b.peer_ids().await.is_empty());
    assert!(m.peer_ids().await.is_empty());

    // The relay cost A two attempts; the real B still pairs.
    b.lan.pair_with(None, Some(&a.addr()), &code).await.unwrap();
    assert_eq!(b.peer_ids().await, vec![a.lan.device_id().to_string()]);
    assert_eq!(a.peer_ids().await, vec![b.lan.device_id().to_string()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_client_gets_426_with_a_readable_error() {
    let a = Node::start("a").await;
    let old = Node::start("old").await;
    let code = a.lan.begin_pairing().unwrap().code;
    let old_fp = old.lan.fingerprint().to_string();
    // The v1 body: HMAC of the code, no session.
    let body = serde_json::json!({
        "deviceId": old.lan.device_id(),
        "name": "Old Mac",
        "fingerprint": old_fp,
        "proof": "00",
        "port": 1,
    });
    let resp = post_json(&raw_client(&old.identity().await), &a, "/pair", &body).await;
    assert_eq!(resp.status(), 426);
    let answer: serde_json::Value = resp.json().await.unwrap();
    assert!(
        answer["error"].as_str().unwrap().contains("update MySpace"),
        "{answer}"
    );
    assert!(a.peer_ids().await.is_empty());
    // It cost no attempt: the code still works.
    let b = Node::start("b").await;
    b.lan.pair_with(None, Some(&a.addr()), &code).await.unwrap();
}

/// A server that answers `GET /pair` the way MySpace before pairing v2 did,
/// then closes.
async fn old_pairing_server(identity: &TransportIdentity) -> SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls::server_config(identity).unwrap()));
    let body = serde_json::json!({
        "deviceId": identity.device_id,
        "name": "Old Mac",
        "protocol": 1,
        "fingerprint": identity.fingerprint,
    })
    .to_string();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let Ok(mut tls) = acceptor.accept(tcp).await else {
                continue;
            };
            let mut buf = vec![0u8; 16 * 1024];
            let mut read = 0;
            while !buf[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                match tls.read(&mut buf[read..]).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => read += n,
                }
            }
            let request = String::from_utf8_lossy(&buf[..read]).to_string();
            let answer = if request.starts_with("GET /pair ") {
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else {
                "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    .to_string()
            };
            let _ = tls.write_all(answer.as_bytes()).await;
            let _ = tls.shutdown().await;
        }
    });
    addr
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_client_refuses_a_server_without_pairing_two() {
    let b = Node::start("b").await;
    let old = Node::start("old").await;
    let addr = old_pairing_server(&old.identity().await).await;
    let err = b
        .lan
        .pair_with(None, Some(&addr.to_string()), "12345678")
        .await
        .unwrap_err();
    assert!(
        format!("{err}").contains("update MySpace on the other device"),
        "{err}"
    );
    assert!(b.peer_ids().await.is_empty());
}

/// Needs multicast on the host (not available in every CI container): run
/// with `cargo test --test sync_lan -- --ignored`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn mdns_discovers_the_other_device_and_pairs_by_device_id() {
    let start = |tag: &'static str| async move {
        let dir = std::env::temp_dir().join(format!("myspace-mdns-{tag}-{}", uuid::Uuid::now_v7()));
        let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
        let lan = LanSync::start(
            ws.clone(),
            LanConfig {
                bind: SocketAddr::from(([0, 0, 0, 0], 0)),
                discovery: true,
                run_loop: false,
                compact: false,
            },
            Arc::new(NoEvents),
        )
        .await
        .unwrap();
        Node { ws, lan, dir }
    };
    let a = start("a").await;
    let b = start("b").await;
    assert!(b.lan.state().await.unwrap().discovering);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let seen = loop {
        let list = b.lan.discovered().await.unwrap();
        if let Some(d) = list
            .into_iter()
            .find(|d| d.device_id == a.lan.device_id() && !d.addresses.is_empty())
        {
            break d;
        }
        assert!(std::time::Instant::now() < deadline, "A never discovered");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };
    assert_eq!(seen.fingerprint, a.lan.fingerprint());
    assert!(!seen.paired);
    let code = a.lan.begin_pairing().unwrap().code;
    b.lan
        .pair_with(Some(a.lan.device_id()), None, &code)
        .await
        .unwrap();
    assert!(b.lan.discovered().await.unwrap()[0].paired);
}
