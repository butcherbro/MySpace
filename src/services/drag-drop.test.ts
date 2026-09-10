import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeNativeDropItems, subscribeToNativeDrops } from "./drag-drop";

const listenMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

describe("native drag-drop", () => {
  beforeEach(() => {
    listenMock.mockReset();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
  });

  it("forwards every native path, including folders, to the application classifier", async () => {
    let listener: ((event: { payload: { paths: string[]; position: { x: number; y: number } } }) => void) | undefined;
    listenMock.mockImplementation(async (_event, callback) => {
      listener = callback;
      return vi.fn();
    });
    const onDrop = vi.fn();

    subscribeToNativeDrops(onDrop);
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({
      payload: {
        paths: ["/Users/me/Folder", "/Users/me/photo.png", "/Users/me/readme.txt"],
        position: { x: 100, y: 200 },
      },
    });

    expect(onDrop).toHaveBeenCalledWith(
      ["/Users/me/Folder", "/Users/me/photo.png", "/Users/me/readme.txt"],
      100,
      200,
    );
  });

  it("routes folders and existing images after Rust classification with deterministic offsets", async () => {
    const gateway = {
      classifyDropPaths: vi.fn().mockResolvedValue([
        { path: "/Users/me/Folder", kind: "folder", fileName: "Folder", mimeType: null },
        { path: "/Users/me/photo.png", kind: "image", fileName: "photo.png", mimeType: "image/png" },
        { path: "/Users/me/readme.txt", kind: "unsupported", fileName: "readme.txt", mimeType: null },
      ]),
    };
    const createFolder = vi.fn().mockResolvedValue(undefined);
    const createImage = vi.fn().mockResolvedValue(undefined);
    const createFile = vi.fn().mockResolvedValue(undefined);

    await routeNativeDropItems({
      gateway,
      paths: ["/Users/me/Folder", "/Users/me/photo.png", "/Users/me/readme.txt"],
      origin: { x: 400, y: 300 },
      onFolder: createFolder,
      onImage: createImage,
      onFile: createFile,
    });

    expect(gateway.classifyDropPaths).toHaveBeenCalledWith([
      "/Users/me/Folder",
      "/Users/me/photo.png",
      "/Users/me/readme.txt",
    ]);
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/Users/me/Folder", kind: "folder" }),
      { x: 400, y: 300 },
    );
    expect(createImage).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/Users/me/photo.png", kind: "image" }),
      { x: 418, y: 318 },
    );
  });
});
