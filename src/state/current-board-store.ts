// Current-board store: the projection of the open board that the UI renders.
//
// This isolates board state (cards of *all* kinds, selection, revisions,
// viewport) from `App.tsx` so the canvas, note editor, and future portals all
// read a single authoritative in-memory projection that mirrors SQLite.
//
// Mutations are optimistic: actions apply immediately and the caller is
// responsible for reconciliation on failure (see `rollback`/`reconcile`).

import type { BoardSummary, CardDto, Breadcrumb } from "../services/workspace-gateway";
import type { CanvasViewport } from "../canvas/canvas-types";

export interface CurrentBoardState {
  board: BoardSummary | null;
  breadcrumbs: Breadcrumb[];
  viewport: CanvasViewport;
  viewportRevision: number;
  boardOpenRevision: number;
  cards: CardDto[];
  /** Cards in the board's Unsorted panel (hidden from canvas). */
  unsortedCards: CardDto[];
  selection: string[];
  editingCardId: string | null;
  loading: boolean;
  error: string | null;
}

export type CurrentBoardAction =
  | { type: "loading" }
  | {
      type: "snapshotLoaded";
      board: BoardSummary;
      breadcrumbs: Breadcrumb[];
      viewport: CanvasViewport;
      viewportRevision: number;
      cards: CardDto[];
      unsortedCards: CardDto[];
    }
  | { type: "cardAdded"; card: CardDto }
  | { type: "cardContentUpdated"; id: string; revision: number; documentJson: unknown; plainText: string }
  | { type: "imageCaptionUpdated"; id: string; revision: number; captionJson: unknown; captionPlainText: string }
  | { type: "embedDescriptionUpdated"; id: string; revision: number; descriptionJson: unknown; descriptionPlainText: string }
  | { type: "cardReplaced"; id: string; card: CardDto }
  | { type: "unsortedCardPlaced"; id: string; revision: number; frame: CardDto["frame"] }
  | { type: "cardMovedToUnsorted"; id: string; revision: number }
  | { type: "cardMoved"; id: string; revision: number; frame: CardDto["frame"] }
  | { type: "noteColorChanged"; id: string; colorToken: string }
  | { type: "cardsRemoved"; ids: string[] }
  | { type: "boardRenamed"; boardId: string; title: string }
  | { type: "selectionChanged"; ids: string[] }
  | { type: "editingStarted"; id: string }
  | { type: "editingStopped" }
  | { type: "viewportChanged"; viewport: CanvasViewport }
  | { type: "viewportSaved"; revision: number }
  | { type: "failed"; message: string }
  | { type: "clearError" };

export const initialState: CurrentBoardState = {
  board: null,
  breadcrumbs: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  viewportRevision: 1,
  boardOpenRevision: 0,
  cards: [],
  unsortedCards: [],
  selection: [],
  editingCardId: null,
  loading: false,
  error: null,
};

