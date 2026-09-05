//! A local Model Context Protocol (MCP) server over stdio, exposing a minimal
//! read/write vertical slice of the MySpace workspace to any MCP-compatible agent
//! host (Codex, Hermes, etc.) without coupling to a provider (ADR-0005).
//!
//! Tools:
//!   - list_boards          (read)
//!   - read_board           (read)  — resolves myspace://board/<id>
//!   - add_links            (write) — idempotent batch Link Card creation
//!
//! The server is a thin adapter over `WorkspaceService`, talking JSON-RPC 2.0
//! messages deliminated by newlines on stdin/stdout, per the MCP stdio transport.

use std::io::{BufRead, Write};

use myspace_lib::db;
use myspace_lib::domain::errors::WorkspaceError;
use myspace_lib::domain::models::{CreateLinkBatchInput, LinkBatchItem};
use myspace_lib::services::workspace_service::{parse_address, WorkspaceService};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "myspace-mcp";
const SERVER_VERSION: &str = "0.1.0";

/// Reads a DB path from `--db <path>` or falls back to the default macOS
/// Application Support location.
fn resolve_db_path() -> String {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--db" {
            if let Some(path) = args.next() {
                return path;
            }
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    format!("{home}/Library/Application Support/com.bro.myspace/workspace.sqlite3")
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
                "name": "read_board",
                "description": "Read a board (cards, notes, links, image assets) by myspace://board/<id> or board id.",
                "inputSchema": tool_schema(
                    serde_json::json!({ "board": { "type": "string", "description": "myspace://board/<id> or bare board id" } }),
                    &["board"]
                ),
                "annotations": { "readOnlyHint": true, "destructiveHint": false }
            },
            {
                "name": "add_links",
                "description": "Add a batch of Link Cards to a board. Idempotent under an idempotency key.",
                "inputSchema": tool_schema(
                    serde_json::json!({
                        "board": { "type": "string", "description": "myspace://board/<id> or bare board id" },
                        "idempotencyKey": { "type": "string" },
                        "links": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "sourceUrl": { "type": "string" }, "title": { "type": "string" } } } }
                    }),
                    &["board", "idempotencyKey", "links"]
                ),
                "annotations": { "readOnlyHint": false, "destructiveHint": false }
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
    let db_path = resolve_db_path();
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
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
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

                match handle_tool_call(&mut conn, name, &arguments) {
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
        "read_board" => {
            let board_arg = arguments
                .get("board")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'board' argument".to_string())?;
            let id = resolve_board_id(board_arg).map_err(|e| e.to_string())?;
            let snapshot = WorkspaceService::read_board(conn, &id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?)
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
        _ => Err(format!("unknown tool: {name}")),
    }
}
