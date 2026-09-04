// Library-independent canvas types.
//
// ADR-002: React Flow is isolated behind `CanvasAdapter`. These types are the
// application's own vocabulary for a card's spatial state and the events the
// canvas emits. No React Flow `Node` or viewport type may appear here or leak
// into domain, persistence, or repository modules.

export type CanvasCardKind = "note" | "board_portal" | "image";

/** A card's placement rectangle in board-space coordinates. */
export interface CanvasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A card rendered on the canvas, expressed purely in domain terms. */
export interface CanvasCard {
  id: string;
  boardId: string;
  kind: CanvasCardKind;
  frame: CanvasFrame;
  zIndex: number;
  /**
   * The card's current revision. Included so the adapter can detect content
   * changes (which bump revision) and rebuild its node contents accordingly.
   */
  revision: number;
  /** For board portals, the id of the board they lead to. */
  targetBoardId?: string;
}

/** A point in board-space coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** An application-owned rectangle (board-space), for marquee selection. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The persisted viewport of a board. */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

/** What changed when the user finished dragging a card. */
export interface CardMoved {
  id: string;
  frame: CanvasFrame;
}

/** A multi-card move reports every moved card's final frame. */
export interface CardsMoved {
  cards: CardMoved[];
}

/** Result of a manual width resize on a card. */
export interface CardResized {
  id: string;
  frame: CanvasFrame;
}

/** Selection changed: the set of selected card ids and their anchor card. */
export interface SelectionChanged {
  ids: string[];
}

/** Viewport changed (pan or zoom). Fired continuously during the gesture. */
export interface ViewportChanged {
  viewport: CanvasViewport;
}

/**
 * The event surface the canvas exposes to the rest of the app. These are the
 * only interactions the UI must implement for V1.
 */
export interface CanvasEvents {
  /** A drag gesture finished; report final frames. */
  onCardsMoved?(e: CardsMoved): void;
  /** A width-resize gesture finished. */
  onCardResized?(e: CardResized): void;
  /** Selection changed (marquee, click, shift+click). */
  onSelectionChanged?(e: SelectionChanged): void;
  /** Viewport changed continuously (pan/zoom). */
  onViewportChanged?(e: ViewportChanged): void;
  /** A card was single-clicked (activate note editing). */
  onCardActivated?(id: string): void;
  /** A card was double-clicked (open board portals). */
  onCardOpened?(id: string): void;
  /** A card was right-clicked (request a context menu). Coordinates are screen-space. */
  onCardContextMenu?(id: string, x: number, y: number): void;
  /** A card was dropped onto a board portal (move to that board). */
  onCardDroppedOnPortal?(cardId: string, targetBoardId: string): void;
}
