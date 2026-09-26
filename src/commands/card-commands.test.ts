import { describe, expect, it, vi } from "vitest";
import { CreateImageCardCommand, CreateNoteCommand, MoveCardsCommand, MoveCardToBoardCommand } from "./card-commands";
import type { MoveCardToBoardInput, MoveCardsInput, WorkspaceGateway } from "../services/workspace-gateway";

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

  it("undo moves back to the source board and frame with bumped revision", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new MoveCardToBoardCommand(
      "cmd-1",
      "note-1",
      "home",
      sourceFrame,
      3,
      "board-b",
      targetFrame,
    );

    await cmd.execute(gateway);
    await cmd.undo(gateway);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      id: "note-1",
      expectedRevision: 4, // 3 + 1 from execute
      targetBoardId: "home",
      frame: sourceFrame,
    });

    await cmd.execute(gateway);
    expect(calls[2]).toEqual({
      id: "note-1",
      expectedRevision: 5,
      targetBoardId: "board-b",
      frame: targetFrame,
    });
  });
});

describe("MoveCardsCommand", () => {
  it("uses the current revision through repeated undo and redo", async () => {
    const calls: MoveCardsInput[] = [];
    const gateway = {
      moveCards: vi.fn(async (input: MoveCardsInput) => {
        calls.push(input);
        return {
          cards: input.cards.map((c) => ({ id: c.id, revision: c.expectedRevision + 1 })),
        };
      }),
    } as unknown as WorkspaceGateway;
    const cmd = new MoveCardsCommand("move", [
      { id: "note-1", revision: 7, before: sourceFrame, after: targetFrame },
    ]);

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    await cmd.execute(gateway);

    expect(calls.map((call) => call.cards[0].expectedRevision)).toEqual([7, 8, 9]);
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
