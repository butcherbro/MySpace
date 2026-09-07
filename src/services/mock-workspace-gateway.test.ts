import { describe, expect, it } from "vitest";
import { MockWorkspaceGateway } from "./mock-workspace-gateway";

const noteInput = (id: string, plainText: string) => ({
  id,
  boardId: "home",
  frame: { x: 0, y: 0, width: 200, height: 80 },
  zIndex: 0,
  documentJson: { type: "doc" },
  plainText,
});

describe("MockWorkspaceGateway", () => {
  it("loads a created child board snapshot", async () => {
    const gateway = new MockWorkspaceGateway();

    await gateway.createChildBoard({
      parentBoardId: "home",
      boardId: "child-1",
      portalCardId: "portal-1",
      frame: { x: 40, y: 40, width: 120, height: 112 },
      title: "New Board",
    });

    const snapshot = await gateway.loadBoardSnapshot("child-1");

    expect(snapshot.board.id).toBe("child-1");
    expect(snapshot.board.title).toBe("New Board");
    expect(snapshot.breadcrumbs.map((crumb) => crumb.title)).toEqual(["Home", "New Board"]);
    expect(snapshot.cards).toEqual([]);
  });

  it("lists a recoverable trash batch after deleting a note", async () => {
    const gateway = new MockWorkspaceGateway();
    await gateway.createNote(noteInput("n1", "Remember to ship"));

    const batchId = await gateway.trashSelection({
      items: [{ id: "n1", kind: "note" }],
    });

    const summary = await gateway.listTrash();

    expect(summary.batchCount).toBe(1);
    expect(summary.cardCount).toBe(1);
    expect(summary.boardCount).toBe(0);
    expect(summary.batches[0].batchId).toBe(batchId);
    expect(summary.batches[0].items).toEqual([
      { id: "n1", kind: "note", title: "Remember to ship" },
    ]);
  });

  it("restoring a trash batch removes it from the trash list", async () => {
    const gateway = new MockWorkspaceGateway();
    await gateway.createNote(noteInput("n1", "keep"));
    const batchId = await gateway.trashSelection({ items: [{ id: "n1", kind: "note" }] });

    await gateway.restoreTrashBatch(batchId);

    const summary = await gateway.listTrash();
    expect(summary.batchCount).toBe(0);
  });
});
