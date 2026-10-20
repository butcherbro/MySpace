# MySpace for AI agents (MCP)

MySpace has a built-in [MCP](https://modelcontextprotocol.io) server. Any agent host that
speaks MCP over stdio (Claude Desktop, Claude Code, Codex, Cursor, …) can list boards, create
boards, put notes, links and images on them and read them back.

The server is the installed app itself started with `--mcp`. Nothing extra to install: it is
on every Mac and Windows machine that has MySpace, and it updates together with the app.

This page has two parts: **setup** (for the person connecting an agent) and the **agent
manual** (what to hand to the agent; the server also sends a short version of it to the host
automatically on connect).

## Setup

### 1. Requirements

- MySpace installed and started at least once on this machine (that creates the workspace).
- The app does not have to be running. If it is, changes appear on screen within a second;
  if it is not, they are there on next start. Other devices get them through LAN sync while
  the app runs on this machine.

### 2. Find the server command

| OS | Command |
|---|---|
| macOS | `/Applications/myspace.app/Contents/MacOS/myspace --mcp` |
| Windows | `%LOCALAPPDATA%\myspace\myspace.exe --mcp` (e.g. `C:\Users\<you>\AppData\Local\myspace\myspace.exe`) |

If the app lives elsewhere: macOS — right-click the app → Show Package Contents →
`Contents/MacOS/myspace`; Windows — Start menu → right-click MySpace → Open file location.

Options (rarely needed): `--data-dir <dir>` points at another workspace folder (the one that
holds `workspace.sqlite3`); the `MYSPACE_DATA_DIR` environment variable does the same.
Default: macOS `~/Library/Application Support/com.bro.myspace`, Windows
`%APPDATA%\com.bro.myspace`.

### 3. Connect a host

**Claude Desktop** — Settings → Developer → Edit Config (`claude_desktop_config.json`), then
restart Claude Desktop:

```json
{
  "mcpServers": {
    "myspace": {
      "command": "/Applications/myspace.app/Contents/MacOS/myspace",
      "args": ["--mcp"]
    }
  }
}
```

On Windows use the full path with doubled backslashes:
`"command": "C:\\Users\\<you>\\AppData\\Local\\myspace\\myspace.exe"`.

**Claude Code**

```sh
# macOS
claude mcp add --scope user myspace -- /Applications/myspace.app/Contents/MacOS/myspace --mcp
# Windows (PowerShell)
claude mcp add --scope user myspace -- "$env:LOCALAPPDATA\myspace\myspace.exe" --mcp
```

**Codex** — `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.myspace]
command = "/Applications/myspace.app/Contents/MacOS/myspace"
args = ["--mcp"]
```

Any other host: command = the path above, arguments = `["--mcp"]`, transport = stdio.

### 4. Check it works (1 minute)

Ask the agent: *"List my MySpace boards, then create a board called MCP test and put a note
'hello' on it."* The board should appear in the app. Delete it from the app afterwards.

Without an agent, from a terminal (macOS; on Windows use the `.exe` path in PowerShell):

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}' \
  | /Applications/myspace.app/Contents/MacOS/myspace --mcp
```

Two JSON lines come back; the second lists your boards. An error mentioning
"Start the MySpace app once" means the workspace was not found (step 1, or `--data-dir`).

## Agent manual

Hand this section to an agent that will work with MySpace.

### Model

- **Board** — a canvas, nested like folders. The top one is *Home* (`parentBoardId: null`).
- **Card** — something on a board: `note` (text), `embed` (a link with preview), `image`,
  `board_portal` (a sub-board shown on its parent), plus kinds you only read (`file`,
  `filesystem_alias`, `board_shortcut`).
- **Address** — `myspace://board/<id>` and `myspace://card/<id>`. Ids are stable through
  renames and moves. Titles are not unique: find a board by title with `list_boards`, then
  use its id.

### Tools

| Tool | What it does |
|---|---|
| `list_boards` | All boards: `id`, `title`, `parentBoardId`, `address`. |
| `read_board` `{board}` | The board and all its cards. Image cards carry `asset.absolutePath`, a file you can open. |
| `read_card` `{card}` | One card, including its `boardId`. |
| `create_board` `{title, parentBoard?}` | New board inside `parentBoard` (default Home). Returns `boardId`, `address`. |
| `add_items` `{board, idempotencyKey, items}` | Adds cards in one batch. Returns `batchId`, `cardIds`, `cardAddresses`. |
| `trash_batch` `{batchId}` | Moves a whole `add_items` batch to the app's Trash (restorable there). |

`board` / `card` accept an address or a bare id.

### `add_items`

```json
{
  "board": "myspace://board/0199…",
  "idempotencyKey": "tg-post-1842",
  "items": [
    { "kind": "note",  "text": "Post text\n\nSecond paragraph" },
    { "kind": "link",  "url": "https://example.com/article", "comment": "why it matters" },
    { "kind": "image", "path": "/Users/me/Downloads/chart.png", "caption": "Q3" },
    { "kind": "image", "url": "https://example.com/photo.jpg" }
  ]
}
```

- **One request = one batch = one undo unit.** Either all items are added or none.
- **`idempotencyKey`** — make a new one per logical request (a UUID, or a stable source id
  like a message id). If a call fails or times out, retry with the **same** key: a batch that
  already went through is returned as is, nothing is duplicated.
- **Notes** are plain text. Line breaks are kept; Markdown is shown as typed, not rendered.
- **Links** must be http(s). Title and preview image are fetched by the app when the user
  opens the board; `title` is optional, `comment` shows under the preview.
- **Images**: `path` (a local file) or `url` (public http(s), up to 8 MB). PNG, JPEG, GIF or
  WebP. The same picture added twice is stored once.
- Items keep their order and are stacked below what is already on the board.

### Rules

- Never trash or overwrite what the user did not ask you to. `trash_batch` is for undoing your
  own batch.
- Prefer one `add_items` call with many items over many single-item calls.
- When the user names a board, look it up with `list_boards`; ask if several boards share the
  title. Create a board only when asked or when none fits.
