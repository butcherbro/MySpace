//! A local Model Context Protocol (MCP) server over stdio, exposing the MySpace
//! workspace to any MCP-compatible agent host (Claude Desktop, Claude Code,
//! Codex, Cursor, ...) without coupling to a provider (ADR-0005).
//!
//! It ships inside the app: the installed executable runs it with `--mcp`
//! (`myspace --mcp`), so the server is on every machine the app is on, updates
//! with it and always matches the database schema. `cargo run --bin
//! myspace-mcp` runs the same server during development.
//!
//! Tools:
//!   - list_boards   (read)
//!   - read_board    (read)  — resolves myspace://board/<id>
//!   - read_card     (read)  — resolves myspace://card/<id>
//!   - create_board  (write)
//!   - add_items     (write) — idempotent batch of notes, links and images
//!   - trash_batch   (write, destructive) — undoes one add_items batch
//!
//! `add_links`, `enrich_links` and `trash_links` from the first slice stay
//! callable for existing clients but are no longer listed.
//!
//! The server is a thin adapter over `WorkspaceService`, talking JSON-RPC 2.0
//! messages delimited by newlines on stdin/stdout, per the MCP stdio transport.
//! Nothing else may write to stdout: it is the protocol channel.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::app::{Workspace, WorkspacePaths};
use crate::domain::errors::WorkspaceError;
use crate::domain::link_metadata::{enrich_embed_blocking, ReqwestMetadataFetcher};
use crate::domain::models::{BatchItem, CreateItemBatchInput, CreateLinkBatchInput, LinkBatchItem};
use crate::services::workspace_service::{parse_address, WorkspaceService};

/// Newest first; the server answers with the client's version when it is
/// listed, else with the newest. The tools used here are the same in all.
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_NAME: &str = "myspace";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
/// `identifier` in `tauri.conf.json`: Tauri names the app data dir after it.
const APP_IDENTIFIER: &str = "com.bro.myspace";

/// Sent to the agent host on `initialize`; hosts show it to the model as the
/// server's manual. The long form is `docs/agents.md`.
const INSTRUCTIONS: &str = "\
MySpace is the user's local visual workspace: Boards (nested, like folders) holding Cards \
(notes, links, images, sub-board portals). Every entity has a stable address \
myspace://board/<id> or myspace://card/<id>; titles are not unique, so always work with ids.

Typical flow:
1. list_boards to find the target board (or create_board under a parent to make one).
2. add_items to put notes, links and images on it in one batch. Pass a fresh idempotencyKey \
(e.g. a UUID) per logical request and reuse it only when retrying the same request: a retry \
with the same key returns the original result instead of creating duplicates.
3. read_board / read_card to read content back. Image assets include absolutePath, a file you \
can open directly.

Rules: items keep their order and are stacked below the board's existing cards. Notes are \
plain text (line breaks kept, Markdown is not rendered). Links get their preview (title, image) \
when the user opens the board. Images come from a local file path or a public http(s) URL \
(PNG, JPEG, GIF, WebP). trash_batch with the batchId from add_items undoes a whole batch \
(recoverable from the app's Trash). Never delete anything the user did not ask you to.";

/// Where the workspace lives. `--data-dir <dir>` wins, then `--db <file>` (its
/// parent dir), then `MYSPACE_DATA_DIR`, then the app's own data dir.
pub fn resolve_data_dir(args: &[String]) -> Result<PathBuf, String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--data-dir" => {
                return iter
                    .next()
                    .map(PathBuf::from)
                    .ok_or_else(|| "--data-dir needs a directory".to_string());
            }
            "--db" => {
                let db = iter
                    .next()
                    .ok_or_else(|| "--db needs a file path".to_string())?;
                return Path::new(db)
                    .parent()
                    .map(Path::to_path_buf)
                    .ok_or_else(|| format!("--db {db} has no parent directory"));
            }
            _ => {}
        }
    }
    if let Some(dir) = std::env::var_os("MYSPACE_DATA_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    default_data_dir()
}

