import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "./app/AppShell";
import { EmptyBoardHint } from "./app/EmptyBoardHint";
import {
  confirmAbandonWithDialog,
  destroyWindow,
  useCloseFlush,
} from "./app/use-close-flush";
import { useTrashController } from "./app/use-trash-controller";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import { useCrossBoardDragSession } from "./canvas/use-cross-board-drag";
import { moveSelectionOntoBoard } from "./canvas/move-selection-onto-board";
import type { CanvasCard } from "./canvas/canvas-types";
import { renderCard as renderCardFromRegistry } from "./cards/card-registry";
import {
  MoveCardsCommand,
  CreateNoteCommand,
  MoveCardToBoardCommand,
  SetNoteColorCommand,
} from "./commands/card-commands";
import { PasteCardsCommand, type PasteCardSpec } from "./commands/paste-commands";
import { buildPasteSpecs, readCardClipboard, setCardClipboard, type CopiedCard } from "./app/card-clipboard";
import {
  CreateChildBoardCommand,
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
import { ContextMenu, type ContextMenuAction } from "./components/context-menu/ContextMenu";
import { SearchBar } from "./search/SearchBar";
import { useSearchController } from "./search/use-search-controller";
import { useViewportController } from "./state/use-viewport-controller";
import { plainTextToDocument, documentToPlainText, normalizeDocument } from "./editor/document-codec";
import { classifyLinkConversion } from "./cards/link/link-conversion";
import { BoardBreadcrumbs } from "./navigation/BoardBreadcrumbs";
import { BoardTabs } from "./navigation/BoardTabs";
import { QuickBoardsRail } from "./navigation/QuickBoardsRail";
import { UndoRedoControls } from "./navigation/UndoRedoControls";
import { UnsortedPanel } from "./navigation/UnsortedPanel";
import { useBoardNavigation } from "./navigation/use-board-navigation";
import { MutationQueue } from "./persistence/entity-write-queue";
import { createGateway } from "./services/create-gateway";
import { errorMessage } from "./services/error-message";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import { pickImageFile } from "./services/asset-picker";
import { computeInitialImageFrameSize, loadNaturalImageSize } from "./cards/image/image-card-geometry";
import { useNativeFileDrop } from "./app/use-native-file-drop";
import { useCanvasPaste } from "./app/use-canvas-paste";
import { htmlToDocument } from "./editor/html-to-document";
import { copyText } from "./services/clipboard";
import type {
  BoardPortalDto,
  CardDto,
  EmbedCardDto,
  FileCardDto,
  FilesystemAliasDto,
  ImageCardDto,
  NoteCardDto,
  QuickBoardDto,
  BoardSnapshot,
  WorkspaceGateway,
} from "./services/workspace-gateway";
import {
  initialState,
  reducer,
} from "./state/current-board-store";

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


  // Quick Boards: persisted, ordered references to Boards. The rail starts
  // collapsed so it never occupies full width on launch.
  const [quickBoards, setQuickBoards] = useState<QuickBoardDto[]>([]);
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

  // Contextual note rail: the active note's editor command surface + bold state.
  const noteCommandsRef = useRef<NoteEditorCommands | null>(null);
  const [boldActive, setBoldActive] = useState(false);
  const [italicActive, setItalicActive] = useState(false);
  const [strikeActive, setStrikeActive] = useState(false);
  const [textColor, setTextColor] = useState<TextColorId>("default");

  // Serializes mutations (save/drag) so they never race on a card's revision.
  const queueRef = useRef(new MutationQueue());
  // Undo/redo over workspace commands (depends only on the stable gateway).
  const dispatcher = useMemo(() => new CommandDispatcher(gateway), [gateway]);
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

  const metadataInFlightRef = useRef(new Set<string>());
  const metadataAttemptedRef = useRef(new Set<string>());

  const requestEmbedMetadata = useCallback(
    (embed: EmbedCardDto, force = false) => {
      const attemptKey = `${embed.id}:${embed.revision}`;
      if (metadataInFlightRef.current.has(embed.id)) return;
      if (!force && metadataAttemptedRef.current.has(attemptKey)) return;

      metadataInFlightRef.current.add(embed.id);
      metadataAttemptedRef.current.add(attemptKey);
      void gateway
        .enrichEmbedMetadata({ id: embed.id, expectedRevision: embed.revision })
        .then((enriched) => {
          // Keep the mutation ref authoritative before the enriched card mounts:
          // Link Card may immediately persist a larger content-driven height.
          cardsRef.current = cardsRef.current.map((card) =>
            card.id === embed.id ? enriched : card,
          );
          dispatch({ type: "cardReplaced", id: embed.id, card: enriched });
        })
        .catch((cause) => {
          dispatch({ type: "failed", message: errorMessage(cause) });
        })
        .finally(() => {
          metadataInFlightRef.current.delete(embed.id);
        });
    },
    [gateway],
  );

  useEffect(() => {
    for (const card of state.cards) {
      if (card.kind === "embed" && card.metadataStatus === "pending") {
        requestEmbedMetadata(card);
      }
    }
  }, [requestEmbedMetadata, state.cards]);

  const handleRetryEmbedMetadata = useCallback(
    (id: string) => {
      const embed = cardsRef.current.find(
        (card): card is EmbedCardDto => card.kind === "embed" && card.id === id,
      );
      if (embed) requestEmbedMetadata(embed, true);
    },
    [requestEmbedMetadata],
  );

  // Screen->board coordinate converter, populated by CanvasAdapter on init.
  const screenToFlowRef = useRef<((x: number, y: number) => { x: number; y: number }) | null>(null);
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);


  // Load persisted Quick Board references once at startup.
  const loadQuickBoards = useCallback(() => {
    void gateway
      .listQuickBoards()
      .then(setQuickBoards)
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [gateway]);

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
  useEffect(() => {
    loadQuickBoards();
  }, [loadQuickBoards]);


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
            plainText,
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
        .then(() => {
          dispatch({
            type: "unsortedCardPlaced",
            id: cardId,
            frame,
            revision: card.revision + 1,
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
          .then(() => {
            dispatch({
              type: "unsortedCardPlaced",
              id,
              frame,
              revision: card.revision + 1,
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
        // Backend не читает natural width/height картинки при импорте
        // (assets.width/height в БД всегда NULL), поэтому пропорции для
        // стартового frame берём в браузере — иначе карточка получает
        // фиксированный 320x240 и обрезает картинку под рамку (todo.md №3).
        const natural = await loadNaturalImageSize(`myspace-asset://localhost/${asset.filePath}`);
        const { width, height } = computeInitialImageFrameSize(natural?.width, natural?.height);
        const card: ImageCardDto = {
          kind: "image",
          id: cardId,
          boardId: currentBoard.id,
          frame: { x, y, width, height },
          zIndex: cardsRef.current.length,
          revision: 1,
          asset,
          captionJson: plainTextToDocument(""),
          captionPlainText: "",
        };
        await gateway.createImageCard({
          id: cardId,
          boardId: currentBoard.id,
          frame: card.frame,
          zIndex: card.zIndex,
          assetId,
          captionJson: card.captionJson,
          captionPlainText: "",
        });
        dispatch({ type: "cardAdded", card });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator],
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

  // Fallback paste position when the cursor was never over the canvas (e.g.
  // paste fired right after the app opened, before any pointermove) — the
  // center of the visible canvas, not a fixed corner (todo.md №18). Both
  // paste paths below share it so a fix to one can't drift from the other.
  const fallbackPastePosition = useCallback((): { x: number; y: number } => {
    const flow = screenToFlowRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (flow && rect && rect.width > 0 && rect.height > 0) {
      return flow(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    return { x: 40, y: 40 + notes.length * 24 };
  }, [notes.length]);

  // Paste onto the empty canvas (no editor open) creates a note. `text/html`
  // (Telegram/browser copy) keeps its bold/italic/strike/paragraphs/lists —
  // pasting *into* an open note editor already gets this for free from
  // ProseMirror's own paste handling, so this only covers the canvas-level case.
  const handleCanvasPaste = useCallback(
    ({ html, text }: { html: string; text: string }) => {
      const useHtml = html.trim().length > 0;
      const documentJson = useHtml ? htmlToDocument(html, text) : plainTextToDocument(text);
      const plainText = useHtml ? documentToPlainText(documentJson) : text;
      const position = lastCanvasPointRef.current ?? fallbackPastePosition();
      void handleCreateNote(position, { content: { documentJson, plainText } });
    },
    [handleCreateNote, fallbackPastePosition],
  );
  // Paste the internal card clipboard (todo.md №15): duplicates land under the
  // last known cursor position, keeping the copied group's relative layout.
  // One PasteCardsCommand = one undo entry for the whole group.
  const handlePasteCards = useCallback((): boolean => {
    if (!board) return false;
    const copied = readCardClipboard();
    if (!copied || copied.length === 0) return false;
    const cursor = lastCanvasPointRef.current ?? fallbackPastePosition();
    const baseZ = cardsRef.current.length;
    const specs: PasteCardSpec[] = buildPasteSpecs(copied, cursor, board.id, baseZ, () =>
      idGenerator.nextId(),
    );
    const assetById = new Map(
      copied.filter((c): c is Extract<CopiedCard, { kind: "image" }> => c.kind === "image").map((c) => [c.asset.id, c.asset]),
    );
    void (async () => {
      try {
        await dispatcher.execute(new PasteCardsCommand(idGenerator.nextId(), specs));
        for (const spec of specs) {
          if (spec.kind === "note") {
            const card: NoteCardDto = {
              kind: "note",
              id: spec.id,
              boardId: spec.boardId,
              frame: spec.frame,
              zIndex: spec.zIndex,
              revision: 1,
              documentJson: spec.documentJson,
              plainText: spec.plainText,
              colorToken: spec.colorToken,
            };
            dispatch({ type: "cardAdded", card });
          } else {
            const asset = assetById.get(spec.assetId);
            if (!asset) continue; // unreachable: built from the same copied list
            const card: ImageCardDto = {
              kind: "image",
              id: spec.id,
              boardId: spec.boardId,
              frame: spec.frame,
              zIndex: spec.zIndex,
              revision: 1,
              asset,
              captionJson: spec.captionJson,
              captionPlainText: spec.captionPlainText,
            };
            dispatch({ type: "cardAdded", card });
          }
        }
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    })();
    return true;
  }, [board, dispatcher, idGenerator, fallbackPastePosition]);

  useCanvasPaste({ enabled: Boolean(board), onPaste: handleCanvasPaste, onPasteCards: handlePasteCards });

  const handleUpdateNote = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const note = cardsRef.current.find(
          (n): n is NoteCardDto => n.kind === "note" && n.id === id,
        );
        if (!note) return;
        // Defensive check before persisting: never write a non-object document
        // into SQLite. A structurally unusual (but still object) document is
        // preserved as-is — validation is protective, not a source of user-facing
        // save failures.
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Note content is not a valid document");
        }

        const plainText = documentToPlainText(document);
        await gateway.updateNote({
          id,
          expectedRevision: note.revision,
          documentJson: document,
          plainText,
        });
        // Keep the ref authoritative *inside this microtask*: the note's own
        // auto-grow (NoteCard) debounces a resize write off the same keystroke
        // and can land right behind this one in the queue, before React's
        // effect has re-synced `cardsRef` from state (see the embed-metadata
        // note above for the same pattern).
        const nextRevision = note.revision + 1;
        cardsRef.current = cardsRef.current.map((c) =>
          c.id === id ? { ...c, revision: nextRevision, documentJson: document, plainText } : c,
        );
        dispatch({
          type: "cardContentUpdated",
          id,
          revision: nextRevision,
          documentJson: document,
          plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  const handleFinalizeNote = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const note = cardsRef.current.find(
          (n): n is NoteCardDto => n.kind === "note" && n.id === id,
        );
        if (!note) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Note content is not a valid document");
        }

        const classification = classifyLinkConversion(document);
        if (classification.qualifies) {
          const embed = await gateway.convertNoteToEmbed({
            id,
            expectedRevision: note.revision,
            sourceUrl: classification.url,
            displayUrl: displayUrl(classification.url),
            title: classification.url,
            descriptionJson: plainTextToDocument(""),
            descriptionPlainText: "",
          });
          cardsRef.current = cardsRef.current.map((c) => (c.id === id ? embed : c));
          dispatch({ type: "cardReplaced", id, card: embed });
          return;
        }

        const plainText = documentToPlainText(document);
        await gateway.updateNote({
          id,
          expectedRevision: note.revision,
          documentJson: document,
          plainText,
        });
        // Same ref-staleness guard as handleUpdateNote above: a pending
        // auto-grow resize can be queued right behind this finalize.
        const nextRevision = note.revision + 1;
        cardsRef.current = cardsRef.current.map((c) =>
          c.id === id ? { ...c, revision: nextRevision, documentJson: document, plainText } : c,
        );
        dispatch({
          type: "cardContentUpdated",
          id,
          revision: nextRevision,
          documentJson: document,
          plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  const handleUpdateImageCaption = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const image = cardsRef.current.find(
          (c): c is ImageCardDto => c.kind === "image" && c.id === id,
        );
        if (!image) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Image caption is not a valid document");
        }
        const captionPlainText = documentToPlainText(document);
        await gateway.updateImageCaption({
          id,
          expectedRevision: image.revision,
          captionJson: document,
          captionPlainText,
        });
        dispatch({
          type: "imageCaptionUpdated",
          id,
          revision: image.revision + 1,
          captionJson: document,
          captionPlainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  const handleUpdateEmbedDescription = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const embed = cardsRef.current.find(
          (c): c is EmbedCardDto => c.kind === "embed" && c.id === id,
        );
        if (!embed) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Link description is not a valid document");
        }
        const descriptionPlainText = documentToPlainText(document);
        await gateway.updateEmbedDescription({
          id,
          expectedRevision: embed.revision,
          descriptionJson: document,
          descriptionPlainText,
        });
        dispatch({
          type: "embedDescriptionUpdated",
          id,
          revision: embed.revision + 1,
          descriptionJson: document,
          descriptionPlainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  // Build the canvas projection from all cards (notes + portals).
  const canvasCards: CanvasCard[] = state.cards.map((c) => ({
    id: c.id,
    boardId: c.boardId,
    kind: c.kind,
    frame: c.frame,
    zIndex: c.zIndex,
    revision: c.revision,
    targetBoardId: c.kind === "board_portal" ? c.target.id : undefined,
    portalTitle: c.kind === "board_portal" ? c.target.title : undefined,
    portalCoverAssetId: c.kind === "board_portal" ? c.target.coverAsset?.id ?? undefined : undefined,
  }));

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
          await dispatcher.execute(
            new MoveCardsCommand(idGenerator.nextId(), moves),
          );

          for (const item of moves) {
            dispatch({
              type: "cardMoved",
              id: item.id,
              revision: item.revision + 1,
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
            dispatch({ type: "cardMovedToUnsorted", id: cardId });
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
                  dispatch({ type: "cardMovedToUnsorted", id: card.id });
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

  // Quick Boards: remove deletes only the reference, and pin adds a reference
  // without moving/reparenting the Board. (Open lives after `navigateTo`.)
  const handleQuickBoardRemove = useCallback(
    (boardId: string) => {
      void gateway
        .removeQuickBoard(boardId)
        .then(loadQuickBoards)
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway, loadQuickBoards],
  );

  const handleQuickBoardPin = useCallback(
    (boardId: string) => {
      void gateway
        .addQuickBoard({ boardId })
        .then(loadQuickBoards)
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway, loadQuickBoards],
  );

  const handleQuickBoardsReorder = useCallback(
    (boardIds: string[]) => {
      // Optimistically apply the new order, then persist transactionally.
      setQuickBoards((prev) => {
        const byId = new Map(prev.map((q) => [q.boardId, q]));
        const next: QuickBoardDto[] = [];
        for (const id of boardIds) {
          const q = byId.get(id);
          if (q) next.push({ ...q, sortOrder: next.length });
        }
        return next;
      });
      void gateway
        .reorderQuickBoards({ boardIds })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
          loadQuickBoards();
        });
    },
    [gateway, loadQuickBoards],
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

    try {
      await dispatcher.execute(new TrashSelectionCommand(idGenerator.nextId(), items));
      dispatch({ type: "cardsRemoved", ids: state.selection });
      void refreshTrash();
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [state.selection, state.cards, dispatcher, idGenerator, refreshTrash]);

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
    flushes: [() => queueRef.current.flush(), () => viewportController.flush()],
    close: destroyWindow,
    confirmAbandon: confirmAbandonWithDialog,
    onError: (error) => dispatch({ type: "failed", message: errorMessage(error) }),
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

  const handleResizeNote = useCallback(
    (id: string, width: number, height: number) => {
      const card = cardsRef.current.find((c) => c.id === id);
      if (!card) return;
      void queueRef.current
        .run(async () => {
          const current = cardsRef.current.find((c) => c.id === id);
          if (!current) return;
          const frame = { ...current.frame, width, height };
          await gateway.moveCard({
            id,
            expectedRevision: current.revision,
            frame,
          });
          // Same ref-staleness guard as content saves above: NoteCard's
          // auto-grow can queue a resize right behind a content autosave for
          // the same keystroke, and the two must not read the same stale
          // revision (tasks/lessons.md 2026-09-08).
          const nextRevision = current.revision + 1;
          cardsRef.current = cardsRef.current.map((c) =>
            c.id === id ? { ...c, revision: nextRevision, frame } : c,
          );
          dispatch({ type: "cardMoved", id, revision: nextRevision, frame });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway],
  );

  const handleLoadFolderPreview = useCallback((id: string) => gateway.listFolderPreview(id, 50), [gateway]);
  const handleOpenFolderInFinder = useCallback((id: string) => {
    void gateway.openFolderInFinder(id).catch((error) => dispatch({ type: "failed", message: errorMessage(error) }));
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
    void dispatcher
      .execute(new TrashSelectionCommand(idGenerator.nextId(), items))
      .then(() => {
        dispatch({ type: "cardsRemoved", ids });
        void refreshTrash();
      })
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [contextMenu, state.selection, state.cards, dispatcher, idGenerator, refreshTrash]);

  // Copy the stable MySpace address for the right-clicked card (or the current
  // board when invoked from a portal/board context). "Copy MySpace Link" is the
  // universal action; images additionally offer "Copy File Path".
  const handleCopyLink = useCallback(async () => {
    if (!contextMenu) return;
    const card = state.cards.find((c) => c.id === contextMenu.cardId);
    let address: string;
    if (card?.kind === "board_portal") {
      // A portal is a folder: copy the address of the board it leads to.
      address = `myspace://board/${card.target.id}`;
    } else if (card) {
      address = `myspace://card/${card.id}`;
    } else {
      address = "";
    }
    try {
      await copyText(address);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, state.cards]);

  const handleCopyFilePath = useCallback(async () => {
    if (!contextMenu) return;
    const card = state.cards.find((c): c is ImageCardDto => c.kind === "image" && c.id === contextMenu.cardId);
    if (!card) return;
    try {
      const path = await gateway.resolveAssetPath(card.asset.id);
      await copyText(path);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, state.cards, gateway]);

  // Copy the actual source URL of a Link Card (embed).
  const handleCopySourceUrl = useCallback(async () => {
    if (!contextMenu) return;
    const card = state.cards.find((c): c is EmbedCardDto => c.kind === "embed" && c.id === contextMenu.cardId);
    if (!card) return;
    try {
      await copyText(card.sourceUrl);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, state.cards]);

  // Copy the stable address of the currently-open board.
  const handleCopyBoardLink = useCallback(async () => {
    setPaneContextMenu(null);
    if (!board) return;
    try {
      await copyText(`myspace://board/${board.id}`);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [board]);

  const handlePaneContextMenu = useCallback((x: number, y: number) => {
    const flow = screenToFlowRef.current;
    const point = flow ? flow(x, y) : { x, y };
    setPaneContextMenu({ x, y, flowX: point.x, flowY: point.y });
  }, []);

  // Copy the images of the current selection to the system clipboard.
  const handleCopySelectionImages = useCallback(() => {
    const imageIds = state.selection.filter((id) => {
      const card = state.cards.find((c) => c.id === id);
      return card?.kind === "image";
    });
    if (imageIds.length === 0) return;
    void gateway
      .copyImageCards({ cardIds: imageIds })
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [state.selection, state.cards, gateway]);

  // Cmd+C over a canvas selection: fills the internal card clipboard
  // (todo.md №15) with every copyable card (note/image) in the selection, in
  // addition to the existing system-clipboard image copy above (unchanged).
  const handleCopySelection = useCallback(() => {
    const selected = state.selection
      .map((id) => state.cards.find((c) => c.id === id))
      .filter(
        (c): c is NoteCardDto | ImageCardDto =>
          c != null && (c.kind === "note" || c.kind === "image"),
      );
    if (selected.length > 0) {
      const minX = Math.min(...selected.map((c) => c.frame.x));
      const minY = Math.min(...selected.map((c) => c.frame.y));
      const copied: CopiedCard[] = selected.map((c) =>
        c.kind === "note"
          ? {
              kind: "note",
              dx: c.frame.x - minX,
              dy: c.frame.y - minY,
              width: c.frame.width,
              height: c.frame.height,
              documentJson: c.documentJson,
              plainText: c.plainText,
              colorToken: c.colorToken,
            }
          : {
              kind: "image",
              dx: c.frame.x - minX,
              dy: c.frame.y - minY,
              width: c.frame.width,
              height: c.frame.height,
              asset: c.asset,
              captionJson: c.captionJson,
              captionPlainText: c.captionPlainText,
            },
      );
      setCardClipboard(copied);
    }
    handleCopySelectionImages();
  }, [state.selection, state.cards, handleCopySelectionImages]);

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


  // The contextual note rail: command bridge + bold state come from the active
  // note's editor (Tiptap-free contract).
  const handleNoteCommands = useCallback((commands: NoteEditorCommands | null) => {
    noteCommandsRef.current = commands;
    if (!commands) {
      setBoldActive(false);
      setItalicActive(false);
      setStrikeActive(false);
    }
  }, []);

  const handleNoteBoldStateChange = useCallback((active: boolean) => {
    setBoldActive(active);
  }, []);

  const handleNoteItalicStateChange = useCallback((active: boolean) => {
    setItalicActive(active);
  }, []);

  const handleNoteStrikeStateChange = useCallback((active: boolean) => {
    setStrikeActive(active);
  }, []);

  const handleNoteTextColorChange = useCallback((color: TextColorId) => {
    setTextColor(color);
  }, []);

  const handleBold = useCallback(() => {
    noteCommandsRef.current?.toggleBold();
  }, []);

  const handleItalic = useCallback(() => {
    noteCommandsRef.current?.toggleItalic();
  }, []);

  const handleStrike = useCallback(() => {
    noteCommandsRef.current?.toggleStrike();
  }, []);

  const handleTextColor = useCallback((color: TextColorId) => {
    noteCommandsRef.current?.setTextColor(color);
  }, []);

  const handleNoteColor = useCallback(
    (color: NoteColorId) => {
      const note = activeNote;
      if (!note) return;
      const prevColor = (note.colorToken as NoteColorId) ?? "default";
      void dispatcher
        .execute(new SetNoteColorCommand(idGenerator.nextId(), note.id, color, prevColor))
        .then(() => {
          dispatch({ type: "noteColorChanged", id: note.id, colorToken: color });
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    [activeNote, dispatcher, idGenerator],
  );

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

  // Board cover actions: set from clipboard, choose a file, or remove. Each
  // updates the local portal projection immediately (cardReplaced) so the tile
  // re-renders without a full board reload.
  const handleSetCoverFromClipboard = useCallback(async () => {
    if (!contextMenu) return;
    const portal = state.cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    try {
      const asset = await gateway.importClipboardImage();
      await gateway.setBoardCover({ boardId: portal.target.id, assetId: asset.id });
      dispatch({
        type: "cardReplaced",
        id: portal.id,
        card: { ...portal, target: { ...portal.target, coverAsset: asset } },
      });
      setQuickBoards((boards) =>
        boards.map((quickBoard) =>
          quickBoard.boardId === portal.target.id
            ? { ...quickBoard, coverAsset: asset }
            : quickBoard,
        ),
      );
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, state.cards, gateway]);

  const handleChooseCover = useCallback(async () => {
    if (!contextMenu) return;
    const portal = state.cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    const picked = await pickImageFile();
    if (!picked) return;
    try {
      const asset = await gateway.importAsset({
        id: idGenerator.nextId(),
        sourcePath: picked.path,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
      });
      await gateway.setBoardCover({ boardId: portal.target.id, assetId: asset.id });
      dispatch({
        type: "cardReplaced",
        id: portal.id,
        card: { ...portal, target: { ...portal.target, coverAsset: asset } },
      });
      setQuickBoards((boards) =>
        boards.map((quickBoard) =>
          quickBoard.boardId === portal.target.id
            ? { ...quickBoard, coverAsset: asset }
            : quickBoard,
        ),
      );
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, state.cards, gateway, idGenerator]);

  const handleRemoveCover = useCallback(async () => {
    if (!contextMenu) return;
    const portal = state.cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    try {
      await gateway.removeBoardCover(portal.target.id);
      dispatch({
        type: "cardReplaced",
        id: portal.id,
        card: { ...portal, target: { ...portal.target, coverAsset: null } },
      });
      setQuickBoards((boards) =>
        boards.map((quickBoard) =>
          quickBoard.boardId === portal.target.id
            ? { ...quickBoard, coverAsset: null }
            : quickBoard,
        ),
      );
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, state.cards, gateway]);

  // Quick Boards: open navigates (opening/activating a tab).
  const handleQuickBoardOpen = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { pushHistory: true, tabMode: "open" });
    },
    [navigateTo],
  );

  // Detect external (agent) writes by polling SQLite's PRAGMA data_version. Any
  // commit from another connection changes it; then reload the open Board so the
  // UI reflects the external change without a manual refresh.
  const dataVersionRef = useRef<number>(0);
  useEffect(() => {
    let cancelled = false;
    // Prime the baseline once.
    void gateway.getDataVersion().then((v) => {
      if (!cancelled) dataVersionRef.current = v;
    });
    const id = setInterval(() => {
      void gateway.getDataVersion().then((v) => {
        if (!cancelled && v !== dataVersionRef.current && board) {
          dataVersionRef.current = v;
          void navigateTo(board.id);
          void refreshTrash();
        }
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gateway, board, navigateTo, refreshTrash]);

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
          onBold={handleBold}
          boldActive={boldActive}
          onItalic={handleItalic}
          italicActive={italicActive}
          onStrike={handleStrike}
          strikeActive={strikeActive}
          onBackToCreate={handleBackToCreate}
          textColor={textColor}
          onTextColor={handleTextColor}
          noteColor={noteColor}
          onNoteColor={handleNoteColor}
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
            if (isFolderAlias) {
              actions.push({
                id: "show-in-finder",
                label: "Show in Finder",
                onSelect: () => handleOpenFolderInFinder(card.id),
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
                { id: "set-cover-clipboard", label: "Set Cover from Clipboard", onSelect: () => void handleSetCoverFromClipboard() },
                { id: "choose-cover", label: "Choose Cover…", onSelect: () => void handleChooseCover() },
              );
              if ((card as BoardPortalDto).target.coverAsset !== null) {
                actions.push({ id: "remove-cover", label: "Remove Cover", onSelect: () => void handleRemoveCover() });
              }
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
          />
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
              onPaneDoubleClick: (point, screen) => {
                setPaneContextMenu({ x: screen.x, y: screen.y, flowX: point.x, flowY: point.y });
              },
            }}
            renderCard={(card) => {
              const full = state.cards.find((c) => c.id === card.id);
              if (!full) return null;
              return renderCardFromRegistry(full, {
                editing: state.editingCardId === full.id,
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
                onOpenFileCard: openFileCard,
                onRevealFileCard: revealFileCard,
                onResizeFileCard: handleResizeNote,
                highlightedPortalId,
                highlightQuery: search.highlightQuery,
                onNoteCommands: handleNoteCommands,
                onNoteBoldStateChange: handleNoteBoldStateChange,
                onNoteItalicStateChange: handleNoteItalicStateChange,
                onNoteStrikeStateChange: handleNoteStrikeStateChange,
                onNoteTextColorChange: handleNoteTextColorChange,
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

/** A short, human-friendly URL for display (strips scheme and trailing slash). */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return path ? `${host}${path}` : host;
  } catch {
    return raw;
  }
}