export function reducer(
  state: CurrentBoardState,
  action: CurrentBoardAction,
): CurrentBoardState {
  switch (action.type) {
    case "loading":
      return { ...state, loading: true, error: null };

    case "snapshotLoaded": {
      // A reload of the board that is already open (undo/redo, rename, the
      // `change_seq` poll after an agent write) is not a
      // board switch: the user's pan, the note being edited and the selection
      // must survive it. Bumping `boardOpenRevision` here is what made the
      // canvas snap back to the origin "at random" (todo.md №26, second cause):
      // CanvasAdapter re-applies the pinned (0,0) viewport on every bump.
      const sameBoard = state.board?.id === action.board.id;
      if (sameBoard) {
        const ids = new Set([...action.cards, ...action.unsortedCards].map((c) => c.id));
        return {
          ...state,
          board: action.board,
          breadcrumbs: action.breadcrumbs,
          viewport: { ...state.viewport, zoom: action.viewport.zoom },
          viewportRevision: action.viewportRevision,
          cards: action.cards,
          unsortedCards: action.unsortedCards,
          selection: state.selection.filter((id) => ids.has(id)),
          editingCardId:
            state.editingCardId !== null && ids.has(state.editingCardId)
              ? state.editingCardId
              : null,
          loading: false,
          error: null,
        };
      }

      // A genuine board switch reopens the board pinned to its top-left
      // origin: one fixed visible surface, growing right/down only. Ignore any
      // persisted viewport position so a prior pan never reopens the board
      // scrolled away from the user's primary content.
      const viewport: CanvasViewport = {
        x: 0,
        y: 0,
        zoom: action.viewport.zoom,
      };
      return {
        ...state,
        board: action.board,
        breadcrumbs: action.breadcrumbs,
        viewport,
        viewportRevision: action.viewportRevision,
        boardOpenRevision: state.boardOpenRevision + 1,
        cards: action.cards,
        unsortedCards: action.unsortedCards,
        selection: [],
        editingCardId: null,
        loading: false,
        error: null,
      };
    }

    case "cardAdded":
      return { ...state, cards: [...state.cards, action.card] };

    case "cardContentUpdated":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id && c.kind === "note"
            ? {
                ...c,
                revision: action.revision,
                documentJson: action.documentJson,
                plainText: action.plainText,
              }
            : c,
        ),
      };

    case "imageCaptionUpdated":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id && c.kind === "image"
            ? {
                ...c,
                revision: action.revision,
                captionJson: action.captionJson,
                captionPlainText: action.captionPlainText,
              }
            : c,
        ),
      };

    case "embedDescriptionUpdated":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id && c.kind === "embed"
            ? {
                ...c,
                revision: action.revision,
                descriptionJson: action.descriptionJson,
                descriptionPlainText: action.descriptionPlainText,
              }
            : c,
        ),
      };

    case "cardReplaced":
      return {
        ...state,
        cards: state.cards.map((c) => (c.id === action.id ? action.card : c)),
        editingCardId: state.editingCardId === action.id ? null : state.editingCardId,
      };

    case "unsortedCardPlaced": {
      const card = state.unsortedCards.find((c) => c.id === action.id);
      if (!card) return state;
      const placed = { ...card, frame: action.frame, revision: action.revision };
      return {
        ...state,
        unsortedCards: state.unsortedCards.filter((c) => c.id !== action.id),
        cards: [...state.cards, placed],
      };
    }

    case "cardMovedToUnsorted": {
      const card = state.cards.find((c) => c.id === action.id);
      if (!card) return state;
      // The backend bumped the card's revision on the move; the receipt
      // carries the authoritative value so a later Place uses it.
      const moved = { ...card, revision: action.revision };
      return {
        ...state,
        cards: state.cards.filter((c) => c.id !== action.id),
        unsortedCards: [...state.unsortedCards, moved],
      };
    }

    case "cardMoved":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id
            ? { ...c, revision: action.revision, frame: action.frame }
            : c,
        ),
      };

    case "noteColorChanged":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id && c.kind === "note"
            ? { ...c, colorToken: action.colorToken }
            : c,
        ),
      };

    case "cardsRemoved":
      return {
        ...state,
        cards: state.cards.filter((c) => !action.ids.includes(c.id)),
        selection: [],
        editingCardId: null,
      };

    case "boardRenamed":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.kind === "board_portal" && c.target.id === action.boardId
            ? { ...c, target: { ...c.target, title: action.title } }
            : c,
        ),
        board:
          state.board?.id === action.boardId
            ? { ...state.board, title: action.title }
            : state.board,
      };

    case "selectionChanged":
      return { ...state, selection: action.ids };

    case "editingStarted":
      return { ...state, editingCardId: action.id, selection: [action.id] };

    case "editingStopped":
      return { ...state, editingCardId: null };

    case "viewportChanged":
      return { ...state, viewport: action.viewport };

    case "viewportSaved":
      return { ...state, viewportRevision: action.revision };

    case "failed":
      return { ...state, error: action.message, loading: false };

    case "clearError":
      return { ...state, error: null };

    default:
      return state;
  }
}
