import { useCallback, useMemo, useReducer, useRef, useState } from "react";
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
import { useCardCreation } from "./app/use-card-creation";
import { useContextActions } from "./app/use-context-actions";
import { useCardDrop } from "./app/use-card-drop";
import { useBoardLoading } from "./app/use-board-loading";
import { useBoardRefresh } from "./app/use-board-refresh";
import { useCreationDrag } from "./app/use-creation-drag";
import { useTrashController } from "./app/use-trash-controller";
import { useErrorReports } from "./app/error-reports";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import { useCrossBoardDragSession } from "./canvas/use-cross-board-drag";
import type { CanvasCard } from "./canvas/canvas-types";
import { renderCard as renderCardFromRegistry } from "./cards/card-registry";
import { RenameBoardCommand } from "./commands/board-commands";
import { CommandDispatcher } from "./commands/command-dispatcher";
import type { NoteColorId } from "./cards/note/note-color";
import { CanvasErrorBanner } from "./components/errors/CanvasErrorBanner";
import { ToolRail } from "./components/tool-rail/ToolRail";
import { TrashDrawer } from "./components/trash/TrashDrawer";
import { EmptyTrashDialog } from "./components/trash/EmptyTrashDialog";
import { RestoreDialog } from "./backup/restore-dialog";
import { DevicesDialog } from "./sync/DevicesDialog";
import { UpdatePrompt } from "./updates/UpdatePrompt";
import { useUpdateCheck } from "./updates/use-update-check";
import { SyncStatusPill } from "./sync/SyncStatusPill";
import { ContextMenu, type ContextMenuAction } from "./components/context-menu/ContextMenu";
import { SearchBar } from "./search/SearchBar";
import { useSearchController } from "./search/use-search-controller";
import { useViewportController } from "./state/use-viewport-controller";
import { BoardBreadcrumbs } from "./navigation/BoardBreadcrumbs";
import { BoardTabs } from "./navigation/BoardTabs";
import { QuickBoardsRail } from "./navigation/QuickBoardsRail";
import { UndoRedoControls } from "./navigation/UndoRedoControls";
import { UnsortedPanel } from "./navigation/UnsortedPanel";
import { MutationQueue } from "./persistence/entity-write-queue";
import { createGateway } from "./services/create-gateway";
import { errorMessage } from "./services/error-message";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import { useNativeFileDrop } from "./app/use-native-file-drop";
import { useCanvasPaste } from "./app/use-canvas-paste";
import { useWorkspaceShortcuts } from "./app/use-workspace-shortcuts";
import { useStableCardHandlers } from "./app/use-stable-card-handlers";
import { useLatestRef } from "./app/use-latest-ref";
import { useCanvasPointer, useCanvasPointerTracking } from "./app/use-canvas-pointer";
import { useUnsortedDrawer } from "./app/use-unsorted-drawer";
import { flushAllDrafts } from "./editor/draft-flush-registry";
import type {
  BoardPortalDto,
  BoardShortcutDto,
  NoteCardDto,
  WorkspaceGateway,
} from "./services/workspace-gateway";
import {
  initialState,
  reducer,
} from "./state/current-board-store";

