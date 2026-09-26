import { describe, expect, it, vi } from "vitest";
import {
  CreateFileCardCommand,
  CreateFolderShortcutCommand,
  CreateImageCardCommand,
  CreateNoteCommand,
  EditCardTextCommand,
  MoveCardsCommand,
  MoveCardToBoardCommand,
  ResizeCardCommand,
  sameDocument,
} from "./card-commands";
import { CommandConflictError } from "./workspace-command";
import type {
  CardDto,
  Frame,
  MoveCardInput,
  MoveCardToBoardInput,
  MoveCardsInput,
  UpdateEmbedDescriptionInput,
  UpdateImageCaptionInput,
  UpdateNoteInput,
  WorkspaceGateway,
} from "../services/workspace-gateway";

function gatewaySpy() {
  const calls: MoveCardToBoardInput[] = [];
  const gateway = {
    moveCardToBoard: vi.fn(async (input: MoveCardToBoardInput) => {
      calls.push(input);
      return { id: input.id, revision: input.expectedRevision + 1 };
    }),
  } as unknown as WorkspaceGateway;
  return { gateway, calls };
}

const sourceFrame = { x: 10, y: 20, width: 200, height: 80 };
const targetFrame = { x: 320, y: 240, width: 200, height: 80 };

interface StoredCard {
  boardId: string;
  frame: Frame;
  revision: number;
}

/** In-memory card store with backend-like revision checks. */
function storeGateway(initial: Record<string, StoredCard>) {
  const cards = new Map(Object.entries(initial).map(([id, c]) => [id, { ...c }]));
  const check = (id: string, expectedRevision: number) => {
    const card = cards.get(id)!;
    if (card.revision !== expectedRevision) {
      throw { code: "stale_revision", message: { expected: expectedRevision, actual: card.revision } };
    }
    return card;
  };
  const gateway = {
    readCard: vi.fn(async (id: string) => {
      const card = cards.get(id)!;
      return { kind: "note", id, ...card, frame: { ...card.frame } } as unknown as CardDto;
    }),
    moveCards: vi.fn(async (input: MoveCardsInput) => {
      for (const c of input.cards) check(c.id, c.expectedRevision);
      return {
        cards: input.cards.map((c) => {
          const card = cards.get(c.id)!;
          card.frame = c.frame;
          card.revision += 1;
          return { id: c.id, revision: card.revision };
        }),
      };
    }),
    moveCardToBoard: vi.fn(async (input: MoveCardToBoardInput) => {
      const card = check(input.id, input.expectedRevision);
      card.boardId = input.targetBoardId;
      card.frame = input.frame!;
      card.revision += 1;
      return { id: input.id, revision: card.revision };
    }),
  } as unknown as WorkspaceGateway;
  /** Simulates an edit outside the command (text edit, resize, LAN sync). */
  const touch = (id: string, patch: Partial<StoredCard> = {}) => {
    const card = cards.get(id)!;
    Object.assign(card, patch);
    card.revision += 1;
  };
  return { gateway, cards, touch };
}

