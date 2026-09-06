# Architecture verdict — Filesystem shortcuts

## Decision

Proceed after the current Quiet Desk shell. Preserve the ADR-0005 model: a
`filesystem_alias` is a spatial Card backed by one external-target detail row.
Directory children are an ephemeral projection, not persisted Cards.

## Answers to the five open questions

1. **Locator:** the authoritative locator is opaque macOS bookmark data, not an
   absolute path. Store it in `filesystem_aliases.locator_blob` together with
   `locator_kind`, `path_hint`, and the last resolved display name. The path is
   diagnostic and copyable UI data only. Resolve stale bookmarks and replace the
   stored blob transactionally. The platform service owns bookmark creation and
   resolution; repositories treat the blob as opaque.

2. **Add flow:** ship the native picker first. Selection and bookmark creation
   must happen in one dedicated Rust/macOS boundary. Do not assume that a path
   returned to JavaScript, or a Finder drop path, grants persistent access: the
   Tauri dialog scope is explicitly reset on application restart. Add Finder
   drag-and-drop in the next slice only after a packaged-app restart test proves
   that it creates the same persistent locator. Do not silently fall back to an
   absolute-path-only alias.

3. **Directory projection:** list one level on demand, directories first, with a
   hard page size of 200 and an opaque continuation cursor. Never recurse, watch,
   or persist children in V1. Return explicit states for `empty`, `missing`,
   `permission_lost`, `unsupported`, and `io_error`. A broken alias remains on the
   Board and offers **Locate Again**; it is never automatically deleted.

4. **Agent access:** reserve `myspace://alias/<card-id>` as the stable external
   address. Do not add a global `myspace://file/<absolute-path>` scheme. Add MCP
   only after the UI access slice, through allowlisted operations such as
   `read_alias` and `read_alias_entry(alias_id, relative_path)`. Normalize and
   reject absolute paths, `..`, symlink escapes, and any resolved target outside
   the selected root. Apply MIME and byte limits. The MCP server receives content
   through `WorkspaceService`; it never gets a general filesystem-read tool.

5. **Data model:** keep one `filesystem_alias` Card kind for both files and
   folders, differentiated by `target_kind`. Add a detail table rather than a
   parallel spatial entity. Before adding the kind, replace the repeatedly rebuilt
   `cards.kind` CHECK with the already proposed extensible kind registry/FK, then
   rebuild `cards` once in a guarded migration. Alias children remain DTOs from
   the listing service, not new card kinds.

## macOS capability boundary

For a sandboxed packaged build, use read-only app-scoped bookmarks and configure
an entitlements plist through `bundle.macOS.entitlements` with:

- `com.apple.security.app-sandbox = true`;
- `com.apple.security.files.user-selected.read-only = true`;
- `com.apple.security.files.bookmarks.app-scope = true`.

Do not request all-files or read-write access for the first slice. Development
mode is not proof of persistence: the acceptance test must select an external
folder, restart a signed packaged build, resolve it again, list it, then revoke or
move it and verify the recovery state.

## Execution order

1. Finish Quiet Desk create rail and navigation chrome.
2. Slice A — kind registry migration, alias schema, opaque locator interface, and
   repository tests. No UI and no raw absolute-path authority.
3. Slice B — native picker plus bookmark create/resolve, add/remove alias, shallow
   paged listing, and packaged restart/recovery tests.
4. Slice C — Folder/File Alias card UI, Open/Reveal in Finder, Copy Path, Locate
   Again, and empty/error states.
5. Slice D — Finder drag-and-drop through the same locator service.
6. Slice E — scoped MCP read operations and `myspace://alias/<id>` resources.

## Sources checked

- ADR-0005, especially the filesystem shortcut and allowlisted-agent invariants.
- Apple App Sandbox bookmark and user-selected file entitlements documentation.
- Tauri 2 dialog documentation: dynamically granted dialog scopes are not
  persisted across application restarts and a dedicated command is recommended
  when stronger security is required.
