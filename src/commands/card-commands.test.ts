import { describe, expect, it, vi } from "vitest";
import { MoveCardToBoardCommand } from "./card-commands";
import type { MoveCardToBoardInput, WorkspaceGateway } from "../services/workspace-gateway";

function gatewaySpy() {
  const calls: MoveCardToBoardInput[] = [];
  const gateway = {
    moveCardToBoard: vi.fn(async (input: MoveCardToBoardInput) => {
      calls.push(input);
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
  });
});