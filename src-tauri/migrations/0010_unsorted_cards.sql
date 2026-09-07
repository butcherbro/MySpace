-- 0010_unsorted_cards.sql
-- Cards moved into a Board without being placed land in that Board's "Unsorted"
-- side panel (Milanote-style) instead of stacking at the origin. A card with
-- unsorted = 1 belongs to its board but has no meaningful placement yet: the
-- canvas hides it and the right rail shows it as a thumbnail until the user
-- distributes it (unsorted = 0 + a real frame).
--
-- This is a flag on the existing card, not a separate entity: the card keeps
-- its board_id (so counts and hierarchy stay correct) and its frame is simply
-- ignored while unsorted. Distributing is a single UPDATE.

ALTER TABLE cards
    ADD COLUMN unsorted INTEGER NOT NULL DEFAULT 0
        CHECK(unsorted IN (0, 1));