# ADR-0005: Provider-Agnostic Agent Surface

- **Status:** Accepted
- **Date:** 2026-09-05
- **Source:** `docs/review-brief-9-external-world.md`
- **Supersedes:** the blanket agent/LLM non-goal in ADR-0001

## Context

MySpace is a logical workspace stored in SQLite plus immutable managed assets. A Board is not a filesystem directory, so raw paths and direct SQLite access cannot be the integration contract.

The product requirement is bidirectional:

1. an external agent can read a Board containing Notes, Links, images, and nested Boards;
2. an external agent can add and organize content, including a batch such as ten YouTube Links.

The current Tauri commands are UI transport wrappers. They are not a stable external API, and the TypeScript `WorkspaceGateway` cannot be reused by a separate local process.

## Decision

Create one concrete Rust application layer, named `WorkspaceService`, above repositories and domain services. Tauri, MCP, and any later CLI become thin adapters over the same use cases.

```text
React UI                 External agent              Future in-app chat
   │                           │                            │
Tauri adapter             MCP stdio adapter           in-process adapter
   └───────────────┬───────────┴──────────────┬─────────────┘
                   │                          │
              WorkspaceService (typed queries + commands)
                   │
          domain services + repositories
                   │
       SQLite workspace + managed assets
```

Do not introduce a generic repository trait or plugin SDK first. A concrete service with typed methods is the smallest useful boundary. Extract a separate core crate only when a second compiled adapter proves the need.

## Initial external protocol

Use a local MCP server over stdio as the first external adapter.

Why:

- it is supported by multiple agent hosts;
- stdio avoids an always-running daemon, open TCP port, local authentication, and socket lifecycle;
- MCP tools/resources map naturally to typed commands, Board resources, and image resources;
- provider-specific logic stays outside the workspace domain.

A CLI can follow as a diagnostic/manual adapter over the same `WorkspaceService`. Do not build a custom JSON-RPC socket for the first slice.

## Stable addressing

Canonical identity is the existing UUIDv7 ID:

- `myspace://board/<board_id>`
- `myspace://card/<card_id>`
- `myspace://asset/<asset_id>`

Breadcrumb titles form a human-readable display path only. They are not identifiers because titles are non-unique and Boards can be renamed or reparented.

The UI action should be named `Copy MySpace Link`, not `Copy Board Path`. Image assets may also expose `Copy File Path` as a separate explicit action, but the internal asset path is never the identity of a Board or Card.

## First vertical slice

Do not stop after creating an interface with no user-visible value. The first agent slice must prove one read and one write journey end to end:

### Read journey

- list Boards;
- resolve a `myspace://board/<id>` address;
- read paginated Card summaries and full Card data;
- resolve image assets by asset ID without granting arbitrary filesystem access.

### Write journey

- create a batch of Link Cards directly in a target Board;
- preserve source order and deterministic non-overlapping placement;
- return created IDs and one durable operation/batch ID;
- enrich each Link asynchronously through the existing metadata service;
- allow the created batch to be undone/trashed as one operation.

The agent must not simulate UI behavior by creating a Note and triggering Note-to-Link conversion. Add a direct domain `create_link_card` path and let both the future Link tool and agent adapter reuse it.

## External-write invariants

Before enabling agent writes:

1. finish validated backups and a tested restore path;
2. add a caller-supplied idempotency key for every agent mutation;
3. keep optimistic revisions on updates and moves;
4. represent multi-object creation as one durable operation/batch;
5. make the running app notice commits from another SQLite connection, for example by polling `PRAGMA data_version` and reloading the affected Board;
6. configure SQLite busy timeout and return recoverable conflict errors;
7. expose allowlisted typed operations only, never raw SQL, shell execution, or arbitrary filesystem reads;
8. separate read and write capabilities in MCP metadata so the agent host can apply confirmations.

## Backup gate

The existing startup snapshot is a useful base, not yet the write-safety gate.

Before agent writes or another destructive migration, backups must:

- stage into a unique temporary directory;
- copy the SQLite snapshot and every referenced managed asset;
- run `PRAGMA integrity_check` and `PRAGMA foreign_key_check` against the snapshot;
- record a manifest containing timestamp, schema version, asset count, and validation status;
- atomically publish only a complete snapshot;
- prune only previously validated snapshots;
- rate-limit normal startup snapshots so rapid development restarts cannot consume all ten recovery points;
- provide a tested restore flow that preserves the damaged live DB/assets before replacement.

## Filesystem shortcuts

Filesystem projection is a separate feature that shares the external-address and permission model but not the agent implementation slice.

Future shape:

- one spatial Card kind, `filesystem_alias`;
- one detail table with `target_kind = file | folder`;
- a platform locator/bookmark plus a human-readable path hint;
- read-only, shallow, on-demand directory listing initially;
- no watcher and no materialization of every child as a persisted Card;
- explicit user selection grants access; an alias never grants arbitrary parent-directory traversal.

Do not modify the schema for this until the agent vertical slice is working.

## Clipboard scope

Clipboard export remains separate. It is not automatically a trivial slice:

- one selected image can expose PNG/TIFF image data;
- multiple selected images should use Finder-compatible file URLs if the target must receive separate attachments;
- a mixed Note plus image selection has inconsistent support across destination apps and should defer to `Copy MySpace Link` or the agent Board resource.

Before implementation, define the first supported paste targets and test against them in a real macOS pasteboard, not browser mocks.

## Recommended execution order

1. Finish the active Board hierarchy transaction and drag/drop block.
2. Complete the backup gate and restore drill because the normal workspace already contains real user data.
3. Add `WorkspaceService` and direct Link creation without changing behavior.
4. Ship the MCP read-Board plus batch-add-Links vertical slice.
5. Add cross-process refresh and durable batch undo if not completed inside step 4; agent writes remain disabled until both work.
6. Continue browser tabs/Quick Boards and the spatial UI plan.
7. Add the tested image clipboard slice.
8. Add filesystem aliases after the access model is proven.

## NOT in scope for the first agent slice

- embedded chat UI or choosing Hermes/OpenAI/another model;
- autonomous filesystem access;
- arbitrary SQL, shell, or plugin execution;
- cloud sync or remote MCP transport;
- agent-driven deletion or permanent trash emptying;
- full generic move/edit coverage before read Board plus batch-create Links proves value;
- filesystem watchers and recursive folder indexing.

## Consequences

- The UI and agents share business rules instead of duplicating them.
- IDs remain stable through rename and Board reparenting.
- MCP is replaceable because it is an adapter, not the domain model.
- Agent writes require a small amount of safety infrastructure before they can ship.
- ADR-0001 now keeps embedded/provider-specific agent work out of the original V1
  while explicitly delegating the provider-agnostic MCP workspace surface to this ADR.

## Priority decision

Accepted on 2026-09-05: after Board hierarchy and the backup/restore safety gate,
ship the first useful MCP agent vertical slice before browser tabs. The embedded
chat UI and the choice of an agent provider remain later product work.