describe("MoveCardToBoardCommand", () => {
  it("executes a move to the target board at the exact frame", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new MoveCardToBoardCommand(
      "cmd-1",
      "note-1",
      "home",
      sourceFrame,
      1,
      "board-b",
      targetFrame,
    );

    await cmd.execute(gateway);

    expect(calls).toEqual([
      {
        id: "note-1",
        expectedRevision: 1,
        targetBoardId: "board-b",
        frame: targetFrame,
      },
    ]);
  });

  it("undo after an intervening text edit uses the fresh revision and keeps a later resize", async () => {
    const { gateway, cards, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 3 },
    });
    const cmd = new MoveCardToBoardCommand("cmd-1", "note-1", "home", sourceFrame, 3, "board-b", targetFrame);

    await cmd.execute(gateway);
    touch("note-1"); // правка текста
    touch("note-1", { frame: { ...targetFrame, width: 500, height: 300 } }); // resize
    await cmd.undo(gateway);

    expect(cards.get("note-1")).toEqual({
      boardId: "home",
      frame: { x: sourceFrame.x, y: sourceFrame.y, width: 500, height: 300 },
      revision: 7,
    });
  });

  it("redo after undo and an intervening revision bump uses the fresh revision", async () => {
    const { gateway, cards, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 3 },
    });
    const cmd = new MoveCardToBoardCommand("cmd-1", "note-1", "home", sourceFrame, 3, "board-b", targetFrame);

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    touch("note-1");
    await cmd.execute(gateway);

    expect(cards.get("note-1")).toEqual({ boardId: "board-b", frame: targetFrame, revision: 7 });
  });

  it("undo refuses when the card was moved since", async () => {
    const { gateway, cards, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 3 },
    });
    const cmd = new MoveCardToBoardCommand("cmd-1", "note-1", "home", sourceFrame, 3, "board-b", targetFrame);

    await cmd.execute(gateway);
    touch("note-1", { frame: { ...targetFrame, x: 999 } });
    const before = { ...cards.get("note-1")! };

    await expect(cmd.undo(gateway)).rejects.toBeInstanceOf(CommandConflictError);
    expect(gateway.moveCardToBoard).toHaveBeenCalledTimes(1);
    expect(cards.get("note-1")).toEqual(before);
  });

  it("undo refuses when the card is on another board now", async () => {
    const { gateway, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 3 },
    });
    const cmd = new MoveCardToBoardCommand("cmd-1", "note-1", "home", sourceFrame, 3, "board-b", targetFrame);

    await cmd.execute(gateway);
    touch("note-1", { boardId: "board-c" });

    await expect(cmd.undo(gateway)).rejects.toThrow('Can\'t undo "Move to board": the card has changed since.');
    expect(gateway.moveCardToBoard).toHaveBeenCalledTimes(1);
  });

  it("redo refuses when the card was moved since the undo", async () => {
    const { gateway, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 3 },
    });
    const cmd = new MoveCardToBoardCommand("cmd-1", "note-1", "home", sourceFrame, 3, "board-b", targetFrame);

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    touch("note-1", { frame: { ...sourceFrame, y: 999 } });

    await expect(cmd.execute(gateway)).rejects.toThrow('Can\'t redo "Move to board": the card has changed since.');
    expect(gateway.moveCardToBoard).toHaveBeenCalledTimes(2);
  });
});

describe("MoveCardsCommand", () => {
  it("uses the caller's revision on first execute", async () => {
    const { gateway } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 7 },
    });
    const cmd = new MoveCardsCommand("move", [
      { id: "note-1", revision: 6, before: sourceFrame, after: targetFrame },
    ]);

    await expect(cmd.execute(gateway)).rejects.toMatchObject({ code: "stale_revision" });
    expect(gateway.readCard).not.toHaveBeenCalled();
  });

  it("undo after intervening text edits succeeds with the fresh revision", async () => {
    const { gateway, cards, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 5 },
      "note-2": { boardId: "home", frame: sourceFrame, revision: 1 },
    });
    const cmd = new MoveCardsCommand("move", [
      { id: "note-1", revision: 5, before: sourceFrame, after: targetFrame },
      { id: "note-2", revision: 1, before: sourceFrame, after: targetFrame },
    ]);

    await cmd.execute(gateway); // note-1 -> 6
    touch("note-1");
    touch("note-1");
    touch("note-1"); // 9
    await cmd.undo(gateway);

    expect(gateway.moveCards).toHaveBeenLastCalledWith({
      cards: [
        { id: "note-1", expectedRevision: 9, frame: sourceFrame },
        { id: "note-2", expectedRevision: 2, frame: sourceFrame },
      ],
    });
    expect(cards.get("note-1")!.frame).toEqual(sourceFrame);
  });

  // Координаты после перетаскивания дробные; serde_json без float_roundtrip
  // может вернуть их с расхождением в последнем бите — это не «сдвинули».
  it("undo treats a last-bit difference in stored coordinates as the same position", async () => {
    const after = { ...targetFrame, x: 267.339488153343, y: 1079.7334438078 };
    const { gateway, cards, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 1 },
    });
    const cmd = new MoveCardsCommand("move", [{ id: "note-1", revision: 1, before: sourceFrame, after }]);

    await cmd.execute(gateway);
    touch("note-1", { frame: { ...after, x: after.x * (1 + Number.EPSILON), y: after.y * (1 - Number.EPSILON) } });
    await cmd.undo(gateway);

    expect(cards.get("note-1")!.frame.x).toBe(sourceFrame.x);
  });

  it("undo keeps a resize made after the move", async () => {
    const { gateway, cards, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 1 },
    });
    const cmd = new MoveCardsCommand("move", [
      { id: "note-1", revision: 1, before: sourceFrame, after: targetFrame },
    ]);

    await cmd.execute(gateway);
    touch("note-1", { frame: { ...targetFrame, width: 640, height: 480 } });
    await cmd.undo(gateway);

    expect(cards.get("note-1")!.frame).toEqual({ x: sourceFrame.x, y: sourceFrame.y, width: 640, height: 480 });
  });

  it("undo refuses without writing when any card was moved since", async () => {
    const { gateway, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 1 },
      "note-2": { boardId: "home", frame: sourceFrame, revision: 1 },
    });
    const cmd = new MoveCardsCommand("move", [
      { id: "note-1", revision: 1, before: sourceFrame, after: targetFrame },
      { id: "note-2", revision: 1, before: sourceFrame, after: targetFrame },
    ]);

    await cmd.execute(gateway);
    touch("note-2", { frame: { ...targetFrame, x: 1000 } });

    await expect(cmd.undo(gateway)).rejects.toThrow('Can\'t undo "Move": the card has changed since.');
    expect(gateway.moveCards).toHaveBeenCalledTimes(1);
  });

  it("redo after undo and an intervening revision bump uses the fresh revision", async () => {
    const { gateway, cards, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 7 },
    });
    const cmd = new MoveCardsCommand("move", [
      { id: "note-1", revision: 7, before: sourceFrame, after: targetFrame },
    ]);

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    touch("note-1", { frame: { ...sourceFrame, width: 50 } });
    await cmd.execute(gateway);

    expect(gateway.moveCards).toHaveBeenLastCalledWith({
      cards: [{ id: "note-1", expectedRevision: 10, frame: { ...targetFrame, width: 50 } }],
    });
    expect(cards.get("note-1")!.revision).toBe(11);
  });

  it("redo refuses when the card was moved since the undo", async () => {
    const { gateway, touch } = storeGateway({
      "note-1": { boardId: "home", frame: sourceFrame, revision: 1 },
    });
    const cmd = new MoveCardsCommand("move", [
      { id: "note-1", revision: 1, before: sourceFrame, after: targetFrame },
    ]);

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    touch("note-1", { frame: { ...sourceFrame, x: -5 } });

    await expect(cmd.execute(gateway)).rejects.toThrow('Can\'t redo "Move": the card has changed since.');
    expect(gateway.moveCards).toHaveBeenCalledTimes(2);
  });
});

