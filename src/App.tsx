import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppShell } from "./app/AppShell";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import type { CanvasCard, CanvasViewport } from "./canvas/canvas-types";
import { renderCard as renderCardFromRegistry } from "./cards/card-registry";
import { plainTextToDocument } from "./editor/document-codec";
import { MutationQueue } from "./persistence/entity-write-queue";
import { createGateway } from "./services/create-gateway";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import type { BoardPortalDto, NoteCardDto, WorkspaceGateway } from "./services/workspace-gateway";
import {
  initialState,
  reducer,
} from "./state/current-board-store";

function App() {
  const gateway: WorkspaceGateway = useMemo(() => createGateway(), []);
  const idGenerator: IdGenerator = useMemo(() => new UuidV7Generator(), []);

  const [state, dispatch] = useReducer(reducer, initialState);
  const { board, viewport, viewportRevision, error } = state;
  const notes = state.cards.filter((c): c is NoteCardDto => c.kind === "note");

  // Serializes mutations (save/drag) so they never race on a card's revision.
  const queueRef = useRef(new MutationQueue());
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
        dispatch({
          type: "snapshotLoaded",
          board: snapshot.board,
          viewport: { x: snapshot.viewport.x, y: snapshot.viewport.y, zoom: snapshot.viewport.zoom },
          viewportRevision: snapshot.viewport.revision,
          cards: snapshot.cards,
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
      await gateway.createNote({
        id,
        boardId: board.id,
        frame: card.frame,
        zIndex: card.zIndex,
        documentJson: card.documentJson,
        plainText: "",
      });
      dispatch({ type: "cardAdded", card });
    } catch (e) {
      dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [board, gateway, idGenerator, notes.length]);

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
      await gateway.createChildBoard({
        parentBoardId: board.id,
        boardId,
        portalCardId,
        frame: portal.frame,
        title: "New Board",
      });
      dispatch({ type: "cardAdded", card: portal });
    } catch (e) {
      dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [board, gateway, idGenerator, state.cards.length]);

  const handleUpdateNote = useCallback(
    (id: string, plainText: string): Promise<void> => {
      const task = queueRef.current
        .run(async () => {
          const note = cardsRef.current.find(
            (n): n is NoteCardDto => n.kind === "note" && n.id === id,
          );
          if (!note) return;
          await gateway.updateNote({
            id,
            expectedRevision: note.revision,
            documentJson: plainTextToDocument(plainText),
            plainText,
          });
          dispatch({
            type: "cardContentUpdated",
            id,
            revision: note.revision + 1,
            documentJson: plainTextToDocument(plainText),
            plainText,
          });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
        });
      return task;
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
          const batch = e.cards
            .map((moved) => {
              const card = cardsRef.current.find((c) => c.id === moved.id);
              return card
                ? { id: moved.id, expectedRevision: card.revision, frame: moved.frame }
                : null;
            })
            .filter(
              (x): x is { id: string; expectedRevision: number; frame: CanvasCard["frame"] } =>
                x !== null,
            );

          if (batch.length === 0) return;

          await gateway.moveCards({ cards: batch });
          for (const item of batch) {
            const card = cardsRef.current.find((c) => c.id === item.id);
            if (!card) continue;
            dispatch({
              type: "cardMoved",
              id: item.id,
              revision: card.revision + 1,
              frame: item.frame,
            });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: err instanceof Error ? err.message : String(err) });
        });
    },
    [gateway],
  );

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
    dispatch({ type: "selectionChanged", ids: e.ids });
  }, []);

  const handleCardActivated = useCallback((id: string) => {
    const card = state.cards.find((c) => c.id === id);
    if (card?.kind === "note") {
      dispatch({ type: "editingStarted", id });
    }
  }, [state.cards]);

  // Open a child board (full navigation history arrives in Task 4.3).
  const handleOpenBoard = useCallback(
    async (boardId: string) => {
      const snapshot = await gateway.loadBoardSnapshot(boardId);
      dispatch({
        type: "snapshotLoaded",
        board: snapshot.board,
        viewport: { x: snapshot.viewport.x, y: snapshot.viewport.y, zoom: snapshot.viewport.zoom },
        viewportRevision: snapshot.viewport.revision,
        cards: snapshot.cards,
      });
    },
    [gateway],
  );

  const canvasRef = useRef<HTMLDivElement>(null);

  const handleEditDeactivate = useCallback(() => {
    dispatch({ type: "editingStopped" });
    // Return focus to the canvas so keyboard shortcuts (e.g. Cmd+A) and the
    // next interaction land back on the board, not a stale editor.
    canvasRef.current?.focus();
  }, []);

  return (
    <AppShell>
      <div className="workspace">
        <div className="workspace__toolbar">
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
        </div>
        {error && (
          <div className="workspace__error" data-testid="workspace-error">
            {error}
          </div>
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
            }}
            renderCard={(card) => {
              const full = state.cards.find((c) => c.id === card.id);
              if (!full) return null;
              return renderCardFromRegistry(full, {
                editing: state.editingCardId === full.id,
                onDeactivate: handleEditDeactivate,
                onUpdateNote: handleUpdateNote,
                onOpenBoard: handleOpenBoard,
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
