# ADR-0008: Favicon Identity by Stored Bytes

- **Status:** Accepted (user decision 2026-09-13; architect confirmation still open)
- **Date:** 2026-09-13
- **Source:** checkpoint TASK-14-FAVICON-IDENTITY of
  `docs/plans/2026-09-11-v1-stabilization-and-debt-paydown.md`
- **Decides:** the identity used by the startup favicon collapse (Task 14)

## Context

Two identities were in play and they disagreed.

Enrichment keys the runtime cache by **favicon URL**: `enrich_embed_with_metadata`
passes `metadata.favicon_url` as the cache key, and `download_optional_image`
reads and writes `favicon_cache(source_url, asset_id)` with it. Startup collapse
keyed by **page URL** (`embed_cards.source_url`), so ten YouTube links with ten
URLs but one favicon were ten groups of one and nothing ever merged. Because the
old collapse also wrote those page URLs into `favicon_cache`, the URL-keyed
runtime lookup could never hit its own rows either.

The plan asks for the runtime identity to be used at startup, and notes two
fallbacks when historical rows do not store the favicon URL: derive a host-level
key, or add an append-only migration storing `favicon_source_url`. A migration was
the trigger for an **ASK ARCHITECT** checkpoint.

## Decision

Identity is the **stored file bytes**. Assets merge only when their files are
byte-for-byte equal; the lowest asset id in a group survives.

Why the other options were rejected:

- **Storing `favicon_source_url` (migration).** The URL of an asset already on
  disk was never recorded anywhere, so a migration cannot repair the existing
  duplicates at all — it would only cover cards enriched later, which the runtime
  URL cache already deduplicates. It would add a schema version for no
  additional repair.
- **Deriving a host-level key.** This is inference, and the plan warns against
  it: one host can serve different icons, and merging those silently shows a card
  the wrong image. Byte equality needs no such assumption.

Scope is bounded: only assets referenced by a live Embed card's
`favicon_asset_id` (or by `favicon_cache`) are read, at most 4 MB per file and
64 MB per startup pass. An unreadable, unsafe or oversized file is skipped —
never merged, never fatal — so the collapse cannot fail startup. The collapse
only re-points rows; deleting the orphaned files stays the asset GC's job, which
runs immediately afterwards. Failures are now logged (`favicon-dedup:`) instead
of being swallowed by `let _ =`.

## Consequences

- Duplicate favicons collapse exactly, with no heuristic, and the GC reclaims the
  redundant files.
- `favicon_cache` rows whose key is a page URL are deleted: they were never a
  favicon identity and they disabled the runtime dedup. Rows that point at a
  merged asset follow the merge, so the runtime cache stays coherent.
- The favicon URL is still not stored per card. Future dedup relies on the
  runtime URL cache, which is correct for cards enriched from now on; recording
  the URL durably remains available if the architect prefers it.
- Startup reads the favicon files once. On the live library that is 13 files of a
  few KB; the byte budgets keep a pathological workspace bounded.

## Evidence

- `src-tauri/tests/link_metadata.rs`: distinct videos sharing bytes collapse; same
  host with different bytes does not; page-URL cache keys are dropped while real
  favicon URLs follow the merge; missing files merge nothing.
- Dry run on a copy of the live library, then the shipped implementation against
  the startup snapshot `backups/1789292654` (pre-change: 14 cards, 13 favicon
  assets, 13 cache rows): 12 cards re-pointed, 13 assets → 2, 13 page-URL cache
  rows removed, **no card's image bytes changed**, `integrity_check: ok`.

## Open question for the architect

Whether the favicon source URL should also be stored durably (migration 0018) for
future identity checks. Not required for the repair above; deferred on the user's
instruction to ask later.
