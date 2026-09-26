import { describe, expect, it, vi } from "vitest";
import { CreateImageCardCommand, CreateNoteCommand, MoveCardsCommand, MoveCardToBoardCommand } from "./card-commands";
import { CommandConflictError } from "./workspace-command";
import type {
  CardDto,
  Frame,
  MoveCardToBoardInput,
  MoveCardsInput,
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
