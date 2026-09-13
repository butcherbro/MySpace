# ADR-0006: Plain File-System Bookmarks Outside App Sandbox

- **Status:** Accepted
- **Date:** 2026-09-11
- **Source:** folder-shortcut regression reported by the user (2026-09-11)
- **Supersedes:** for the currently unsandboxed build, the security-scoped
  bookmark provisions of `docs/review-verdict-12-filesystem-shortcuts.md`
  ("macOS capability boundary") and the "balanced security-scoped access via RAII
  guard" note in `tasks/todo.md` (Active handoff — Folder Shortcut V1).

## Context

A folder shortcut must survive restarts: SQLite stores opaque locator bytes for the
chosen folder, and a later resolve re-opens that folder to render its preview and
to reveal/open it in Finder. On macOS the locator was created with
`NSURLBookmarkCreationWithSecurityScope | NSURLBookmarkCreationSecurityScopeAllowOnlyReadAccess`,
and resolved with `NSURLBookmarkResolutionOptions::WithSecurityScope` plus
`startAccessingSecurityScopedResource()`, guarded by a `SecurityScopeGuard`.

That design assumed an App Sandbox. The app is **not** sandboxed: `src-tauri`
contains no entitlements file and no `com.apple.security.app-sandbox`, so there is
no sandbox to escape and no security-scoped bookmark to grant. On current macOS the
security-scoped path is now rejected outside App Sandbox, which surfaced as a user
visible regression:

```
constraint_violation: could not create folder locator
```

The failure was silent about its cause because the underlying Foundation error was
discarded (`map_err(|_| LocatorError::Io)`).

### Evidence

A temporary diagnostic compared both creation paths on a real directory:

```
DIAG scoped:  FAIL domain=NSCocoaErrorDomain code=256 desc=The file couldn’t be opened.
DIAG regular: OK 1104 bytes
```

- `NSCocoaErrorDomain 256` is `NSFileReadUnknownError`.
- After the change, `cargo test` is fully green (the previously failing
  `macos_locator_persists_bookmark_data_not_source_path_bytes` now passes), and the
  user confirmed the fix manually: dragging a folder from Finder onto a board
  creates the shortcut again.

## Decision

1. Create and resolve **plain** bookmarks:
   `NSURLBookmarkCreationOptions::empty()` and
   `NSURLBookmarkResolutionOptions::WithoutUI`.
2. Never request or hold a security scope. `SecurityScopeGuard` and
   `ResolvedFolder::_scope` are removed.
3. Locator failures carry the Foundation diagnostic
   (`<domain> <code>: <localizedDescription>`) so a broken locator is diagnosable
   from the error text alone, and the command surfaces it:
   `could not create folder locator: <reason>`.
4. Keep the macOS bookmark behind the `FolderLocator` trait so the transport can
   change without touching callers.

## Consequences

- Folder shortcuts work in the currently unsandboxed app. Two guards cover the
  decision: `macos_locator_round_trips_regular_bookmark` exercises the real
  Foundation create → resolve path (the functional guard, meaningful on an
  unsandboxed macOS runner), while
  `macos_locator_creation_options_are_plain` asserts the shared creation-options
  constant stays scope-free (a narrower guard that a caller inlining its own
  options would bypass).
- Plain bookmarks grant no access under App Sandbox. **If the app is ever
  sandboxed, security-scoped bookmarks and the
  `com.apple.security.files.bookmarks.app-scope` entitlement must be re-introduced
  together.** The `FolderLocator` boundary keeps that change local to
  `platform_macos` code plus entitlements.
- A future locator failure now reports the underlying Foundation error instead of
  an opaque message, so the same investigation does not have to be repeated.
