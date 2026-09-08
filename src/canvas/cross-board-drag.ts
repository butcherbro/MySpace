// Cross-board drag state machine (app-owned, outside React Flow).
//
// A drag that hovers a Board tab opens that board and shows a ghost copy of the
// dragged card(s) under the cursor. The database is NOT changed until the user
// releases the pointer on the target board's canvas, at which point the cards
// are moved (leaf cards into Unsorted, board portals reparented). Escape, release
// outside the canvas, or pointercancel cancel the drag with no side effects.

export type CrossBoardDragPhase =
  | "dragging" // pointer down on a card, still on the source board
  | "loading-target" // hovered a tab, board is being opened
  | "previewing" // target board open, ghost follows the cursor
  | "committing" // pointerup on target canvas, moving
  | "cancelled"; // aborted, no side effects

/** A snapshot of one dragged card, captured at drag start. */
export interface CrossBoardCardSnapshot {
  cardId: string;
  kind: string;
  width: number;
  height: number;
  label: string;
  revision: number;
  boardId: string;
  frame: { x: number; y: number; width: number; height: number };
  /** For board portals: the board the portal leads to. */
  targetBoardId?: string;
  /** For board portals: that board's current revision (for reparenting). */
  boardRevision?: number;
}

export interface CrossBoardDragState {
  /** The dragged card ids (single card, or a whole multi-selection). */
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
  /** Snapshots of every dragged card (for the group commit). */
  cards: CrossBoardCardSnapshot[];
  /** The representative card for the ghost (== cards[0], or null). */
  ghostCard: CrossBoardCardSnapshot | null;
}

export function createCrossBoardDrag(
  cards: CrossBoardCardSnapshot[],
  sourceBoardId: string,
): CrossBoardDragState {
  return {
    cardIds: cards.map((c) => c.cardId),
    sourceBoardId,
    hoverBoardId: null,
    pointerBoardId: null,
    phase: "dragging",
    pointer: { x: 0, y: 0 },
    cards,
    ghostCard: cards[0] ?? null,
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