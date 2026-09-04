import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "./app/AppShell";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import type { CanvasCard, CanvasViewport } from "./canvas/canvas-types";
import { renderCard as renderCardFromRegistry } from "./cards/card-registry";
import { MoveCardsCommand, CreateNoteCommand } from "./commands/card-commands";
import { CreateChildBoardCommand, RenameBoardCommand } from "./commands/board-commands";
import { CommandDispatcher } from "./commands/command-dispatcher";
import { TrashSelectionCommand } from "./commands/trash-commands";
import { CanvasErrorBanner } from "./components/errors/CanvasErrorBanner";
import { plainTextToDocument, documentToPlainText, normalizeDocument } from "./editor/document-codec";
import { BoardBreadcrumbs } from "./navigation/BoardBreadcrumbs";
import { BoardHistory } from "./navigation/board-history";
import { MutationQueue } from "./persistence/entity-write-queue";
import { createGateway } from "./services/create-gateway";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import { pickImageFile } from "./services/asset-picker";
import type { BoardPortalDto, ImageCardDto, NoteCardDto, WorkspaceGateway } from "./services/workspace-gateway";
import {
  initialState,
  reducer,
} from "./state/current-board-store";

function App() {
  const gateway: WorkspaceGateway = useMemo(() => createGateway(), []);
  const idGenerator: IdGenerator = useMemo(() => new UuidV7Generator(), []);

  const [state, dispatch] = useReducer(reducer, initialState);
  const [contextMenu, setContextMenu] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const { board, breadcrumbs, viewport, viewportRevision, error } = state;
  const notes = state.cards.filter((c): c is NoteCardDto => c.kind === "note");

  // Browser-style navigation history. Initialized lazily once Home is known.
  const historyRef = useRef<BoardHistory | null>(null);
  const homeIdRef = useRef<string | null>(null);

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

  const viewportRevisionRef = useRef(viewportRevision);
  useEffect(() => {
    viewportRevisionRef.current = viewportRevision;
  }, [viewportRevision]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      dispatch({ type: "loading" });
      try {
        const home = await gateway.getHomeBoard();
        const snapshot = await gateway.loadBoardSnapshot(home.id);
        if (cancelled) return;
        historyRef.current = new BoardHistory(home.id);
        homeIdRef.current = home.id;
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
        });
      } catch (e) {
        if (!cancelled) {
          dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  const handleCreateNote = useCallback(async () => {
    if (!board) return;
    const id = idGenerator.nextId();
    const card: NoteCardDto = {
      kind: "note",
      id,
      boardId: board.id,
      frame: { x: 40, y: 40 + notes.length * 24, width: 240, height: 120 },
      zIndex: notes.length,
      revision: 1,
      documentJson: plainTextToDocument(""),
      plainText: "",
    };
    try {
      await dispatcher.execute(
        new CreateNoteCommand(id, {
          id,
          boardId: board.id,
          frame: card.frame,
          zIndex: card.zIndex,
          documentJson: card.documentJson,
          plainText: "",
        }),
      );
      dispatch({ type: "cardAdded", card });
    } catch (e) {
      dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [board, dispatcher, idGenerator, notes.length]);

  const handleCreateChildBoard = useCallback(async () => {
    if (!board) return;
    const boardId = idGenerator.nextId();
    const portalCardId = idGenerator.nextId();
    const portal: BoardPortalDto = {
      kind: "board_portal",
      id: portalCardId,
      boardId: board.id,
      frame: { x: 100, y: 100 + state.cards.length * 24, width: 120, height: 112 },
      zIndex: 0,
      revision: 1,
      target: {
        id: boardId,
        title: "New Board",
        colorToken: "terracotta",
        symbol: null,
        childBoardCount: 0,
        childCardCount: 0,
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
      dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [board, dispatcher, idGenerator, state.cards.length]);

  const handleCreateImage = useCallback(async () => {
    if (!board) return;
    const picked = await pickImageFile();
    if (!picked) return;

    const assetId = idGenerator.nextId();
    const cardId = idGenerator.nextId();
    try {
      const asset = await gateway.importAsset({
        id: assetId,
        sourcePath: picked.path,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
      });
      const card: ImageCardDto = {
        kind: "image",
        id: cardId,
        boardId: board.id,
        frame: { x: 80, y: 80 + state.cards.length * 24, width: 320, height: 240 },
        zIndex: state.cards.length,
        revision: 1,
        asset,
        captionJson: plainTextToDocument(""),
        captionPlainText: "",
      };
      await gateway.createImageCard({
        id: cardId,
        boardId: board.id,
        frame: card.frame,
        zIndex: card.zIndex,
        assetId,
        captionJson: card.captionJson,
        captionPlainText: "",
      });
      dispatch({ type: "cardAdded", card });
    } catch (e) {
      dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [board, gateway, idGenerator, state.cards.length]);

  const handleUpdateNote = useCallback(
    (id: string, document: unknown): Promise<void> => {
      // The returned promise *rejects* on failure so the note card can keep its
      // editor open and its draft visible. We surface the error to the banner
      // here but do NOT swallow it.
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
          // eslint-disable-next-line no-console
          console.warn("[note-document] refusing to persist malformed document", document);
          throw new Error("Note content is not a valid document");
        }
        const plainText = documentToPlainText(document);
        await gateway.updateNote({
          id,
          expectedRevision: note.revision,
          documentJson: document,
          plainText,
        });
        dispatch({
          type: "cardContentUpdated",
          id,
          revision: note.revision + 1,
          documentJson: document,
          plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
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
          dispatch({ type: "failed", message: err instanceof Error ? err.message : String(err) });
        });
    },
    [idGenerator, dispatcher],
  );

  const handleDeleteSelection = useCallback(async () => {
    if (state.selection.length === 0) return;
    const items = state.selection
      .map((id) => {
        const card = state.cards.find((c) => c.id === id);
        if (!card) return null;
        if (card.kind === "board_portal") {
          return { id: card.target.id, kind: "board_portal" as const };
        }
        return { id: card.id, kind: card.kind as "note" | "image" };
      })
      .filter((x): x is { id: string; kind: "note" | "image" | "board_portal" } => x !== null);

    if (items.length === 0) return;

    try {
      await dispatcher.execute(new TrashSelectionCommand(idGenerator.nextId(), items));
      dispatch({ type: "cardsRemoved", ids: state.selection });
    } catch (e) {
      dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [state.selection, state.cards, dispatcher, idGenerator]);

  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleViewportChanged = useCallback(
    (e: { viewport: CanvasViewport }) => {
      dispatch({ type: "viewportChanged", viewport: e.viewport });
      if (viewportTimer.current) clearTimeout(viewportTimer.current);
      viewportTimer.current = setTimeout(() => {
        if (!board) return;
        void gateway
          .saveViewport({
            boardId: board.id,
            expectedRevision: viewportRevisionRef.current,
            x: e.viewport.x,
            y: e.viewport.y,
            zoom: e.viewport.zoom,
          })
          .then(() => {
            dispatch({ type: "viewportSaved", revision: viewportRevisionRef.current + 1 });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: err instanceof Error ? err.message : String(err) });
          });
      }, 400);
    },
    [board, gateway],
  );

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
      const note = cardsRef.current.find((c) => c.kind === "note" && c.id === id);
      if (!note || note.kind !== "note") return;
      void queueRef.current
        .run(async () => {
          const current = cardsRef.current.find((c) => c.kind === "note" && c.id === id);
          if (!current || current.kind !== "note") return;
          const frame = { ...current.frame, width, height };
          await gateway.moveCard({
            id,
            expectedRevision: current.revision,
            frame,
          });
          dispatch({ type: "cardMoved", id, revision: current.revision + 1, frame });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
        });
    },
    [gateway],
  );

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    // Delete the current selection, not just the single right-clicked card. If
    // the selection is empty (e.g. cleared), fall back to the clicked card.
    const ids = state.selection.length > 0 ? state.selection : [contextMenu.cardId];
    setContextMenu(null);

    const items = ids
      .map((id) => {
        const card = state.cards.find((c) => c.id === id);
        if (!card) return null;
        if (card.kind === "board_portal") {
          return { id: card.target.id, kind: "board_portal" as const };
        }
        return { id: card.id, kind: card.kind as "note" | "image" };
      })
      .filter((x): x is { id: string; kind: "note" | "image" | "board_portal" } => x !== null);

    if (items.length === 0) return;
    void dispatcher
      .execute(new TrashSelectionCommand(idGenerator.nextId(), items))
      .then(() => dispatch({ type: "cardsRemoved", ids }))
      .catch((e) => {
        dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }, [contextMenu, state.selection, state.cards, dispatcher, idGenerator]);

  // Load a board's snapshot into the store.
  const navigateTo = useCallback(
    async (boardId: string, opts?: { push?: boolean }) => {
      // Flush any pending note/viewport writes before replacing the projection,
      // so a debounced save cannot be abandoned by navigation (plan Section H).
      await queueRef.current.flush();
      const snapshot = await gateway.loadBoardSnapshot(boardId);
      if (opts?.push && historyRef.current) {
        historyRef.current.push(boardId);
      }
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
      });
    },
    [gateway],
  );

  // Reload the current board (no history push). Used to reconcile UI with the
  // database after undo/redo.
  const reloadCurrentBoard = useCallback(() => {
    if (board) void navigateTo(board.id);
  }, [board, navigateTo]);

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
          reloadCurrentBoard();
        })
        .catch((e) => {
          dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
        });
    },
    [state.cards, dispatcher, idGenerator, reloadCurrentBoard],
  );

  // Open a child board via a portal (double-click / Enter).
  const handleOpenBoard = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { push: true });
    },
    [navigateTo],
  );

  // Double-click on a card: if it's a portal, open its target board (the
  // canvas passes the *card* id, so resolve to the target board first).
  const handleCardOpened = useCallback(
    (cardId: string) => {
      const card = state.cards.find((c) => c.id === cardId);
      if (card?.kind === "board_portal") {
        void navigateTo(card.target.id, { push: true });
      }
    },
    [state.cards, navigateTo],
  );

  const handleNavigateBack = useCallback(() => {
    const prev = historyRef.current?.back();
    if (prev) void navigateTo(prev);
  }, [navigateTo]);

  const handleNavigateForward = useCallback(() => {
    const next = historyRef.current?.forward();
    if (next) void navigateTo(next);
  }, [navigateTo]);

  const canvasRef = useRef<HTMLDivElement>(null);

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
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const inEditor = target && (target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inEditor) return;
      if (e.key === "[") {
        e.preventDefault();
        handleNavigateBack();
      } else if (e.key === "]") {
        e.preventDefault();
        handleNavigateForward();
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          void dispatcher.redo().then(() => reloadCurrentBoard());
        } else {
          void dispatcher.undo().then(() => reloadCurrentBoard());
        }
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        void handleDeleteSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNavigateBack, handleNavigateForward, dispatcher, handleDeleteSelection, reloadCurrentBoard]);

  return (
    <AppShell>
      <div className="workspace">
        <div className="workspace__toolbar">
          <button type="button" className="workspace__home" onClick={() => { if (homeIdRef.current) void navigateTo(homeIdRef.current, { push: true }); }}>
            Home
          </button>
          <span className="workspace__board-title">
            {board ? board.title : "Loading…"}
          </span>
          <span className="workspace__count" data-testid="note-count">
            {notes.length} note{notes.length === 1 ? "" : "s"}
          </span>
          <button type="button" onClick={() => void handleCreateNote()}>
            New note
          </button>
          <button type="button" onClick={() => void handleCreateChildBoard()}>
            New board
          </button>
          <button type="button" onClick={() => void handleCreateImage()}>
            Add image
          </button>
        </div>
        <BoardBreadcrumbs breadcrumbs={breadcrumbs} onNavigate={(id) => void navigateTo(id, { push: true })} />
        {contextMenu && (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            data-testid="context-menu"
          >
            <button type="button" className="context-menu__item" onClick={handleContextDelete}>
              Delete
            </button>
          </div>
        )}
        {contextMenu && <div className="context-menu__backdrop" onClick={() => setContextMenu(null)} />}
        {error && (
          <CanvasErrorBanner
            message={error}
            onRetry={() => dispatch({ type: "clearError" })}
          />
        )}
        <div className="workspace__canvas" data-testid="canvas" ref={canvasRef}>
          <CanvasAdapter
            cards={canvasCards}
            viewport={viewport}
            editingCardId={state.editingCardId}
            events={{
              onCardsMoved: handleCardsMoved,
              onViewportChanged: handleViewportChanged,
              onSelectionChanged: handleCardsSelected,
              onCardActivated: handleCardActivated,
              onCardOpened: handleCardOpened,
              onCardContextMenu: handleRequestContextMenu,
            }}
            renderCard={(card) => {
              const full = state.cards.find((c) => c.id === card.id);
              if (!full) return null;
              return renderCardFromRegistry(full, {
                editing: state.editingCardId === full.id,
                onDeactivate: handleEditDeactivate,
                onUpdateNote: handleUpdateNote,
                onOpenBoard: handleOpenBoard,
                onRenameBoard: handleRenameBoard,
                onContextMenu: handleRequestContextMenu,
                onResizeNote: handleResizeNote,
              });
            }}
          />
          {notes.length === 0 && !error && (
            <div className="workspace__empty">
              Click “New note” to create your first note.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

export default App;
