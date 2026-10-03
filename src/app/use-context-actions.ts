import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import { pickFolder } from "../services/asset-picker";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { CreateBoardShortcutCommand, DuplicateBoardCommand } from "../commands/board-commands";
import { TrashSelectionCommand, type TrashItem } from "../commands/trash-commands";
import type {
  BoardPortalDto,
  BoardShortcutDto,
  CardDto,
  FolderPreviewDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { BoardViewAction } from "../state/current-board-store";
import type { CardWrites } from "../state/card-writes";

/**
 * Context-menu and selection actions: card/pane context-menu state, delete
 * selection (trash + shortcut cascade + undo), duplicate portal, create
 * shortcut, folder-shortcut preview/open/point-here, and the two plain
 * selection/activation relays from the canvas.
 *
 * `contextMenu` itself stays in `App` (also read by `use-copy-actions` and
 * `use-board-cover`) and is passed in; `paneContextMenu` moves here since only
 * these handlers and the JSX read it.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 9).
 */

export interface ContextActionsDeps {
  cards: CardDto[];
  selection: string[];
  contextMenu: { cardId: string; x: number; y: number } | null;
  setContextMenu: Dispatch<SetStateAction<{ cardId: string; x: number; y: number } | null>>;
  screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null>;
  gateway: WorkspaceGateway;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  dispatch: Dispatch<BoardViewAction>;
  /** Applies every local card change to the refs and the store together. */
  cardWrites: CardWrites;
  refreshTrash: () => Promise<void>;
}

export interface ContextActionsController {
  paneContextMenu: { x: number; y: number; flowX: number; flowY: number } | null;
  setPaneContextMenu: Dispatch<SetStateAction<{ x: number; y: number; flowX: number; flowY: number } | null>>;
  handleDeleteSelection: () => Promise<void>;
  handleCardsSelected: (e: { ids: string[] }) => void;
  handleCardActivated: (id: string) => void;
  handleRequestContextMenu: (cardId: string, x: number, y: number) => void;
  handleLoadFolderPreview: (id: string) => Promise<FolderPreviewDto>;
  handleOpenFolderInFinder: (id: string) => void;
  handlePointFolderShortcutHere: (id: string) => void;
  handleContextDelete: () => void;
  handlePaneContextMenu: (x: number, y: number) => void;
  handleDuplicatePortal: (portal: BoardPortalDto) => void;
  handleCreateShortcut: (source: BoardPortalDto | BoardShortcutDto) => void;
}

export function useContextActions(deps: ContextActionsDeps): ContextActionsController {
  const { cards, selection, contextMenu, setContextMenu, screenToFlowRef, gateway, dispatcher, idGenerator, dispatch, cardWrites, refreshTrash } =
    deps;

  // x/y — экранные координаты для позиционирования меню; flowX/flowY — координаты
  // доски (с учётом zoom/pan) для размещения левого верхнего угла новой карточки.
  const [paneContextMenu, setPaneContextMenu] = useState<
    { x: number; y: number; flowX: number; flowY: number } | null
  >(null);

  // Trashing a board_portal cascades server-side to every shortcut pointing at
  // it (todo.md №17, ADR-0010). A shortcut on the SAME board being viewed is
  // visible right now and must disappear immediately too — the backend already
  // trashed it, so re-sending it as a leaf trash item would 404 against an
  // already-trashed row. This only patches the currently-rendered board; a
  // shortcut elsewhere pointing deeper into the trashed subtree self-heals on
  // its own board's next snapshot load, which already reflects the cascade.
  const cascadedShortcutIds = useCallback(
    (trashedBoardIds: Set<string>): string[] =>
      cards
        .filter((c) => c.kind === "board_shortcut" && c.target && trashedBoardIds.has(c.target.id))
        .map((c) => c.id),
    [cards],
  );

  // Карточки, чьё удаление уже ушло в бэкенд. Выделение снимается только после
  // ответа, и второе нажатие Delete (или автоповтор клавиши) в этот промежуток
  // отправляло те же карточки ещё раз — бэкенд отвечал not_found на уже
  // удалённую (Windows, 2026-10-03).
  const trashingRef = useRef(new Set<string>());
  const handleDeleteSelection = useCallback(async () => {
    const pending = trashingRef.current;
    const ids = selection.filter((id) => !pending.has(id));
    if (ids.length === 0) return;
    const items: TrashItem[] = ids
      .map((id) => {
        const card = cards.find((c) => c.id === id);
        if (!card) return null;
        if (card.kind === "board_portal") {
          return { id: card.target.id, kind: "board_portal" as const };
        }
        return { id: card.id, kind: card.kind };
      })
      .filter((x): x is TrashItem => x !== null);

    if (items.length === 0) return;

    const trashedBoardIds = new Set(
      items.filter((i) => i.kind === "board_portal").map((i) => i.id),
    );
    const extraIds = cascadedShortcutIds(trashedBoardIds);

    ids.forEach((id) => pending.add(id));
    try {
      await dispatcher.execute(new TrashSelectionCommand(idGenerator.nextId(), items));
      cardWrites.apply({ type: "cardsRemoved", ids: [...ids, ...extraIds] });
      void refreshTrash();
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    } finally {
      ids.forEach((id) => pending.delete(id));
    }
    // dispatch стабилен (useReducer), но вне App линтер этого не видит —
    // указываем явно.
  }, [selection, cards, dispatcher, idGenerator, refreshTrash, cascadedShortcutIds, dispatch, cardWrites]);

  const handleCardsSelected = useCallback(
    (e: { ids: string[] }) => {
      const prev = selection;
      const next = e.ids;
      if (prev.length === next.length && prev.every((id, i) => id === next[i])) {
        return;
      }
      dispatch({ type: "selectionChanged", ids: next });
    },
    [selection, dispatch],
  );

  const handleCardActivated = useCallback(
    (id: string) => {
      const card = cards.find((c) => c.id === id);
      if (card?.kind === "note") {
        dispatch({ type: "editingStarted", id });
      }
    },
    [cards, dispatch],
  );

  const handleRequestContextMenu = useCallback(
    (cardId: string, x: number, y: number) => {
      // If the right-clicked card isn't part of the current selection, the menu
      // should act on just that card (and select it), matching Finder/Milanote.
      if (!selection.includes(cardId)) {
        dispatch({ type: "selectionChanged", ids: [cardId] });
      }
      setContextMenu({ cardId, x, y });
    },
    [selection, dispatch, setContextMenu],
  );

  const handleLoadFolderPreview = useCallback((id: string) => gateway.listFolderPreview(id, 50), [gateway]);
  const handleOpenFolderInFinder = useCallback(
    (id: string) => {
      void gateway.openFolderInFinder(id).catch((error) => dispatch({ type: "failed", message: errorMessage(error) }));
    },
    [gateway, dispatch],
  );
  // ADR-0012 "Point to a folder on this computer…": a shortcut created on
  // another device gets this device's own locator; the card turns local and
  // its preview loads.
  const handlePointFolderShortcutHere = useCallback(
    (id: string) => {
      void (async () => {
        const picked = await pickFolder();
        if (!picked) return;
        const alias = await gateway.setFilesystemAliasLocalTarget(id, picked);
        cardWrites.apply({ type: "filesystemAliasUpdated", alias });
      })().catch((error) => dispatch({ type: "failed", message: errorMessage(error) }));
    },
    [gateway, dispatch, cardWrites],
  );

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    // Delete the current selection, not just the single right-clicked card. If
    // the selection is empty (e.g. cleared), fall back to the clicked card.
    const ids = selection.length > 0 ? selection : [contextMenu.cardId];
    setContextMenu(null);

    const items: TrashItem[] = ids
      .map((id) => {
        const card = cards.find((c) => c.id === id);
        if (!card) return null;
        if (card.kind === "board_portal") {
          return { id: card.target.id, kind: "board_portal" as const };
        }
        return { id: card.id, kind: card.kind };
      })
      .filter((x): x is TrashItem => x !== null);

    if (items.length === 0) return;
    const trashedBoardIds = new Set(
      items.filter((i) => i.kind === "board_portal").map((i) => i.id),
    );
    const extraIds = cascadedShortcutIds(trashedBoardIds);
    void dispatcher
      .execute(new TrashSelectionCommand(idGenerator.nextId(), items))
      .then(() => {
        cardWrites.apply({ type: "cardsRemoved", ids: [...ids, ...extraIds] });
        void refreshTrash();
      })
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [contextMenu, selection, cards, dispatcher, idGenerator, refreshTrash, cascadedShortcutIds, dispatch, setContextMenu, cardWrites]);

  const handlePaneContextMenu = useCallback(
    (x: number, y: number) => {
      const flow = screenToFlowRef.current;
      const point = flow ? flow(x, y) : { x, y };
      setPaneContextMenu({ x, y, flowX: point.x, flowY: point.y });
    },
    [screenToFlowRef, setPaneContextMenu],
  );

  // "Duplicate" on a portal's context menu (todo.md №16): a copy of the
  // portal's whole board subtree appears on the SAME board, offset +24/+24
  // from the source — the menu-driven counterpart of copy/paste, sharing the
  // same atomic backend call and undo (DuplicateBoardCommand).
  const handleDuplicatePortal = useCallback(
    (portal: BoardPortalDto) => {
      const newBoardId = idGenerator.nextId();
      const newPortalCardId = idGenerator.nextId();
      void (async () => {
        try {
          const receipt = await dispatcher.execute(
            new DuplicateBoardCommand(idGenerator.nextId(), {
              sourceBoardId: portal.target.id,
              targetBoardId: portal.boardId,
              newBoardId,
              newPortalCardId,
              frame: {
                x: portal.frame.x + 24,
                y: portal.frame.y + 24,
                width: portal.frame.width,
                height: portal.frame.height,
              },
            }),
          );
          cardWrites.apply({ type: "cardAdded", card: receipt.portal });
        } catch (e) {
          dispatch({ type: "failed", message: errorMessage(e) });
        }
      })();
    },
    [dispatcher, idGenerator, dispatch, cardWrites],
  );

  // "Create shortcut" on a portal or on another shortcut (todo.md №17): a new
  // shortcut card appears +24/+24 from the source, same size, pointing at the
  // same target board. A shortcut on a shortcut never chains — it points at
  // the SAME target the source shortcut points at, not at the source card.
  const handleCreateShortcut = useCallback(
    (source: BoardPortalDto | BoardShortcutDto) => {
      const targetBoardId = source.kind === "board_portal" ? source.target.id : source.target?.id;
      if (!targetBoardId) return; // a broken shortcut has nothing to point a new shortcut at
      const id = idGenerator.nextId();
      void dispatcher
        .execute(
          new CreateBoardShortcutCommand(idGenerator.nextId(), {
            id,
            boardId: source.boardId,
            frame: {
              x: source.frame.x + 24,
              y: source.frame.y + 24,
              width: source.frame.width,
              height: source.frame.height,
            },
            zIndex: 0,
            targetBoardId,
          }),
        )
        .then((created) => {
          cardWrites.apply({ type: "cardAdded", card: created });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [dispatcher, idGenerator, dispatch, cardWrites],
  );

  return {
    paneContextMenu,
    setPaneContextMenu,
    handleDeleteSelection,
    handleCardsSelected,
    handleCardActivated,
    handleRequestContextMenu,
    handleLoadFolderPreview,
    handleOpenFolderInFinder,
    handlePointFolderShortcutHere,
    handleContextDelete,
    handlePaneContextMenu,
    handleDuplicatePortal,
    handleCreateShortcut,
  };
}
