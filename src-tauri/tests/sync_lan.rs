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
    CreateChildBoardInput, CreateImageCardInput, CreateNoteInput, Frame,
};
use myspace_lib::domain::mutation::Mutation;
use myspace_lib::domain::plain_text::plain_text_to_document;
use myspace_lib::sync::lan::{LanConfig, LanSync, NoEvents};
use myspace_lib::sync::peer_client::PeerClient;
use myspace_lib::sync::peers::{self, PeerOutcome, PeerWrite, TransportIdentity};
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
        let dir = std::env::temp_dir().join(format!("myspace-lan-{tag}-{}", uuid::Uuid::now_v7()));
        let ws = Workspace::open(WorkspacePaths::new(&dir)).unwrap();
        let lan = LanSync::start(
            ws.clone(),
            LanConfig {
                bind: SocketAddr::from(([127, 0, 0, 1], 0)),
                discovery: false,
                run_loop,
            },
            Arc::new(NoEvents),
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
        .pair_with(None, Some(&a.addr()), "123456")
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("not showing"), "{err}");

    let code = a.lan.begin_pairing().unwrap().code;
    let wrong = if code == "000000" { "000001" } else { "000000" };
    let err = b
        .lan
        .pair_with(None, Some(&a.addr()), wrong)
        .await
        .unwrap_err();
    assert!(format!("{err}").contains("wrong code"), "{err}");
    assert!(a.peer_ids().await.is_empty());
    assert!(b.peer_ids().await.is_empty());
    // Malformed codes never reach the network.
    assert!(matches!(
        b.lan.pair_with(None, Some(&a.addr()), "12345").await,
        Err(WorkspaceError::ConstraintViolation(_))
    ));

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
    let wrong = if code == "000000" { "000001" } else { "000000" };
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