/// The directory Tauri's `app_data_dir()` resolves to for this app.
fn default_data_dir() -> Result<PathBuf, String> {
    let env_dir = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let base = if cfg!(target_os = "macos") {
        env_dir("HOME").map(|home| home.join("Library").join("Application Support"))
    } else if cfg!(windows) {
        env_dir("APPDATA")
    } else {
        env_dir("XDG_DATA_HOME").or_else(|| env_dir("HOME").map(|h| h.join(".local").join("share")))
    };
    base.map(|b| b.join(APP_IDENTIFIER))
        .ok_or_else(|| "cannot locate the app data dir; pass --data-dir".to_string())
}

/// Entry point for `myspace --mcp` and the `myspace-mcp` dev binary. Serves
/// stdin/stdout until stdin closes; returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let data_dir = match resolve_data_dir(args) {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("myspace-mcp: {err}");
            return 2;
        }
    };
    let paths = WorkspacePaths::new(&data_dir);
    let db_path = paths.db_path();
    let ws = match Workspace::open_existing(paths) {
        Ok(ws) => ws,
        Err(err) => {
            eprintln!(
                "myspace-mcp: cannot open the workspace at {} ({err}). Start the MySpace app once \
                 to create it, or pass --data-dir.",
                db_path.display()
            );
            return 1;
        }
    };
    serve(&ws, std::io::stdin().lock(), &mut std::io::stdout().lock());
    0
}

/// The JSON-RPC loop, generic over the streams so tests can drive it.
pub fn serve(ws: &Workspace, input: impl BufRead, out: &mut impl Write) {
    for line in input.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            send(
                out,
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }),
            );
            continue;
        };
        // Notifications (no id) need no answer.
        let Some(id) = msg.get("id").filter(|id| !id.is_null()).cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        let reply = match method {
            "initialize" => Ok(initialize(&params)),
            "tools/list" => Ok(tools_list()),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
                Ok(match handle_tool_call(ws, name, &arguments) {
                    Ok(result) => {
                        json!({ "content": [{ "type": "text", "text": pretty(&result) }] })
                    }
                    Err(e) => json!({
                        "content": [{ "type": "text", "text": format!("error: {e}") }],
                        "isError": true
                    }),
                })
            }
            "ping" => Ok(json!({})),
            _ => Err((-32601, "method not found")),
        };
        send(
            out,
            match reply {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, message)) => {
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                }
            },
        );
    }
}

fn send(out: &mut impl Write, msg: Value) {
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn initialize(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    let version = requested
        .filter(|v| SUPPORTED_PROTOCOL_VERSIONS.contains(v))
        .unwrap_or(SUPPORTED_PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "instructions": INSTRUCTIONS,
    })
}

fn tool(
    name: &str,
    description: &str,
    props: Value,
    required: &[&str],
    annotations: Value,
) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required },
        "annotations": annotations,
    })
}

fn read_only() -> Value {
    json!({ "readOnlyHint": true, "destructiveHint": false })
}

