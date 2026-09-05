# ADR-0003: Top-left Board Origin

- **Status:** Accepted
- **Date:** 2026-09-04
- **Supersedes:** The viewport-position persistence and unbounded-canvas parts of ADR-0001

## Decision

Every board uses a fixed top-left origin. Board coordinates are non-negative;
cards and the camera may extend indefinitely to the right and down, but may not
cross above or left of `(0, 0)`.

Opening or reopening any board resets the camera position to `(0, 0)` while
retaining that board's saved zoom. Pan position is not restored.

Existing layouts with negative coordinates are migrated by translating every
card on each board by the same per-axis offset. Active and trashed cards move
together so relative placement and later Trash restoration remain intact.

## Consequences

- React Flow must receive an explicit viewport reset for every snapshot load;
  `defaultViewport` alone is insufficient.
- Camera and node extents start at `(0, 0)` and remain unbounded at the far edge.
- `board_view_states.viewport_x` and `viewport_y` remain schema-compatible but
  are normalized to zero; zoom and the row revision are preserved.
