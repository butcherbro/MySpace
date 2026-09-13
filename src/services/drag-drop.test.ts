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

  it("tears down a listener that registers after cleanup and never delivers to it", async () => {
    type Listener = (event: {
      payload: { paths: string[]; position: { x: number; y: number } };
    }) => void;
    let captured: Listener | undefined;
    let resolveListen: ((stop: () => void) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation((_event: string, callback: Listener) => {
      captured = callback;
      return new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      });
    });
    const onDrop = vi.fn();

    const unsubscribe = subscribeToNativeDrops(onDrop);
    // Cleanup runs while registration is still in flight.
    unsubscribe();

    await vi.waitFor(() => expect(captured).toBeDefined());
    resolveListen?.(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));

    // The late listener is unlistened exactly once, not left live.
    expect(unlisten).toHaveBeenCalledTimes(1);
    // A drop arriving through it must not reach the application either.
    captured?.({ payload: { paths: ["/Users/me/late.png"], position: { x: 1, y: 2 } } });
    expect(onDrop).not.toHaveBeenCalled();

    // A second cleanup must not double-unlisten.
    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens on cleanup when registration already completed", async () => {
    const unlisten = vi.fn();
    listenMock.mockImplementation(async () => unlisten);
    const onDrop = vi.fn();

    const unsubscribe = subscribeToNativeDrops(onDrop);
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(0));

    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("swallows a registration failure instead of leaking a rejection", async () => {
    listenMock.mockRejectedValue(new Error("listen denied"));
    const onDrop = vi.fn();

    const unsubscribe = subscribeToNativeDrops(onDrop);
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());
    await Promise.resolve();

    expect(() => unsubscribe()).not.toThrow();
    expect(onDrop).not.toHaveBeenCalled();
  });
});
