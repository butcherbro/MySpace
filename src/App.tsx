import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "./app/AppShell";
import { EmptyBoardHint } from "./app/EmptyBoardHint";
import {
  confirmAbandonWithDialog,
  destroyWindow,
  useCloseFlush,
} from "./app/use-close-flush";
import { useNoteFormatting } from "./app/use-note-formatting";
import { useBoardCover } from "./app/use-board-cover";
import { useQuickBoards } from "./app/use-quick-boards";
import { useEmbedMetadata } from "./app/use-embed-metadata";
import { useCopyActions } from "./app/use-copy-actions";
import { usePasteActions } from "./app/use-paste-actions";
import { useCardEdits } from "./app/use-card-edits";
import { useTrashController } from "./app/use-trash-controller";
import { buildCreateImageCardInput } from "./app/import-image-card";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import { useCrossBoardDragSession } from "./canvas/use-cross-board-drag";
import { moveSelectionOntoBoard } from "./canvas/move-selection-onto-board";
import type { CanvasCard } from "./canvas/canvas-types";
import { renderCard as renderCardFromRegistry, type CardRenderContext } from "./cards/card-registry";
import {
  MoveCardsCommand,
  CreateNoteCommand,
  MoveCardToBoardCommand,
} from "./commands/card-commands";
import {
  CreateBoardShortcutCommand,
  CreateChildBoardCommand,
  DuplicateBoardCommand,
  MoveBoardCommand,
  RenameBoardCommand,
} from "./commands/board-commands";
import { CommandDispatcher } from "./commands/command-dispatcher";
import type { NoteEditorCommands } from "./editor/editor-commands";
import type { TextColorId } from "./editor/text-color";
import type { NoteColorId } from "./cards/note/note-color";
import { TrashSelectionCommand, type TrashItem } from "./commands/trash-commands";
import { CanvasErrorBanner } from "./components/errors/CanvasErrorBanner";
import { ToolRail } from "./components/tool-rail/ToolRail";
import { TrashDrawer } from "./components/trash/TrashDrawer";
import { EmptyTrashDialog } from "./components/trash/EmptyTrashDialog";
import { RestoreDialog } from "./backup/restore-dialog";
import { DevicesDialog } from "./sync/DevicesDialog";
import { UpdatePrompt } from "./updates/UpdatePrompt";
import { useUpdateCheck } from "./updates/use-update-check";
import { SyncStatusPill } from "./sync/SyncStatusPill";
import { useSyncAppliedReload } from "./sync/use-sync-state";
import { ContextMenu, type ContextMenuAction } from "./components/context-menu/ContextMenu";
import { SearchBar } from "./search/SearchBar";
import { useSearchController } from "./search/use-search-controller";
import { useViewportController } from "./state/use-viewport-controller";
import { shouldReload, type ChangeSample } from "./state/external-change-detector";
import { plainTextToDocument, normalizeDocument } from "./editor/document-codec";
import { BoardBreadcrumbs } from "./navigation/BoardBreadcrumbs";
import { BoardTabs } from "./navigation/BoardTabs";
import { QuickBoardsRail } from "./navigation/QuickBoardsRail";
import { UndoRedoControls } from "./navigation/UndoRedoControls";
import { UnsortedPanel } from "./navigation/UnsortedPanel";
import { useBoardNavigation } from "./navigation/use-board-navigation";
import { MutationQueue } from "./persistence/entity-write-queue";
import { createGateway } from "./services/create-gateway";
import type { DocumentSaveOptions } from "./editor/corrupt-document";
import { errorMessage } from "./services/error-message";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import { pickFolder, pickImageFile } from "./services/asset-picker";
import { computeInitialImageFrameSize, loadNaturalImageSize } from "./cards/image/image-card-geometry";
import { useNativeFileDrop } from "./app/use-native-file-drop";
import { useCanvasPaste } from "./app/use-canvas-paste";
import { flushAllDrafts } from "./editor/draft-flush-registry";
import type {
  AssetDto,
  BoardPortalDto,
  BoardShortcutDto,
  CardDto,
  FileCardDto,
  FilesystemAliasDto,
  ImageCardDto,
  NoteCardDto,
  BoardSnapshot,
  WorkspaceGateway,
} from "./services/workspace-gateway";
import {
  initialState,
  reducer,
} from "./state/current-board-store";
import { assetUrl } from "./services/asset-url";

type ToolKind = "note" | "link" | "board";

