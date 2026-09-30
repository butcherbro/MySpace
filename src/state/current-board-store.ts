// Current-board store: the projection of the open board that the UI renders.
//
// This isolates board state (cards of *all* kinds, selection, revisions,
// viewport) from `App.tsx` so the canvas, note editor, and future portals all
// read a single authoritative in-memory projection that mirrors SQLite.
//
// Mutations are optimistic: actions apply immediately and the caller is
// responsible for reconciliation on failure (see `rollback`/`reconcile`).

import type {
  AssetDto,
  BoardSummary,
  CardDto,
  Breadcrumb,
  FilesystemAliasDto,
} from "../services/workspace-gateway";
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

/** Card ids changed locally after a snapshot was requested. */
export interface SnapshotRequestChanges {
  /** A write answer changed the card (an addition counts too). */
  written: string[];
  added: string[];
  removed: string[];
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
      /**
       * Local changes made after this snapshot was requested (`CardWrites`).
       * A same-board reload merges them in; for every other card the snapshot
       * wins, even at a lower revision (a device sync can legitimately lower one).
       */
      sinceRequest?: SnapshotRequestChanges;
    }
  | { type: "cardAdded"; card: CardDto }
  | { type: "cardContentUpdated"; id: string; revision: number; documentJson: unknown; plainText: string }
  | { type: "imageCaptionUpdated"; id: string; revision: number; captionJson: unknown; captionPlainText: string }
  | { type: "embedDescriptionUpdated"; id: string; revision: number; descriptionJson: unknown; descriptionPlainText: string }
  | { type: "cardReplaced"; id: string; card: CardDto }
  /** A board's cover was set or removed; the backend bumps no revision for it. */
  | { type: "boardCoverChanged"; boardId: string; coverAsset: AssetDto | null }
  /** A shortcut's device-local state changed (ADR-0012: pointed at a local folder). */
  | { type: "filesystemAliasUpdated"; alias: FilesystemAliasDto }
  | { type: "unsortedCardPlaced"; id: string; revision: number; frame: CardDto["frame"] }
  | { type: "cardMovedToUnsorted"; id: string; revision: number }
  | { type: "cardMoved"; id: string; revision: number; frame: CardDto["frame"] }
  /** A portal's board was reparented and the portal stayed on the open board. */
  | { type: "portalMoved"; id: string; revision: number; boardRevision: number; frame: CardDto["frame"] }
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

/**
 * Применяет ответ записи к карточке `id`, если своя копия не новее ответа.
 * Инвариант: бэкенд применяет записи одной карточки строго по очереди, и каждая
 * поднимает ревизию, поэтому копия с большей ревизией уже содержит результат
 * записи с меньшей. Ответ ниже своей копии — ответ более ранней записи, пришедший
 * позже (записи вне очереди — метаданные ссылки — обгоняют очередь). Применённый,
 * он откатил бы ревизию, и следующая запись из очереди упала бы с `stale_revision`.
 */
