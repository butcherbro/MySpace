import { describe, expect, it } from "vitest";
import { MockWorkspaceGateway } from "./mock-workspace-gateway";

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
});
