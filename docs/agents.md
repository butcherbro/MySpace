# MySpace for AI agents (MCP)

MySpace has a built-in [MCP](https://modelcontextprotocol.io) server. An agent connected to
it can list boards, create boards, put notes, links and images on them and read them back.

The server is the installed app itself started with `--mcp`. Nothing extra to install: it is
on every Mac and Windows machine that has MySpace, and it updates together with the app.

**Canonical link to this page** (give it to any agent that can read the web):
`https://raw.githubusercontent.com/butcherbro/MySpace/main/docs/agents.md`

Contents: [what to give an agent](#what-to-give-an-agent) ·
[where it works](#where-it-works) · [connect a host](#connect-a-host) ·
[one-step setup scripts](#one-step-setup-scripts) · [check it works](#check-it-works) ·
[agent manual](#agent-manual) · [troubleshooting](#troubleshooting)

## What to give an agent

| Situation | What to do |
|---|---|
| The agent is already connected to MySpace (MCP) | Nothing. On connect the server sends the host a short manual (MCP `instructions`); the tool descriptions do the rest. |
| The agent runs on your computer but is not connected yet | Connect it once ([connect a host](#connect-a-host) or the [scripts](#one-step-setup-scripts)). If the agent can edit its own config (Claude Code, Codex, Cursor), just paste the prompt below. |
| You want the agent to know the rules in detail | Give it the canonical link above, or paste the [agent manual](#agent-manual) section. |

Prompt that makes a local agent connect itself and learn the board:

```text
Read https://raw.githubusercontent.com/butcherbro/MySpace/main/docs/agents.md.
Connect yourself to the MySpace MCP server on this computer as that page describes for
your host (command = the MySpace executable, args = ["--mcp"], stdio), tell me if I need
to restart you, and after that follow its "Agent manual" section whenever I ask you to
save something to MySpace or read from it.
```

## Where it works

- **Works:** any agent that runs on a computer with MySpace installed and can start a local
  MCP server over stdio: Claude Desktop, Claude Code, Codex, Cursor, Windsurf, VS Code
  (Copilot), Gemini CLI, LM Studio, and others.
- **Does not work yet:** agents that run elsewhere and cannot start programs on your
  computer: ChatGPT and other cloud chats, a bot on a remote server (e.g. Hermes reached
  through Telegram). They need a network inbox, which is planned: the agent drops items
  into it and MySpace picks them up when your computer is on. If such an agent runs on the
  same computer as MySpace, it connects like any other.
- **Other devices:** what an agent adds on one computer reaches your other devices through
  LAN sync while the app runs there.

## Connect a host

Every host needs the same three things:

| | macOS | Windows |
|---|---|---|
| command | `/Applications/myspace.app/Contents/MacOS/myspace` | `%LOCALAPPDATA%\myspace\myspace.exe`, i.e. `C:\Users\<you>\AppData\Local\myspace\myspace.exe` |
| args | `["--mcp"]` | `["--mcp"]` |
| transport | stdio | stdio |

In JSON on Windows, double the backslashes: `"C:\\Users\\<you>\\AppData\\Local\\myspace\\myspace.exe"`.
If the app is elsewhere: macOS — right-click the app → Show Package Contents →
`Contents/MacOS/myspace`; Windows — Start menu → right-click MySpace → Open file location.
Restart the host after changing its config.

Requirements: MySpace installed and started once on this computer (that creates the
workspace). The app does not have to be running while the agent works; if it is, changes
show up within a second.

### Command-line hosts

```sh
# Claude Code (Windows PowerShell: use "$env:LOCALAPPDATA\myspace\myspace.exe")
claude mcp add --scope user myspace -- /Applications/myspace.app/Contents/MacOS/myspace --mcp

# Codex (CLI and app share ~/.codex/config.toml)
codex mcp add myspace -- /Applications/myspace.app/Contents/MacOS/myspace --mcp
```

Codex by hand, `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.myspace]
command = "/Applications/myspace.app/Contents/MacOS/myspace"
args = ["--mcp"]
```

### Hosts with an `mcpServers` JSON file

Claude Desktop, Cursor, Windsurf, Gemini CLI and LM Studio all take this block; merge it into
the file if it already has other settings:

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

| Host | File (macOS; on Windows the same path under `C:\Users\<you>\` unless noted) |
|---|---|
| Claude Desktop | Settings → Developer → Edit Config. macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| LM Studio | Program → Install → Edit mcp.json |

### VS Code (Copilot)

Command palette → **MCP: Open User Configuration**:

```json
{
  "servers": {
    "myspace": {
      "type": "stdio",
      "command": "/Applications/myspace.app/Contents/MacOS/myspace",
      "args": ["--mcp"]
    }
  }
}
```

### Any other host

command = the path above, arguments = `--mcp`, transport = stdio. Hosts that only accept a
remote (HTTP) MCP URL cannot use it yet.

## One-step setup scripts

Each script finds MySpace, checks the server answers, adds it to Claude Desktop (backing up
the old config) and to Claude Code if installed.

**macOS** (paste into Terminal):

```zsh
APP=$(ls -d /Applications/*[Mm]y[Ss]pace*.app 2>/dev/null | head -1)
BIN="$APP/Contents/MacOS/myspace"
if [ -z "$APP" ] || [ ! -x "$BIN" ]; then
  echo "MySpace not found in /Applications"
else
  echo "Executable: $BIN"
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}' | "$BIN" --mcp | tail -1 | head -c 400; echo
  CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  mkdir -p "$(dirname "$CFG")"
  [ -f "$CFG" ] && cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
  osascript -l JavaScript - "$CFG" "$BIN" <<'JS'
function run(argv) {
  ObjC.import('Foundation');
  var path = argv[0], bin = argv[1], cfg = {};
  if ($.NSFileManager.defaultManager.fileExistsAtPath(path)) {
    var s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;
    if (s && s.trim()) cfg = JSON.parse(s);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.myspace = { command: bin, args: ["--mcp"] };
  $(JSON.stringify(cfg, null, 2)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  return "Claude Desktop: myspace added";
}
JS
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user myspace >/dev/null 2>&1
    claude mcp add --scope user myspace -- "$BIN" --mcp && echo "Claude Code: myspace added"
  fi
  osascript -e 'quit app "Claude"' 2>/dev/null; sleep 3; open -a Claude 2>/dev/null
fi
```

**Windows** (paste into PowerShell):

```powershell
$bin = Join-Path $env:LOCALAPPDATA 'myspace\myspace.exe'
if (-not (Test-Path $bin)) { $bin = (Get-ChildItem $env:LOCALAPPDATA, $env:ProgramFiles -Filter myspace.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
if (-not $bin) { Write-Host "MySpace not found" } else {
  Write-Host "Executable: $bin"
  $req = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' + "`n" + '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}'
  ($req | & $bin --mcp | Select-Object -Last 1) -replace '^(.{0,400}).*','$1'
  $store = Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter 'Claude_*' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  $cfgPath = if ($store) { "$($store.FullName)\LocalCache\Roaming\Claude\claude_desktop_config.json" } else { "$env:APPDATA\Claude\claude_desktop_config.json" }
  New-Item -ItemType Directory -Force -Path (Split-Path $cfgPath) | Out-Null
  if (Test-Path $cfgPath) { Copy-Item $cfgPath "$cfgPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"; $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } else { $cfg = $null }
  if (-not $cfg) { $cfg = [pscustomobject]@{} }
  if (-not $cfg.mcpServers) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force }
  $cfg.mcpServers | Add-Member -NotePropertyName myspace -NotePropertyValue ([pscustomobject]@{ command = $bin; args = @('--mcp') }) -Force
  [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
  Write-Host "Claude Desktop: myspace added to $cfgPath"
  if (Get-Command claude -ErrorAction SilentlyContinue) { claude mcp remove --scope user myspace 2>$null | Out-Null; claude mcp add --scope user myspace -- $bin --mcp }
  Stop-Process -Name Claude -ErrorAction SilentlyContinue; Write-Host "Reopen Claude Desktop"
}
```

## Check it works

Ask the agent: *"List my MySpace boards, then create a board called MCP test and put a note
'hello' on it."* The board should appear in the app.

The first lines of the scripts above do the same check without an agent: one JSON line comes
back listing your boards.

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
- To save something from a chat (a post, an article, a screenshot): a note with the text, a
  link to the source, images by path or URL — in one `add_items` call.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "cannot open the workspace … Start the MySpace app once" | The app never ran on this computer, or the agent uses another user account. Start MySpace once, or pass `--data-dir` with the folder that holds `workspace.sqlite3` (macOS `~/Library/Application Support/com.bro.myspace`, Windows `%APPDATA%\com.bro.myspace`; the `MYSPACE_DATA_DIR` variable does the same). |
| The host lists no MySpace tools | Wrong path in `command`, or the host was not restarted. Run the command from the table with `--mcp` in a terminal: it should wait silently for input (Ctrl+C to quit). |
| Unknown tool `--mcp` / the app window opens | The installed app is older than 0.2.6. Update it (it updates itself on start). |
| Cards added but not visible | Look on the board you passed; new cards are stacked below the existing ones (scroll down). |