export function applyCardWrite(
  cards: CardDto[],
  id: string,
  revision: number,
  update: (card: CardDto) => CardDto,
): CardDto[] {
  return cards.map((c) => (c.id === id && c.revision <= revision ? update(c) : c));
}

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
        // Снимок мог быть прочитан раньше локальных изменений, сделанных после
        // его запроса. Своя копия побеждает, только если её записали после
        // запроса И её ревизия выше, чем в снимке; иначе снимок новее (другой
        // процесс писал позже). Созданная после запроса карточка, которой в
        // снимке ещё нет, остаётся; удалённая после запроса не возвращается.
        // Остальных карточек без снимка больше нет — их удалил другой процесс.
        const since = action.sinceRequest ?? { written: [], added: [], removed: [] };
        const written = new Set(since.written);
        const added = new Set(since.added);
        const removed = new Set(since.removed);
        const onCanvas = new Map(state.cards.map((c) => [c.id, c]));
        const inUnsorted = new Map(state.unsortedCards.map((c) => [c.id, c]));
        const snapshotIds = new Set([...action.cards, ...action.unsortedCards].map((c) => c.id));
        const keepHeld = new Set(
          [...action.cards, ...action.unsortedCards]
            .filter((c) => {
              const own = onCanvas.get(c.id) ?? inUnsorted.get(c.id);
              return own !== undefined && written.has(c.id) && own.revision > c.revision;
            })
            .map((c) => c.id),
        );
        const merge = (fresh: CardDto[], held: Map<string, CardDto>): CardDto[] => {
          const freshIds = new Set(fresh.map((c) => c.id));
          return [
            ...fresh.flatMap((c) => {
              if (removed.has(c.id)) return [];
              if (!keepHeld.has(c.id)) return [c];
              const own = held.get(c.id);
              return own ? [own] : [];
            }),
            ...[...held.values()].filter(
              (c) =>
                // Своя копия перешла между холстом и Unsorted после запроса.
                (keepHeld.has(c.id) && !freshIds.has(c.id)) ||
                (!snapshotIds.has(c.id) && added.has(c.id)),
            ),
          ];
        };
        const cards = merge(action.cards, onCanvas);
        const unsortedCards = merge(action.unsortedCards, inUnsorted);
        const ids = new Set([...cards, ...unsortedCards].map((c) => c.id));
        return {
          ...state,
          board: action.board,
          breadcrumbs: action.breadcrumbs,
          viewport: { ...state.viewport, zoom: action.viewport.zoom },
          viewportRevision: action.viewportRevision,
          cards,
          unsortedCards,
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
        cards: applyCardWrite(state.cards, action.id, action.revision, (c) =>
          c.kind === "note"
            ? {
                ...c,
                revision: action.revision,
                documentJson: action.documentJson,
                plainText: action.plainText,
                // A successful write stored a valid document (P1.7).
                corrupt: false,
              }
            : c,
        ),
      };

    case "imageCaptionUpdated":
      return {
        ...state,
        cards: applyCardWrite(state.cards, action.id, action.revision, (c) =>
          c.kind === "image"
            ? {
                ...c,
                revision: action.revision,
                captionJson: action.captionJson,
                captionPlainText: action.captionPlainText,
                // A successful write stored a valid document (P1.7).
                corrupt: false,
              }
            : c,
        ),
      };

    case "embedDescriptionUpdated":
      return {
        ...state,
        cards: applyCardWrite(state.cards, action.id, action.revision, (c) =>
          c.kind === "embed"
            ? {
                ...c,
                revision: action.revision,
                descriptionJson: action.descriptionJson,
                descriptionPlainText: action.descriptionPlainText,
                // A successful write stored a valid document (P1.7).
                corrupt: false,
              }
            : c,
        ),
      };

    case "cardReplaced": {
      const held = state.cards.find((c) => c.id === action.id);
      // Устаревший DTO (см. applyCardWrite) не применяем целиком и редактирование не сбрасываем.
      if (held && held.revision > action.card.revision) return state;
      return {
        ...state,
        cards: state.cards.map((c) => (c.id === action.id ? action.card : c)),
        editingCardId: state.editingCardId === action.id ? null : state.editingCardId,
      };
    }

    case "boardCoverChanged":
      // Only the cover moves: frame, title and revision stay whatever the store
      // already holds, however stale the caller's copy of the portal was.
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.kind === "board_portal" && c.target.id === action.boardId
            ? { ...c, target: { ...c.target, coverAsset: action.coverAsset } }
            : c,
        ),
      };

    case "filesystemAliasUpdated": {
      // Only the device-scoped fields move: the frame, z-order and revision
      // the UI holds stay authoritative (a local re-point bumps no revision).
      const update = (c: CardDto): CardDto =>
        c.id === action.alias.id && c.kind === "filesystem_alias"
          ? {
              ...c,
              local: action.alias.local,
              originDeviceId: action.alias.originDeviceId,
              originDeviceName: action.alias.originDeviceName,
              pathHint: action.alias.pathHint,
              displayName: action.alias.displayName,
            }
          : c;
      return {
        ...state,
        cards: state.cards.map(update),
        unsortedCards: state.unsortedCards.map(update),
      };
    }

    case "unsortedCardPlaced": {
      const card = state.unsortedCards.find((c) => c.id === action.id);
      if (!card) return state;
      // Ревизия — max (не откатываем, см. applyCardWrite), а frame — всегда из
      // ответа: у карточки в Unsorted своего места на холсте нет.
      const placed = { ...card, frame: action.frame, revision: Math.max(card.revision, action.revision) };
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
      const moved = { ...card, revision: Math.max(card.revision, action.revision) };
      return {
        ...state,
        cards: state.cards.filter((c) => c.id !== action.id),
        unsortedCards: [...state.unsortedCards, moved],
      };
    }

    case "cardMoved":
      return {
        ...state,
        cards: applyCardWrite(state.cards, action.id, action.revision, (c) => ({
          ...c,
          revision: action.revision,
          frame: action.frame,
        })),
      };

    case "portalMoved":
      return {
        ...state,
        cards: applyCardWrite(state.cards, action.id, action.revision, (c) =>
          c.kind === "board_portal"
            ? {
                ...c,
                revision: action.revision,
                frame: action.frame,
                target: { ...c.target, boardRevision: action.boardRevision },
              }
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