describe("CreateNoteCommand", () => {
  it("redoes a soft-deleted note by restoring its trash batch", async () => {
    const gateway = {
      createNote: vi.fn(async () => ({ id: "note-1", revision: 1 })),
      trashNote: vi.fn(async () => "batch-note"),
      restoreTrashBatch: vi.fn(async () => {}),
    } as unknown as WorkspaceGateway;
    const cmd = new CreateNoteCommand("create", {
      id: "note-1",
      boardId: "home",
      frame: sourceFrame,
      zIndex: 0,
      documentJson: { type: "doc" },
    });

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    await cmd.execute(gateway);

    expect(gateway.createNote).toHaveBeenCalledTimes(1);
    expect(gateway.restoreTrashBatch).toHaveBeenCalledWith("batch-note");
  });
});

describe("CreateImageCardCommand", () => {
  it("undo trashes the image card as its own batch, keyed by kind 'image'", async () => {
    const gateway = {
      createImageCard: vi.fn(async () => {}),
      trashSelection: vi.fn(async () => "batch-image"),
      restoreTrashBatch: vi.fn(async () => {}),
    } as unknown as WorkspaceGateway;
    const cmd = new CreateImageCardCommand("create", {
      id: "image-1",
      boardId: "home",
      frame: sourceFrame,
      zIndex: 0,
      assetId: "asset-1",
      captionJson: { type: "doc" },
    });

    await cmd.execute(gateway);
    await cmd.undo(gateway);

    expect(gateway.trashSelection).toHaveBeenCalledWith({
      items: [{ id: "image-1", kind: "image" }],
    });
  });

  it("redoes by restoring the trash batch instead of recreating", async () => {
    const gateway = {
      createImageCard: vi.fn(async () => {}),
      trashSelection: vi.fn(async () => "batch-image"),
      restoreTrashBatch: vi.fn(async () => {}),
    } as unknown as WorkspaceGateway;
    const cmd = new CreateImageCardCommand("create", {
      id: "image-1",
      boardId: "home",
      frame: sourceFrame,
      zIndex: 0,
      assetId: "asset-1",
      captionJson: { type: "doc" },
    });

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    await cmd.execute(gateway);

    expect(gateway.createImageCard).toHaveBeenCalledTimes(1);
    expect(gateway.restoreTrashBatch).toHaveBeenCalledWith("batch-image");
  });
});

