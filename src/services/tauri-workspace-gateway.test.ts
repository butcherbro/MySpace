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

  it("calls create_note with a wrapped input payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 200, height: 80 },
      zIndex: 0,
      documentJson: { type: "doc" },
      plainText: "hi",
    };
    await gw.createNote(input);
    expect(invokeMock).toHaveBeenCalledWith("create_note", { input });
  });

  it("calls update_note with a wrapped input payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      expectedRevision: 1,
      documentJson: { type: "doc" },
      plainText: "updated",
    };
    await gw.updateNote(input);
    expect(invokeMock).toHaveBeenCalledWith("update_note", { input });
  });

  it("calls move_card with a wrapped input payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      expectedRevision: 2,
      frame: { x: 100, y: 200, width: 240, height: 120 },
    };
    await gw.moveCard(input);
    expect(invokeMock).toHaveBeenCalledWith("move_card", { input });
  });

  it("calls save_viewport with a wrapped input payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    const input = {
      boardId: "home",
      expectedRevision: 1,
      x: 0,
      y: 0,
      zoom: 1.5,
    };
    await gw.saveViewport(input);
    expect(invokeMock).toHaveBeenCalledWith("save_viewport", { input });
  });

  it("calls move_cards with a wrapped batch payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    const input = {
      cards: [
        { id: "a", expectedRevision: 1, frame: { x: 0, y: 0, width: 200, height: 80 } },
        { id: "b", expectedRevision: 1, frame: { x: 10, y: 10, width: 200, height: 80 } },
      ],
    };
    await gw.moveCards(input);
    expect(invokeMock).toHaveBeenCalledWith("move_cards", { input });
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
      descriptionPlainText: "",
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

    const result = await gw.enrichEmbedMetadata({ id: "note-1", expectedRevision: 2 });

    expect(invokeMock).toHaveBeenCalledWith("enrich_embed_metadata", {
      input: { id: "note-1", expectedRevision: 2 },
    });
    expect(result.kind).toBe("embed");
    expect(result.title).toBe("Example Domain");
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
});
