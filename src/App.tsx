import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "./app/AppShell";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import type { CanvasCard, CanvasViewport } from "./canvas/canvas-types";
import { NoteCard } from "./cards/note/NoteCard";
import { plainTextToDocument } from "./editor/document-codec";
import { createGateway } from "./services/create-gateway";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import type { BoardSummary, NoteCardDto, WorkspaceGateway } from "./services/workspace-gateway";

function App() {
  const gateway: WorkspaceGateway = useMemo(() => createGateway(), []);
  const idGenerator: IdGenerator = useMemo(() => new UuidV7Generator(), []);

  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [notes, setNotes] = useState<NoteCardDto[]>([]);
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const home = await gateway.getHomeBoard();
        const snapshot = await gateway.loadBoardSnapshot(home.id);
        if (cancelled) return;
        setBoard(snapshot.board);
        setNotes(snapshot.cards.filter((c): c is NoteCardDto => c.kind === "note"));
        setViewport({
          x: snapshot.viewport.x,
          y: snapshot.viewport.y,
          zoom: snapshot.viewport.zoom,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
    const input = {
      id,
      boardId: board.id,
      frame: { x: 40, y: 40 + notes.length * 24, width: 240, height: 120 },
      zIndex: notes.length,
      documentJson: plainTextToDocument(""),
      plainText: "",
    };
    try {
      await gateway.createNote(input);
      setNotes((prev) => [
        ...prev,
        {
          kind: "note",
          id,
          boardId: board.id,
          frame: input.frame,
          zIndex: input.zIndex,
          revision: 1,
          documentJson: input.documentJson,
          plainText: "",
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [board, gateway, idGenerator, notes.length]);

  const handleUpdateNote = useCallback(
    async (id: string, plainText: string) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      await gateway.updateNote({
        id,
        expectedRevision: note.revision,
        documentJson: plainTextToDocument(plainText),
        plainText,
      });
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                plainText,
                documentJson: plainTextToDocument(plainText),
                revision: n.revision + 1,
              }
            : n,
        ),
      );
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
  }));

  // Changing this value (e.g. after a text edit) forces the canvas to rebuild
  // its nodes so the updated content is rendered immediately.
  const dependencyKey = notes
    .map((n) => `${n.id}:${n.plainText}:${n.revision}`)
    .join("|");

  // A drag gesture finished: persist the new frames to SQLite, then reflect
  // the bumped revision locally.
  const handleCardsMoved = useCallback(
    (e: { cards: Array<{ id: string; frame: CanvasCard["frame"] }> }) => {
      for (const moved of e.cards) {
        const note = notes.find((n) => n.id === moved.id);
        if (!note) continue;
        void gateway
          .moveCard({
            id: moved.id,
            expectedRevision: note.revision,
            frame: moved.frame,
          })
          .then(() => {
            setNotes((prev) =>
              prev.map((n) =>
                n.id === moved.id
                  ? { ...n, frame: moved.frame, revision: n.revision + 1 }
                  : n,
              ),
            );
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
          });
      }
    },
    [gateway, notes],
  );

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
            dependencyKey={dependencyKey}
            events={{
              onCardsMoved: handleCardsMoved,
              onViewportChanged: (e) => setViewport(e.viewport),
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