fn tools_list() -> Value {
    let board_arg =
        json!({ "type": "string", "description": "myspace://board/<id> or a bare board id" });
    json!({ "tools": [
        tool(
            "list_boards",
            "List all boards (id, title, parent, myspace:// address). Home is the board without a parent.",
            json!({}), &[], read_only(),
        ),
        tool(
            "read_board",
            "Read a board with all its cards: notes (text), links (url, title), images (asset with absolutePath), sub-board portals.",
            json!({ "board": board_arg }), &["board"], read_only(),
        ),
        tool(
            "read_card",
            "Read one card by myspace://card/<id> or bare id; includes its boardId.",
            json!({ "card": { "type": "string", "description": "myspace://card/<id> or a bare card id" } }),
            &["card"], read_only(),
        ),
        tool(
            "create_board",
            "Create a board inside a parent board (Home when parentBoard is omitted). Returns its id and address.",
            json!({
                "title": { "type": "string" },
                "parentBoard": { "type": "string", "description": "myspace://board/<id> or bare id; defaults to Home" }
            }),
            &["title"],
            json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false }),
        ),
        tool(
            "add_items",
            "Add notes, links and images to a board in one batch (one undo unit). Returns batchId and the new card addresses. Retrying with the same idempotencyKey returns the first result and creates nothing.",
            json!({
                "board": board_arg,
                "idempotencyKey": { "type": "string", "description": "unique per logical request, e.g. a UUID; reuse only for retries" },
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "kind": { "const": "note" },
                                "text": { "type": "string", "description": "plain text; line breaks are kept" }
                            },
                            "required": ["kind", "text"]
                        },
                        {
                            "type": "object",
                            "properties": {
                                "kind": { "const": "link" },
                                "url": { "type": "string", "description": "http(s) URL" },
                                "title": { "type": "string", "description": "optional; the preview fills it in" },
                                "comment": { "type": "string", "description": "optional note shown under the preview" }
                            },
                            "required": ["kind", "url"]
                        },
                        {
                            "type": "object",
                            "properties": {
                                "kind": { "const": "image" },
                                "path": { "type": "string", "description": "absolute local file path" },
                                "url": { "type": "string", "description": "public http(s) image URL (used when path is absent)" },
                                "caption": { "type": "string" }
                            },
                            "required": ["kind"]
                        }
                    ]}
                }
            }),
            &["board", "idempotencyKey", "items"],
            json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true }),
        ),
        tool(
            "trash_batch",
            "Move every card of one add_items batch to the app's Trash (the user can restore it there).",
            json!({ "batchId": { "type": "string" } }),
            &["batchId"],
            json!({ "readOnlyHint": false, "destructiveHint": true }),
        ),
    ]})
}

fn str_arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing '{name}' argument"))
}

fn opt_str<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}

fn address_id(arg: &str, expected: &str) -> Result<String, String> {
    match parse_address(arg) {
        Ok((kind, id)) if kind == expected => Ok(id),
        Ok((kind, _)) => Err(format!("expected a {expected} address, got {kind}")),
        Err(_) => Ok(arg.to_string()),
    }
}

fn err(e: WorkspaceError) -> String {
    e.to_string()
}

fn handle_tool_call(ws: &Workspace, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_boards" => {
            let boards = WorkspaceService::list_boards(ws).map_err(err)?;
            let items: Vec<Value> = boards
                .into_iter()
                .map(|b| {
                    json!({
                        "id": b.id,
                        "title": b.title,
                        "address": format!("myspace://board/{}", b.id),
                        "parentBoardId": b.parent_board_id,
                    })
                })
                .collect();
            Ok(json!({ "boards": items }))
        }
        "read_board" => {
            let id = address_id(str_arg(args, "board")?, "board")?;
            let snapshot = WorkspaceService::read_board(ws, &id).map_err(err)?;
            Ok(with_asset_paths(
                ws,
                serde_json::to_value(snapshot).map_err(|e| e.to_string())?,
            ))
        }
        "read_card" => {
            let id = address_id(str_arg(args, "card")?, "card")?;
            let card = WorkspaceService::read_card(ws, &id).map_err(err)?;
            Ok(with_asset_paths(
                ws,
                serde_json::to_value(card).map_err(|e| e.to_string())?,
            ))
        }
        "create_board" => {
            let title = str_arg(args, "title")?;
            // `parentBoardId` is the first slice's spelling.
            let parent = args
                .get("parentBoard")
                .or_else(|| args.get("parentBoardId"))
                .and_then(Value::as_str);
            let parent_id = match parent {
                Some(p) => address_id(p, "board")?,
                None => home_board_id(ws)?,
            };
            let board_id = WorkspaceService::create_board(ws, &parent_id, title).map_err(err)?;
            Ok(json!({ "boardId": board_id, "address": format!("myspace://board/{board_id}") }))
        }
        "add_items" => add_items(ws, args),
        "trash_batch" | "trash_links" => {
            let trash_batch_id =
                WorkspaceService::trash_link_batch(ws, str_arg(args, "batchId")?).map_err(err)?;
            Ok(json!({ "trashBatchId": trash_batch_id }))
        }
        "add_links" => add_links_legacy(ws, args),
        "enrich_links" => enrich_links_legacy(ws, args),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn home_board_id(ws: &Workspace) -> Result<String, String> {
    ws.read_blocking(|conn| {
        conn.query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
            r.get(0)
        })
        .map_err(WorkspaceError::from)
    })
    .map_err(err)
}

