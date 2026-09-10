//! A local Model Context Protocol (MCP) server over stdio, exposing a minimal
//! read/write vertical slice of the MySpace workspace to any MCP-compatible agent
//! host (Codex, Hermes, etc.) without coupling to a provider (ADR-0005).
//!
//! Tools:
//!   - list_boards          (read)
//!   - read_board           (read)  — resolves myspace://board/<id>
//!   - read_card            (read)  — resolves myspace://card/<id>
//!   - add_links            (write) — idempotent batch Link Card creation
//!
//! The server is a thin adapter over `WorkspaceService`, talking JSON-RPC 2.0
//! messages deliminated by newlines on stdin/stdout, per the MCP stdio transport.

use std::io::{BufRead, Write};

use myspace_lib::db;
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::link_metadata::{enrich_embed_with_metadata, ReqwestMetadataFetcher};
use myspace_lib::domain::models::{CreateLinkBatchInput, LinkBatchItem};
use myspace_lib::services::workspace_service::{parse_address, WorkspaceService};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "myspace-mcp";
const SERVER_VERSION: &str = "0.1.0";

/// Reads a DB path from `--db <path>` or falls back to the default macOS
/// Application Support location. Returns (db_path, asset_dir).
fn resolve_paths() -> (String, String) {
    let mut db_path = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--db" {
            if let Some(path) = args.next() {
                db_path = Some(path);
            }
        }
    }
    let db_path = db_path.unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/Library/Application Support/com.bro.myspace/workspace.sqlite3")
    });
    // Assets live next to the DB in `<data_dir>/assets`.
    let asset_dir = std::path::Path::new(&db_path)
        .parent()
        .map(|p| p.join("assets").to_string_lossy().to_string())
        .unwrap_or_default();
    (db_path, asset_dir)
}

fn send_response(w: &mut impl Write, id: &serde_json::Value, result: serde_json::Value) {
    let msg = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let _ = writeln!(w, "{}", msg);
    let _ = w.flush();
}

fn send_error(w: &mut impl Write, id: &serde_json::Value, code: i64, message: &str) {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    });
    let _ = writeln!(w, "{}", msg);
    let _ = w.flush();
}

/// A tool's JSON-Schema-ish input schema (loose, for host display/confirmation).
fn tool_schema(props: serde_json::Value, required: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": required,
    })
}

fn tools_list() -> serde_json::Value {
    serde_json::json!({
        "tools": [
            {
                "name": "list_boards",
                "description": "List all active MySpace boards with their myspace:// addresses.",
                "inputSchema": tool_schema(serde_json::json!({}), &[]),
                "annotations": { "readOnlyHint": true, "destructiveHint": false }
            },
            {
                "name": "create_board",
                "description": "Create a child board under a parent board (Home by default) and return its myspace://board/<id> address.",
                "inputSchema": tool_schema(
                    serde_json::json!({ "parentBoardId": { "type": "string", "description": "parent board id or myspace://board/<id> (optional; defaults to Home)" }, "title": { "type": "string" } }),
                    &["title"]
                ),
                "annotations": { "readOnlyHint": false, "destructiveHint": false }
            },
            {
                "name": "read_board",
                "description": "Read a board (cards, notes, links, image assets) by myspace://board/<id> or board id.",
                "inputSchema": tool_schema(
                    serde_json::json!({ "board": { "type": "string", "description": "myspace://board/<id> or bare board id" } }),
                    &["board"]
                ),
                "annotations": { "readOnlyHint": true, "destructiveHint": false }
            },
            {
                "name": "read_card",
                "description": "Read a single card (note, image, link, board portal) by myspace://card/<id> or bare card id.",
                "inputSchema": tool_schema(
                    serde_json::json!({ "card": { "type": "string", "description": "myspace://card/<id> or bare card id" } }),
                    &["card"]
                ),
                "annotations": { "readOnlyHint": true, "destructiveHint": false }
            },
            {
                "name": "add_links",
                "description": "Add a batch of Link Cards to a board. Idempotent under an idempotency key. A link may carry an optional 'description' (user comment shown under the preview; never overwritten by enrichment).",
                "inputSchema": tool_schema(
                    serde_json::json!({
                        "board": { "type": "string", "description": "myspace://board/<id> or bare board id" },
                        "idempotencyKey": { "type": "string" },
                        "links": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "sourceUrl": { "type": "string" }, "title": { "type": "string" }, "description": { "type": "string", "description": "optional user comment" } } } }
                    }),
                    &["board", "idempotencyKey", "links"]
                ),
                "annotations": { "readOnlyHint": false, "destructiveHint": false }
            },
            {
                "name": "enrich_links",
                "description": "Fetch and apply preview metadata for a batch of Link Cards (by id).",
                "inputSchema": tool_schema(
                    serde_json::json!({ "cardIds": { "type": "array", "items": { "type": "string" } } }),
                    &["cardIds"]
                ),
                "annotations": { "readOnlyHint": false, "destructiveHint": false }
            },
            {
                "name": "trash_links",
                "description": "Remove all Link Cards created by an agent batch (one undo unit).",
                "inputSchema": tool_schema(
                    serde_json::json!({ "batchId": { "type": "string" } }),
                    &["batchId"]
                ),
                "annotations": { "readOnlyHint": false, "destructiveHint": true }
            }
        ]
    })
}

