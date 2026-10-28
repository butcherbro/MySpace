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

  it("keeps error reports in memory and returns a synthetic text", async () => {
    const gateway = new MockWorkspaceGateway();
    const input = { message: "boom", source: "canvas", frontendVersion: "0.2.3", userAgent: "UA" };

    const saved = await gateway.recordErrorReport(input);

    expect(gateway.errorReports).toEqual([input]);
    expect(saved.text).toContain("boom");
    expect(saved.text).toContain("0.2.3");
  });

  describe("connectors", () => {
    async function twoNotes() {
      const gateway = new MockWorkspaceGateway();
      await gateway.createNote(noteInput("a", "A"));
      await gateway.createNote(noteInput("b", "B"));
      return gateway;
    }
    const link = { id: "c1", boardId: "home", fromCardId: "a", toCardId: "b" };

    it("creates a connector with defaults, idempotently by id, and loads it with the board", async () => {
      const gateway = await twoNotes();
      const created = await gateway.createConnector(link);
      expect(created).toMatchObject({ ...link, colorToken: "default", arrowEnds: "end", label: null, revision: 1 });

      const again = await gateway.createConnector({ ...link, colorToken: "blue" });
      expect(again).toEqual(created);

      const snapshot = await gateway.loadBoardSnapshot("home");
      expect(snapshot.connectors).toEqual([created]);
    });

    it("refuses self links, missing endpoints and unknown values, and a missing board", async () => {
      const gateway = await twoNotes();
      await expect(gateway.createConnector({ ...link, toCardId: "a" })).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(gateway.createConnector({ ...link, toCardId: "nope" })).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(gateway.createConnector({ ...link, colorToken: "neon" })).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(gateway.createConnector({ ...link, boardId: "nowhere" })).rejects.toMatchObject({ code: "not_found" });
    });

    it("updates with a revision check and swaps ends on reverse", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      const updated = await gateway.updateConnector({ connectorId: "c1", expectedRevision: 1, colorToken: "green", arrowEnds: "both" });
      expect(updated).toMatchObject({ colorToken: "green", arrowEnds: "both", revision: 2 });

      await expect(gateway.updateConnector({ connectorId: "c1", expectedRevision: 1, arrowEnds: "none" })).rejects.toEqual({
        code: "stale_revision",
        message: { expected: 1, actual: 2 },
      });

      const reversed = await gateway.updateConnector({ connectorId: "c1", expectedRevision: 2, fromCardId: "b", toCardId: "a" });
      expect(reversed).toMatchObject({ fromCardId: "b", toCardId: "a", revision: 3 });
    });

    it("removes a connector, and removing a missing one is a no-op", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      await gateway.removeConnector({ connectorId: "c1" });
      await gateway.removeConnector({ connectorId: "c1" });
      await gateway.removeConnector({ connectorId: "nope" });
      expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);
    });

    it("soft-removes a connector with its revision kept; creating the same id restores the stored row", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      const styled = await gateway.updateConnector({ connectorId: "c1", expectedRevision: 1, colorToken: "green", label: "why" });
      await gateway.removeConnector({ connectorId: "c1" });

      await expect(gateway.updateConnector({ connectorId: "c1", expectedRevision: 2, arrowEnds: "none" })).rejects.toMatchObject({
        code: "not_found",
      });

      const restored = await gateway.createConnector({ ...link, colorToken: "blue", arrowEnds: "both" });
      expect(restored).toEqual(styled);
      expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([styled]);
    });

    it("empty trash keeps a removed connector between live cards, so creating its id still restores it", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      await gateway.updateConnector({ connectorId: "c1", expectedRevision: 1, colorToken: "green" });
      await gateway.removeConnector({ connectorId: "c1" });
      await gateway.emptyTrash("EMPTY");

      const restored = await gateway.createConnector({ ...link, colorToken: "blue" });
      expect(restored).toMatchObject({ colorToken: "green", revision: 2 });
    });

    it("removing a connector that is in the trash takes it out of its batch", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      const batchId = await gateway.trashSelection({ items: [{ id: "a", kind: "note" }] });
      await gateway.removeConnector({ connectorId: "c1" });

      await gateway.restoreTrashBatch(batchId);
      expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);
    });

    it("trashes connectors with their card in the same batch and restores them with it", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      const batchId = await gateway.trashSelection({ items: [{ id: "a", kind: "note" }] });
      expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);

      await gateway.restoreTrashBatch(batchId);
      expect((await gateway.loadBoardSnapshot("home")).connectors.map((c) => c.id)).toEqual(["c1"]);
    });

    it("keeps a restored connector hidden until its other trashed endpoint returns", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      const first = await gateway.trashSelection({ items: [{ id: "a", kind: "note" }] });
      const second = await gateway.trashSelection({ items: [{ id: "b", kind: "note" }] });

      await gateway.restoreTrashBatch(first);
      expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);
      await gateway.restoreTrashBatch(second);
      expect((await gateway.loadBoardSnapshot("home")).connectors.map((c) => c.id)).toEqual(["c1"]);
    });

    it("empty trash purges the connectors of purged cards for good", async () => {
      const gateway = await twoNotes();
      await gateway.createConnector(link);
      await gateway.updateConnector({ connectorId: "c1", expectedRevision: 1, colorToken: "green" });
      const batchId = await gateway.trashSelection({ items: [{ id: "a", kind: "note" }] });
      await gateway.emptyTrash("EMPTY");
      await gateway.restoreTrashBatch(batchId);
      await gateway.createNote(noteInput("a", "A again"));
      expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);

      // Строки больше нет: тот же id создаётся заново, а не восстанавливается.
      const created = await gateway.createConnector({ ...link, colorToken: "blue" });
      expect(created).toMatchObject({ colorToken: "blue", revision: 1 });
    });

    it("soft-deletes the connectors of a card that leaves the board or goes to Unsorted", async () => {
      const gateway = await twoNotes();
      await gateway.createNote(noteInput("c", "C"));
      await gateway.createChildBoard({
        parentBoardId: "home",
        boardId: "child",
        portalCardId: "portal",
        frame: { x: 0, y: 0, width: 120, height: 112 },
        title: "Child",
      });
      await gateway.createConnector(link);
      await gateway.createConnector({ ...link, id: "c2", fromCardId: "c" });
      await gateway.moveCardsToBoardUnsorted({ targetBoardId: "home", cards: [{ id: "a", expectedRevision: 1 }] });
      await gateway.moveCardToBoard({ id: "c", expectedRevision: 1, targetBoardId: "child" });

      await gateway.placeUnsortedCard({ id: "a", expectedRevision: 2, frame: { x: 0, y: 0, width: 200, height: 80 } });
      await gateway.moveCardToBoard({ id: "c", expectedRevision: 2, targetBoardId: "home" });
      expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);

      // Строка осталась (мягко удалена, ревизия та же): create с тем же id её возвращает.
      const restored = await gateway.createConnector(link);
      expect(restored).toMatchObject({ id: "c1", revision: 1 });
      expect((await gateway.loadBoardSnapshot("home")).connectors.map((c) => c.id)).toEqual(["c1"]);
    });
  });

  describe("groups", () => {
    const frame = { x: 40, y: 40, width: 2400, height: 600 };

    it("creates a group with defaults, idempotently by id, wider than the old 1600 px limit", async () => {
      const gateway = new MockWorkspaceGateway();
      const created = await gateway.createGroup({ id: "g1", boardId: "home", frame, zIndex: 0 });
      expect(created.group).toMatchObject({
        kind: "group",
        id: "g1",
        frame,
        title: "",
        colorToken: "default",
        revision: 1,
        groupId: null,
      });
      expect(created.members).toEqual([]);

      const again = await gateway.createGroup({ id: "g1", boardId: "home", frame, zIndex: 0, title: "other" });
      expect(again).toEqual(created);
      expect((await gateway.loadBoardSnapshot("home")).cards).toEqual([created.group]);
    });

    it("refuses an unknown colour, an out-of-range frame and a missing board", async () => {
      const gateway = new MockWorkspaceGateway();
      await expect(
        gateway.createGroup({ id: "g1", boardId: "home", frame, zIndex: 0, colorToken: "neon" }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(
        gateway.createGroup({ id: "g2", boardId: "home", frame: { ...frame, width: 8001 }, zIndex: 0 }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(
        gateway.createGroup({ id: "g3", boardId: "nowhere", frame, zIndex: 0 }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("updates the title and colour with a revision check and returns a receipt", async () => {
      const gateway = new MockWorkspaceGateway();
      await gateway.createGroup({ id: "g1", boardId: "home", frame, zIndex: 0 });

      expect(await gateway.updateGroup({ cardId: "g1", expectedRevision: 1, title: "Идеи" })).toEqual({
        id: "g1",
        revision: 2,
      });
      expect(await gateway.updateGroup({ cardId: "g1", expectedRevision: 2, colorToken: "blue" })).toEqual({
        id: "g1",
        revision: 3,
      });
      expect(await gateway.readCard("g1")).toMatchObject({ title: "Идеи", colorToken: "blue", revision: 3 });

      await expect(gateway.updateGroup({ cardId: "g1", expectedRevision: 1, title: "x" })).rejects.toMatchObject({
        code: "stale_revision",
      });
      await expect(gateway.updateGroup({ cardId: "missing", expectedRevision: 1, title: "x" })).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("limits the title to 200 characters (not bytes) on create and update", async () => {
      const gateway = new MockWorkspaceGateway();
      const cyrillic200 = "я".repeat(200);
      await gateway.createGroup({ id: "g1", boardId: "home", frame, zIndex: 0, title: cyrillic200 });
      await expect(
        gateway.createGroup({ id: "g2", boardId: "home", frame, zIndex: 0, title: "я".repeat(201) }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(
        gateway.updateGroup({ cardId: "g1", expectedRevision: 1, title: "x".repeat(201) }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("refuses an empty update before looking the group up", async () => {
      const gateway = new MockWorkspaceGateway();
      await expect(gateway.updateGroup({ cardId: "missing", expectedRevision: 1 })).rejects.toMatchObject({
        code: "constraint_violation",
      });
    });

    it("trashes a group as a leaf and lists it in the Trash by its title", async () => {
      const gateway = new MockWorkspaceGateway();
      await gateway.createGroup({ id: "g1", boardId: "home", frame, zIndex: 0, title: "Проект" });
      await gateway.trashSelection({ items: [{ id: "g1", kind: "group" }] });

      expect((await gateway.loadBoardSnapshot("home")).cards).toEqual([]);
      const trash = await gateway.listTrash();
      expect(trash.batches[0].items).toMatchObject([{ id: "g1", kind: "group", title: "Проект" }]);
    });

    it("seeds the ?fixture=groups board: a group «Проект», two notes inside and one outside", async () => {
      const previous = window.location.href;
      window.history.replaceState(null, "", "/?fixture=groups");
      try {
        const cards = (await new MockWorkspaceGateway().loadBoardSnapshot("home")).cards;
        const group = cards.find((c) => c.kind === "group");
        expect(group).toMatchObject({ id: "group-project", title: "Проект", groupId: null });
        expect(cards.filter((c) => c.kind === "note").map((c) => [c.id, c.groupId])).toEqual([
          ["group-note-a", "group-project"],
          ["group-note-b", "group-project"],
          ["group-note-outside", null],
        ]);
      } finally {
        window.history.replaceState(null, "", previous);
      }
    });
  });

  describe("stored group membership", () => {
    const groupFrame = { x: 0, y: 0, width: 1000, height: 800 };

    async function boardWithNotes() {
      const gateway = new MockWorkspaceGateway();
      for (const id of ["n1", "n2"]) {
        await gateway.createNote({
          id,
          boardId: "home",
          frame: { x: 100, y: 100, width: 200, height: 80 },
          zIndex: 0,
          documentJson: { type: "doc", content: [] },
        });
      }
      return gateway;
    }

    const groupIdOf = async (gateway: MockWorkspaceGateway, id: string) =>
      (await gateway.loadBoardSnapshot("home")).cards.find((c) => c.id === id)?.groupId;

    it("createGroup sets the members in the same call, deduped, and bumps their revisions once", async () => {
      const gateway = await boardWithNotes();
      const receipt = await gateway.createGroup({
        id: "g",
        boardId: "home",
        frame: groupFrame,
        zIndex: 0,
        memberIds: ["n1", "n2", "n1"],
      });
      expect(receipt.members).toEqual([
        { id: "n1", revision: 2 },
        { id: "n2", revision: 2 },
      ]);
      expect(await groupIdOf(gateway, "n1")).toBe("g");
      expect(await groupIdOf(gateway, "n2")).toBe("g");
    });

    it("createGroup with an unknown or foreign member fails and creates nothing", async () => {
      const gateway = await boardWithNotes();
      await gateway.createChildBoard({
        boardId: "child",
        parentBoardId: "home",
        portalCardId: "portal",
        title: "Child",
        frame: { x: 0, y: 0, width: 200, height: 160 },
      });
      await gateway.createNote({
        id: "far",
        boardId: "child",
        frame: { x: 0, y: 0, width: 200, height: 80 },
        zIndex: 0,
        documentJson: { type: "doc", content: [] },
      });
      for (const memberIds of [["n1", "missing"], ["n1", "far"], ["g"]]) {
        await expect(
          gateway.createGroup({ id: "g", boardId: "home", frame: groupFrame, zIndex: 0, memberIds }),
        ).rejects.toMatchObject({ code: "constraint_violation" });
      }
      const cards = (await gateway.loadBoardSnapshot("home")).cards;
      expect(cards.some((c) => c.id === "g")).toBe(false);
      expect(cards.find((c) => c.id === "n1")).toMatchObject({ groupId: null, revision: 1 });
    });

    it("moveCards applies `group` with one revision bump; absent `group` keeps membership", async () => {
      const gateway = await boardWithNotes();
      await gateway.createGroup({ id: "g", boardId: "home", frame: groupFrame, zIndex: 0 });
      const frame = { x: 120, y: 120, width: 200, height: 80 };

      expect(
        await gateway.moveCards({ cards: [{ id: "n1", expectedRevision: 1, frame, group: { groupId: "g" } }] }),
      ).toEqual({ cards: [{ id: "n1", revision: 2 }] });
      expect(await groupIdOf(gateway, "n1")).toBe("g");

      await gateway.moveCards({ cards: [{ id: "n1", expectedRevision: 2, frame }] });
      expect(await groupIdOf(gateway, "n1")).toBe("g");

      await gateway.moveCards({ cards: [{ id: "n1", expectedRevision: 3, frame, group: { groupId: null } }] });
      expect(await groupIdOf(gateway, "n1")).toBeNull();
    });

    it("moveCards refuses a target that is not a live group, the card itself, or a descendant — writing nothing", async () => {
      const gateway = await boardWithNotes();
      await gateway.createGroup({ id: "outer", boardId: "home", frame: groupFrame, zIndex: 0 });
      await gateway.createGroup({ id: "inner", boardId: "home", frame: groupFrame, zIndex: 0 });
      await gateway.moveCards({
        cards: [{ id: "inner", expectedRevision: 1, frame: groupFrame, group: { groupId: "outer" } }],
      });
      const frame = { x: 120, y: 120, width: 200, height: 80 };
      const refused = [
        { id: "n1", expectedRevision: 1, frame, group: { groupId: "missing" } },
        { id: "n1", expectedRevision: 1, frame, group: { groupId: "n2" } },
        { id: "outer", expectedRevision: 1, frame: groupFrame, group: { groupId: "outer" } },
        // outer → inner → outer: цикл.
        { id: "outer", expectedRevision: 1, frame: groupFrame, group: { groupId: "inner" } },
      ];
      for (const item of refused) {
        await expect(
          gateway.moveCards({ cards: [{ id: "n2", expectedRevision: 1, frame }, item] }),
        ).rejects.toMatchObject({ code: "constraint_violation" });
      }
      const cards = (await gateway.loadBoardSnapshot("home")).cards;
      expect(cards.find((c) => c.id === "n2")).toMatchObject({ revision: 1 });
      expect(cards.find((c) => c.id === "outer")).toMatchObject({ groupId: null, revision: 1 });
    });

    it("createGroup nests the new group in `groupId` and refuses a parent that would make a cycle", async () => {
      const gateway = await boardWithNotes();
      await gateway.createGroup({ id: "outer", boardId: "home", frame: groupFrame, zIndex: 0 });
      const { group } = await gateway.createGroup({
        id: "inner",
        boardId: "home",
        frame: groupFrame,
        zIndex: 0,
        groupId: "outer",
      });
      expect(group.groupId).toBe("outer");
      expect(await groupIdOf(gateway, "inner")).toBe("outer");

      await expect(
        gateway.createGroup({ id: "x", boardId: "home", frame: groupFrame, zIndex: 0, groupId: "n1" }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      // Родитель inner сам стал бы членом новой группы: outer → x → inner → outer.
      await expect(
        gateway.createGroup({
          id: "x",
          boardId: "home",
          frame: groupFrame,
          zIndex: 0,
          memberIds: ["outer"],
          groupId: "inner",
        }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      expect(await groupIdOf(gateway, "x")).toBeUndefined();
    });

    it("moveCards validates items in order against the earlier ones and rolls the batch back", async () => {
      const gateway = await boardWithNotes();
      await gateway.createGroup({ id: "g1", boardId: "home", frame: groupFrame, zIndex: 0 });
      await gateway.createGroup({ id: "g2", boardId: "home", frame: groupFrame, zIndex: 0 });
      const frame = { x: 5, y: 5, width: 200, height: 80 };

      await expect(
        gateway.moveCards({
          cards: [
            { id: "n1", expectedRevision: 1, frame },
            { id: "g1", expectedRevision: 1, frame: groupFrame, group: { groupId: "g2" } },
            { id: "g2", expectedRevision: 1, frame: groupFrame, group: { groupId: "g1" } },
          ],
        }),
      ).rejects.toMatchObject({ code: "constraint_violation" });

      const cards = (await gateway.loadBoardSnapshot("home")).cards;
      expect(cards.find((c) => c.id === "n1")).toMatchObject({ revision: 1, frame: { x: 100, y: 100 } });
      expect(cards.find((c) => c.id === "g1")).toMatchObject({ revision: 1, groupId: null });
      expect(cards.find((c) => c.id === "g2")).toMatchObject({ revision: 1, groupId: null });
    });

    it("placing a card from Unsorted clears its membership even when the group is live", async () => {
      const gateway = await boardWithNotes();
      await gateway.createGroup({ id: "g", boardId: "home", frame: groupFrame, zIndex: 0, memberIds: ["n1"] });
      await gateway.moveCardsToBoardUnsorted({ targetBoardId: "home", cards: [{ id: "n1", expectedRevision: 2 }] });
      const held = (await gateway.loadBoardSnapshot("home")).unsortedCards.find((c) => c.id === "n1")!;
      await gateway.placeUnsortedCard({
        id: "n1",
        expectedRevision: held.revision,
        frame: { x: 120, y: 120, width: 200, height: 80 },
      });
      expect(await groupIdOf(gateway, "n1")).toBeNull();
    });

    it("loads membership as dormant while the group is in the Trash and revives it on restore", async () => {
      const gateway = await boardWithNotes();
      await gateway.createGroup({ id: "g", boardId: "home", frame: groupFrame, zIndex: 0, memberIds: ["n1"] });

      const batchId = await gateway.trashSelection({ items: [{ id: "g", kind: "group" }] });
      expect(await groupIdOf(gateway, "n1")).toBeNull();
      expect((await gateway.readCard("n1")).groupId).toBeNull();

      await gateway.restoreTrashBatch(batchId);
      expect(await groupIdOf(gateway, "n1")).toBe("g");
    });
  });
});