fn batch_result(result: crate::domain::models::CreateLinkBatchResult) -> Value {
    let addresses: Vec<String> = result
        .card_ids
        .iter()
        .map(|id| format!("myspace://card/{id}"))
        .collect();
    json!({ "batchId": result.batch_id, "cardIds": result.card_ids, "cardAddresses": addresses })
}

fn add_items(ws: &Workspace, args: &Value) -> Result<Value, String> {
    let board_id = address_id(str_arg(args, "board")?, "board")?;
    let idempotency_key = str_arg(args, "idempotencyKey")?;
    if idempotency_key.trim().is_empty() {
        return Err("'idempotencyKey' must not be empty".into());
    }
    let raw_items = args
        .get("items")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| "'items' must be a non-empty array".to_string())?;

    // A retry must not download or copy images again before the batch replays.
    if let Some(done) = WorkspaceService::find_batch(ws, idempotency_key).map_err(err)? {
        return Ok(batch_result(done));
    }

    let mut items = Vec::with_capacity(raw_items.len());
    for (index, raw) in raw_items.iter().enumerate() {
        let at = |msg: &str| format!("items[{index}]: {msg}");
        let id = uuid::Uuid::now_v7().to_string();
        let item = match raw.get("kind").and_then(Value::as_str) {
            Some("note") => {
                let text = raw
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| at("a note needs 'text'"))?;
                BatchItem::Note {
                    id,
                    text: text.to_string(),
                }
            }
            Some("link") => {
                let url = raw
                    .get("url")
                    .or_else(|| raw.get("sourceUrl"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| at("a link needs 'url'"))?;
                let parsed = url::Url::parse(url).map_err(|e| at(&format!("invalid url: {e}")))?;
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err(at("a link url must be http(s)"));
                }
                BatchItem::Link {
                    id,
                    source_url: url.to_string(),
                    title: opt_str(raw, "title").to_string(),
                    description: opt_str(raw, "comment").to_string(),
                }
            }
            Some("image") => {
                let asset = if let Some(path) = raw.get("path").and_then(Value::as_str) {
                    WorkspaceService::import_image_file(ws, Path::new(path))
                } else if let Some(url) = raw.get("url").and_then(Value::as_str) {
                    WorkspaceService::import_image_url(ws, url)
                } else {
                    return Err(at("an image needs 'path' or 'url'"));
                }
                .map_err(|e| at(&e.to_string()))?;
                BatchItem::Image {
                    id,
                    asset_id: asset.id,
                    caption: opt_str(raw, "caption").to_string(),
                }
            }
            _ => return Err(at("'kind' must be note, link or image")),
        };
        items.push(item);
    }

    let result = WorkspaceService::create_item_batch(
        ws,
        &CreateItemBatchInput {
            idempotency_key: idempotency_key.to_string(),
            board_id,
            items,
        },
    )
    .map_err(err)?;
    Ok(batch_result(result))
}

