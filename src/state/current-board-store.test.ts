import { describe, expect, it } from "vitest";
import { initialState, reducer, type CurrentBoardState } from "./current-board-store";
import type { BoardSummary, EmbedCardDto, NoteCardDto } from "../services/workspace-gateway";

const home: BoardSummary = {
  id: "home",
  title: "Home",
  parentBoardId: null,
  revision: 1,
  colorToken: "ink",
  symbol: null,
  coverAsset: null,
};

function note(id: string, x = 0): NoteCardDto {
  return {
    kind: "note",
    id,
    boardId: "home",
    frame: { x, y: 0, width: 200, height: 80 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc" },
    plainText: "",
    colorToken: "default",
  };
}

function embed(id: string): EmbedCardDto {
  return {
    kind: "embed",
    id,
    boardId: "home",
    frame: { x: 0, y: 0, width: 320, height: 180 },
    zIndex: 0,
    revision: 2,
    sourceUrl: "https://example.com",
    displayUrl: "example.com",
    siteName: null,
    title: "https://example.com",
    provider: null,
    descriptionJson: { type: "doc", content: [] },
    descriptionPlainText: "",
    descriptionOrigin: null,
    faviconAsset: null,
    previewAsset: null,
    previewOrigin: null,
    metadataStatus: "pending",
    metadataError: null,
  };
}

describe("current board reducer", () => {
  it("loads a snapshot and clears selection", () => {
    const state = reducer(
      { ...initialState, selection: ["x"] },
      {
        type: "snapshotLoaded",
        board: home,
        breadcrumbs: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportRevision: 3,
        cards: [note("a")],
        unsortedCards: [],
      },
    );
    expect(state.board).toEqual(home);
    expect(state.cards).toHaveLength(1);
    expect(state.selection).toEqual([]);
    expect(state.viewportRevision).toBe(3);
  });

  it("adds a card optimistically", () => {
    const state = reducer(initialState, { type: "cardAdded", card: note("a") });
    expect(state.cards.map((c) => c.id)).toEqual(["a"]);
  });

  it("places an Unsorted card with the persisted frame and revision", () => {
    const unsorted = note("a");
    const frame = { x: 420, y: 240, width: 200, height: 80 };
    const state = reducer(
      { ...initialState, unsortedCards: [unsorted] },
      {
        type: "unsortedCardPlaced",
        id: "a",
        frame,
        revision: 2,
      },
    );

    expect(state.unsortedCards).toEqual([]);
    expect(state.cards).toEqual([{ ...unsorted, frame, revision: 2 }]);
  });

  it("moves a card and bumps its revision", () => {
    let state = reducer(initialState, { type: "cardAdded", card: note("a") });
    state = reducer(state, {
      type: "cardMoved",
      id: "a",
      revision: 2,
      frame: { x: 42, y: 43, width: 200, height: 80 },
    });
    const card = state.cards[0] as NoteCardDto;
    expect(card.frame.x).toBe(42);
    expect(card.revision).toBe(2);
  });

  it("updates note content and bumps revision", () => {
    let state = reducer(initialState, { type: "cardAdded", card: note("a") });
    state = reducer(state, {
      type: "cardContentUpdated",
      id: "a",
      revision: 2,
      documentJson: { type: "doc", content: [] },
      plainText: "hello",
    });
    const card = state.cards[0] as NoteCardDto;
    expect(card.plainText).toBe("hello");
    expect(card.revision).toBe(2);
  });

  it("clears stale note editing when a note is replaced by a link card", () => {
    const state = reducer(
      { ...initialState, cards: [note("a")], editingCardId: "a", selection: ["a"] },
      { type: "cardReplaced", id: "a", card: embed("a") },
    );

    expect(state.cards[0]).toEqual(embed("a"));
    expect(state.editingCardId).toBeNull();
  });

  it("updates selection and viewport", () => {
    let state = reducer(initialState, { type: "selectionChanged", ids: ["a", "b"] });
    expect(state.selection).toEqual(["a", "b"]);
    state = reducer(state, { type: "viewportChanged", viewport: { x: 10, y: 20, zoom: 1.5 } });
    expect(state.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it("starts and stops editing, clearing when a snapshot loads", () => {
    let state = reducer(initialState, { type: "editingStarted", id: "a" });
    expect(state.editingCardId).toBe("a");
    expect(state.selection).toEqual(["a"]);

    state = reducer(state, { type: "editingStopped" });
    expect(state.editingCardId).toBeNull();

    state = reducer(
      { ...initialState, editingCardId: "a", selection: ["a"] },
      {
        type: "snapshotLoaded",
        board: home,
        breadcrumbs: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportRevision: 1,
        cards: [note("a")],
        unsortedCards: [],
      },
    );
    expect(state.editingCardId).toBeNull();
    expect(state.selection).toEqual([]);
  });

  it("keeps pan, editing and selection when the same board is reloaded", () => {
    // todo.md №26 (second cause): undo/redo, rename and the data_version poll
    // reload the open board; that is not a board switch and must not snap the
    // canvas back to the origin or close the note being edited.
    let state = reducer(initialState, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportRevision: 1,
      cards: [note("a"), note("b")],
      unsortedCards: [],
    });
    const openRevision = state.boardOpenRevision;
    state = reducer(state, { type: "viewportChanged", viewport: { x: 0, y: 0, zoom: 1.5 } });
    state = reducer(state, { type: "editingStarted", id: "a" });
    state = reducer(state, { type: "selectionChanged", ids: ["a", "b"] });

    state = reducer(state, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1.5 },
      viewportRevision: 2,
      cards: [note("a")],
      unsortedCards: [],
    });
    expect(state.boardOpenRevision).toBe(openRevision);
    expect(state.viewport.zoom).toBe(1.5);
    expect(state.viewportRevision).toBe(2);
    expect(state.editingCardId).toBe("a");
    // A card that vanished from the snapshot leaves the selection.
    expect(state.selection).toEqual(["a"]);
    expect(state.cards).toHaveLength(1);
  });

  it("drops editing when the edited card is gone from the reloaded snapshot", () => {
    let state = reducer(initialState, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportRevision: 1,
      cards: [note("a")],
      unsortedCards: [],
    });
    state = reducer(state, { type: "editingStarted", id: "a" });
    state = reducer(state, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportRevision: 1,
      cards: [],
      unsortedCards: [],
    });
    expect(state.editingCardId).toBeNull();
    expect(state.selection).toEqual([]);
  });

  it("switching to another board resets pan, editing and selection", () => {
    let state = reducer(initialState, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportRevision: 1,
      cards: [note("a")],
      unsortedCards: [],
    });
    const openRevision = state.boardOpenRevision;
    state = reducer(state, { type: "editingStarted", id: "a" });
    state = reducer(state, {
      type: "snapshotLoaded",
      board: { ...home, id: "other" },
      breadcrumbs: [],
      viewport: { x: 300, y: 200, zoom: 2 },
      viewportRevision: 1,
      cards: [note("a")],
      unsortedCards: [],
    });
    expect(state.boardOpenRevision).toBe(openRevision + 1);
    expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(state.editingCardId).toBeNull();
    expect(state.selection).toEqual([]);
  });

  it("resets the viewport to the board origin on load (ignores persisted position)", () => {
    const state = reducer(initialState, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: -240, y: 300, zoom: 1 },
      viewportRevision: 1,
      cards: [note("a", 40)],
      unsortedCards: [],
    });
    expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("resets a positive viewport to origin on load too", () => {
    const state = reducer(initialState, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: 120, y: 300, zoom: 1.5 },
      viewportRevision: 1,
      cards: [note("a", 40)],
      unsortedCards: [],
    });
    expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 1.5 });
  });

  it("records errors and clears them", () => {
    let state: CurrentBoardState = reducer(initialState, { type: "failed", message: "boom" });
    expect(state.error).toBe("boom");
    state = reducer(state, { type: "clearError" });
    expect(state.error).toBeNull();
  });
});