function App() {
  const gateway: WorkspaceGateway = useMemo(() => createGateway(), []);
  const idGenerator: IdGenerator = useMemo(() => new UuidV7Generator(), []);

  const [state, dispatch] = useReducer(reducer, initialState);
  const [contextMenu, setContextMenu] = useState<{ cardId: string; x: number; y: number } | null>(null);
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
  const { unsortedOpen, setUnsortedOpen } = useUnsortedDrawer({ unsortedCount: state.unsortedCards.length });


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

  // Always reflects the latest cards (notes AND portals) so queued tasks read the current revision.
  const cardsRef = useLatestRef(state.cards);

  // Last known pointer position over the canvas, in board-space (flow
  // coordinates); drives paste placement (todo.md №15). See
  // use-canvas-pointer.ts for why the reset effect and the pointermove
  // effect (near the JSX, below) are declared as two hooks instead of one.
  const { canvasRef, lastCanvasPointRef } = useCanvasPointer({ boardOpenRevision });

  // Always reflects the latest selection, so a drag start can snapshot all currently-selected card ids for a group move.
  const selectionRef = useLatestRef(state.selection);

  const { handleRetryEmbedMetadata } = useEmbedMetadata({
    cards: state.cards,
    cardsRef,
    gateway,
    dispatch,
  });

  // Screen->board coordinate converter, populated by CanvasAdapter on init.
  const screenToFlowRef = useRef<((x: number, y: number) => { x: number; y: number }) | null>(null);
  const boardRef = useLatestRef(board);


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
  // Every newly shown error is saved as a local report (never synced).
  const { copyReport } = useErrorReports({
    gateway,
    canvasError: error,
    boardId: board?.id,
    trashError: trash.error,
    trashEmptyError: trash.emptyError,
  });
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [devicesDialogOpen, setDevicesDialogOpen] = useState(false);


  const {
    handleCreateNote,
    handleCreateLink,
    handleCreateChildBoard,
    placeImageAsset,
    importImageCard,
    handleCreateImage,
    createFolderShortcut,
    createFileCard,
    handleAddFolderShortcutViaDialog,
    openFileCard,
    revealFileCard,
  } = useCardCreation({
    board,
    boardRef,
    notes,
    cards: state.cards,
    cardsRef,
    screenToFlowRef,
    gateway,
    dispatcher,
    idGenerator,
    dispatch,
  });

  // The two pointer-driven drags (Unsorted panel, tool rail) place cards that
  // useCardCreation just built the handlers for.
  const { unsortedGhost, handlePlaceUnsortedCard, handleUnsortedPointerDown, createGhost, handleCreationDragStart } =
    useCreationDrag({
      unsortedCards: state.unsortedCards,
      cards: state.cards,
      board,
      gateway,
      dispatch,
      screenToFlowRef,
      handleCreateNote,
      handleCreateLink,
      handleCreateChildBoard,
    });

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
    handleFinalizeImageCaption,
    handleUpdateEmbedDescription,
    handleFinalizeEmbedDescription,
    handleResizeNote,
  } = useCardEdits({ gateway, dispatch, queueRef, cardsRef, dispatcher, idGenerator });

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


  const {
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
  } = useContextActions({
    cards: state.cards,
    selection: state.selection,
    contextMenu,
    setContextMenu,
    screenToFlowRef,
    gateway,
    dispatcher,
    idGenerator,
    dispatch,
    refreshTrash,
  });

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

  // Board loading and the navigation spine (tabs, history, initial load).
  const navigation = useBoardLoading({ gateway, dispatch, queueRef, viewportController });
  const navigateTo = navigation.navigateTo;

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

  const { handleCardsMoved, handleCardDroppedOnPortal, handleCardsDroppedOnBoard, handleCardDragEnd } =
    useCardDrop({
      gateway,
      dispatcher,
      idGenerator,
      dispatch,
      queueRef,
      cardsRef,
      boardRef,
      crossBoardDragSession,
      navigateTo,
      handleQuickBoardPin,
    });

  // Keeps the open board current: undo/redo reload, external-write poll, LAN sync reload.
  const { reloadCurrentBoard, handleWorkspaceUndo, handleWorkspaceRedo } = useBoardRefresh({
    gateway,
    board,
    dispatcher,
    dispatch,
    navigateTo,
    refreshTrash,
    loadQuickBoards,
    reloadBoardRef,
  });


  const handleBackToCreate = useCallback(() => {
    dispatch({ type: "editingStopped" });
    dispatch({ type: "selectionChanged", ids: [] });
  }, []);


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
  // placement (use-canvas-pointer.ts).
  useCanvasPointerTracking({ canvasRef, lastCanvasPointRef, screenToFlowRef });

  const handleEditDeactivate = useCallback(() => {
    dispatch({ type: "editingStopped" });
    // Return focus to the canvas so keyboard shortcuts (e.g. Cmd+A) and the
    // next interaction land back on the board, not a stale editor.
    canvasRef.current?.focus();
    // canvasRef — стабильный ref, но теперь приходит из хука, поэтому линтер
    // просит указать его явно (то же исключение, что и для dispatch/сеттеров).
  }, [canvasRef]);

  useWorkspaceShortcuts({
    handleNavigateBack,
    handleNavigateForward,
    handleWorkspaceUndo,
    handleWorkspaceRedo,
    handleDeleteSelection,
    handleCopySelection,
    trashOpen,
    closeTrashDrawer,
  });

  // Card callbacks handed to the canvas, as stable wrappers over the latest
  // handlers (P1.8): see use-stable-card-handlers.ts for the "latest ref +
  // stable facade" pattern. Values (editing flag, highlight) are not here:
  // they are read when a card is (re)built.
  const stableCardHandlers = useStableCardHandlers({
    onDeactivate: handleEditDeactivate,
    onUpdateNote: handleUpdateNote,
    onFinalizeNote: handleFinalizeNote,
    onUpdateImageCaption: handleUpdateImageCaption,
    onFinalizeImageCaption: handleFinalizeImageCaption,
    onUpdateEmbedDescription: handleUpdateEmbedDescription,
    onFinalizeEmbedDescription: handleFinalizeEmbedDescription,
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
  });

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
            onCopyReport={() => copyReport(error)}
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
