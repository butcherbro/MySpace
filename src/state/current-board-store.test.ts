import { describe, expect, it } from "vitest";
import {
  initialState,
  reducer,
  type CurrentBoardAction,
  type CurrentBoardState,
  type SnapshotRequestChanges,
} from "./current-board-store";
import type {
  BoardPortalDto,
  BoardSummary,
  EmbedCardDto,
  ImageCardDto,
  FilesystemAliasDto,
  NoteCardDto,
} from "../services/workspace-gateway";

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

function foreignAlias(id: string): FilesystemAliasDto {
  return {
    kind: "filesystem_alias",
    id,
    boardId: "home",
    frame: { x: 10, y: 20, width: 300, height: 220 },
    zIndex: 3,
    revision: 4,
    targetKind: "folder",
    pathHint: "/Users/me/Research",
    displayName: "Research",
    originDeviceId: "studio-mac",
    originDeviceName: "Studio Mac",
    local: false,
  };
}

describe("current board reducer", () => {
  it("marks a shortcut local after it is pointed at a folder here (ADR-0012)", () => {
    const onCanvas = foreignAlias("f1");
    const inUnsorted = foreignAlias("f2");
    const state: CurrentBoardState = {
      ...initialState,
      cards: [onCanvas, note("n1")],
      unsortedCards: [inUnsorted],
    };
    // The backend answer carries a stale frame on purpose: only the
    // device-scoped fields may move.
    const answer = { ...onCanvas, local: true, frame: { x: 0, y: 0, width: 280, height: 180 } };
    const next = reducer(state, { type: "filesystemAliasUpdated", alias: answer });
    expect(next.cards[0]).toEqual({ ...onCanvas, local: true });
    expect(next.cards[1]).toBe(state.cards[1]);
    expect(next.unsortedCards[0]).toEqual(inUnsorted);

    const unsorted = reducer(next, {
      type: "filesystemAliasUpdated",
      alias: { ...inUnsorted, local: true },
    });
    expect(unsorted.unsortedCards[0]).toMatchObject({ id: "f2", local: true });
  });

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
    expect(state.editingCardId).toBeNull();
  });

  it("adds a card already being edited in one step, so it never renders idle first", () => {
    const editing = { ...initialState, cards: [note("a")], editingCardId: "a", selection: ["a"] };
    const state = reducer(editing, { type: "cardAdded", card: note("b"), startEditing: true });
    expect(state.cards.map((c) => c.id)).toEqual(["a", "b"]);
    expect(state.editingCardId).toBe("b");
    expect(state.selection).toEqual(["b"]);
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

  it("moves a card to Unsorted using the revision carried by the action", () => {
    let state = reducer(initialState, { type: "cardAdded", card: note("a") });
    state = reducer(state, { type: "cardMovedToUnsorted", id: "a", revision: 5 });
    expect(state.cards).toEqual([]);
    expect(state.unsortedCards).toHaveLength(1);
    expect(state.unsortedCards[0].revision).toBe(5);
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

  it("keeps the error banner when the same board is reloaded (a stale write reloads it)", () => {
    const reloaded = reducer(
      { ...initialState, board: home, error: "stale_revision: expected 1, actual 2" },
      {
        type: "snapshotLoaded",
        board: home,
        breadcrumbs: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportRevision: 1,
        cards: [],
        unsortedCards: [],
      },
    );
    expect(reloaded.error).toBe("stale_revision: expected 1, actual 2");
  });

  it("records errors and clears them", () => {
    let state: CurrentBoardState = reducer(initialState, { type: "failed", message: "boom" });
    expect(state.error).toBe("boom");
    state = reducer(state, { type: "clearError" });
    expect(state.error).toBeNull();
  });

  it("keeps an error raised during a board switch on the board it lands on, and only then", () => {
    const other: BoardSummary = { ...home, id: "other", title: "Other" };
    const open = (board: BoardSummary): CurrentBoardAction => ({
      type: "snapshotLoaded",
      board,
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportRevision: 1,
      cards: [],
      unsortedCards: [],
    });
    const copied = { type: "failed", message: "saved as a copy", outlivesBoardSwitch: true } as const;
    let state = reducer(initialState, open(home));

    state = reducer(state, { type: "boardSwitchStarted" });
    state = reducer(state, copied);
    state = reducer(state, open(other));
    expect(state.error).toBe("saved as a copy");
    state = reducer(state, { type: "boardSwitchStarted" });
    state = reducer(state, open(home));
    expect(state.error).toBeNull();

    // Raised with no switch pending: a later switch clears it.
    state = reducer(state, copied);
    state = reducer(state, { type: "boardSwitchStarted" });
    state = reducer(state, open(other));
    expect(state.error).toBeNull();

    // The switch was abandoned: the next one does not keep it.
    state = reducer(state, { type: "boardSwitchStarted" });
    state = reducer(state, copied);
    state = reducer(state, { type: "boardSwitchAbandoned" });
    expect(state.error).toBe("saved as a copy");
    state = reducer(state, { type: "boardSwitchStarted" });
    state = reducer(state, open(home));
    expect(state.error).toBeNull();

    // `loading` and `clearError` drop the flag with the error.
    state = reducer(state, { type: "boardSwitchStarted" });
    state = reducer(state, copied);
    state = reducer(state, { type: "clearError" });
    expect(state.errorOutlivesBoardSwitch).toBe(false);
    state = reducer(state, copied);
    state = reducer(state, { type: "loading" });
    expect(state.errorOutlivesBoardSwitch).toBe(false);
  });

  it("applies a stored card without ending its editing", () => {
    const held = note("n1");
    let state = reducer(initialState, { type: "cardAdded", card: held });
    state = reducer(state, { type: "editingStarted", id: "n1" });
    state = reducer(state, { type: "cardStored", id: "n1", card: { ...held, revision: 2, zIndex: 7 } });
    expect(state.editingCardId).toBe("n1");
    expect(state.cards[0]).toMatchObject({ revision: 2, zIndex: 7 });
    // An older answer does not roll the card back.
    state = reducer(state, { type: "cardStored", id: "n1", card: { ...held, revision: 1 } });
    expect(state.cards[0].revision).toBe(2);
  });
});

// Ответы двух записей одной карточки могут прийти в обратном порядке (запись из
// очереди и метаданные ссылки): более старый ответ не должен откатить ревизию,
// иначе следующая запись из очереди падает с stale_revision.
describe("out-of-order write responses", () => {
  const frame = { x: 99, y: 99, width: 200, height: 80 };
  const doc = { type: "doc", content: [] };

  function held<T extends { revision: number }>(card: T, revision: number): T {
    return { ...card, revision };
  }

  it("ignores an older cardMoved receipt", () => {
    const state = { ...initialState, cards: [held(note("a"), 6)] };
    const next = reducer(state, { type: "cardMoved", id: "a", revision: 5, frame });
    expect(next.cards[0]).toEqual(state.cards[0]);
  });

  it("ignores an older cardReplaced DTO and keeps editing", () => {
    const newer = held(embed("e"), 7);
    const state = { ...initialState, cards: [newer], editingCardId: "e" };
    const next = reducer(state, {
      type: "cardReplaced",
      id: "e",
      card: { ...held(embed("e"), 6), title: "Older" },
    });
    expect(next.cards[0]).toEqual(newer);
    expect(next.editingCardId).toBe("e");
  });

  it("ignores older text receipts for notes, captions and link descriptions", () => {
    const image = {
      kind: "image",
      id: "i",
      boardId: "home",
      frame: { x: 0, y: 0, width: 200, height: 200 },
      zIndex: 0,
      revision: 6,
      captionJson: doc,
      captionPlainText: "",
    } as unknown as ImageCardDto;
    const state = { ...initialState, cards: [held(note("n"), 6), image, held(embed("e"), 6)] };
    let next = reducer(state, { type: "cardContentUpdated", id: "n", revision: 5, documentJson: doc, plainText: "old" });
    next = reducer(next, { type: "imageCaptionUpdated", id: "i", revision: 5, captionJson: doc, captionPlainText: "old" });
    next = reducer(next, {
      type: "embedDescriptionUpdated",
      id: "e",
      revision: 5,
      descriptionJson: doc,
      descriptionPlainText: "old",
    });
    expect(next.cards).toEqual(state.cards);
  });

  it("still applies a receipt at the same or a newer revision", () => {
    const state = { ...initialState, cards: [held(note("a"), 6)] };
    const same = reducer(state, { type: "cardMoved", id: "a", revision: 6, frame });
    expect(same.cards[0]).toMatchObject({ revision: 6, frame });
    const newer = reducer(state, { type: "cardMoved", id: "a", revision: 7, frame });
    expect(newer.cards[0]).toMatchObject({ revision: 7, frame });
  });

  it("keeps the newer revision when a card moves between the canvas and Unsorted", () => {
    const toUnsorted = reducer(
      { ...initialState, cards: [held(note("a"), 6)] },
      { type: "cardMovedToUnsorted", id: "a", revision: 5 },
    );
    expect(toUnsorted.unsortedCards[0].revision).toBe(6);

    const placed = reducer(
      { ...initialState, unsortedCards: [held(note("b"), 6)] },
      { type: "unsortedCardPlaced", id: "b", revision: 5, frame },
    );
    expect(placed.cards[0]).toMatchObject({ revision: 6, frame });
  });

  it("applies a newer portalMoved receipt", () => {
    const portal = {
      kind: "board_portal",
      id: "p",
      boardId: "home",
      frame: { x: 0, y: 0, width: 120, height: 112 },
      zIndex: 0,
      revision: 6,
      target: { id: "child", boardRevision: 3 },
    } as unknown as BoardPortalDto;
    const next = reducer(
      { ...initialState, cards: [portal] },
      { type: "portalMoved", id: "p", revision: 7, boardRevision: 4, frame },
    );
    expect(next.cards[0]).toMatchObject({ revision: 7, frame, target: { id: "child", boardRevision: 4 } });
  });

  it("ignores an older portalMoved receipt", () => {
    const portal = {
      kind: "board_portal",
      id: "p",
      boardId: "home",
      frame: { x: 0, y: 0, width: 120, height: 112 },
      zIndex: 0,
      revision: 6,
      target: { id: "child", boardRevision: 3 },
    } as unknown as BoardPortalDto;
    const next = reducer(
      { ...initialState, cards: [portal] },
      { type: "portalMoved", id: "p", revision: 5, boardRevision: 2, frame },
    );
    expect(next.cards[0]).toEqual(portal);
  });
});

describe("same-board snapshot vs. local changes", () => {
  function reload(
    state: CurrentBoardState,
    cards: NoteCardDto[],
    sinceRequest: Partial<SnapshotRequestChanges> = {},
  ) {
    return reducer(state, {
      type: "snapshotLoaded",
      board: home,
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportRevision: 1,
      cards,
      unsortedCards: [],
      sinceRequest: { written: [], added: [], removed: [], ...sinceRequest },
    });
  }

  const open: CurrentBoardState = { ...initialState, board: home };

  it("keeps the held card when it was written since the request and is newer than the snapshot", () => {
    const newer = { ...note("a", 50), revision: 6 };
    const next = reload({ ...open, cards: [newer, note("b")] }, [{ ...note("a"), revision: 5 }, note("b")], {
      written: ["a"],
    });
    expect(next.cards).toEqual([newer, note("b")]);
  });

  it("takes the snapshot when the held card was written since the request but the snapshot is newer", () => {
    // Другой процесс записал карточку ещё раз после нашего ответа, до чтения снимка.
    const external = { ...note("a", 90), revision: 7 };
    const next = reload({ ...open, cards: [{ ...note("a"), revision: 6 }] }, [external], { written: ["a"] });
    expect(next.cards).toEqual([external]);
  });

  it("takes the snapshot at an equal revision", () => {
    const fresh = { ...note("a", 90), revision: 6 };
    const next = reload({ ...open, cards: [{ ...note("a"), revision: 6 }] }, [fresh], { written: ["a"] });
    expect(next.cards).toEqual([fresh]);
  });

  it("applies a lower snapshot revision as is when nothing was written since the request", () => {
    const synced = { ...note("a"), revision: 2 };
    const next = reload({ ...open, cards: [{ ...note("a"), revision: 6 }] }, [synced]);
    expect(next.cards).toEqual([synced]);
  });

  it("removes a card the snapshot no longer has, even right after a local write", () => {
    const next = reload({ ...open, cards: [{ ...note("a"), revision: 6 }, note("b")] }, [note("b")], {
      written: ["a"],
    });
    expect(next.cards.map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps a card added since the request that the snapshot does not have yet", () => {
    const created = note("new");
    const next = reload({ ...open, cards: [note("b"), created] }, [note("b")], {
      written: ["new"],
      added: ["new"],
    });
    expect(next.cards).toEqual([note("b"), created]);
  });

  it("keeps a card removed since the request removed, even though the snapshot still has it", () => {
    const next = reload({ ...open, cards: [note("b")], selection: ["b"] }, [note("gone"), note("b")], {
      removed: ["gone"],
    });
    expect(next.cards.map((c) => c.id)).toEqual(["b"]);
    expect(next.selection).toEqual(["b"]);
  });

  it("keeps the held copy in Unsorted when it moved there after the request", () => {
    const moved = { ...note("a"), revision: 6 };
    const next = reload({ ...open, cards: [], unsortedCards: [moved] }, [{ ...note("a"), revision: 5 }], {
      written: ["a"],
    });
    expect(next.cards).toEqual([]);
    expect(next.unsortedCards).toEqual([moved]);
  });
});

describe("boardCoverChanged", () => {
  const cover = {
    id: "asset-1",
    fileName: "cover.png",
    mimeType: "image/png",
    width: 10,
    height: 10,
    sizeBytes: 1,
    filePath: "/a/cover.png",
  };

  it("changes only the cover of the portal and keeps its newer revision, frame and title", () => {
    const portal = {
      kind: "board_portal",
      id: "p",
      boardId: "home",
      frame: { x: 70, y: 80, width: 120, height: 112 },
      zIndex: 0,
      revision: 8,
      target: { id: "child", boardRevision: 3, title: "Renamed", coverAsset: null },
    } as unknown as BoardPortalDto;
    const next = reducer(
      { ...initialState, cards: [portal, note("n")] },
      { type: "boardCoverChanged", boardId: "child", coverAsset: cover },
    );
    expect(next.cards[0]).toEqual({ ...portal, target: { ...portal.target, coverAsset: cover } });
    expect(next.cards[1]).toEqual(note("n"));
  });
});
