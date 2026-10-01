import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useDocumentDraft } from "../editor/use-document-draft";
import { flushAllDrafts } from "../editor/draft-flush-registry";
import { MutationQueue } from "../persistence/entity-write-queue";
import type { BoardSnapshot, WorkspaceGateway } from "../services/workspace-gateway";
import { useBoardNavigation } from "./use-board-navigation";

/**
 * Reproduces (and guards) the suspected navigation data-loss bug end to end,
 * wiring the same three pieces `App.tsx` wires together: an editing note's
 * `useDocumentDraft`, a `MutationQueue` gated by a stale-cards check (mirrors
 * App's `cardsRef.current.find(...)` / `handleUpdateNote`), and
 * `useBoardNavigation`'s `navigateTo`, which drains pending writes *before*
 * loading the next snapshot and unmounting the editing card.
 *
 * A mouse click elsewhere blurs first (handleBlur -> finalize) and is
 * unaffected; this reproduces a navigation that does NOT blur first, e.g.
 * activating another open tab.
 */

const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };

function doc(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function textOf(document: unknown): string {
  return (
    (document as { content: Array<{ content?: Array<{ text?: string }> }> }).content[0]
      ?.content?.[0]?.text ?? ""
  );
}

function snapshot(boardId: string): BoardSnapshot {
  return {
    board: {
      id: boardId,
      title: boardId,
      colorToken: "slate",
      symbol: null,
      coverAsset: null,
      revision: 1,
      parentBoardId: null,
      portalRevision: null,
    },
    breadcrumbs: [],
    viewport: { x: 0, y: 0, zoom: 1, revision: 1 },
    cards: [],
    unsortedCards: [],
  } as unknown as BoardSnapshot;
}

/**
 * Mirrors `App.tsx`'s `cardsRef` + `handleUpdateNote`: the write is dropped,
 * silently, when the note isn't found among the *currently loaded* board's
 * cards — which is exactly what happens once navigation has already swapped
 * the projection to the next board.
 */
function makeBackend() {
  const queue = new MutationQueue();
  const persisted: { text: string | null } = { text: null };
  let currentBoardNoteIds = new Set(["note-1"]);

  const handleUpdateNote = (id: string, document: unknown): Promise<void> =>
    queue.run(async () => {
      if (!currentBoardNoteIds.has(id)) return; // note not on the loaded board: dropped
      persisted.text = textOf(document);
    });

  return {
    queue,
    persisted,
    setCurrentBoardNoteIds: (ids: string[]) => {
      currentBoardNoteIds = new Set(ids);
    },
    handleUpdateNote,
  };
}

function NoteHarness({ backend }: { backend: ReturnType<typeof makeBackend> }) {
  // `persistedDocument` must be a stable reference across renders (as
  // `note.documentJson` is in App.tsx): a fresh object here would make
  // useDocumentDraft's "adopt while clean" effect re-adopt on every render.
  const { handleChange } = useDocumentDraft({
    id: "note-1",
    persistedDocument: emptyDoc,
    onUpdate: backend.handleUpdateNote,
  });
  return <div data-testid="note" onClick={() => handleChange(doc("typed"))} />;
}

function Harness({
  backend,
  onNavigation,
}: {
  backend: ReturnType<typeof makeBackend>;
  onNavigation: (nav: ReturnType<typeof useBoardNavigation>) => void;
}) {
  const [showNote, setShowNote] = useState(true);

  const gateway = {
    loadBoardSnapshot: async (boardId: string) => {
      // Board switch: the note only lives on "board-a"; unmount the editor and
      // drop the loaded board's cards down to the new (empty) board's cards —
      // the same shape as `applySnapshot` dispatching `snapshotLoaded` and
      // re-syncing `cardsRef` in App.tsx.
      backend.setCurrentBoardNoteIds(boardId === "board-a" ? ["note-1"] : []);
      setShowNote(boardId === "board-a");
      return snapshot(boardId);
    },
  } as unknown as WorkspaceGateway;

  const navigation = useBoardNavigation({
    gateway,
    stampSnapshotRequest: () => 0,
    drainPendingWrites: async () => {
      await flushAllDrafts();
      await backend.queue.flush();
    },
    onSnapshotLoaded: () => {},
  });
  onNavigation(navigation);

  return <>{showNote && <NoteHarness backend={backend} />}</>;
}

describe("note draft survives navigation without a blur", () => {
  it("persists the last keystroke when navigating away before the debounce fires", async () => {
    const backend = makeBackend();
    let nav!: ReturnType<typeof useBoardNavigation>;

    const { getByTestId } = render(
      <Harness backend={backend} onNavigation={(n) => (nav = n)} />,
    );

    act(() => {
      nav.initialize(snapshot("board-a"));
    });

    // Type: this only schedules a debounced save (250ms) — it never fires on
    // its own within this test.
    await act(async () => {
      getByTestId("note").click();
    });
    expect(backend.persisted.text).toBeNull();

    // Navigate away WITHOUT a blur (e.g. clicking another tab, or keyboard
    // back/forward): drainPendingWrites runs, then the snapshot loads and the
    // note card unmounts.
    await act(async () => {
      await nav.navigateTo("board-b", { tabMode: "open" });
    });

    // The keystroke must have been persisted before the projection swapped —
    // not silently dropped because the note was no longer on the (new)
    // current board by the time the too-late unmount-flush would have fired.
    expect(backend.persisted.text).toBe("typed");
  });
});
