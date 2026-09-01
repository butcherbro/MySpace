import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "./app/AppShell";
import { NoteCard } from "./cards/note/NoteCard";
import { createGateway } from "./services/create-gateway";
import type { BoardSummary, NoteCardDto, WorkspaceGateway } from "./services/workspace-gateway";

function App() {
  const gateway: WorkspaceGateway = useMemo(() => createGateway(), []);

  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [notes, setNotes] = useState<NoteCardDto[]>([]);
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
    const id = crypto.randomUUID();
    const input = {
      id,
      boardId: board.id,
      frame: { x: 40, y: 40 + notes.length * 24, width: 240, height: 120 },
      zIndex: notes.length,
      documentJson: { type: "doc" },
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
  }, [board, gateway, notes.length]);

  const handleUpdateNote = useCallback(
    async (id: string, plainText: string) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      await gateway.updateNote({
        id,
        expectedRevision: note.revision,
        documentJson: note.documentJson,
        plainText,
      });
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, plainText, revision: n.revision + 1 } : n,
        ),
      );
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
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onUpdate={handleUpdateNote}
            />
          ))}
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
