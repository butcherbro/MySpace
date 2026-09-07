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

  it("searches boards, notes, and links by their indexed fields", async () => {
    const gateway = new MockWorkspaceGateway();
    await gateway.createChildBoard({
      parentBoardId: "home",
      boardId: "b1",
      portalCardId: "p1",
      frame: { x: 40, y: 40, width: 120, height: 112 },
      title: "Research",
    });
    await gateway.createNote(noteInput("n1", "ship the rocket"));
    await gateway.createNote(noteInput("n2", ""));
    await gateway.convertNoteToEmbed({
      id: "n2",
      expectedRevision: 1,
      sourceUrl: "https://example.com",
      displayUrl: "example.com",
      title: "Example Domain",
      descriptionJson: { type: "doc" },
      descriptionPlainText: "A useful example",
    });

    const boards = await gateway.searchWorkspace("RESEARCH");
    expect(boards.map((r) => r.kind)).toEqual(["board"]);
    expect(boards[0].title).toBe("Research");

    const notes = await gateway.searchWorkspace("rocket");
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("note");
    expect(notes[0].entityId).toBe("n1");

    const links = await gateway.searchWorkspace("useful");
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe("link");
    expect(links[0].excerpt).toBe("A useful example");
  });
});