fn resolve_board_id(board_arg: &str) -> Result<String, WorkspaceError> {
    if let Ok((kind, id)) = parse_address(board_arg) {
        if kind != "board" {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "expected board address, got {kind}"
            )));
        }
        Ok(id)
    } else {
        Ok(board_arg.to_string())
    }
}

fn main() {
    let (db_path, asset_dir) = resolve_paths();
    let mut conn = db::open(std::path::Path::new(&db_path)).expect("failed to open workspace db");

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);

        // Notifications (no id) are ignored except where required.
        if id.is_null() {
            continue;
        }

        match method {
            "initialize" => {
                let result = serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
                });
                send_response(&mut out, &id, result);
            }
            "tools/list" => {
                send_response(&mut out, &id, tools_list());
            }
            "tools/call" => {
                let name = msg
                    .get("params")
                    .and_then(|p| p.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let arguments = msg
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);

                match handle_tool_call(&mut conn, &asset_dir, name, &arguments) {
                    Ok(result) => {
                        send_response(
                            &mut out,
                            &id,
                            serde_json::json!({ "content": [ { "type": "text", "text": result } ] }),
                        );
                    }
                    Err(e) => {
                        send_response(
                            &mut out,
                            &id,
                            serde_json::json!({ "content": [ { "type": "text", "text": format!("error: {e}") } ], "isError": true }),
                        );
                    }
                }
            }
            "ping" => {
                send_response(&mut out, &id, serde_json::json!({}));
            }
            _ => {
                send_error(&mut out, &id, -32601, "method not found");
            }
        }
    }
}

