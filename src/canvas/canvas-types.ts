// Library-independent canvas types.
//
// ADR-002: React Flow is isolated behind `CanvasAdapter`. These types are the
// application's own vocabulary for a card's spatial state and the events the
// canvas emits. No React Flow `Node` or viewport type may appear here or leak
// into domain, persistence, or repository modules.

import type { CardKind } from "../cards/card-kinds";

/** The canvas's own vocabulary for a card's kind, derived from `CardKind`
 *  (cards/card-kinds.ts) so the two lists cannot drift apart. */
export type CanvasCardKind = CardKind;

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
  /** Группа, в которой карточка состоит (хранимый состав, ADR-0013); `null` — ни в какой. */
  groupId: string | null;
  /** For board portals, the id of the board they lead to. */
  targetBoardId?: string;
  /** For board portals: the portal's display title (re-render key). */
  portalTitle?: string;
  /** For board portals: the id of the cover asset, if any (re-render key). */
  portalCoverAssetId?: string;
  /**
   * For folder shortcuts: whether this device holds a locator (ADR-0012).
   * A re-render key: pointing a shortcut at a local folder bumps no revision.
   */
  aliasLocal?: boolean;
  /** Для групп: название (ключ перерисовки). */
  groupTitle?: string;
  /** Для групп: id цветового пресета (ключ перерисовки). */
  groupColorToken?: string;
  /**
   * Для заметок: пресет фона. Ключ перерисовки: смена цвета не растит revision,
   * и без него открытая заметка остаётся на экране прежнего цвета.
   */
  colorToken?: string;
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
  /**
   * Новое членство по правилу броска (ADR-0013): есть только у карточки,
   * брошенной самостоятельно, когда её группа меняется; `groupId: null` —
   * вышла из группы. Отсутствует — членство не меняется.
   */
  group?: { groupId: string | null };
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
  /** The empty canvas pane was double-clicked (create menu at that point). `point` is
   * board-space (for placing the new card), `screen` is client-space (for the menu). */
  onPaneDoubleClick?(point: Point, screen: Point): void;
  /** A card was right-clicked (request a context menu). Coordinates are screen-space. */
  onCardContextMenu?(id: string, x: number, y: number): void;
  /** The empty canvas pane was right-clicked (request a board context menu). */
  onPaneContextMenu?(x: number, y: number): void;
  /** A card was dropped onto a board portal (move to that board). */
  onCardDroppedOnPortal?(cardId: string, targetBoardId: string): void;
  /** A group of cards was dropped onto a board portal (batch move). */
  onCardsDroppedOnPortal?(ids: string[], targetBoardId: string): void;
  /** A card is being dragged over a portal (or null when it leaves). */
  onPortalHighlight?(portalId: string | null): void;
  /** A card is being dragged; report its screen-space pointer for drop targets. */
  onCardDragMove?(e: { cardId: string; clientX: number; clientY: number }): void;
  /** A card drag gesture finished (for clearing transient drop target state).
   *  Returns true when the drop was consumed (pinned to Quick Boards or moved
   *  to a portal), so the canvas must not also persist a plain reposition. */
  onCardDragEnd?(): boolean | void;
  /** Связь протянута от одной карточки к другой (никогда к самой себе). */
  onConnectorCreate?(e: ConnectorRequested): void;
  /** Изменился набор выделенных связей. */
  onConnectorSelectionChanged?(e: SelectionChanged): void;
  /** Правый клик по связи. Координаты экранные. */
  onConnectorContextMenu?(id: string, x: number, y: number): void;
}

/** На каких концах связи стрелка. "end" — только у `to`. */
export type CanvasConnectorArrowEnds = "end" | "both" | "none";

/** Стрелка между двумя карточками в собственных терминах холста. */
export interface CanvasConnector {
  id: string;
  fromCardId: string;
  toCardId: string;
  /** Id цветового пресета заметки ('default' — нейтральная серая линия). */
  colorToken: string;
  arrowEnds: CanvasConnectorArrowEnds;
}

/** Связь, протянутая от ручки одной карточки, отпущена над другой. */
export interface ConnectorRequested {
  fromCardId: string;
  toCardId: string;
}
