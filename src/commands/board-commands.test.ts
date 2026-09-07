import { describe, expect, it, vi } from "vitest";
import { CreateChildBoardCommand, MoveBoardCommand } from "./board-commands";
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
