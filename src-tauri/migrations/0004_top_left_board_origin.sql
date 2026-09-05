-- Rebase every existing board into the non-negative coordinate quadrant.
--
-- Earlier builds allowed cards to be placed at negative x/y. Once the canvas
-- is bounded at its top-left origin, those cards would become unreachable.
-- Shift each board as one rigid layout, including trashed cards, so relative
-- positions and future Trash restoration remain intact.

CREATE TEMP TABLE board_coordinate_offsets (
    board_id TEXT PRIMARY KEY,
    min_x REAL NOT NULL,
    min_y REAL NOT NULL
);

INSERT INTO board_coordinate_offsets (board_id, min_x, min_y)
SELECT
    board_id,
    CASE WHEN MIN(x) < 0 THEN MIN(x) ELSE 0 END,
    CASE WHEN MIN(y) < 0 THEN MIN(y) ELSE 0 END
FROM cards
GROUP BY board_id;

UPDATE cards
SET
    x = x - (
        SELECT min_x
        FROM board_coordinate_offsets
        WHERE board_coordinate_offsets.board_id = cards.board_id
    ),
    y = y - (
        SELECT min_y
        FROM board_coordinate_offsets
        WHERE board_coordinate_offsets.board_id = cards.board_id
    );

UPDATE board_view_states
SET viewport_x = 0, viewport_y = 0;

DROP TABLE board_coordinate_offsets;
