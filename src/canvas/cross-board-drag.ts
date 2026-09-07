// Cross-board drag state machine (app-owned, outside React Flow).
//
// A drag that hovers a Board tab opens that board and shows a ghost copy of the
// dragged card(s) under the cursor. The database is NOT changed until the user
// releases the pointer on the target board's canvas, at which point the cards
// are moved into that board's Unsorted panel (Milanote-style). Escape, release
// outside the canvas, or pointercancel cancel the drag with no side effects.

export type CrossBoardDragPhase =
  | "dragging" // pointer down on a card, still on the source board
  | "loading-target" // hovered a tab, board is being opened
  | "previewing" // target board open, ghost follows the cursor
  | "committing" // pointerup on target canvas, moving to Unsorted
  | "cancelled"; // aborted, no side effects

export interface CrossBoardDragState {
  /** The dragged card ids (single card for now; batch later). */
  cardIds: string[];
  /** The board the cards currently live on. */
  sourceBoardId: string;
  /** The board being hovered/opened as the drop target, if any. */
  hoverBoardId: string | null;
  /** The board the pointer is currently over (for drop resolution). */
  pointerBoardId: string | null;
  phase: CrossBoardDragPhase;
  /** Screen-space pointer position (for the ghost). */
  pointer: { x: number; y: number };
  /** Snapshot of the dragged card: for the ghost and for the commit (the card
   *  is not in the current board's projection once the target opens). */
  ghostCard: {
    cardId: string;
    kind: string;
    width: number;
    height: number;
    label: string;
    revision: number;
    boardId: string;
    frame: { x: number; y: number; width: number; height: number };
  } | null;
}

export function createCrossBoardDrag(
  cardIds: string[],
  sourceBoardId: string,
  ghostCard: CrossBoardDragState["ghostCard"],
): CrossBoardDragState {
  return {
    cardIds,
    sourceBoardId,
    hoverBoardId: null,
    pointerBoardId: null,
    phase: "dragging",
    pointer: { x: 0, y: 0 },
    ghostCard,
  };
}

/** Pointer moved: update position and the board under the pointer. */
export function moveCrossBoardDrag(
  state: CrossBoardDragState,
  pointer: { x: number; y: number },
  pointerBoardId: string | null,
): CrossBoardDragState {
  return { ...state, pointer, pointerBoardId };
}

/** A tab was hovered: begin opening that board (idempotent). */
export function hoverCrossBoardTab(state: CrossBoardDragState, boardId: string): CrossBoardDragState {
  if (state.hoverBoardId === boardId) return state;
  return { ...state, hoverBoardId: boardId, phase: "loading-target" };
}

/** The hovered board finished loading: ghost mode. */
export function targetBoardLoaded(state: CrossBoardDragState): CrossBoardDragState {
  if (state.phase !== "loading-target") return state;
  return { ...state, phase: "previewing" };
}

/** Pointer released on the target board's canvas: commit the move. */
export function commitCrossBoardDrag(state: CrossBoardDragState): CrossBoardDragState {
  return { ...state, phase: "committing" };
}

/** Abort the drag (Escape, release outside canvas, pointercancel). */
export function cancelCrossBoardDrag(state: CrossBoardDragState): CrossBoardDragState {
  return { ...state, phase: "cancelled" };
}