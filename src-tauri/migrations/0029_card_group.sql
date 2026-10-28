-- 0029_card_group.sql
-- Stored group membership (ADR-0013, revision 2026-10-28): the group a card
-- belongs to. Membership changes only by an action on the card itself
-- (`MoveCards` with `group`, `CreateGroup` with `memberIds`), never by
-- moving or resizing the group.
--
-- No foreign key: sync replay may apply a member before its group, and a
-- purged group leaves the value dangling. The stored value is kept through
-- trash/restore, board moves and Unsorted; the loaders return it only while
-- it names a live, placed `group` card on the member's board.

ALTER TABLE cards ADD COLUMN group_id TEXT NULL;

CREATE INDEX cards_group_id ON cards(group_id) WHERE group_id IS NOT NULL;
