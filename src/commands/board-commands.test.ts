import { describe, expect, it, vi } from "vitest";
import {
  CreateChildBoardCommand,
  DuplicateBoardCommand,
  MoveBoardCommand,
  MoveSelectionCommand,
} from "./board-commands";
import type { MoveBoardInput, WorkspaceGateway } from "../services/workspace-gateway";

function gatewaySpy() {
  const calls: MoveBoardInput[] = [];
  const gateway = {
    moveBoard: vi.fn(async (input: MoveBoardInput) => {
      calls.push(input);
    }),
  } as unknown as WorkspaceGateway;
  return { gateway, calls };
}

const prevFrame = { x: 10, y: 20, width: 120, height: 112 };
const nextFrame = { x: 40, y: 40, width: 120, height: 112 };

describe("MoveBoardCommand", () => {
  it("executes a move to the new parent and frame", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new MoveBoardCommand(
      "cmd-1",
      "board-a",
      "home",
      prevFrame,
      "board-b",
      nextFrame,
      1,
      1,
    );

    await cmd.execute(gateway);

    expect(calls).toEqual([
      {
        boardId: "board-a",
        expectedBoardRevision: 1,
        expectedPortalRevision: 1,
        targetParentBoardId: "board-b",
        frame: nextFrame,
      },
    ]);
  });

  it("undo reparents back with bumped revisions", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new MoveBoardCommand(
      "cmd-1",
      "board-a",
      "home",
      prevFrame,
      "board-b",
      nextFrame,
      3,
      5,
    );

    await cmd.execute(gateway);
    await cmd.undo(gateway);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      boardId: "board-a",
      expectedBoardRevision: 4, // 3 + 1 from execute
      expectedPortalRevision: 6, // 5 + 1 from execute
      targetParentBoardId: "home",
      frame: prevFrame,
    });

    await cmd.execute(gateway);
    expect(calls[2]).toEqual({
      boardId: "board-a",
      expectedBoardRevision: 5,
      expectedPortalRevision: 7,
      targetParentBoardId: "board-b",
      frame: nextFrame,
    });
  });
});

describe("CreateChildBoardCommand", () => {
  it("redoes a soft-deleted board by restoring its trash batch", async () => {
    const gateway = {
      createChildBoard: vi.fn(async () => {}),
      trashBoard: vi.fn(async () => "batch-board"),
      restoreTrashBatch: vi.fn(async () => {}),
    } as unknown as WorkspaceGateway;
    const cmd = new CreateChildBoardCommand("create", {
      parentBoardId: "home",
      boardId: "board-a",
      portalCardId: "portal-a",
      frame: nextFrame,
      title: "Board A",
    });

    await cmd.execute(gateway);
    await cmd.undo(gateway);
    await cmd.execute(gateway);

    expect(gateway.createChildBoard).toHaveBeenCalledTimes(1);
    expect(gateway.restoreTrashBatch).toHaveBeenCalledWith("batch-board");
  });
});

describe("DuplicateBoardCommand", () => {
  const input = {
    sourceBoardId: "template",
    targetBoardId: "home",
    newBoardId: "board-copy",
    newPortalCardId: "portal-copy",
    frame: nextFrame,
  };
  const receipt = {
    newBoardId: "board-copy",
    portal: {
      kind: "board_portal" as const,
      id: "portal-copy",
      boardId: "home",
      frame: nextFrame,
      zIndex: 0,
      revision: 1,
      target: {
        id: "board-copy",
        boardRevision: 1,
        title: "Template copy",
        colorToken: "terracotta",
        symbol: null,
        childBoardCount: 0,
        childCardCount: 0,
        coverAsset: null,
      },
    },
  };
  type Gateway = Parameters<DuplicateBoardCommand["execute"]>[0];

  it("duplicates the board and returns the receipt", async () => {
    const gateway = {
      duplicateBoard: vi.fn().mockResolvedValue(receipt),
    } as unknown as Gateway;

    const command = new DuplicateBoardCommand("cmd-1", input);
    await expect(command.execute(gateway)).resolves.toBe(receipt);
    expect(gateway.duplicateBoard).toHaveBeenCalledWith(input);
  });

  it("undo trashes the new board; redo restores the same batch instead of duplicating again", async () => {
    const gateway = {
      duplicateBoard: vi.fn().mockResolvedValue(receipt),
      trashBoard: vi.fn().mockResolvedValue("batch-dup"),
      restoreTrashBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Gateway;

    const command = new DuplicateBoardCommand("cmd-1", input);
    await command.execute(gateway);
    await command.undo(gateway);
    expect(gateway.trashBoard).toHaveBeenCalledWith("board-copy");

    await command.execute(gateway);
    expect(gateway.restoreTrashBatch).toHaveBeenCalledWith("batch-dup");
    expect(gateway.duplicateBoard).toHaveBeenCalledTimes(1);
  });

  it("refuses to undo a command that never ran", async () => {
    const gateway = { trashBoard: vi.fn() } as unknown as Gateway;
    const command = new DuplicateBoardCommand("cmd-2", input);
    await expect(command.undo(gateway)).rejects.toThrow();
    expect(gateway.trashBoard).not.toHaveBeenCalled();
  });
});

describe("MoveSelectionCommand", () => {
  const input = {
    idempotencyKey: "op-1",
    targetBoardId: "board-b",
    cards: [{ id: "n1", expectedRevision: 1 }],
    boards: [{ boardId: "board-a", expectedBoardRevision: 1, expectedPortalRevision: 1 }],
    leafPlacement: "unsorted" as const,
  };
  const receipt = {
    operationId: "operation-1",
    targetBoardId: "board-b",
    cards: [],
    boards: [],
  };
  type Gateway = Parameters<MoveSelectionCommand["execute"]>[0];

  it("moves once and undoes from the returned receipt", async () => {
    const gateway = {
      moveSelectionToBoard: vi.fn().mockResolvedValue(receipt),
      undoMoveSelection: vi.fn().mockResolvedValue(undefined),
    } as unknown as Gateway;

    const command = new MoveSelectionCommand("cmd-1", input);
    await expect(command.execute(gateway)).resolves.toBe(receipt);
    expect(gateway.moveSelectionToBoard).toHaveBeenCalledWith(input);

    await command.undo(gateway);
    expect(gateway.undoMoveSelection).toHaveBeenCalledWith(receipt);
    expect(gateway.moveSelectionToBoard).toHaveBeenCalledTimes(1);
  });

  it("refuses to undo a command that never ran", async () => {
    const gateway = { undoMoveSelection: vi.fn() } as unknown as Gateway;
    const command = new MoveSelectionCommand("cmd-2", input);
    await expect(command.undo(gateway)).rejects.toThrow();
    expect(gateway.undoMoveSelection).not.toHaveBeenCalled();
  });
});