/// Adds `absolutePath` next to every asset's relative `filePath`, so a local
/// agent can open image files directly.
fn with_asset_paths(ws: &Workspace, mut value: Value) -> Value {
    fn walk(value: &mut Value, assets_dir: &Path) {
        match value {
            Value::Object(map) => {
                let relative = map
                    .get("filePath")
                    .and_then(Value::as_str)
                    .filter(|_| map.contains_key("mimeType"))
                    .map(str::to_string);
                if let Some(relative) = relative {
                    let absolute =
                        crate::domain::asset_service::asset_abs_path(assets_dir, &relative);
                    map.insert(
                        "absolutePath".into(),
                        Value::String(absolute.to_string_lossy().into_owned()),
                    );
                }
                map.values_mut().for_each(|v| walk(v, assets_dir));
            }
            Value::Array(items) => items.iter_mut().for_each(|v| walk(v, assets_dir)),
            _ => {}
        }
    }
    walk(&mut value, &ws.paths().assets_dir());
    value
}

/// First-slice `add_links`: caller-supplied card ids, `sourceUrl`/`description`.
fn add_links_legacy(ws: &Workspace, args: &Value) -> Result<Value, String> {
    let board_id = address_id(str_arg(args, "board")?, "board")?;
    let links = args
        .get("links")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing 'links' argument".to_string())?
        .iter()
        .map(|l| {
            Ok(LinkBatchItem {
                id: str_arg(l, "id")
                    .map_err(|_| "link missing 'id'".to_string())?
                    .to_string(),
                source_url: str_arg(l, "sourceUrl")
                    .map_err(|_| "link missing 'sourceUrl'".to_string())?
                    .to_string(),
                title: opt_str(l, "title").to_string(),
                description: opt_str(l, "description").to_string(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let result = WorkspaceService::create_link_batch(
        ws,
        &CreateLinkBatchInput {
            idempotency_key: str_arg(args, "idempotencyKey")?.to_string(),
            board_id,
            links,
        },
    )
    .map_err(err)?;
    Ok(batch_result(result))
}

/// First-slice `enrich_links`. The app enriches pending links itself when the
/// board is shown, so agents no longer need this.
fn enrich_links_legacy(ws: &Workspace, args: &Value) -> Result<Value, String> {
    let card_ids = args
        .get("cardIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing 'cardIds' argument".to_string())?;
    let fetcher = ReqwestMetadataFetcher::new().map_err(err)?;
    let mut results = Vec::new();
    for id in card_ids {
        let id = id
            .as_str()
            .ok_or_else(|| "cardIds must be strings".to_string())?;
        results.push(match enrich_embed_blocking(ws, &fetcher, id) {
            Ok(embed) => json!({ "id": id, "status": "ready", "title": embed.title }),
            Err(e) => json!({ "id": id, "status": "failed", "error": e.to_string() }),
        });
    }
    Ok(json!({ "results": results }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn explicit_data_dir_wins() {
        assert_eq!(
            resolve_data_dir(&args(&["--mcp", "--data-dir", "/tmp/ws"])),
            Ok(PathBuf::from("/tmp/ws"))
        );
        assert_eq!(
            resolve_data_dir(&args(&["--db", "/tmp/ws/workspace.sqlite3"])),
            Ok(PathBuf::from("/tmp/ws"))
        );
        assert!(resolve_data_dir(&args(&["--data-dir"])).is_err());
    }

    #[test]
    fn default_dir_is_named_after_the_app_identifier() {
        if let Ok(dir) = default_data_dir() {
            assert!(dir.ends_with(APP_IDENTIFIER), "{}", dir.display());
        }
    }

    #[test]
    fn initialize_negotiates_the_protocol_version() {
        let known = initialize(&json!({ "protocolVersion": "2024-11-05" }));
        assert_eq!(known["protocolVersion"], "2024-11-05");
        let unknown = initialize(&json!({ "protocolVersion": "1999-01-01" }));
        assert_eq!(unknown["protocolVersion"], SUPPORTED_PROTOCOL_VERSIONS[0]);
        assert!(known["instructions"]
            .as_str()
            .unwrap()
            .contains("add_items"));
    }
}
