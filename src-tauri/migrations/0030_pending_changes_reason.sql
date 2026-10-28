-- 0030_pending_changes_reason.sql
-- Device sync: rows deferred for a newer build (ADR-0011).
--
-- `pending_changes.reason` tells two kinds of parked rows apart:
--   NULL      a missing dependency (the card's board, an asset). Retried after
--             every batch; `attempts` counts the retries.
--   not NULL  a row this build cannot interpret yet: an unknown entity kind
--             (`entity_kind`), card kind (`card_kind`), register (`register`)
--             or payload version (`payload_version`). Never retried within a
--             batch and never aged out; released once the build's sync
--             capabilities change (`sync::capabilities`), i.e. after an update.
--
-- Additive: existing rows keep NULL, an older build ignores the column.

ALTER TABLE pending_changes ADD COLUMN reason TEXT NULL;
