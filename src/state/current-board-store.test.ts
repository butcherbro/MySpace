import { describe, expect, it } from "vitest";
import { initialState, reducer, type CurrentBoardState } from "./current-board-store";
import type { BoardSummary, EmbedCardDto, NoteCardDto } from "../services/workspace-gateway";

const home: BoardSummary = { id: "home", title: "Home", parentBoardId: null, revision: 1 };

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
      },
    );
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
