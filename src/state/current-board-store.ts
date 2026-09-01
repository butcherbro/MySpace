// Current-board store: the projection of the open board that the UI renders.
//
// This isolates board state (cards of *all* kinds, selection, revisions,
// viewport) from `App.tsx` so the canvas, note editor, and future portals all
// read a single authoritative in-memory projection that mirrors SQLite.
//
// Mutations are optimistic: actions apply immediately and the caller is
// responsible for reconciliation on failure (see `rollback`/`reconcile`).

import type { BoardSummary, CardDto } from "../services/workspace-gateway";
import type { CanvasViewport } from "../canvas/canvas-types";

export interface CurrentBoardState {
  board: BoardSummary | null;
  viewport: CanvasViewport;
  viewportRevision: number;
  cards: CardDto[];
  selection: string[];
  loading: boolean;
  error: string | null;
}

export type CurrentBoardAction =
  | { type: "loading" }
  | {
      type: "snapshotLoaded";
      board: BoardSummary;
      viewport: CanvasViewport;
      viewportRevision: number;
      cards: CardDto[];
    }
  | { type: "cardAdded"; card: CardDto }
  | { type: "cardContentUpdated"; id: string; revision: number; documentJson: unknown; plainText: string }
  | { type: "cardMoved"; id: string; revision: number; frame: CardDto["frame"] }
  | { type: "selectionChanged"; ids: string[] }
  | { type: "viewportChanged"; viewport: CanvasViewport }
  | { type: "viewportSaved"; revision: number }
  | { type: "failed"; message: string }
  | { type: "clearError" };

export const initialState: CurrentBoardState = {
  board: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  viewportRevision: 1,
  cards: [],
  selection: [],
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

    case "snapshotLoaded":
      return {
        ...state,
        board: action.board,
        viewport: action.viewport,
        viewportRevision: action.viewportRevision,
        cards: action.cards,
        selection: [],
        loading: false,
        error: null,
      };

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

    case "cardMoved":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.id
            ? { ...c, revision: action.revision, frame: action.frame }
            : c,
        ),
      };

    case "selectionChanged":
      return { ...state, selection: action.ids };

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
