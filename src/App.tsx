import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppShell } from "./app/AppShell";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import type { CanvasCard, CanvasViewport } from "./canvas/canvas-types";
import { NoteCard } from "./cards/note/NoteCard";
import { plainTextToDocument } from "./editor/document-codec";
import { createGateway } from "./services/create-gateway";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import type { NoteCardDto, WorkspaceGateway } from "./services/workspace-gateway";
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

  const handleUpdateNote = useCallback(
    async (id: string, plainText: string) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      try {
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
      } catch (e) {
        dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [gateway, notes],
  );

  // Build the canvas projection from notes. (Board portals join in Slice 4.)
  const canvasCards: CanvasCard[] = notes.map((n) => ({
    id: n.id,
    boardId: n.boardId,
    kind: "note",
    frame: n.frame,
    zIndex: n.zIndex,
    revision: n.revision,
  }));

  const handleCardsMoved = useCallback(
    (e: { cards: Array<{ id: string; frame: CanvasCard["frame"] }> }) => {
      const batch = e.cards
        .map((moved) => {
          const note = notes.find((n) => n.id === moved.id);
          return note
            ? { id: moved.id, expectedRevision: note.revision, frame: moved.frame }
            : null;
        })
        .filter((x): x is { id: string; expectedRevision: number; frame: CanvasCard["frame"] } => x !== null);

      if (batch.length === 0) return;

      void gateway
        .moveCards({ cards: batch })
        .then(() => {
          for (const item of batch) {
            const note = notes.find((n) => n.id === item.id);
            if (!note) continue;
            dispatch({
              type: "cardMoved",
              id: item.id,
              revision: note.revision + 1,
              frame: item.frame,
            });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: err instanceof Error ? err.message : String(err) });
        });
    },
    [gateway, notes],
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
        </div>
        {error && (
          <div className="workspace__error" data-testid="workspace-error">
            {error}
          </div>
        )}
        <div className="workspace__canvas" data-testid="canvas">
          <CanvasAdapter
            cards={canvasCards}
            viewport={viewport}
            events={{
              onCardsMoved: handleCardsMoved,
              onViewportChanged: handleViewportChanged,
              onSelectionChanged: handleCardsSelected,
            }}
            renderCard={(card) => {
              const note = notes.find((n) => n.id === card.id);
              if (!note) return null;
              return <NoteCard note={note} onUpdate={handleUpdateNote} />;
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