fn handle_tool_call(
    conn: &mut rusqlite::Connection,
    asset_dir: &str,
    name: &str,
    arguments: &serde_json::Value,
) -> Result<String, String> {
    match name {
        "list_boards" => {
            let boards = WorkspaceService::list_boards(conn).map_err(|e| e.to_string())?;
            let items: Vec<serde_json::Value> = boards
                .into_iter()
                .map(|b| {
                    serde_json::json!({
                        "id": b.id,
                        "title": b.title,
                        "address": format!("myspace://board/{}", b.id),
                        "parentBoardId": b.parent_board_id,
                    })
                })
                .collect();
            Ok(
                serde_json::to_string_pretty(&serde_json::json!({ "boards": items }))
                    .map_err(|e| e.to_string())?,
            )
        }
        "create_board" => {
            let title = arguments
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'title' argument".to_string())?;
            let parent_id = match arguments.get("parentBoardId").and_then(|v| v.as_str()) {
                Some(p) => resolve_board_id(p).map_err(|e| e.to_string())?,
                None => {
                    let root: String = conn
                        .query_row("SELECT root_board_id FROM workspaces LIMIT 1", [], |r| {
                            r.get(0)
                        })
                        .map_err(|e| e.to_string())?;
                    root
                }
            };
            let board_id = WorkspaceService::create_board(conn, &parent_id, title)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&serde_json::json!(
                { "boardId": board_id, "address": format!("myspace://board/{}", board_id) }
            ))
            .map_err(|e| e.to_string())?)
        }
        "read_board" => {
            let board_arg = arguments
                .get("board")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'board' argument".to_string())?;
            let id = resolve_board_id(board_arg).map_err(|e| e.to_string())?;
            let snapshot = WorkspaceService::read_board(conn, &id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?)
        }
        "read_card" => {
            let card_arg = arguments
                .get("card")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'card' argument".to_string())?;
            let id = if let Ok((kind, id)) = parse_address(card_arg) {
                if kind != "card" {
                    return Err(format!("expected card address, got {kind}"));
                }
                id
            } else {
                card_arg.to_string()
            };
            let card = WorkspaceService::read_card(conn, &id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&card).map_err(|e| e.to_string())?)
        }
        "add_links" => {
            let board_arg = arguments
                .get("board")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'board' argument".to_string())?;
            let idempotency_key = arguments
                .get("idempotencyKey")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'idempotencyKey' argument".to_string())?;
            let links_value = arguments
                .get("links")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "missing 'links' argument".to_string())?;

            let board_id = resolve_board_id(board_arg).map_err(|e| e.to_string())?;

            let links: Vec<LinkBatchItem> = links_value
                .iter()
                .map(|l| {
                    Ok(LinkBatchItem {
                        id: l
                            .get("id")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| "link missing 'id'".to_string())?
                            .to_string(),
                        source_url: l
                            .get("sourceUrl")
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| "link missing 'sourceUrl'".to_string())?
                            .to_string(),
                        title: l
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        description: l
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;

            let result = WorkspaceService::create_link_batch(
                conn,
                &CreateLinkBatchInput {
                    idempotency_key: idempotency_key.to_string(),
                    board_id,
                    links,
                },
            )
            .map_err(|e| e.to_string())?;

            let card_addresses: Vec<String> = result
                .card_ids
                .iter()
                .map(|id| format!("myspace://card/{id}"))
                .collect();

            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "batchId": result.batch_id,
                "cardAddresses": card_addresses,
                "cardIds": result.card_ids,
            }))
            .map_err(|e| e.to_string())?)
        }
        "enrich_links" => {
            let card_ids: Vec<String> = arguments
                .get("cardIds")
                .and_then(|v| v.as_array())
                .ok_or_else(|| "missing 'cardIds' argument".to_string())?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(|s| s.to_string())
                        .ok_or_else(|| "cardIds must be strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;

            let fetcher = ReqwestMetadataFetcher::new().map_err(|e| e.to_string())?;
            let mut results = Vec::new();
            for id in &card_ids {
                // Resolve the card's current revision first: enrichment is guarded
                // by an optimistic revision, and agent-created cards may already
                // have been enriched/edited (revision > 1).
                let revision = match WorkspaceService::read_card(conn, id) {
                    Ok(card) => match &card {
                        myspace_lib::domain::models::CardDto::Note(n) => n.revision,
                        myspace_lib::domain::models::CardDto::BoardPortal(p) => p.revision,
                        myspace_lib::domain::models::CardDto::Image(i) => i.revision,
                        myspace_lib::domain::models::CardDto::Embed(e) => e.revision,
                        myspace_lib::domain::models::CardDto::FilesystemAlias(a) => a.revision,
                        myspace_lib::domain::models::CardDto::File(f) => f.revision,
                    },
                    Err(e) => {
                        results.push(serde_json::json!({ "id": id, "status": "failed", "error": e.to_string() }));
                        continue;
                    }
                };
                match enrich_embed_with_metadata(
                    conn,
                    std::path::Path::new(asset_dir),
                    &fetcher,
                    id,
                    revision,
                ) {
                    Ok(embed) => results.push(
                        serde_json::json!({ "id": id, "status": "ready", "title": embed.title }),
                    ),
                    Err(e) => results.push(
                        serde_json::json!({ "id": id, "status": "failed", "error": e.to_string() }),
                    ),
                }
            }
            Ok(
                serde_json::to_string_pretty(&serde_json::json!({ "results": results }))
                    .map_err(|e| e.to_string())?,
            )
        }
        "trash_links" => {
            let batch_id = arguments
                .get("batchId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'batchId' argument".to_string())?;
            let trash_batch_id =
                WorkspaceService::trash_link_batch(conn, batch_id).map_err(|e| e.to_string())?;
            Ok(
                serde_json::to_string_pretty(
                    &serde_json::json!({ "trashBatchId": trash_batch_id }),
                )
                .map_err(|e| e.to_string())?,
            )
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}
