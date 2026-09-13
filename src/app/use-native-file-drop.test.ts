import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardDto, DropPathClassificationDto } from "../services/workspace-gateway";
import { useNativeFileDrop } from "./use-native-file-drop";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  route: vi.fn(),
}));

vi.mock("../services/drag-drop", () => ({
  subscribeToNativeDrops: mocks.subscribe,
  routeNativeDropItems: mocks.route,
}));

type DropHandler = (paths: string[], x: number, y: number) => void;

function imageItem(): DropPathClassificationDto {
  return {
    kind: "image",
    path: "/tmp/photo.png",
    fileName: "photo.png",
    mimeType: "image/png",
  } as unknown as DropPathClassificationDto;
}

function harness(
  overrides: {
    screenToFlow?: ((x: number, y: number) => { x: number; y: number }) | null;
    cards?: number;
  } = {},
) {
  let handler: DropHandler | null = null;
  const unsubscribe = vi.fn();
  mocks.subscribe.mockImplementation((next: DropHandler) => {
    handler = next;
    return unsubscribe;
  });
  mocks.route.mockResolvedValue(undefined);

  const onCreateFolder = vi.fn(async () => {});
  const onCreateImage = vi.fn(async () => {});
  const onCreateFile = vi.fn(async () => {});
  const onError = vi.fn();

  const rendered = renderHook(() =>
    useNativeFileDrop({
      gateway: { classifyDropPaths: vi.fn() } as never,
      screenToFlowRef: { current: overrides.screenToFlow ?? null },
      cardsRef: { current: new Array(overrides.cards ?? 0).fill({}) as CardDto[] },
      onCreateFolder,
      onCreateImage,
      onCreateFile,
      onError,
    }),
  );

  return {
    ...rendered,
    onCreateFolder,
    onCreateImage,
    onCreateFile,
    onError,
    unsubscribe,
    drop: (paths: string[], x = 100, y = 200) => {
      act(() => handler?.(paths, x, y));
    },
    lastRouteInput: () => mocks.route.mock.calls[mocks.route.mock.calls.length - 1]?.[0] as {
      origin: { x: number; y: number };
      onFolder: (item: unknown, point: { x: number; y: number }) => Promise<void>;
      onImage: (item: unknown, point: { x: number; y: number }) => Promise<void>;
      onFile: (item: unknown, point: { x: number; y: number }) => Promise<void>;
    },
  };
}

describe("useNativeFileDrop", () => {
  beforeEach(() => {
    mocks.subscribe.mockReset();
    mocks.route.mockReset();
  });

  it("routes a drop at the cursor converted into canvas coordinates", () => {
    // Screen 100/200 maps to canvas 500/600, and the drop origin is the canvas
    // point pulled up and left so the Card lands under the cursor.
    const test = harness({ screenToFlow: () => ({ x: 500, y: 600 }) });

    test.drop(["/tmp/photo.png"], 100, 200);

    expect(test.lastRouteInput().origin).toEqual({ x: 320, y: 450 });
  });

  it("falls back to a cascading default when the canvas cannot convert yet", () => {
    const test = harness({ cards: 3 });

    test.drop(["/tmp/photo.png"], 100, 200);

    // 80 + 3 * 24 = 152, then the same pull-up offset.
    expect(test.lastRouteInput().origin).toEqual({ x: -100, y: 2 });
  });

  it("passes each kind to its own creator with the small fan-out offsets", async () => {
    const test = harness({ screenToFlow: () => ({ x: 500, y: 600 }) });
    test.drop(["/tmp/photo.png"]);
    const routed = test.lastRouteInput();

    await routed.onImage(imageItem(), { x: 10, y: 20 });
    expect(test.onCreateImage).toHaveBeenCalledWith(
      "/tmp/photo.png",
      "photo.png",
      "image/png",
      30,
      50,
    );

    await routed.onFolder({ path: "/tmp/folder" } as never, { x: 10, y: 20 });
    expect(test.onCreateFolder).toHaveBeenCalledWith("/tmp/folder", 10, 20);

    await routed.onFile({ path: "/tmp/a.md" } as never, { x: 10, y: 20 });
    expect(test.onCreateFile).toHaveBeenCalledWith(
      { path: "/tmp/a.md", fileName: "file", mimeType: "text/plain" },
      10,
      20,
    );
  });

  it("reports a failed routing on the caller's banner", async () => {
    const test = harness();
    // Set after the harness, which installs the default resolution.
    mocks.route.mockRejectedValue(new Error("classification failed"));
    test.drop(["/tmp/photo.png"]);

    await waitFor(() => expect(test.onError).toHaveBeenCalledWith("classification failed"));
  });

  it("unsubscribes on unmount", () => {
    const test = harness();
    test.unmount();
    expect(test.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