function textDoc(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

interface StoredTextCard {
  kind: "note" | "image" | "embed";
  frame: Frame;
  revision: number;
  text: unknown;
  corrupt?: boolean;
}

/** In-memory text cards with backend-like revision and corrupt checks. */
function textStoreGateway(initial: Record<string, StoredTextCard>) {
  const cards = new Map(Object.entries(initial).map(([id, c]) => [id, { ...c }]));
  const write = (id: string, expectedRevision: number, patch: Partial<StoredTextCard>, acknowledge?: boolean) => {
    const card = cards.get(id)!;
    if (card.revision !== expectedRevision) {
      throw { code: "stale_revision", message: { expected: expectedRevision, actual: card.revision } };
    }
    if (card.corrupt && !acknowledge) throw new Error("document is corrupt");
    Object.assign(card, patch);
    card.revision += 1;
    return { id, revision: card.revision, plainText: "" };
  };
  const gateway = {
    readCard: vi.fn(async (id: string) => {
      const c = cards.get(id)!;
      const base = { id, boardId: "home", frame: { ...c.frame }, revision: c.revision, corrupt: c.corrupt };
      if (c.kind === "note") return { ...base, kind: "note", documentJson: c.text } as unknown as CardDto;
      if (c.kind === "image") return { ...base, kind: "image", captionJson: c.text } as unknown as CardDto;
      return { ...base, kind: "embed", descriptionJson: c.text } as unknown as CardDto;
    }),
    updateNote: vi.fn(async (i: UpdateNoteInput) =>
      write(i.id, i.expectedRevision, { text: i.documentJson }, i.acknowledgeCorrupt)),
    updateImageCaption: vi.fn(async (i: UpdateImageCaptionInput) =>
      write(i.id, i.expectedRevision, { text: i.captionJson }, i.acknowledgeCorrupt)),
    updateEmbedDescription: vi.fn(async (i: UpdateEmbedDescriptionInput) =>
      write(i.id, i.expectedRevision, { text: i.descriptionJson }, i.acknowledgeCorrupt)),
    moveCard: vi.fn(async (i: MoveCardInput) => {
      const r = write(i.id, i.expectedRevision, { frame: { ...i.frame } });
      return { id: r.id, revision: r.revision };
    }),
  } as unknown as WorkspaceGateway;
  const touch = (id: string, patch: Partial<StoredTextCard> = {}) => {
    const card = cards.get(id)!;
    Object.assign(card, patch);
    card.revision += 1;
  };
  return { gateway, cards, touch };
}

describe("sameDocument", () => {
  it("ignores object key order (serde_json returns keys sorted)", () => {
    expect(sameDocument({ type: "doc", content: [{ type: "p", attrs: { a: 1, b: 2 } }] },
      { content: [{ attrs: { b: 2, a: 1 }, type: "p" }], type: "doc" })).toBe(true);
  });

  it("distinguishes different content, array order and missing keys", () => {
    expect(sameDocument(textDoc("a"), textDoc("b"))).toBe(false);
    expect(sameDocument({ content: [1, 2] }, { content: [2, 1] })).toBe(false);
    expect(sameDocument({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameDocument(null, {})).toBe(false);
  });
});

describe("EditCardTextCommand", () => {
  const frame = { x: 10, y: 20, width: 240, height: 120 };

  it.each([
    ["note", "updateNote", "Edit note"],
    ["image", "updateImageCaption", "Edit caption"],
    ["embed", "updateEmbedDescription", "Edit description"],
  ] as const)("undo/redo of a %s text edit uses the fresh revision", async (kind, method, label) => {
    const { gateway, cards, touch } = textStoreGateway({ c: { kind, frame, revision: 5, text: textDoc("after") } });
    const cmd = new EditCardTextCommand("cmd", kind, "c", textDoc("before"), textDoc("after"));
    expect(cmd.label).toBe(label);

    touch("c"); // посторонняя правка (например, перемещение) подняла ревизию
    await cmd.undo(gateway);
    expect(cards.get("c")).toMatchObject({ text: textDoc("before"), revision: 7 });
    expect(gateway[method]).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c", expectedRevision: 6 }));

    await cmd.execute(gateway);
    expect(cards.get("c")).toMatchObject({ text: textDoc("after"), revision: 8 });
    expect(gateway[method]).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c", expectedRevision: 7 }));
  });

  it("does not touch the card's frame", async () => {
    const { gateway, cards, touch } = textStoreGateway({ c: { kind: "note", frame, revision: 1, text: textDoc("after") } });
    const cmd = new EditCardTextCommand("cmd", "note", "c", textDoc("before"), textDoc("after"));
    const moved = { x: 500, y: 600, width: 300, height: 400 };
    touch("c", { frame: moved });

    await cmd.undo(gateway);

    expect(cards.get("c")!.frame).toEqual(moved);
    expect(gateway.moveCard).not.toHaveBeenCalled();
  });

  it("compares the stored document structurally (key order from the backend differs)", async () => {
    const stored = { content: [{ content: [{ text: "after", type: "text" }], type: "paragraph" }], type: "doc" };
    const { gateway, cards } = textStoreGateway({ c: { kind: "note", frame, revision: 1, text: stored } });
    const cmd = new EditCardTextCommand("cmd", "note", "c", textDoc("before"), textDoc("after"));

    await cmd.undo(gateway);

    expect(cards.get("c")!.text).toEqual(textDoc("before"));
  });

  it("undo refuses with CommandConflictError when the text changed since", async () => {
    const { gateway, cards } = textStoreGateway({ c: { kind: "note", frame, revision: 1, text: textDoc("later") } });
    const cmd = new EditCardTextCommand("cmd", "note", "c", textDoc("before"), textDoc("after"));

    await expect(cmd.undo(gateway)).rejects.toBeInstanceOf(CommandConflictError);
    expect(cards.get("c")).toMatchObject({ text: textDoc("later"), revision: 1 });
    expect(gateway.updateNote).not.toHaveBeenCalled();
  });

  it("redo refuses with CommandConflictError when the text changed after undo", async () => {
    const { gateway, touch } = textStoreGateway({ c: { kind: "image", frame, revision: 1, text: textDoc("after") } });
    const cmd = new EditCardTextCommand("cmd", "image", "c", textDoc("before"), textDoc("after"));
    await cmd.undo(gateway);
    touch("c", { text: textDoc("typed again") });

    await expect(cmd.execute(gateway)).rejects.toBeInstanceOf(CommandConflictError);
  });

  it("refuses to write over a corrupt document", async () => {
    const { gateway } = textStoreGateway({
      c: { kind: "note", frame, revision: 1, text: textDoc("after"), corrupt: true },
    });
    const cmd = new EditCardTextCommand("cmd", "note", "c", textDoc("before"), textDoc("after"));

    await expect(cmd.undo(gateway)).rejects.toBeInstanceOf(CommandConflictError);
    expect(gateway.updateNote).not.toHaveBeenCalled();
  });

  it("refuses when the card is no longer of this kind (note converted to a link)", async () => {
    const { gateway } = textStoreGateway({ c: { kind: "embed", frame, revision: 1, text: textDoc("after") } });
    const cmd = new EditCardTextCommand("cmd", "note", "c", textDoc("before"), textDoc("after"));

    await expect(cmd.undo(gateway)).rejects.toBeInstanceOf(CommandConflictError);
  });
});

describe("ResizeCardCommand", () => {
  const before = { x: 10, y: 20, width: 240, height: 120 };
  const after = { x: 10, y: 20, width: 400, height: 300 };

  it("undo restores the previous frame with the fresh revision, redo re-applies it", async () => {
    const { gateway, cards, touch } = textStoreGateway({ c: { kind: "note", frame: after, revision: 3, text: textDoc("x") } });
    const cmd = new ResizeCardCommand("cmd", "c", before, after);
    expect(cmd.label).toBe("Resize");

    touch("c", { text: textDoc("edited") }); // правка текста поднимает ревизию
    await cmd.undo(gateway);
    expect(gateway.moveCard).toHaveBeenLastCalledWith({ id: "c", expectedRevision: 4, frame: before });
    expect(cards.get("c")).toMatchObject({ frame: before, text: textDoc("edited") });

    await cmd.execute(gateway);
    expect(gateway.moveCard).toHaveBeenLastCalledWith({ id: "c", expectedRevision: 5, frame: after });
    expect(cards.get("c")!.frame).toEqual(after);
  });

  it("restores x/y too (left-edge resize)", async () => {
    const shifted = { x: -30, y: 20, width: 280, height: 120 };
    const { gateway, cards } = textStoreGateway({ c: { kind: "image", frame: shifted, revision: 1, text: textDoc("") } });
    const cmd = new ResizeCardCommand("cmd", "c", before, shifted);

    await cmd.undo(gateway);

    expect(cards.get("c")!.frame).toEqual(before);
  });

  it("does not touch text", async () => {
    const { gateway } = textStoreGateway({ c: { kind: "note", frame: after, revision: 1, text: textDoc("x") } });
    const cmd = new ResizeCardCommand("cmd", "c", before, after);

    await cmd.undo(gateway);
    await cmd.execute(gateway);

    expect(gateway.updateNote).not.toHaveBeenCalled();
  });

  it("tolerates sub-0.01 px float drift", async () => {
    const drifted = { x: 10.000001, y: 19.999999, width: 400.000001, height: 299.999999 };
    const { gateway, cards } = textStoreGateway({ c: { kind: "note", frame: drifted, revision: 1, text: textDoc("x") } });
    const cmd = new ResizeCardCommand("cmd", "c", before, after);

    await cmd.undo(gateway);

    expect(cards.get("c")!.frame).toEqual(before);
  });

  it.each([
    ["size", { ...after, height: 500 }],
    ["position", { ...after, x: 90 }],
  ])("undo refuses with CommandConflictError when the %s changed since", async (_field, current) => {
    const { gateway } = textStoreGateway({ c: { kind: "note", frame: current, revision: 1, text: textDoc("x") } });
    const cmd = new ResizeCardCommand("cmd", "c", before, after);

    await expect(cmd.undo(gateway)).rejects.toBeInstanceOf(CommandConflictError);
    expect(gateway.moveCard).not.toHaveBeenCalled();
  });

  it("redo refuses with CommandConflictError when the frame changed after undo", async () => {
    const { gateway, touch } = textStoreGateway({ c: { kind: "note", frame: after, revision: 1, text: textDoc("x") } });
    const cmd = new ResizeCardCommand("cmd", "c", before, after);
    await cmd.undo(gateway);
    touch("c", { frame: { ...before, height: 999 } });

    await expect(cmd.execute(gateway)).rejects.toBeInstanceOf(CommandConflictError);
  });
});

describe.each([
  {
    name: "CreateFolderShortcutCommand",
    make: () =>
      new CreateFolderShortcutCommand("create", {
        id: "alias-1",
        boardId: "home",
        frame: sourceFrame,
        zIndex: 0,
        sourcePath: "/Users/x/Folder",
      }),
    method: "createFolderAlias",
    kind: "filesystem_alias",
  },
  {
    name: "CreateFileCardCommand",
    make: () =>
      new CreateFileCardCommand("create", {
        id: "alias-1",
        boardId: "home",
        frame: sourceFrame,
        zIndex: 0,
        sourcePath: "/tmp/x.txt",
        mimeType: "text/plain",
        fileName: "x.txt",
      }),
    method: "createFileCard",
    kind: "file",
  },
] as const)("$name", ({ make, method, kind }) => {
  function gateway() {
    return {
      [method]: vi.fn(async () => ({ id: "alias-1", kind })),
      trashSelection: vi.fn(async () => "batch-1"),
      restoreTrashBatch: vi.fn(async () => {}),
    } as unknown as WorkspaceGateway;
  }

  it("creates the card and returns its DTO", async () => {
    const g = gateway();

    await expect(make().execute(g)).resolves.toEqual({ id: "alias-1", kind });
    expect(g[method]).toHaveBeenCalledWith(expect.objectContaining({ id: "alias-1", boardId: "home" }));
  });

  it("undo trashes the card, redo restores the trash batch instead of recreating", async () => {
    const g = gateway();
    const cmd = make();

    await cmd.execute(g);
    await cmd.undo(g);
    expect(g.trashSelection).toHaveBeenCalledWith({ items: [{ id: "alias-1", kind }] });
    await expect(cmd.execute(g)).resolves.toBeNull();

    expect(g[method]).toHaveBeenCalledTimes(1);
    expect(g.restoreTrashBatch).toHaveBeenCalledWith("batch-1");
  });
});
