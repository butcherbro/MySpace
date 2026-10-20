//! End-to-end MCP journeys over a real stdio pipe: the installed app's
//! `myspace --mcp` entry point, exactly as an agent host launches it.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use myspace_lib::app::{Workspace, WorkspacePaths};
use serde_json::{json, Value};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("myspace-mcp-{tag}-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A workspace the app created (the server never creates or migrates one).
fn app_workspace(tag: &str) -> PathBuf {
    let dir = temp_dir(tag);
    drop(Workspace::open(WorkspacePaths::new(&dir)).unwrap());
    dir
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl Server {
    fn start(data_dir: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_myspace"))
            .args(["--mcp", "--data-dir"])
            .arg(data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn myspace --mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut server = Self {
            child,
            stdin,
            stdout,
            next_id: 0,
        };
        let init = server.request(
            "initialize",
            json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } }),
        );
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        server.notify("notifications/initialized");
        server
    }

    fn notify(&mut self, method: &str) {
        writeln!(
            self.stdin,
            "{}",
            json!({ "jsonrpc": "2.0", "method": method })
        )
        .unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let msg =
            json!({ "jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        let reply: Value = serde_json::from_str(&line).expect("one JSON-RPC message per line");
        assert_eq!(reply["id"], self.next_id);
        reply
    }

    /// Calls a tool and returns its parsed JSON payload, or the error text.
    fn call(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
        let reply = self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        );
        let result = &reply["result"];
        let text = result["content"][0]["text"].as_str().unwrap().to_string();
        if result["isError"] == true {
            Err(text)
        } else {
            Ok(serde_json::from_str(&text).unwrap())
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn png_file(dir: &Path, width: u32, height: u32) -> PathBuf {
    let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    let path = dir.join("picture.png");
    std::fs::write(&path, bytes).unwrap();
    path
}

fn cards_of(board: &Value) -> Vec<Value> {
    board["cards"].as_array().unwrap().clone()
}

#[test]
fn lists_only_the_current_tools() {
    let mut server = Server::start(&app_workspace("tools"));
    let tools = server.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "list_boards",
            "read_board",
            "read_card",
            "create_board",
            "add_items",
            "trash_batch"
        ]
    );
}

#[test]
fn agent_creates_a_board_and_fills_it_with_notes_links_and_images() {
    let dir = app_workspace("journey");
    let picture = png_file(&dir, 800, 400);
    let mut server = Server::start(&dir);

    let boards = server.call("list_boards", json!({})).unwrap();
    assert_eq!(boards["boards"].as_array().unwrap().len(), 1, "only Home");

    let board = server
        .call("create_board", json!({ "title": "Telegram saves" }))
        .unwrap();
    let address = board["address"].as_str().unwrap().to_string();

    let add = json!({
        "board": address,
        "idempotencyKey": "post-42",
        "items": [
            { "kind": "note", "text": "First line\n\nThird line" },
            { "kind": "link", "url": "https://example.com/post", "comment": "worth reading" },
            { "kind": "image", "path": picture, "caption": "chart" }
        ]
    });
    let first = server.call("add_items", add.clone()).unwrap();
    assert_eq!(first["cardIds"].as_array().unwrap().len(), 3);

    // A retry with the same key creates nothing and returns the same batch.
    let retry = server.call("add_items", add).unwrap();
    assert_eq!(retry, first);

    let snapshot = server
        .call("read_board", json!({ "board": address }))
        .unwrap();
    let cards = cards_of(&snapshot);
    assert_eq!(cards.len(), 3);

    let note = cards.iter().find(|c| c["kind"] == "note").unwrap();
    assert_eq!(note["plainText"], "First line\nThird line");
    assert_eq!(note["documentJson"]["content"].as_array().unwrap().len(), 3);

    let link = cards.iter().find(|c| c["kind"] == "embed").unwrap();
    assert_eq!(link["sourceUrl"], "https://example.com/post");
    assert_eq!(
        link["metadataStatus"], "pending",
        "the app enriches it on open"
    );

    let image = cards.iter().find(|c| c["kind"] == "image").unwrap();
    assert_eq!(image["captionPlainText"], "chart");
    assert_eq!(image["asset"]["width"], 800);
    assert_eq!(image["frame"]["width"], 320.0);
    assert_eq!(
        image["frame"]["height"], 160.0,
        "keeps the 2:1 aspect ratio"
    );
    let stored = PathBuf::from(image["asset"]["absolutePath"].as_str().unwrap());
    assert!(stored.is_file(), "a local agent can open the image");

    // Items keep their order, stacked without overlap.
    let ys: Vec<f64> = first["cardIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            let card = cards.iter().find(|c| c["id"] == *id).unwrap();
            card["frame"]["y"].as_f64().unwrap()
        })
        .collect();
    assert!(ys.windows(2).all(|w| w[0] < w[1]), "{ys:?}");

    let card = server
        .call("read_card", json!({ "card": first["cardAddresses"][0] }))
        .unwrap();
    assert_eq!(card["kind"], "note");

    server
        .call("trash_batch", json!({ "batchId": first["batchId"] }))
        .unwrap();
    let after = server
        .call("read_board", json!({ "board": address }))
        .unwrap();
    assert!(cards_of(&after).is_empty());
}

#[test]
fn a_bad_item_rejects_the_whole_batch() {
    let dir = app_workspace("bad-item");
    let mut server = Server::start(&dir);
    let home = server.call("list_boards", json!({})).unwrap()["boards"][0]["id"].clone();

    let not_an_image = dir.join("notes.txt");
    std::fs::write(&not_an_image, "plain text").unwrap();
    let error = server
        .call(
            "add_items",
            json!({
                "board": home,
                "idempotencyKey": "k1",
                "items": [
                    { "kind": "note", "text": "kept only if all succeed" },
                    { "kind": "image", "path": not_an_image }
                ]
            }),
        )
        .unwrap_err();
    assert!(
        error.contains("items[1]") && error.contains("unsupported image"),
        "{error}"
    );

    let error = server
        .call(
            "add_items",
            json!({ "board": home, "idempotencyKey": "k2", "items": [{ "kind": "link", "url": "file:///etc/passwd" }] }),
        )
        .unwrap_err();
    assert!(error.contains("http(s)"), "{error}");

    let board = server.call("read_board", json!({ "board": home })).unwrap();
    assert!(cards_of(&board).is_empty());
}

#[test]
fn a_missing_workspace_fails_fast_without_creating_one() {
    let dir = temp_dir("missing");
    let output = Command::new(env!("CARGO_BIN_EXE_myspace"))
        .args(["--mcp", "--data-dir"])
        .arg(&dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty(), "stdout is the protocol channel");
    assert!(String::from_utf8_lossy(&output.stderr).contains("Start the MySpace app once"));
}
