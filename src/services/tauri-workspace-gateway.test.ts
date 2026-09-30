import { describe, expect, it, vi, beforeEach } from "vitest";
import { TauriWorkspaceGateway } from "./tauri-workspace-gateway";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

describe("TauriWorkspaceGateway", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("calls get_home_board with no arguments", async () => {
    invokeMock.mockResolvedValue({ id: "home", title: "Home", parentBoardId: null, revision: 1 });
    const gw = new TauriWorkspaceGateway();
    await gw.getHomeBoard();
    expect(invokeMock).toHaveBeenCalledWith("get_home_board", {});
  });

  it("calls load_board_snapshot with a boardId payload", async () => {
    invokeMock.mockResolvedValue({});
    const gw = new TauriWorkspaceGateway();
    await gw.loadBoardSnapshot("home");
    expect(invokeMock).toHaveBeenCalledWith("load_board_snapshot", { boardId: "home" });
  });

  it("calls get_board_change_seq with a boardId payload and returns both counters", async () => {
    invokeMock.mockResolvedValue({ dataVersion: 7, changeSeq: 3 });
    const gw = new TauriWorkspaceGateway();
    const result = await gw.getBoardChangeSeq("home");
    expect(invokeMock).toHaveBeenCalledWith("get_board_change_seq", { boardId: "home" });
    expect(result).toEqual({ dataVersion: 7, changeSeq: 3 });
  });

  it("calls create_note with a wrapped input payload and returns the receipt", async () => {
    invokeMock.mockResolvedValue({ id: "note-1", revision: 1 });
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 200, height: 80 },
      zIndex: 0,
      documentJson: { type: "doc" },
    };
    const result = await gw.createNote(input);
    expect(invokeMock).toHaveBeenCalledWith("create_note", { input });
    expect(result).toEqual({ id: "note-1", revision: 1 });
  });

  it("calls update_note with a wrapped input payload and returns the text receipt", async () => {
    invokeMock.mockResolvedValue({ id: "note-1", revision: 2, plainText: "updated" });
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      expectedRevision: 1,
      documentJson: { type: "doc" },
    };
    const result = await gw.updateNote(input);
    expect(invokeMock).toHaveBeenCalledWith("update_note", { input });
    expect(result).toEqual({ id: "note-1", revision: 2, plainText: "updated" });
  });

  it("calls duplicate_board with a wrapped input payload and returns the receipt", async () => {
    const receipt = {
      newBoardId: "board-copy",
      portal: {
        kind: "board_portal",
        id: "portal-copy",
        boardId: "home",
        frame: { x: 40, y: 40, width: 120, height: 112 },
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
    invokeMock.mockResolvedValue(receipt);
    const gw = new TauriWorkspaceGateway();
    const input = {
      sourceBoardId: "template",
      targetBoardId: "home",
      newBoardId: "board-copy",
      newPortalCardId: "portal-copy",
      frame: { x: 40, y: 40, width: 120, height: 112 },
    };
    const result = await gw.duplicateBoard(input);
    expect(invokeMock).toHaveBeenCalledWith("duplicate_board", { input });
    expect(result).toEqual(receipt);
  });

  it("calls move_card with a wrapped input payload and returns the card receipt", async () => {
    invokeMock.mockResolvedValue({ id: "note-1", revision: 3 });
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      expectedRevision: 2,
      frame: { x: 100, y: 200, width: 240, height: 120 },
    };
    const result = await gw.moveCard(input);
    expect(invokeMock).toHaveBeenCalledWith("move_card", { input });
    expect(result).toEqual({ id: "note-1", revision: 3 });
  });

  it("calls save_viewport with a wrapped input payload and returns the viewport receipt", async () => {
    invokeMock.mockResolvedValue({ revision: 2 });
    const gw = new TauriWorkspaceGateway();
    const input = {
      boardId: "home",
      expectedRevision: 1,
      x: 0,
      y: 0,
      zoom: 1.5,
    };
    const result = await gw.saveViewport(input);
    expect(invokeMock).toHaveBeenCalledWith("save_viewport", { input });
    expect(result).toEqual({ revision: 2 });
  });

  it("calls move_cards with a wrapped batch payload and returns the cards receipt", async () => {
    invokeMock.mockResolvedValue({
      cards: [
        { id: "a", revision: 2 },
        { id: "b", revision: 2 },
      ],
    });
    const gw = new TauriWorkspaceGateway();
    const input = {
      cards: [
        { id: "a", expectedRevision: 1, frame: { x: 0, y: 0, width: 200, height: 80 } },
        { id: "b", expectedRevision: 1, frame: { x: 10, y: 10, width: 200, height: 80 } },
      ],
    };
    const result = await gw.moveCards(input);
    expect(invokeMock).toHaveBeenCalledWith("move_cards", { input });
    expect(result.cards).toHaveLength(2);
  });

  it("adds the embed discriminator to a converted note response", async () => {
    invokeMock.mockResolvedValue({
      id: "note-1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 240, height: 120 },
      zIndex: 0,
      revision: 2,
      sourceUrl: "https://example.com",
      displayUrl: "example.com",
      siteName: null,
      title: "https://example.com",
      provider: null,
      descriptionJson: { type: "doc", content: [{ type: "paragraph" }] },
      descriptionPlainText: "",
      faviconAsset: null,
      previewAsset: null,
      previewOrigin: null,
      metadataStatus: "pending",
      metadataError: null,
    });
    const gw = new TauriWorkspaceGateway();

    const result = await gw.convertNoteToEmbed({
      id: "note-1",
      expectedRevision: 1,
      sourceUrl: "https://example.com",
      displayUrl: "example.com",
      title: "https://example.com",
      descriptionJson: { type: "doc", content: [{ type: "paragraph" }] },
    });

    expect(result.kind).toBe("embed");
  });

  it("calls enrich_embed_metadata and restores the embed discriminator", async () => {
    invokeMock.mockResolvedValue({
      id: "note-1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 320, height: 240 },
      zIndex: 0,
      revision: 3,
      sourceUrl: "https://example.com",
      displayUrl: "example.com",
      siteName: "Example",
      title: "Example Domain",
      provider: null,
      descriptionJson: { type: "doc", content: [{ type: "paragraph" }] },
      descriptionPlainText: "Example description",
      faviconAsset: null,
      previewAsset: null,
      previewOrigin: null,
      metadataStatus: "ready",
      metadataError: null,
    });
    const gw = new TauriWorkspaceGateway();

    const result = await gw.enrichEmbedMetadata({ id: "note-1" });

    expect(invokeMock).toHaveBeenCalledWith("enrich_embed_metadata", {
      input: { id: "note-1" },
    });
    expect(result.kind).toBe("embed");
    expect(result.title).toBe("Example Domain");
  });

  it("calls update_image_caption with a wrapped input payload and returns the text receipt", async () => {
    invokeMock.mockResolvedValue({ id: "image-1", revision: 2, plainText: "a photo" });
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "image-1",
      expectedRevision: 1,
      captionJson: { type: "doc" },
    };
    const result = await gw.updateImageCaption(input);
    expect(invokeMock).toHaveBeenCalledWith("update_image_caption", { input });
    expect(result).toEqual({ id: "image-1", revision: 2, plainText: "a photo" });
  });

  it("calls update_embed_description with a wrapped input payload and returns the text receipt", async () => {
    invokeMock.mockResolvedValue({ id: "embed-1", revision: 3, plainText: "a description" });
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "embed-1",
      expectedRevision: 2,
      descriptionJson: { type: "doc" },
    };
    const result = await gw.updateEmbedDescription(input);
    expect(invokeMock).toHaveBeenCalledWith("update_embed_description", { input });
    expect(result).toEqual({ id: "embed-1", revision: 3, plainText: "a description" });
  });

  it("calls place_unsorted_card with a wrapped input payload and returns the card receipt", async () => {
    invokeMock.mockResolvedValue({ id: "note-1", revision: 4 });
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      expectedRevision: 3,
      frame: { x: 40, y: 40, width: 240, height: 120 },
    };
    const result = await gw.placeUnsortedCard(input);
    expect(invokeMock).toHaveBeenCalledWith("place_unsorted_card", { input });
    expect(result).toEqual({ id: "note-1", revision: 4 });
  });

  it("calls move_cards_to_board_unsorted with a wrapped input payload and returns the cards receipt", async () => {
    invokeMock.mockResolvedValue({ cards: [{ id: "note-1", revision: 2 }] });
    const gw = new TauriWorkspaceGateway();
    const input = {
      targetBoardId: "board-b",
      cards: [{ id: "note-1", expectedRevision: 1 }],
    };
    const result = await gw.moveCardsToBoardUnsorted(input);
    expect(invokeMock).toHaveBeenCalledWith("move_cards_to_board_unsorted", { input });
    expect(result).toEqual({ cards: [{ id: "note-1", revision: 2 }] });
  });

  it("calls list_trash with no arguments", async () => {
    invokeMock.mockResolvedValue({
      batches: [],
      batchCount: 0,
      boardCount: 0,
      cardCount: 0,
    });
    const gw = new TauriWorkspaceGateway();
    const result = await gw.listTrash();
    expect(invokeMock).toHaveBeenCalledWith("list_trash", {});
    expect(result.batchCount).toBe(0);
  });

  it("calls search_workspace with the query payload", async () => {
    invokeMock.mockResolvedValue([]);
    const gw = new TauriWorkspaceGateway();
    const result = await gw.searchWorkspace("rocket");
    expect(invokeMock).toHaveBeenCalledWith("search_workspace", { query: "rocket" });
    expect(result).toEqual([]);
  });

  it("creates a folder alias and restores its filesystem_alias discriminator", async () => {
    invokeMock.mockResolvedValue({
      id: "folder-1",
      boardId: "home",
      frame: { x: 40, y: 60, width: 360, height: 300 },
      zIndex: 2,
      revision: 1,
      targetKind: "folder",
      pathHint: "/Users/me/Video project",
      displayName: "Video project",
    });
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "folder-1",
      boardId: "home",
      frame: { x: 40, y: 60, width: 360, height: 300 },
      zIndex: 2,
      sourcePath: "/Users/me/Video project",
    };

    const result = await gw.createFolderAlias(input);

    expect(invokeMock).toHaveBeenCalledWith("create_folder_alias", { input });
    expect(result.kind).toBe("filesystem_alias");
    expect(result.displayName).toBe("Video project");
  });

  it("routes folder preview, drop classification, and Finder opening through typed commands", async () => {
    const gw = new TauriWorkspaceGateway();
    invokeMock.mockResolvedValueOnce({
      status: "ready",
      entries: [{ name: "Footage", kind: "folder", sizeBytes: null, childCount: 6 }],
      hasMore: false,
      displayName: "Video project",
      pathHint: "/Users/me/Video project",
    });
    await gw.listFolderPreview("folder-1", 50);
    expect(invokeMock).toHaveBeenLastCalledWith("list_folder_preview", { cardId: "folder-1", limit: 50 });

    invokeMock.mockResolvedValueOnce([
      { path: "/Users/me/Video project", kind: "folder", fileName: "Video project", mimeType: null },
    ]);
    await gw.classifyDropPaths(["/Users/me/Video project"]);
    expect(invokeMock).toHaveBeenLastCalledWith("classify_drop_paths", {
      paths: ["/Users/me/Video project"],
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await gw.openFolderInFinder("folder-1");
    expect(invokeMock).toHaveBeenLastCalledWith("open_folder_in_finder", { cardId: "folder-1" });
  });

  it("points a foreign shortcut at a local folder and reads/renames the device (ADR-0012)", async () => {
    const gw = new TauriWorkspaceGateway();
    invokeMock.mockResolvedValueOnce({
      id: "folder-1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 280, height: 180 },
      zIndex: 0,
      revision: 3,
      targetKind: "folder",
      pathHint: "/Users/me/Research",
      displayName: "Research",
      originDeviceId: "mac",
      originDeviceName: "Studio Mac",
      local: true,
    });
    const alias = await gw.setFilesystemAliasLocalTarget("folder-1", "C:\\Research");
    expect(invokeMock).toHaveBeenLastCalledWith("set_filesystem_alias_local_target", {
      cardId: "folder-1",
      path: "C:\\Research",
    });
    expect(alias).toMatchObject({ kind: "filesystem_alias", local: true, originDeviceName: "Studio Mac" });

    invokeMock.mockResolvedValueOnce({ deviceId: "pc", deviceName: "DESKTOP-1" });
    await expect(gw.getDeviceIdentity()).resolves.toEqual({ deviceId: "pc", deviceName: "DESKTOP-1" });
    expect(invokeMock).toHaveBeenLastCalledWith("get_device_identity", {});

    invokeMock.mockResolvedValueOnce({ deviceId: "pc", deviceName: "Gaming PC" });
    await gw.renameDevice("Gaming PC");
    expect(invokeMock).toHaveBeenLastCalledWith("rename_device", { name: "Gaming PC" });
  });

  it("returns a file card with its generated thumbnail already attached", async () => {
    // The backend now answers create_file_card with the persisted projection, so a
    // generated thumbnail must survive the gateway hop instead of being dropped in
    // favour of a reload.
    const gw = new TauriWorkspaceGateway();
    invokeMock.mockResolvedValueOnce({
      id: "fc",
      boardId: "home",
      frame: { x: 0, y: 0, width: 280, height: 180 },
      zIndex: 0,
      revision: 1,
      asset: {
        id: "fa",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        width: null,
        height: null,
        sizeBytes: 10,
        filePath: "fa.pdf",
      },
      previewText: "(office document)",
      previewAsset: {
        id: "thumb",
        fileName: "thumbnail.png",
        mimeType: "image/png",
        width: 256,
        height: 256,
        sizeBytes: 4,
        filePath: "thumb.png",
      },
    });

    const input = {
      id: "fc",
      boardId: "home",
      frame: { x: 0, y: 0, width: 280, height: 180 },
      zIndex: 0,
      sourcePath: "/tmp/report.pdf",
      mimeType: "application/pdf",
      fileName: "report.pdf",
    };
    const card = await gw.createFileCard(input);

    expect(invokeMock).toHaveBeenLastCalledWith("create_file_card", { input });
    expect(card.kind).toBe("file");
    expect(card.previewAsset?.id).toBe("thumb");
    expect(card.previewAsset?.mimeType).toBe("image/png");
  });

  it("calls list_backups with no arguments", async () => {
    const summaries = [
      {
        dirName: "2026-09-20T12-00-00Z",
        createdAtSecs: 1_758_369_600,
        schemaVersion: 4,
        assetCount: 12,
        totalBytes: 1_048_576,
        valid: true,
      },
    ];
    invokeMock.mockResolvedValue(summaries);
    const gw = new TauriWorkspaceGateway();
    const result = await gw.listBackups();
    expect(invokeMock).toHaveBeenCalledWith("list_backups", {});
    expect(result).toEqual(summaries);
  });

  it("calls request_restore with the chosen snapshot dir name", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    void gw.requestRestore("2026-09-20T12-00-00Z");
    expect(invokeMock).toHaveBeenCalledWith("request_restore", { snapshot: "2026-09-20T12-00-00Z" });
  });

  it("calls record_error_report with the report", async () => {
    const saved = { path: "/data/error-reports/r.json", text: "MySpace error report" };
    invokeMock.mockResolvedValue(saved);
    const gw = new TauriWorkspaceGateway();
    const input = { message: "boom", source: "canvas", frontendVersion: "0.2.3", userAgent: "UA" };
    const result = await gw.recordErrorReport(input);
    expect(invokeMock).toHaveBeenCalledWith("record_error_report", { report: input });
    expect(result).toEqual(saved);
  });
});
