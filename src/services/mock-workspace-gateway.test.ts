import { describe, expect, it } from "vitest";
import { MockWorkspaceGateway } from "./mock-workspace-gateway";
import type { CardDto } from "./workspace-gateway";
import { plainTextToDocument } from "../editor/document-codec";

const noteInput = (id: string, plainText: string) => ({
  id,
  boardId: "home",
  frame: { x: 0, y: 0, width: 200, height: 80 },
  zIndex: 0,
  documentJson: plainTextToDocument(plainText),
});

describe("MockWorkspaceGateway", () => {
  it("derives plainText from the document JSON and returns it on the receipts", async () => {
    const gateway = new MockWorkspaceGateway();

    const created = await gateway.createNote(noteInput("n1", "hello world"));
    expect(created).toEqual({ id: "n1", revision: 1 });

    const updated = await gateway.updateNote({
      id: "n1",
      expectedRevision: 1,
      documentJson: plainTextToDocument("updated text"),
    });
    expect(updated).toEqual({ id: "n1", revision: 2, plainText: "updated text" });

    const card = await gateway.readCard("n1");
    expect(card.kind === "note" && card.plainText).toBe("updated text");
  });

  it("returns a card receipt from moveCard/placeUnsortedCard and a cards receipt from moveCards", async () => {
    const gateway = new MockWorkspaceGateway();
    await gateway.createNote(noteInput("n1", "a"));
    await gateway.createNote(noteInput("n2", "b"));

    const moved = await gateway.moveCard({
      id: "n1",
      expectedRevision: 1,
      frame: { x: 10, y: 10, width: 200, height: 80 },
    });
    expect(moved).toEqual({ id: "n1", revision: 2 });

    const batch = await gateway.moveCards({
      cards: [
        { id: "n1", expectedRevision: 2, frame: { x: 20, y: 20, width: 200, height: 80 } },
        { id: "n2", expectedRevision: 1, frame: { x: 30, y: 30, width: 200, height: 80 } },
      ],
    });
    expect(batch.cards).toEqual([
      { id: "n1", revision: 3 },
      { id: "n2", revision: 2 },
    ]);
  });

  it("returns a viewport receipt from saveViewport", async () => {
    const gateway = new MockWorkspaceGateway();
    const receipt = await gateway.saveViewport({
      boardId: "home",
      expectedRevision: 1,
      x: 0,
      y: 0,
      zoom: 2,
    });
    expect(receipt).toEqual({ revision: 2 });
  });

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
      {
        id: "n1",
        kind: "note",
        title: "Remember to ship",
        thumbnailAsset: null,
        colorToken: null,
        symbol: null,
      },
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

  it("reparents a board and shows it in the target board snapshot", async () => {
    const gateway = new MockWorkspaceGateway();
    await gateway.createChildBoard({
      parentBoardId: "home",
      boardId: "a",
      portalCardId: "p-a",
      frame: { x: 0, y: 0, width: 120, height: 112 },
      title: "A",
    });
    await gateway.createChildBoard({
      parentBoardId: "home",
      boardId: "b",
      portalCardId: "p-b",
      frame: { x: 200, y: 0, width: 120, height: 112 },
      title: "B",
    });

    await gateway.moveBoard({
      boardId: "a",
      expectedBoardRevision: 1,
      expectedPortalRevision: 1,
      targetParentBoardId: "b",
      frame: { x: 40, y: 40, width: 120, height: 112 },
    });

    // The portal for A now lives on B's canvas.
    const snapshot = await gateway.loadBoardSnapshot("b");
    expect(snapshot.cards.map((c) => c.kind)).toContain("board_portal");
    expect(snapshot.cards.find((c) => c.id === "p-a")).toBeDefined();
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
      descriptionJson: plainTextToDocument("A useful example"),
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

    // Image search by caption/file name.
    await gateway.createImageCard({
      id: "img-1",
      boardId: "home",
      frame: { x: 0, y: 200, width: 320, height: 240 },
      zIndex: 0,
      assetId: "asset-1",
      captionJson: plainTextToDocument("Screenshot of dashboard"),
    });
    const images = await gateway.searchWorkspace("dashboard");
    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("image");
  });

  it("keeps a shortcut from another device closed until it is pointed at a folder here (ADR-0012)", async () => {
    const gateway = new MockWorkspaceGateway();
    const created = await gateway.createFolderAlias({
      id: "f1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 300, height: 220 },
      zIndex: 0,
      sourcePath: "/Users/me/Research",
    });
    const me = await gateway.getDeviceIdentity();
    expect(created).toMatchObject({ local: true, originDeviceId: me.deviceId, originDeviceName: me.deviceName });

    // Simulate the card arriving from another device (no locator here).
    Object.assign(
      (gateway as unknown as { snapshot: { cards: CardDto[] } }).snapshot.cards.find((c) => c.id === "f1")!,
      { local: false, originDeviceId: "studio-mac", originDeviceName: "Studio Mac" },
    );
    await expect(gateway.listFolderPreview("f1", 50)).resolves.toMatchObject({ status: "foreign_device", entries: [] });
    await expect(gateway.openFolderInFinder("f1")).rejects.toThrow(/another device/);

    const pointed = await gateway.setFilesystemAliasLocalTarget("f1", "/mock/home/Research");
    expect(pointed).toMatchObject({ local: true, originDeviceName: "Studio Mac", revision: 1, pathHint: "/Users/me/Research" });
    await expect(gateway.listFolderPreview("f1", 50)).resolves.toMatchObject({ status: "ready" });
    await expect(gateway.openFolderInFinder("f1")).resolves.toBeUndefined();

    await expect(gateway.renameDevice("  Desk PC ")).resolves.toEqual({ deviceId: me.deviceId, deviceName: "Desk PC" });
  });

  it("creates a persistent folder alias with deterministic preview states", async () => {
    const gateway = new MockWorkspaceGateway();
    const card = await gateway.createFolderAlias({
      id: "folder-ready",
      boardId: "home",
      frame: { x: 20, y: 30, width: 360, height: 300 },
      zIndex: 0,
      sourcePath: "/mock/Video project",
    });

    expect(card).toMatchObject({
      kind: "filesystem_alias",
      displayName: "Video project",
      pathHint: "/mock/Video project",
    });
    expect((await gateway.readCard("folder-ready")).kind).toBe("filesystem_alias");
    await expect(gateway.listFolderPreview("folder-ready", 50)).resolves.toMatchObject({
      status: "ready",
      hasMore: false,
    });

    for (const [id, sourcePath, status] of [
      ["folder-empty", "/mock/empty", "empty"],
      ["folder-missing", "/mock/missing", "missing"],
      ["folder-denied", "/mock/permission-lost", "permission_lost"],
      ["folder-error", "/mock/io-error", "io_error"],
    ] as const) {
      await gateway.createFolderAlias({
        id,
        boardId: "home",
        frame: { x: 0, y: 0, width: 360, height: 300 },
        zIndex: 0,
        sourcePath,
      });
      await expect(gateway.listFolderPreview(id, 50)).resolves.toMatchObject({ status });
    }
  });

  it("classifies folders and images without turning unsupported files into cards", async () => {
    const gateway = new MockWorkspaceGateway();
    await expect(
      gateway.classifyDropPaths(["/mock/Folder", "/mock/photo.png", "/mock/readme.txt"]),
    ).resolves.toEqual([
      { path: "/mock/Folder", kind: "folder", fileName: "Folder", mimeType: null },
      { path: "/mock/photo.png", kind: "image", fileName: "photo.png", mimeType: "image/png" },
      { path: "/mock/readme.txt", kind: "unsupported", fileName: "readme.txt", mimeType: null },
    ]);
  });

  it("searches, trashes, restores, and projects folder shortcuts as normal cards", async () => {
    const gateway = new MockWorkspaceGateway();
    await gateway.createFolderAlias({
      id: "folder-1",
      boardId: "home",
      frame: { x: 20, y: 30, width: 360, height: 300 },
      zIndex: 0,
      sourcePath: "/Volumes/Studio/Video project",
    });

    await expect(gateway.searchWorkspace("video project")).resolves.toMatchObject([
      { entityId: "folder-1", kind: "folder", title: "Video project" },
    ]);
    await expect(gateway.searchWorkspace("studio")).resolves.toMatchObject([
      { entityId: "folder-1", kind: "folder", excerpt: "/Volumes/Studio/Video project" },
    ]);

    const batchId = await gateway.trashSelection({
      items: [{ id: "folder-1", kind: "filesystem_alias" }],
    });
    await expect(gateway.listTrash()).resolves.toMatchObject({
      batches: [{ items: [{ id: "folder-1", kind: "filesystem_alias", title: "Video project" }] }],
    });

    await gateway.restoreTrashBatch(batchId);
    await expect(gateway.readCard("folder-1")).resolves.toMatchObject({ kind: "filesystem_alias" });
  });
});
