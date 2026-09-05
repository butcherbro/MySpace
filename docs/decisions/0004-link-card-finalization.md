# ADR-0004: Link Card Finalization

- **Status:** Accepted
- **Date:** 2026-09-04
- **Supersedes:** The Link Preview non-goal and narrow clipboard statement in ADR-0001
- **Specification:** `docs/specs/link-card-and-clipboard.md`

## Decision

A Note converts to the existing `embed` card kind only on explicit finalize
intent: Enter or blur. It qualifies only when its semantic content is exactly
one absolute HTTP(S) URL. Debounced autosave never changes the card kind.

Conversion is transactional and preserves card identity, board, frame, z-index,
and Trash identity. Once converted, a Link Card never changes back based on its
content.

The first implementation may use URL-only fallback presentation. Network
metadata, favicon acquisition, and cached preview images are a later enrichment
step and must not be required for conversion or navigation.