function App() {
  const gateway: WorkspaceGateway = useMemo(() => createGateway(), []);
  const idGenerator: IdGenerator = useMemo(() => new UuidV7Generator(), []);

  const [state, dispatch] = useReducer(reducer, initialState);
  const [contextMenu, setContextMenu] = useState<{ cardId: string; x: number; y: number } | null>(null);
  // x/y — экранные координаты для позиционирования меню; flowX/flowY — координаты
  // доски (с учётом zoom/pan) для размещения левого верхнего угла новой карточки.
  const [paneContextMenu, setPaneContextMenu] = useState<
    { x: number; y: number; flowX: number; flowY: number } | null
  >(null);
  const [highlightedPortalId, setHighlightedPortalId] = useState<string | null>(null);
  const { board, breadcrumbs, viewport, viewportRevision, boardOpenRevision, error } = state;
  const notes = state.cards.filter((c): c is NoteCardDto => c.kind === "note");

  // The contextual rail shows note tools when exactly one Note is active:
  // either it is being edited, or it is the single selected card.
  const activeNoteId = state.editingCardId
    ?? (state.selection.length === 1 &&
        state.cards.find((c) => c.id === state.selection[0])?.kind === "note"
      ? state.selection[0]
      : null);
  const noteToolMode = activeNoteId !== null;
  const activeNote = activeNoteId
    ? (state.cards.find((c) => c.id === activeNoteId && c.kind === "note") as
        | NoteCardDto
        | undefined)
    : undefined;
  const noteColor = (activeNote?.colorToken as NoteColorId | undefined) ?? "default";


  // Quick Boards rail starts collapsed so it never occupies full width on launch.
  const [quickBoardsCollapsed, setQuickBoardsCollapsed] = useState(true);

  // Unsorted drawer: shows when unsorted cards exist; Close hides it until the
  // next blind drop.
  const [unsortedOpen, setUnsortedOpen] = useState(false);
  const prevUnsortedCountRef = useRef(state.unsortedCards.length);
  useEffect(() => {
    if (state.unsortedCards.length > prevUnsortedCountRef.current) {
      setUnsortedOpen(true);
    }
    prevUnsortedCountRef.current = state.unsortedCards.length;
  }, [state.unsortedCards.length]);


  // Search: query/debounce/results owned here; rendering/keyboard in
  // `SearchBar` (always-visible input in the top bar) and the search controller
  // live further down: a result can only be opened once `navigateTo` exists.
  // Global scope is the V1 default (see docs/specs/search.md).

  // Serializes mutations (save/drag) so they never race on a card's revision.
  const queueRef = useRef(new MutationQueue());
  // Undo/redo over workspace commands (depends only on the stable gateway).
  const dispatcher = useMemo(() => new CommandDispatcher(gateway), [gateway]);

  // Contextual note rail: the active note's editor command surface + bold state.
  const noteFormatting = useNoteFormatting({ activeNote, dispatcher, idGenerator, dispatch });

  // Always reflects the latest cards (notes AND portals) so queued tasks read
  // the current revision.
  const cardsRef = useRef(state.cards);
  useEffect(() => {
    cardsRef.current = state.cards;
  }, [state.cards]);

  // Last known pointer position over the canvas, in board-space (flow
  // coordinates). Drives paste placement (todo.md №15): pasted cards land
  // under the cursor, not at a fixed origin.
  const lastCanvasPointRef = useRef<{ x: number; y: number } | null>(null);
  // A board switch (todo.md №25) must drop any pointer position tracked for
  // the *previous* board: `lastCanvasPointRef` holds flow-space coordinates,
  // which are only meaningful relative to the React Flow instance that
  // produced them. Without this, pasting right after opening a different
  // board — before the mouse moves again — reused the old board's stale
  // coordinate, landing the note off in whatever spot that number happens to
  // map to on the new board (seen live as "paste lands in the corner").
  // Falling back to `null` here means the very next paste instead uses
  // `fallbackPastePosition()` (viewport center) until a real pointermove
  // re-establishes a same-board position.
  useEffect(() => {
    lastCanvasPointRef.current = null;
  }, [boardOpenRevision]);
  // Declared here (rather than by the JSX below) so the paste callbacks —
  // defined further up the component — can close over it: it's still the
  // same DOM node either way, since the render effect that attaches it runs
  // once for the app's lifetime (see the pointermove effect near the JSX).
  const canvasRef = useRef<HTMLDivElement>(null);

  // Always reflects the latest selection, so a drag start can snapshot all
  // currently-selected card ids for a group move.
  const selectionRef = useRef(state.selection);
  useEffect(() => {
    selectionRef.current = state.selection;
  }, [state.selection]);

  const { handleRetryEmbedMetadata } = useEmbedMetadata({
    cards: state.cards,
    cardsRef,
    gateway,
    dispatch,
  });

  // Screen->board coordinate converter, populated by CanvasAdapter on init.
  const screenToFlowRef = useRef<((x: number, y: number) => { x: number; y: number }) | null>(null);
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);


  const {
    quickBoards,
    setQuickBoards,
    loadQuickBoards,
    handleQuickBoardRemove,
    handleQuickBoardPin,
    handleQuickBoardsReorder,
  } = useQuickBoards({ gateway, dispatch });

  // Recoverable Trash: the summary drives the rail badge and the drawer, and the
  // restore/empty flows reconcile the board and the rail afterwards. The board
  // reload is a ref because navigation is declared later in this component.
  const reloadBoardRef = useRef<(() => Promise<void>) | null>(null);
  const trash = useTrashController({
    gateway,
    reloadBoardRef,
    reloadQuickBoards: loadQuickBoards,
  });
  // Stable members, pulled out so dependency arrays name a value the linter can
  // follow instead of a property access.
  const refreshTrash = trash.refresh;
  const trashOpen = trash.open;
  const closeTrashDrawer = trash.closeDrawer;
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [devicesDialogOpen, setDevicesDialogOpen] = useState(false);


  const handleCreateNote = useCallback(
    async (
      position?: { x: number; y: number },
      options?: { startEditing?: boolean; content?: { documentJson: unknown; plainText: string } },
    ) => {
      if (!board) return;
      const id = idGenerator.nextId();
      // An explicit position (double-click on the empty pane, paste) places the
      // note exactly there; the rail/button path falls back to a cascading default.
      const x = position ? position.x : 40;
      const y = position ? position.y : 40 + notes.length * 24;
      const documentJson = options?.content?.documentJson ?? plainTextToDocument("");
      const plainText = options?.content?.plainText ?? "";
      const card: NoteCardDto = {
        kind: "note",
        id,
        boardId: board.id,
        frame: { x, y, width: 240, height: 120 },
        zIndex: notes.length,
        revision: 1,
        documentJson,
        plainText,
        colorToken: "default",
      };
      try {
        await dispatcher.execute(
          new CreateNoteCommand(id, {
            id,
            boardId: board.id,
            frame: card.frame,
            zIndex: card.zIndex,
            documentJson: card.documentJson,
          }),
        );
        dispatch({ type: "cardAdded", card });
        if (options?.startEditing) {
          dispatch({ type: "editingStarted", id });
        }
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [board, dispatcher, idGenerator, notes.length],
  );

  const handleCreateLink = useCallback(
    (position?: { x: number; y: number }) => {
      void handleCreateNote(position, { startEditing: true });
    },
    [handleCreateNote],
  );

  // Distribute one Unsorted card onto the canvas at a free cascading slot.
  const handlePlaceUnsortedCard = useCallback(
    (cardId: string) => {
      const card = state.unsortedCards.find((c) => c.id === cardId);
      if (!card || !board) return;
      const maxBottom = state.cards.reduce((max, c) => Math.max(max, c.frame.y + c.frame.height), 0);
      const frame = {
        x: 40,
        y: maxBottom > 0 ? maxBottom + 24 : 40,
        width: card.frame.width,
        height: card.frame.height,
      };
      void gateway
        .placeUnsortedCard({ id: cardId, expectedRevision: card.revision, frame })
        .then((receipt) => {
          dispatch({
            type: "unsortedCardPlaced",
            id: cardId,
            frame,
            revision: receipt.revision,
          });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [state.unsortedCards, state.cards, board, gateway],
  );

  // Pointer-drag a card out of the Unsorted panel onto the canvas: track the
  // pointer on window, show a ghost, and place the card exactly where it is
  // released if that is over the canvas.
  const unsortedDragCardIdRef = useRef<string | null>(null);
  const [unsortedGhost, setUnsortedGhost] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const unsortedGhostMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const unsortedGhostUpRef = useRef<((e: PointerEvent) => void) | null>(null);

  const cleanupUnsortedDrag = useCallback(() => {
    if (unsortedGhostMoveRef.current) {
      window.removeEventListener("pointermove", unsortedGhostMoveRef.current);
      unsortedGhostMoveRef.current = null;
    }
    if (unsortedGhostUpRef.current) {
      window.removeEventListener("pointerup", unsortedGhostUpRef.current);
      unsortedGhostUpRef.current = null;
    }
    unsortedDragCardIdRef.current = null;
    setUnsortedGhost(null);
  }, []);

  const handleUnsortedPointerDown = useCallback(
    (cardId: string, clientX: number, clientY: number) => {
      unsortedDragCardIdRef.current = cardId;
      setUnsortedGhost({ cardId, x: clientX, y: clientY });

      const move = (e: PointerEvent) =>
        setUnsortedGhost((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
      const up = (e: PointerEvent) => {
        const id = unsortedDragCardIdRef.current;
        cleanupUnsortedDrag();
        if (!id) return;
        // Place only if released over the canvas.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const overCanvas = Boolean(el?.closest?.('[data-testid="canvas"]'));
        if (!overCanvas) return;
        const card = state.unsortedCards.find((c) => c.id === id);
        if (!card) return;
        const flow = screenToFlowRef.current;
        const point = flow ? flow(e.clientX, e.clientY) : { x: 40, y: 40 };
        const frame = {
          x: point.x - card.frame.width / 2,
          y: point.y - card.frame.height / 2,
          width: card.frame.width,
          height: card.frame.height,
        };
        void gateway
          .placeUnsortedCard({ id, expectedRevision: card.revision, frame })
          .then((receipt) => {
            dispatch({
              type: "unsortedCardPlaced",
              id,
              frame,
              revision: receipt.revision,
            });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
      };

      unsortedGhostMoveRef.current = move;
      unsortedGhostUpRef.current = up;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [state.unsortedCards, gateway, cleanupUnsortedDrag],
  );

  const handleCreateChildBoard = useCallback(
    async (position?: { x: number; y: number }) => {
      if (!board) return;
      const boardId = idGenerator.nextId();
      const portalCardId = idGenerator.nextId();
      let frame;
      if (position) {
        frame = { x: position.x, y: position.y, width: 120, height: 112 };
      } else {
        // Place the new board near the visible viewport center so it never lands
        // far down the board outside the current view.
        const flow = screenToFlowRef.current;
        const center = flow
          ? flow(window.innerWidth * 0.5, window.innerHeight * 0.5)
          : { x: 200, y: 120 };
        const offset = (state.cards.length % 5) * 24;
        frame = {
          x: center.x - 60 + offset,
          y: center.y - 56 + offset,
          width: 120,
          height: 112,
        };
      }
      const portal: BoardPortalDto = {
        kind: "board_portal",
        id: portalCardId,
        boardId: board.id,
        frame,
        zIndex: 0,
        revision: 1,
        target: {
          id: boardId,
          boardRevision: 1,
          title: "New Board",
          colorToken: "terracotta",
          symbol: null,
          childBoardCount: 0,
          childCardCount: 0,
          coverAsset: null,
        },
      };
      try {
        await dispatcher.execute(
          new CreateChildBoardCommand(idGenerator.nextId(), {
            parentBoardId: board.id,
            boardId,
            portalCardId,
            frame: portal.frame,
            title: "New Board",
          }),
        );
        dispatch({ type: "cardAdded", card: portal });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [board, dispatcher, idGenerator, state.cards.length],
  );

  // Drag-to-create a tool out of the rail: on release over the canvas, the item
  // is created at the drop point; a plain click still creates in the default
  // location. Handles Note, Link, and Board (Image uses a file picker).
  const createGhostRef = useRef<{ x: number; y: number; kind: ToolKind } | null>(null);
  const [createGhost, setCreateGhost] = useState<{ x: number; y: number; kind: ToolKind } | null>(null);
  const createDragMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const createDragUpRef = useRef<((e: PointerEvent) => void) | null>(null);

  const cleanupCreationDrag = useCallback(() => {
    if (createDragMoveRef.current) {
      window.removeEventListener("pointermove", createDragMoveRef.current);
      createDragMoveRef.current = null;
    }
    if (createDragUpRef.current) {
      window.removeEventListener("pointerup", createDragUpRef.current);
      createDragUpRef.current = null;
    }
    createGhostRef.current = null;
    setCreateGhost(null);
  }, []);

  const handleCreationDragStart = useCallback(
    (kind: ToolKind, clientX: number, clientY: number) => {
      createGhostRef.current = { x: clientX, y: clientY, kind };
      setCreateGhost({ x: clientX, y: clientY, kind });
      let moved = false;
      const move = (e: PointerEvent) => {
        moved = true;
        createGhostRef.current = { x: e.clientX, y: e.clientY, kind };
        setCreateGhost({ x: e.clientX, y: e.clientY, kind });
      };
      const up = (e: PointerEvent) => {
        cleanupCreationDrag();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const overCanvas = Boolean(el?.closest?.('[data-testid="canvas"]'));
        const flow = screenToFlowRef.current;
        const point = flow ? flow(e.clientX, e.clientY) : { x: 200, y: 120 };
        if (!overCanvas) {
          // Plain click on the rail falls back to the default placement.
          if (!moved) {
            if (kind === "note") void handleCreateNote();
            else if (kind === "link") void handleCreateLink();
            else if (kind === "board") void handleCreateChildBoard();
          }
          return;
        }
        if (kind === "note") void handleCreateNote({ x: point.x - 120, y: point.y - 60 });
        else if (kind === "link") void handleCreateLink({ x: point.x - 120, y: point.y - 60 });
        else if (kind === "board") void handleCreateChildBoard({ x: point.x - 60, y: point.y - 56 });
      };
      createDragMoveRef.current = move;
      createDragUpRef.current = up;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [cleanupCreationDrag, handleCreateNote, handleCreateLink, handleCreateChildBoard],
  );

  // Creates an image card for an already-imported asset at board coordinates.
  const placeImageAsset = useCallback(
    async (asset: AssetDto, x: number, y: number, cardId: string, centered = false) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      {
        // Backend не читает natural width/height картинки при импорте
        // (assets.width/height в БД всегда NULL), поэтому пропорции для
        // стартового frame берём в браузере — иначе карточка получает
        // фиксированный 320x240 и обрезает картинку под рамку (todo.md №3).
        const natural = await loadNaturalImageSize(assetUrl(asset.filePath));
        const { width, height } = computeInitialImageFrameSize(natural?.width, natural?.height);
        const card: ImageCardDto = {
          kind: "image",
          id: cardId,
          boardId: currentBoard.id,
          frame: centered
            ? { x: Math.max(0, x - width / 2), y: Math.max(0, y - height / 2), width, height }
            : { x, y, width, height },
          zIndex: cardsRef.current.length,
          revision: 1,
          asset,
          captionJson: plainTextToDocument(""),
          captionPlainText: "",
        };
        await gateway.createImageCard(
          buildCreateImageCardInput({
            cardId,
            boardId: currentBoard.id,
            frame: card.frame,
            zIndex: card.zIndex,
            asset,
            captionJson: card.captionJson,
          }),
        );
        dispatch({ type: "cardAdded", card });
      }
    },
    [gateway],
  );

  // Imports an image and creates a card at the given board coordinates. Shared
  // by the file picker (button) and native drag-drop.
  const importImageCard = useCallback(
    async (sourcePath: string, fileName: string, mimeType: string, boardX: number, boardY: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      // Guard against NaN/Infinity (e.g. screen->board conversion before the
      // canvas instance is ready) — such values serialize to null/error over IPC.
      const x = Number.isFinite(boardX) ? boardX : 80;
      const y = Number.isFinite(boardY) ? boardY : 80;
      const assetId = idGenerator.nextId();
      const cardId = idGenerator.nextId();
      try {
        const asset = await gateway.importAsset({
          id: assetId,
          sourcePath,
          fileName,
          mimeType,
        });
        await placeImageAsset(asset, x, y, cardId);
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator, placeImageAsset],
  );

  const handleCreateImage = useCallback(async () => {
    const picked = await pickImageFile();
    if (!picked) return;
    await importImageCard(picked.path, picked.fileName, picked.mimeType, 80, 80 + cardsRef.current.length * 24);
  }, [importImageCard]);

  const createFolderShortcut = useCallback(
    async (sourcePath: string, boardX: number, boardY: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      const frame = {
        x: Number.isFinite(boardX) ? boardX : 80,
        y: Number.isFinite(boardY) ? boardY : 80,
        width: 360,
        height: 300,
      };
      try {
        const card: FilesystemAliasDto = await gateway.createFolderAlias({
          id: idGenerator.nextId(),
          boardId: currentBoard.id,
          frame,
          zIndex: cardsRef.current.length,
          sourcePath,
        });
        dispatch({ type: "cardAdded", card });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator],
  );

  const createFileCard = useCallback(
    async (item: { path: string; fileName: string; mimeType: string }, boardX: number, boardY: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      const frame = {
        x: Number.isFinite(boardX) ? boardX : 80,
        y: Number.isFinite(boardY) ? boardY : 80,
        width: 320,
        height: 240,
      };
      try {
        const card: FileCardDto = await gateway.createFileCard({
          id: idGenerator.nextId(),
          boardId: currentBoard.id,
          frame,
          zIndex: cardsRef.current.length,
          sourcePath: item.path,
          mimeType: item.mimeType,
          fileName: item.fileName,
        });
        dispatch({ type: "cardAdded", card });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator],
  );

  // "Add Folder Shortcut…" on the pane context menu (todo.md №23): the native
  // folder picker, then the same creation call as a Finder drop/pasted path.
  const handleAddFolderShortcutViaDialog = useCallback(
    async (boardX: number, boardY: number) => {
      const picked = await pickFolder();
      if (!picked) return;
      await createFolderShortcut(picked, boardX, boardY);
    },
    [createFolderShortcut],
  );

  const openFileCard = useCallback(
    (cardId: string) => {
      void gateway.openFileCard(cardId).catch((e) => dispatch({ type: "failed", message: errorMessage(e) }));
    },
    [gateway],
  );

  const revealFileCard = useCallback(
    (cardId: string) => {
      void gateway.revealFileCard(cardId).catch((e) => dispatch({ type: "failed", message: errorMessage(e) }));
    },
    [gateway],
  );

  // One stable sink for controller failures, so their effects never re-subscribe.
  const onCanvasError = useCallback(
    (message: string) => dispatch({ type: "failed", message }),
    [],
  );

  // Native drag-drop: Rust classifies Finder paths before the UI creates Cards;
  // the controller only places them on the canvas.
  useNativeFileDrop({
    gateway,
    screenToFlowRef,
    cardsRef,
    onCreateFolder: createFolderShortcut,
    onCreateImage: importImageCard,
    onCreateFile: createFileCard,
    onError: onCanvasError,
  });

  const { handlePastePath, handleCanvasPaste, handlePasteCards, handlePasteImage } = usePasteActions({
    board,
    notes,
    gateway,
    dispatch,
    dispatcher,
    idGenerator,
    createFolderShortcut,
    createFileCard,
    handleCreateNote,
    placeImageAsset,
    lastCanvasPointRef,
    canvasRef,
    screenToFlowRef,
    boardRef,
    cardsRef,
  });

  useCanvasPaste({
    enabled: Boolean(board),
    onPaste: handleCanvasPaste,
    onPasteCards: handlePasteCards,
    onPastePath: handlePastePath,
    onPasteImage: handlePasteImage,
  });

  const {
    handleUpdateNote,
    handleFinalizeNote,
    handleUpdateImageCaption,
    handleUpdateEmbedDescription,
    handleResizeNote,
  } = useCardEdits({ gateway, dispatch, queueRef, cardsRef });

  // Build the canvas projection from all cards (notes + portals). Memoised on
  // `state.cards` (P1.8): the canvas diffs this array per card, and an App
  // re-render that didn't touch the cards must hand it the same array.
  const canvasCards: CanvasCard[] = useMemo(() => state.cards.map((c) => ({
    id: c.id,
    boardId: c.boardId,
    kind: c.kind,
    frame: c.frame,
    zIndex: c.zIndex,
    revision: c.revision,
    targetBoardId: c.kind === "board_portal" ? c.target.id : undefined,
    portalTitle: c.kind === "board_portal" ? c.target.title : undefined,
    portalCoverAssetId: c.kind === "board_portal" ? c.target.coverAsset?.id ?? undefined : undefined,
    aliasLocal: c.kind === "filesystem_alias" ? c.local : undefined,
  })), [state.cards]);
  const cardsById = useMemo(() => new Map(state.cards.map((c) => [c.id, c])), [state.cards]);


  const handleCardsMoved = useCallback(
    (e: { cards: Array<{ id: string; frame: CanvasCard["frame"] }> }) => {
      void queueRef.current
        .run(async () => {
          const moves = e.cards
            .map((moved) => {
              const card = cardsRef.current.find((c) => c.id === moved.id);
              return card
                ? {
                    id: moved.id,
                    revision: card.revision,
                    before: card.frame,
                    after: moved.frame,
                  }
                : null;
            })
            .filter(
              (x): x is { id: string; revision: number; before: CanvasCard["frame"]; after: CanvasCard["frame"] } =>
                x !== null,
            );

          if (moves.length === 0) return;

          // One gesture = one undo entry via the dispatcher.
          const receipt = await dispatcher.execute(
            new MoveCardsCommand(idGenerator.nextId(), moves),
          );
          const revisionById = new Map(receipt.cards.map((c) => [c.id, c.revision]));

          for (const item of moves) {
            const revision = revisionById.get(item.id);
            if (revision === undefined) continue; // unreachable: one receipt per requested card
            dispatch({
              type: "cardMoved",
              id: item.id,
              revision,
              frame: item.after,
            });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    [idGenerator, dispatcher],
  );

  // Moving a card onto a board portal. A leaf card (note/image/embed) changes
  // board via moveCardToBoard; a board_portal reparents the underlying board via
  // the undoable MoveBoardCommand. After a successful move the card no longer
  // belongs to the current projection, so remove it from local state.
  const handleCardDroppedOnPortal = useCallback(
    (cardId: string, targetBoardId: string) => {
      const card = cardsRef.current.find((c) => c.id === cardId);
      if (!card) return;

      if (card.kind === "board_portal") {
        const portal = card;
        const prevParent = portal.boardId;
        const prevFrame = portal.frame;
        const nextFrame = { x: 40, y: 40, width: portal.frame.width, height: portal.frame.height };
        void dispatcher
          .execute(
            new MoveBoardCommand(
              idGenerator.nextId(),
              portal.target.id,
              prevParent,
              prevFrame,
              targetBoardId,
              nextFrame,
              portal.target.boardRevision,
              portal.revision,
            ),
          )
          .then(() => {
            dispatch({ type: "cardsRemoved", ids: [cardId] });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
        return;
      }

      // Blind drop of a leaf card into a board: it lands in that board's
      // Unsorted panel (Milanote-style) instead of stacking at the origin.
      //
      // Routed through moveSelectionOntoBoard/MoveSelectionCommand (the same
      // path the group drop below uses) instead of calling the gateway
      // directly: a raw gateway call never entered the dispatcher's undo
      // stack, so Cmd+Z after this specific drop undid whatever OLDER command
      // happened to be on top instead — which had usually gone stale by then,
      // surfacing as an unrelated "stale_revision" toast and no visible
      // change (tasks/lessons.md 2026-09-18).
      void moveSelectionOntoBoard({
        gateway,
        dispatcher,
        idGenerator,
        targetBoardId,
        leafCards: [card],
        portals: [],
      })
        .then((receipt) => {
          // If the target is the currently open board, show it in its Unsorted
          // panel; otherwise the card simply left this board (it will appear in
          // the target board's Unsorted when that board is opened).
          if (receipt.targetBoardId === boardRef.current?.id) {
            const moved = receipt.cards.find((c) => c.id === cardId);
            if (moved) {
              dispatch({ type: "cardMovedToUnsorted", id: cardId, revision: moved.afterRevision });
            }
          } else {
            dispatch({ type: "cardsRemoved", ids: [cardId] });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    [gateway, dispatcher, idGenerator],
  );

  // Group drop onto a board (portal or breadcrumb): leaf cards move as one batch
  // into the target's Unsorted panel; board portals reparent one by one.
  const handleCardsDroppedOnBoard = useCallback(
    (ids: string[], targetBoardId: string) => {
      const cards = ids
        .map((id) => cardsRef.current.find((c) => c.id === id))
        .filter((c): c is CardDto => Boolean(c));

      const leafCards = cards.filter((c) => c.kind !== "board_portal");
      // The destination board is NOT filtered out here: ADR-0007 makes the
      // backend refuse the whole operation when the selection contains it, so the
      // user gets a reason instead of a silently shrunken selection.
      const portals = cards.filter((c): c is BoardPortalDto => c.kind === "board_portal");

      if (leafCards.length > 0 || portals.length > 0) {
        // One atomic call for the whole selection, and the state is mirrored from
        // the receipt the backend returned rather than recomputed locally.
        const currentBoardId = boardRef.current?.id;
        // moveSelectionOntoBoard refreshes each leaf's revision via readCard and
        // retries once on a stale-revision refusal: a draft save (blur flush) can
        // still land in the gap between that refresh and the move's own IPC call,
        // especially for a large note whose write is slower than the drag gesture
        // (tasks/lessons.md 2026-09-08; tasks/lessons.md 2026-09-18).
        void moveSelectionOntoBoard({
          gateway,
          dispatcher,
          idGenerator,
          targetBoardId,
          leafCards,
          portals: portals.map((p) => ({
            boardId: p.target.id,
            boardRevision: p.target.boardRevision,
            portalRevision: p.revision,
          })),
        })
          .then((receipt) => {
            if (receipt.cards.length > 0) {
              if (receipt.targetBoardId === currentBoardId) {
                for (const card of receipt.cards) {
                  dispatch({ type: "cardMovedToUnsorted", id: card.id, revision: card.afterRevision });
                }
              } else {
                dispatch({ type: "cardsRemoved", ids: receipt.cards.map((card) => card.id) });
              }
            }
            const departed = receipt.boards
              .filter(
                (board) =>
                  board.previousParentBoardId === currentBoardId &&
                  receipt.targetBoardId !== currentBoardId,
              )
              .map((board) => board.portalCardId);
            if (departed.length > 0) dispatch({ type: "cardsRemoved", ids: departed });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
      }
    },
    [gateway, dispatcher, idGenerator],
  );

  // Trashing a board_portal cascades server-side to every shortcut pointing at
  // it (todo.md №17, ADR-0010). A shortcut on the SAME board being viewed is
  // visible right now and must disappear immediately too — the backend already
  // trashed it, so re-sending it as a leaf trash item would 404 against an
  // already-trashed row. This only patches the currently-rendered board; a
  // shortcut elsewhere pointing deeper into the trashed subtree self-heals on
  // its own board's next snapshot load, which already reflects the cascade.
  const cascadedShortcutIds = useCallback(
    (trashedBoardIds: Set<string>): string[] =>
      state.cards
        .filter((c) => c.kind === "board_shortcut" && c.target && trashedBoardIds.has(c.target.id))
        .map((c) => c.id),
    [state.cards],
  );

  const handleDeleteSelection = useCallback(async () => {
    if (state.selection.length === 0) return;
    const items: TrashItem[] = state.selection
      .map((id) => {
        const card = state.cards.find((c) => c.id === id);
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

    try {
      await dispatcher.execute(new TrashSelectionCommand(idGenerator.nextId(), items));
      dispatch({ type: "cardsRemoved", ids: [...state.selection, ...extraIds] });
      void refreshTrash();
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [state.selection, state.cards, dispatcher, idGenerator, refreshTrash, cascadedShortcutIds]);

  // Viewport saves are debounced, flushed on navigation, and pinned to the board
  // revision captured when the viewport settled. The board-scoped policy around
  // that (origin pinning, late-save guard) lives in the controller.
  const viewportController = useViewportController({
    gateway,
    boardId: board?.id ?? null,
    revision: viewportRevision,
    onSettled: (settled) => dispatch({ type: "viewportChanged", viewport: settled }),
    onSaved: (revision) => dispatch({ type: "viewportSaved", revision }),
    onError: (message) => dispatch({ type: "failed", message }),
  });

  // Closing the window must not lose the last edit: the note/caption queue and
  // the viewport queue are flushed before the window is allowed to go. See
  // src/app/use-close-flush.ts — the queues keep their own owners.
  useCloseFlush({
    flushes: [() => flushAllDrafts(), () => queueRef.current.flush(), () => viewportController.flush()],
    close: destroyWindow,
    confirmAbandon: confirmAbandonWithDialog,
    onError: (error) => dispatch({ type: "failed", message: errorMessage(error) }),
  });

  // In-app updates (desktop only). The same pending-write barriers as the close
  // run before the app is replaced: the installer and `relaunch()` bypass the
  // window close handler above.
  const updates = useUpdateCheck({
    flushBeforeInstall: async () => {
      await Promise.all([flushAllDrafts(), queueRef.current.flush(), viewportController.flush()]);
    },
  });

  const handleCardsSelected = useCallback((e: { ids: string[] }) => {
    const prev = state.selection;
    const next = e.ids;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) {
      return;
    }
    dispatch({ type: "selectionChanged", ids: next });
  }, [state.selection]);

  const handleCardActivated = useCallback((id: string) => {
    const card = state.cards.find((c) => c.id === id);
    if (card?.kind === "note") {
      dispatch({ type: "editingStarted", id });
    }
  }, [state.cards]);

  const handleRequestContextMenu = useCallback(
    (cardId: string, x: number, y: number) => {
      // If the right-clicked card isn't part of the current selection, the menu
      // should act on just that card (and select it), matching Finder/Milanote.
      if (!state.selection.includes(cardId)) {
        dispatch({ type: "selectionChanged", ids: [cardId] });
      }
      setContextMenu({ cardId, x, y });
    },
    [state.selection],
  );

  const handleLoadFolderPreview = useCallback((id: string) => gateway.listFolderPreview(id, 50), [gateway]);
  const handleOpenFolderInFinder = useCallback((id: string) => {
    void gateway.openFolderInFinder(id).catch((error) => dispatch({ type: "failed", message: errorMessage(error) }));
  }, [gateway]);
  // ADR-0012 "Point to a folder on this computer…": a shortcut created on
  // another device gets this device's own locator; the card turns local and
  // its preview loads.
  const handlePointFolderShortcutHere = useCallback((id: string) => {
    void (async () => {
      const picked = await pickFolder();
      if (!picked) return;
      const alias = await gateway.setFilesystemAliasLocalTarget(id, picked);
      dispatch({ type: "filesystemAliasUpdated", alias });
    })().catch((error) => dispatch({ type: "failed", message: errorMessage(error) }));
  }, [gateway]);

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    // Delete the current selection, not just the single right-clicked card. If
    // the selection is empty (e.g. cleared), fall back to the clicked card.
    const ids = state.selection.length > 0 ? state.selection : [contextMenu.cardId];
    setContextMenu(null);

    const items: TrashItem[] = ids
      .map((id) => {
        const card = state.cards.find((c) => c.id === id);
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
        dispatch({ type: "cardsRemoved", ids: [...ids, ...extraIds] });
        void refreshTrash();
      })
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [contextMenu, state.selection, state.cards, dispatcher, idGenerator, refreshTrash, cascadedShortcutIds]);

  const {
    handleCopyLink,
    handleCopyFilePath,
    handleCopySourceUrl,
    handleCopyBoardLink,
    handleCopySelectionImages,
    handleCopySelection,
  } = useCopyActions({
    contextMenu,
    selection: state.selection,
    cards: state.cards,
    board,
    gateway,
    dispatch,
    setPaneContextMenu,
  });

  const handlePaneContextMenu = useCallback((x: number, y: number) => {
    const flow = screenToFlowRef.current;
    const point = flow ? flow(x, y) : { x, y };
    setPaneContextMenu({ x, y, flowX: point.x, flowY: point.y });
  }, []);

  // Copy the images of the current selection to the system clipboard.
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
          dispatch({ type: "cardAdded", card: receipt.portal });
        } catch (e) {
          dispatch({ type: "failed", message: errorMessage(e) });
        }
      })();
    },
    [dispatcher, idGenerator],
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
          dispatch({ type: "cardAdded", card: created });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [dispatcher, idGenerator],
  );

  // Applying a loaded snapshot is the store's concern, not navigation's: note
  // documents are normalized here, and both the startup load and every later
  // navigation go through this one place.
  const applySnapshot = useCallback(
    (snapshot: BoardSnapshot) => {
      dispatch({
        type: "snapshotLoaded",
        board: snapshot.board,
        breadcrumbs: snapshot.breadcrumbs,
        viewport: { x: snapshot.viewport.x, y: snapshot.viewport.y, zoom: snapshot.viewport.zoom },
        viewportRevision: snapshot.viewport.revision,
        cards: snapshot.cards.map((c) =>
          c.kind === "note"
            ? { ...c, documentJson: normalizeDocument(c.documentJson) }
            : c,
        ),
        unsortedCards: snapshot.unsortedCards.map((c) =>
          c.kind === "note"
            ? { ...c, documentJson: normalizeDocument(c.documentJson) }
            : c,
        ),
      });
    },
    [dispatch],
  );

  // The navigation spine: snapshot loading, open-board tabs, back/forward
  // history, and the latest-wins guard that keeps a slow load from overwriting a
  // newer navigation. Pending writes are drained through the queue and viewport
  // barriers before the projection is replaced.
  const navigation = useBoardNavigation({
    gateway,
    drainPendingWrites: useCallback(async () => {
      // The editing card's own draft (still inside its 250ms debounce) must
      // land in the mutation queue before the queue is flushed, or navigation
      // would replace the projection while that write is still in flight —
      // see draft-flush-registry.ts.
      await flushAllDrafts();
      await queueRef.current.flush();
      await viewportController.flush();
    }, [viewportController]),
    onSnapshotLoaded: applySnapshot,
  });
  const navigateTo = navigation.navigateTo;
  const initializeNavigation = navigation.initialize;

  // Initial board load. Lives after the navigation controller because it seeds
  // the tabs and history through it.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      dispatch({ type: "loading" });
      try {
        const home = await gateway.getHomeBoard();
        const snapshot = await gateway.loadBoardSnapshot(home.id);
        if (cancelled) return;
        initializeNavigation(snapshot);
        applySnapshot(snapshot);
      } catch (e) {
        if (!cancelled) {
          dispatch({ type: "failed", message: errorMessage(e) });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, gateway, initializeNavigation]);

  const search = useSearchController({
    gateway,
    navigateTo,
    onError: useCallback(
      (message: string) => dispatch({ type: "failed", message }),
      [dispatch],
    ),
  });

  // Cross-board drag session: one gesture state machine (hover-open, ghost,
  // window pointer tracking) and no commands. What a drop means is resolved by
  // handleCardDragEnd below.
  const crossBoardDragSession = useCrossBoardDragSession({
    cardsRef,
    boardRef,
    selectionRef,
    screenToFlowRef,
    navigateTo,
  });

  const handleCardDragEnd = useCallback((): boolean => {
    const drop = crossBoardDragSession.takeDragEnd();
    const { cardId, groupIds, overQuickBoards: overQuick, dropTargetBoardId: targetBoardId } = drop;

    {
      const resolved = drop.crossBoard;
      const drag = resolved?.drag;
      const target = resolved?.targetBoardId;
      const gc = drag?.ghostCard;
      if (resolved && drag && target && gc) {
        const frame = resolved.frame;

          // Group move onto a tab: every leaf card goes into the target's
          // Unsorted panel as one batch; any board portals reparent one by one.
          if (drag.cardIds.length > 1) {
            const leafSanps = drag.cards.filter((c) => c.kind !== "board_portal");
            const portals = drag.cards.filter(
              (
                c,
              ): c is (typeof drag.cards)[number] & {
                targetBoardId: string;
                boardRevision: number;
              } =>
                c.kind === "board_portal" &&
                c.targetBoardId !== undefined &&
                c.boardRevision !== undefined,
            );

            const finish = () => {
              drop.commitCrossBoard();
              void navigateTo(target, { tabMode: "sync" });
            };

            if (leafSanps.length > 0 || portals.length > 0) {
              // Same retry-on-stale-revision helper as the on-canvas portal drop:
              // a draft flush (blur) can still bump a leaf's revision in the gap
              // between the readCard refresh and this call's own IPC round-trip.
              void moveSelectionOntoBoard({
                gateway,
                dispatcher,
                idGenerator,
                targetBoardId: target,
                leafCards: leafSanps.map((c) => ({ id: c.cardId, revision: c.revision })),
                portals: portals.map((p) => ({
                  boardId: p.targetBoardId,
                  boardRevision: p.boardRevision,
                  portalRevision: p.revision,
                })),
              })
                .then(finish)
                .catch((err) => {
                  dispatch({ type: "failed", message: errorMessage(err) });
                  drop.cancelCrossBoard();
                });
            } else {
              finish();
            }
            return true; // consumed
          }

          // A board portal reparents its underlying board (moveBoard), not the
          // leaf-card move path. Reuse the same MoveBoardCommand as a portal
          // dropped onto another portal on the canvas.
          if (gc.kind === "board_portal" && gc.targetBoardId && gc.boardRevision !== undefined) {
            void dispatcher
              .execute(
                new MoveBoardCommand(
                  idGenerator.nextId(),
                  gc.targetBoardId,
                  gc.boardId,
                  gc.frame,
                  target,
                  frame,
                  gc.boardRevision,
                  gc.revision,
                ),
              )
              .then(() => {
                drop.commitCrossBoard();
                void navigateTo(target, { tabMode: "sync" });
              })
              .catch((err) => {
                dispatch({ type: "failed", message: errorMessage(err) });
                drop.cancelCrossBoard();
              });
            return true; // consumed
          }

          // The card's revision may have moved since drag start (e.g. a draft
          // save on blur); read the current revision before committing.
          void gateway
            .readCard(gc.cardId)
            .then((fresh) => {
              const revision =
                fresh && "revision" in fresh ? (fresh as { revision: number }).revision : gc.revision;
              return dispatcher.execute(
                new MoveCardToBoardCommand(
                  idGenerator.nextId(),
                  gc.cardId,
                  gc.boardId,
                  gc.frame,
                  revision,
                  target,
                  frame,
                ),
              );
            })
            .then(() => {
              drop.commitCrossBoard();
              // Reload the target board so the placed card appears immediately
              // (its snapshot was loaded before the move; the card now lives
              // there, so a plain cardsRemoved would wrongly hide it).
              void navigateTo(target, { tabMode: "sync" });
            })
            .catch((err) => {
              dispatch({ type: "failed", message: errorMessage(err) });
              drop.cancelCrossBoard();
            });
          return true; // consumed
        }
      }

    if (cardId && overQuick) {
      // Pin the dragged Board Portal as a Quick Board reference (no move/reparent).
      const card = cardsRef.current.find((c) => c.id === cardId);
      if (card?.kind === "board_portal") {
        handleQuickBoardPin(card.target.id);
        return true; // consumed: do not also persist a plain reposition
      }
      // Quick Boards only accepts Board Portals. A leaf card dragged across the
      // rail must still follow the normal canvas-position persistence path.
    }
    if (cardId && targetBoardId) {
      handleCardsDroppedOnBoard(groupIds.length > 0 ? groupIds : [cardId], targetBoardId);
      return true; // consumed: moved to a portal/breadcrumb
    }
    return false;
  }, [
    crossBoardDragSession,
    handleCardsDroppedOnBoard,
    handleQuickBoardPin,
    gateway,
    dispatcher,
    idGenerator,
    navigateTo,
  ]);

  // The session resolves the drop through this callback once its window pointer
  // tracking sees the release.
  useEffect(() => {
    crossBoardDragSession.setDragEndResolver(handleCardDragEnd);
  }, [crossBoardDragSession, handleCardDragEnd]);

  // Reload the current board (no history push). Used to reconcile UI with the
  // database after undo/redo.
  const reloadCurrentBoard = useCallback(async () => {
    if (board) await navigateTo(board.id);
  }, [board, navigateTo]);

  useEffect(() => {
    reloadBoardRef.current = reloadCurrentBoard;
  }, [reloadCurrentBoard]);


  const handleBackToCreate = useCallback(() => {
    dispatch({ type: "editingStopped" });
    dispatch({ type: "selectionChanged", ids: [] });
  }, []);

  const handleWorkspaceUndo = useCallback(async () => {
    try {
      if (await dispatcher.undo()) await reloadCurrentBoard();
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error) });
    }
  }, [dispatcher, reloadCurrentBoard]);

  const handleWorkspaceRedo = useCallback(async () => {
    try {
      if (await dispatcher.redo()) await reloadCurrentBoard();
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error) });
    }
  }, [dispatcher, reloadCurrentBoard]);

  const { handleSetCoverFromClipboard, handleChooseCover, handleRemoveCover } = useBoardCover({
    contextMenu,
    cards: state.cards,
    gateway,
    idGenerator,
    dispatch,
    setQuickBoards,
  });

  // Quick Boards: open navigates (opening/activating a tab). Stays here, not in
  // use-quick-boards, because it needs `navigateTo`, which is declared later
  // in this component than the hook (see use-quick-boards.ts).
  const handleQuickBoardOpen = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { pushHistory: true, tabMode: "open" });
    },
    [navigateTo],
  );

  // Detect external (agent / second instance) writes (P1.6). Every 3 s poll the
  // open board's `get_board_change_seq`: reload the board only when another
  // process committed (dataVersion) AND the commit touched this board
  // (changeSeq); refresh the trash on any external commit. The decision lives
  // in `shouldReload`; a sample for a different board just re-primes it. The
  // same-board `snapshotLoaded` merge keeps pan, editing and selection.
  const changeSampleRef = useRef<ChangeSample | null>(null);
  const openBoardId = board?.id ?? null;
  useEffect(() => {
    if (openBoardId === null) return;
    let cancelled = false;
    const poll = () => {
      gateway.getBoardChangeSeq(openBoardId).then(
        (v) => {
          if (cancelled) return;
          const next: ChangeSample = { boardId: openBoardId, ...v };
          const decision = shouldReload(changeSampleRef.current, next);
          changeSampleRef.current = next;
          if (decision.reloadBoard) void navigateTo(openBoardId);
          if (decision.refreshTrash) void refreshTrash();
        },
        () => {
          // The board may have been removed externally; the next navigation
          // re-primes. Polling never surfaces an error.
        },
      );
    };
    // Prime (or re-prime after a board switch) immediately.
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gateway, openBoardId, navigateTo, refreshTrash]);

  // LAN sync (ADR-0011 S3): a replay commits on the app's own writer, so the
  // poll above never sees it; `sync-applied` names the boards it changed and
  // the open one reloads through the same same-board merge.
  useSyncAppliedReload(
    gateway,
    openBoardId,
    (boardId) => void navigateTo(boardId),
    () => {
      // Quick boards and the trash badge are not part of the board load.
      void refreshTrash();
      loadQuickBoards();
    },
  );

  const handleRenameBoard = useCallback(
    (boardId: string, title: string) => {
      const card = state.cards.find(
        (c) => c.kind === "board_portal" && c.target.id === boardId,
      );
      const prevTitle = card?.kind === "board_portal" ? card.target.title : title;
      void dispatcher
        .execute(new RenameBoardCommand(idGenerator.nextId(), boardId, title, prevTitle))
        .then(() => {
          // Reload the board so portal titles + breadcrumbs reflect the new name.
          return reloadCurrentBoard();
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [state.cards, dispatcher, idGenerator, reloadCurrentBoard],
  );

  // Open a child board via a portal (double-click / Enter).
  const handleOpenBoard = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { pushHistory: true, tabMode: "open" });
    },
    [navigateTo],
  );

  // Double-click on a card: if it's a portal, open its target board (the
  // canvas passes the *card* id, so resolve to the target board first).
  const handleCardOpened = useCallback(
    (cardId: string) => {
      const card = state.cards.find((c) => c.id === cardId);
      if (card?.kind === "board_portal") {
        void navigateTo(card.target.id, { pushHistory: true, tabMode: "open" });
      }
    },
    [state.cards, navigateTo],
  );

  const handleNavigateBack = navigation.goBack;
  const handleNavigateForward = navigation.goForward;
  const handleTabActivate = navigation.activateTab;
  const handleTabClose = navigation.closeTab;

  // Tracks pointer position over the canvas in board-space, for paste
  // placement. The canvas element is stable for the app's lifetime, so one
  // listener suffices; screenToFlowRef may not be ready on the very first
  // paint, in which case the move is simply skipped (next move catches up).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function handleMove(e: PointerEvent) {
      const flow = screenToFlowRef.current;
      if (!flow) return;
      lastCanvasPointRef.current = flow(e.clientX, e.clientY);
    }
    el.addEventListener("pointermove", handleMove);
    return () => el.removeEventListener("pointermove", handleMove);
  }, []);

  const handleEditDeactivate = useCallback(() => {
    dispatch({ type: "editingStopped" });
    // Return focus to the canvas so keyboard shortcuts (e.g. Cmd+A) and the
    // next interaction land back on the board, not a stale editor.
    canvasRef.current?.focus();
  }, []);

  // Cmd+[ / Cmd+] navigate back/forward, Cmd+Z / Cmd+Shift+Z undo/redo,
  // unless an editor owns focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      // The top-bar search field is a plain <input>, not a Tiptap editor or a
      // textarea. Backspace/Delete inside it must edit text, not trash canvas
      // selection, so treat any text-entry control as owning focus.
      const inTextEntry =
        target &&
        (target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.tagName === "INPUT");
      if (inTextEntry) return;
      if (e.key === "Escape") {
        if (trashOpen) {
          e.preventDefault();
          closeTrashDrawer();
        }
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        void handleDeleteSelection();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[") {
        e.preventDefault();
        handleNavigateBack();
      } else if (e.key === "]") {
        e.preventDefault();
        handleNavigateForward();
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          void handleWorkspaceRedo();
        } else {
          void handleWorkspaceUndo();
        }
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        handleCopySelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNavigateBack, handleNavigateForward, handleWorkspaceUndo, handleWorkspaceRedo, handleDeleteSelection, handleCopySelection, trashOpen, closeTrashDrawer]);

  // Card callbacks handed to the canvas, as stable wrappers over the latest
  // handlers (P1.8). The canvas keeps a card's rendered element until that card
  // itself changes, so a handler captured at build time must never go stale
  // (several close over `state`), and stable identities let the memoised card
  // components skip re-rendering. Values (editing flag, highlight) are not
  // here: they are read when a card is (re)built.
  const cardHandlers = {
    onDeactivate: handleEditDeactivate,
    onUpdateNote: handleUpdateNote,
    onFinalizeNote: handleFinalizeNote,
    onUpdateImageCaption: handleUpdateImageCaption,
    onUpdateEmbedDescription: handleUpdateEmbedDescription,
    onRetryEmbedMetadata: handleRetryEmbedMetadata,
    onOpenBoard: handleOpenBoard,
    onRenameBoard: handleRenameBoard,
    onContextMenu: handleRequestContextMenu,
    onResizeNote: handleResizeNote,
    onResizeImage: handleResizeNote,
    onResizeEmbed: handleResizeNote,
    onResizeFilesystemAlias: handleResizeNote,
    onLoadFolderPreview: handleLoadFolderPreview,
    onOpenFolderInFinder: handleOpenFolderInFinder,
    onPointFolderShortcutHere: handlePointFolderShortcutHere,
    onOpenFileCard: openFileCard,
    onRevealFileCard: revealFileCard,
    onResizeFileCard: handleResizeNote,
    onNoteCommands: noteFormatting.handleNoteCommands,
    onNoteBoldStateChange: noteFormatting.handleNoteBoldStateChange,
    onNoteItalicStateChange: noteFormatting.handleNoteItalicStateChange,
    onNoteStrikeStateChange: noteFormatting.handleNoteStrikeStateChange,
    onNoteTextColorChange: noteFormatting.handleNoteTextColorChange,
  } satisfies Partial<CardRenderContext>;
  const cardHandlersRef = useRef(cardHandlers);
  useLayoutEffect(() => {
    cardHandlersRef.current = cardHandlers;
  });
  const stableCardHandlers = useMemo(() => {
    const latest = () => cardHandlersRef.current;
    return {
      onDeactivate: () => latest().onDeactivate(),
      onUpdateNote: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onUpdateNote(id, document, options),
      onFinalizeNote: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onFinalizeNote(id, document, options),
      onUpdateImageCaption: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onUpdateImageCaption(id, document, options),
      onUpdateEmbedDescription: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onUpdateEmbedDescription(id, document, options),
      onRetryEmbedMetadata: (id: string) => latest().onRetryEmbedMetadata(id),
      onOpenBoard: (boardId: string) => latest().onOpenBoard(boardId),
      onRenameBoard: (boardId: string, title: string) => latest().onRenameBoard(boardId, title),
      onContextMenu: (cardId: string, x: number, y: number) => latest().onContextMenu(cardId, x, y),
      onResizeNote: (id: string, w: number, h: number) => latest().onResizeNote(id, w, h),
      onResizeImage: (id: string, w: number, h: number) => latest().onResizeImage(id, w, h),
      onResizeEmbed: (id: string, w: number, h: number) => latest().onResizeEmbed(id, w, h),
      onResizeFilesystemAlias: (id: string, w: number, h: number) => latest().onResizeFilesystemAlias(id, w, h),
      onLoadFolderPreview: (id: string) => latest().onLoadFolderPreview(id),
      onOpenFolderInFinder: (id: string) => latest().onOpenFolderInFinder(id),
      onPointFolderShortcutHere: (id: string) => latest().onPointFolderShortcutHere(id),
      onOpenFileCard: (id: string) => latest().onOpenFileCard(id),
      onRevealFileCard: (id: string) => latest().onRevealFileCard(id),
      onResizeFileCard: (id: string, w: number, h: number) => latest().onResizeFileCard(id, w, h),
      onNoteCommands: (commands: NoteEditorCommands | null) => latest().onNoteCommands(commands),
      onNoteBoldStateChange: (active: boolean) => latest().onNoteBoldStateChange(active),
      onNoteItalicStateChange: (active: boolean) => latest().onNoteItalicStateChange(active),
      onNoteStrikeStateChange: (active: boolean) => latest().onNoteStrikeStateChange(active),
      onNoteTextColorChange: (color: TextColorId) => latest().onNoteTextColorChange(color),
    } satisfies Partial<CardRenderContext>;
  }, []);

  return (
    <AppShell
      topBar={
        <>
          <BoardBreadcrumbs
            breadcrumbs={breadcrumbs}
            currentBoardId={board?.id ?? ""}
            dropTargetBoardId={crossBoardDragSession.dropTargetBoardId}
            onNavigate={(id) => void navigateTo(id, { pushHistory: true, tabMode: "open" })}
          />
          <div className="topbar-actions" data-tauri-drag-region="false">
            <SearchBar
              query={search.query}
              onQueryChange={search.onQueryChange}
              results={search.results}
              loading={search.loading}
              onSelect={(result) => void search.onSelect(result)}
            />
            <SyncStatusPill gateway={gateway} onOpen={() => setDevicesDialogOpen(true)} />
            <UndoRedoControls
              dispatcher={dispatcher}
              onUndo={handleWorkspaceUndo}
              onRedo={handleWorkspaceRedo}
            />
          </div>
        </>
      }
      toolRail={
        <ToolRail
          mode={noteToolMode ? "note" : "create"}
          onCreationDragStart={handleCreationDragStart}
          onAddImage={() => void handleCreateImage()}
          trashBatchCount={trash.summary?.batchCount ?? 0}
          onOpenTrash={trash.openDrawer}
          onBold={noteFormatting.handleBold}
          boldActive={noteFormatting.boldActive}
          onItalic={noteFormatting.handleItalic}
          italicActive={noteFormatting.italicActive}
          onStrike={noteFormatting.handleStrike}
          strikeActive={noteFormatting.strikeActive}
          onBackToCreate={handleBackToCreate}
          textColor={noteFormatting.textColor}
          onTextColor={noteFormatting.handleTextColor}
          noteColor={noteColor}
          onNoteColor={noteFormatting.handleNoteColor}
        />
      }
      rightRail={
        <QuickBoardsRail
          quickBoards={quickBoards}
          onOpen={handleQuickBoardOpen}
          onRemove={handleQuickBoardRemove}
          onReorder={handleQuickBoardsReorder}
          dropActive={crossBoardDragSession.overQuickBoards}
          collapsed={quickBoardsCollapsed}
          onToggleCollapsed={() => setQuickBoardsCollapsed((collapsed) => !collapsed)}
        />
      }
      rightRailCollapsed={quickBoardsCollapsed}
    >
      <div className="workspace">
        {navigation.tabs && (
          <BoardTabs
            homeBoardId={navigation.tabs.homeBoardId}
            tabs={navigation.tabs.tabs}
            activeBoardId={navigation.tabs.activeBoardId}
            onActivate={handleTabActivate}
            onClose={handleTabClose}
            onReorder={navigation.reorderTabs}
          />
        )}
        {unsortedOpen && state.unsortedCards.length > 0 && (
          <UnsortedPanel
            cards={state.unsortedCards}
            onPlace={handlePlaceUnsortedCard}
            onDragStartCard={handleUnsortedPointerDown}
            onClose={() => setUnsortedOpen(false)}
          />
        )}
        {contextMenu &&
          (() => {
            const card = state.cards.find((c) => c.id === contextMenu.cardId);
            const isImage = card?.kind === "image";
            const isPortal = card?.kind === "board_portal";
            const isShortcut = card?.kind === "board_shortcut";
            const isFolderAlias = card?.kind === "filesystem_alias";
            const isFileCard = card?.kind === "file";
            const isLinkCard = card?.kind === "embed";
            const actions: ContextMenuAction[] = [
              { id: "copy-link", label: "Copy MySpace Link", onSelect: () => void handleCopyLink() },
            ];
            if (isLinkCard) {
              actions.push({ id: "copy-url", label: "Copy URL", onSelect: () => void handleCopySourceUrl() });
            }
            if (isImage) {
              actions.push(
                { id: "copy-file-path", label: "Copy File Path", onSelect: () => void handleCopyFilePath() },
                { id: "copy-image", label: "Copy Image", onSelect: handleCopySelectionImages },
              );
            }
            if (isFolderAlias && card.local) {
              actions.push({
                id: "show-in-finder",
                label: "Show in Finder",
                onSelect: () => handleOpenFolderInFinder(card.id),
              });
            }
            if (isFolderAlias && !card.local) {
              actions.push({
                id: "point-to-local-folder",
                label: "Point to a folder on this computer…",
                onSelect: () => handlePointFolderShortcutHere(card.id),
              });
            }
            if (isFileCard) {
              actions.push(
                {
                  id: "open-file",
                  label: "Open",
                  onSelect: () => openFileCard(card.id),
                },
                {
                  id: "reveal-file",
                  label: "Reveal in Finder",
                  onSelect: () => revealFileCard(card.id),
                },
              );
            }
            if (isPortal) {
              actions.push(
                { id: "duplicate", label: "Duplicate", onSelect: () => handleDuplicatePortal(card as BoardPortalDto) },
                { id: "create-shortcut", label: "Create Shortcut", onSelect: () => handleCreateShortcut(card as BoardPortalDto) },
                { id: "set-cover-clipboard", label: "Set Cover from Clipboard", onSelect: () => void handleSetCoverFromClipboard() },
                { id: "choose-cover", label: "Choose Cover…", onSelect: () => void handleChooseCover() },
              );
              if ((card as BoardPortalDto).target.coverAsset !== null) {
                actions.push({ id: "remove-cover", label: "Remove Cover", onSelect: () => void handleRemoveCover() });
              }
            }
            if (isShortcut && (card as BoardShortcutDto).target !== null) {
              actions.push({
                id: "create-shortcut",
                label: "Create Shortcut",
                onSelect: () => handleCreateShortcut(card as BoardShortcutDto),
              });
            }
            actions.push({ id: "delete", label: "Delete", onSelect: handleContextDelete });
            return (
              <ContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                actions={actions}
                onClose={() => setContextMenu(null)}
              />
            );
          })()}
        {paneContextMenu && (
          <ContextMenu
            x={paneContextMenu.x}
            y={paneContextMenu.y}
            actions={[
              {
                id: "add-note",
                label: "Add Note",
                onSelect: () => void handleCreateNote({ x: paneContextMenu.flowX, y: paneContextMenu.flowY }),
              },
              {
                id: "add-board",
                label: "Add Board",
                onSelect: () =>
                  void handleCreateChildBoard({ x: paneContextMenu.flowX, y: paneContextMenu.flowY }),
              },
              {
                id: "add-folder-shortcut",
                label: "Add Folder Shortcut…",
                onSelect: () =>
                  void handleAddFolderShortcutViaDialog(paneContextMenu.flowX, paneContextMenu.flowY),
              },
              { id: "copy-board-link", label: "Copy MySpace Link", onSelect: () => void handleCopyBoardLink() },
            ]}
            onClose={() => setPaneContextMenu(null)}
            testId="pane-context-menu"
          />
        )}
        {error && (
          <CanvasErrorBanner
            message={error}
            onRetry={() => dispatch({ type: "clearError" })}
          />
        )}
        {trash.open && (
          <TrashDrawer
            summary={trash.summary}
            loading={trash.loading}
            error={trash.error}
            restoringBatchId={trash.restoringBatchId}
            onClose={trash.closeDrawer}
            onRestore={(batchId) => void trash.restoreBatch(batchId)}
            onEmptyTrash={trash.requestEmpty}
            onRestoreFromBackup={() => setRestoreDialogOpen(true)}
            onOpenDevices={() => setDevicesDialogOpen(true)}
            onCheckForUpdates={updates.supported ? () => void updates.checkNow() : undefined}
          />
        )}
        <UpdatePrompt controller={updates} />
        {devicesDialogOpen && (
          <>
            <div className="devices-dialog-backdrop" onClick={() => setDevicesDialogOpen(false)} />
            <div className="devices-dialog-overlay">
              <DevicesDialog gateway={gateway} onClose={() => setDevicesDialogOpen(false)} />
            </div>
          </>
        )}
        {restoreDialogOpen && (
          <>
            <div className="restore-dialog-backdrop" onClick={() => setRestoreDialogOpen(false)} />
            <div className="restore-dialog-overlay">
              <RestoreDialog gateway={gateway} onClose={() => setRestoreDialogOpen(false)} />
            </div>
          </>
        )}
        {trash.emptyDialogOpen && (
          <>
            <div className="empty-trash-backdrop" onClick={trash.cancelEmpty} />
            <div className="empty-trash-overlay">
              <EmptyTrashDialog
                batchCount={trash.summary?.batchCount ?? 0}
                boardCount={trash.summary?.boardCount ?? 0}
                cardCount={trash.summary?.cardCount ?? 0}
                busy={trash.emptyBusy}
                error={trash.emptyError}
                onConfirm={(typed) => void trash.confirmEmpty(typed)}
                onCancel={trash.cancelEmpty}
              />
            </div>
          </>
        )}
        {crossBoardDragSession.drag?.phase === "previewing" && crossBoardDragSession.drag.ghostCard && (
          <div
            className="cross-board-ghost"
            data-testid="cross-board-ghost"
            style={{
              left: crossBoardDragSession.drag.pointer.x,
              top: crossBoardDragSession.drag.pointer.y,
              width: crossBoardDragSession.drag.ghostCard.width,
              height: crossBoardDragSession.drag.ghostCard.height,
            }}
          >
            {crossBoardDragSession.drag.ghostCard.label}
          </div>
        )}
        {unsortedGhost &&
          (() => {
            const card = state.unsortedCards.find((c) => c.id === unsortedGhost.cardId);
            if (!card) return null;
            return (
              <div
                className="cross-board-ghost"
                data-testid="unsorted-ghost"
                style={{
                  left: unsortedGhost.x,
                  top: unsortedGhost.y,
                  width: card.frame.width,
                  height: card.frame.height,
                }}
              >
                {card.kind === "note" ? card.plainText || "Note" : card.kind}
              </div>
            );
          })()}
        {createGhost && (
          <div
            className="cross-board-ghost"
            data-testid="create-ghost"
            style={{
              left: createGhost.x,
              top: createGhost.y,
              width: createGhost.kind === "board" ? 120 : 240,
              height: createGhost.kind === "board" ? 112 : 120,
            }}
          >
            {createGhost.kind === "board" ? "New Board" : createGhost.kind === "link" ? "New Link" : "New Note"}
          </div>
        )}
        <div className="workspace__canvas" data-testid="canvas" ref={canvasRef}>
          <CanvasAdapter
            cards={canvasCards}
            viewport={viewport}
            viewportResetToken={boardOpenRevision}
            editingCardId={state.editingCardId}
            focusRequest={search.focusRequest}
            highlightQuery={search.highlightQuery}
            onScreenToFlowReady={(fn) => {
              screenToFlowRef.current = fn;
            }}
            events={{
              onCardsMoved: handleCardsMoved,
              onViewportChanged: viewportController.handleViewportChanged,
              onSelectionChanged: handleCardsSelected,
              onCardActivated: handleCardActivated,
              onCardOpened: handleCardOpened,
              onCardContextMenu: handleRequestContextMenu,
              onPaneContextMenu: handlePaneContextMenu,
              onCardDroppedOnPortal: handleCardDroppedOnPortal,
              onCardsDroppedOnPortal: handleCardsDroppedOnBoard,
              onPortalHighlight: setHighlightedPortalId,
              onCardDragMove: crossBoardDragSession.onDragMove,
              onCardDragEnd: handleCardDragEnd,
              // Double-click on the empty canvas creates a note directly, top-left
              // corner at the click point, and opens it for editing (todo.md №19,
              // Milanote-style — corrects №10, which routed this through a menu).
              // The create menu stays right-click-only (`onPaneContextMenu` above).
              onPaneDoubleClick: (point) => {
                void handleCreateNote(point, { startEditing: true });
              },
            }}
            renderCard={(card) => {
              const full = cardsById.get(card.id);
              if (!full) return null;
              return renderCardFromRegistry(full, {
                ...stableCardHandlers,
                editing: state.editingCardId === full.id,
                highlightedPortalId,
                highlightQuery: search.highlightQuery,
              });
            }}
          />
          <EmptyBoardHint cards={state.cards} error={error} />
        </div>
      </div>
    </AppShell>
  );
}

export default App;
