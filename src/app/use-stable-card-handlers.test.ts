import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStableCardHandlers, type StableCardHandlersDeps } from "./use-stable-card-handlers";

function makeDeps(overrides: Partial<StableCardHandlersDeps> = {}): StableCardHandlersDeps {
  return {
    onDeactivate: vi.fn(),
    onUpdateNote: vi.fn(async () => {}),
    onFinalizeNote: vi.fn(async () => {}),
    onUpdateImageCaption: vi.fn(async () => {}),
    onFinalizeImageCaption: vi.fn(async () => {}),
    onUpdateEmbedDescription: vi.fn(async () => {}),
    onFinalizeEmbedDescription: vi.fn(async () => {}),
    onRetryEmbedMetadata: vi.fn(),
    onOpenBoard: vi.fn(),
    onRenameBoard: vi.fn(),
    onContextMenu: vi.fn(),
    onResizeNote: vi.fn(),
    onResizeImage: vi.fn(),
    onResizeEmbed: vi.fn(),
    onResizeFilesystemAlias: vi.fn(),
    onLoadFolderPreview: vi.fn(async () => ({ entries: [] }) as never),
    onOpenFolderInFinder: vi.fn(),
    onPointFolderShortcutHere: vi.fn(),
    onOpenFileCard: vi.fn(),
    onRevealFileCard: vi.fn(),
    onResizeFileCard: vi.fn(),
    onNoteCommands: vi.fn(),
    onNoteBoldStateChange: vi.fn(),
    onNoteItalicStateChange: vi.fn(),
    onNoteStrikeStateChange: vi.fn(),
    onNoteTextColorChange: vi.fn(),
    ...overrides,
  };
}

describe("useStableCardHandlers", () => {
  it("exposes every handler key from the deps", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useStableCardHandlers(deps));

    expect(Object.keys(result.current).sort()).toEqual(Object.keys(deps).sort());
  });

  it("keeps the same facade identity across rerenders with new handlers", () => {
    const deps = makeDeps();
    const { result, rerender } = renderHook((props: StableCardHandlersDeps) => useStableCardHandlers(props), {
      initialProps: deps,
    });
    const firstFacade = result.current;

    rerender(makeDeps());

    expect(result.current).toBe(firstFacade);
  });

  it("calling a facade method after a rerender invokes the newest handler with the same arguments", () => {
    const deps = makeDeps();
    const { result, rerender } = renderHook((props: StableCardHandlersDeps) => useStableCardHandlers(props), {
      initialProps: deps,
    });

    const nextOnOpenBoard = vi.fn();
    rerender(makeDeps({ onOpenBoard: nextOnOpenBoard }));

    result.current.onOpenBoard("board-1");

    expect(nextOnOpenBoard).toHaveBeenCalledWith("board-1");
    expect(deps.onOpenBoard).not.toHaveBeenCalled();
  });

  it("passes through arguments verbatim for a multi-argument handler", () => {
    const deps = makeDeps();
    const { result, rerender } = renderHook((props: StableCardHandlersDeps) => useStableCardHandlers(props), {
      initialProps: deps,
    });

    const nextOnResizeNote = vi.fn();
    rerender(makeDeps({ onResizeNote: nextOnResizeNote }));

    result.current.onResizeNote("card-1", 100, 200, { auto: true } as never);

    expect(nextOnResizeNote).toHaveBeenCalledWith("card-1", 100, 200, { auto: true });
  });
});
