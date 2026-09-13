import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardDto } from "../services/workspace-gateway";
import { useCrossBoardDragSession } from "./use-cross-board-drag";

/** A DOM stand-in for the regions the session hit-tests. */
function fakeElement(attrs: { dropId?: string; tabBoardId?: string; quick?: boolean }): Element {
  const attribute = (value: string | undefined) => () => value ?? null;
  return {
    closest: (selector: string) => {
      if (selector === "[data-board-drop-id]" && attrs.dropId) {
        return { getAttribute: attribute(attrs.dropId) };
      }
      if (selector === "[data-quick-boards-drop]" && attrs.quick) return { getAttribute: () => null };
      if (selector === "[data-testid='board-tab']" && attrs.tabBoardId) {
        return { getAttribute: attribute(attrs.tabBoardId) };
      }
      return null;
    },
  } as unknown as Element;
}

function note(id: string, boardId: string, revision = 1): CardDto {
  return {
    id,
    kind: "note",
    boardId,
    revision,
    frame: { x: 0, y: 0, width: 200, height: 80 },
    plainText: `note ${id}`,
  } as unknown as CardDto;
}

function harness(
  overrides: {
    cards?: CardDto[];
    selection?: string[];
    boardId?: string;
    screenToFlow?: ((x: number, y: number) => { x: number; y: number }) | null;
  } = {},
) {
  const navigateTo = vi.fn(async () => {});
  const resolver = vi.fn(() => true);
  // Exposed so a test can switch the open board, as navigation does in the app.
  const boardRef = { current: { id: overrides.boardId ?? "board-a" } as { id: string } | null };
  const { result } = renderHook(() =>
    useCrossBoardDragSession({
      cardsRef: { current: overrides.cards ?? [note("n1", "board-a"), note("n2", "board-a")] },
      boardRef,
      selectionRef: { current: overrides.selection ?? [] },
      screenToFlowRef: { current: overrides.screenToFlow ?? (() => ({ x: 500, y: 600 })) },
      navigateTo,
    }),
  );
  act(() => result.current.setDragEndResolver(resolver));
  return { result, navigateTo, resolver, boardRef };
}

function at(element: Element) {
  Object.defineProperty(document, "elementFromPoint", {
    value: () => element,
    configurable: true,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useCrossBoardDragSession", () => {
  it("starts a session on the first move and reports the hovered regions", () => {
    const test = harness();
    at(fakeElement({ dropId: "board-b", quick: true }));

    act(() =>
      test.result.current.onDragMove({ cardId: "n1", clientX: 10, clientY: 20 }),
    );

    expect(test.result.current.drag?.sourceBoardId).toBe("board-a");
    expect(test.result.current.drag?.cards.map((c) => c.cardId)).toEqual(["n1"]);
    expect(test.result.current.dropTargetBoardId).toBe("board-b");
    expect(test.result.current.overQuickBoards).toBe(true);
  });

  it("drags the whole selection when the dragged card is part of one", () => {
    const test = harness({ selection: ["n1", "n2"] });
    at(fakeElement({}));

    act(() =>
      test.result.current.onDragMove({ cardId: "n1", clientX: 10, clientY: 20 }),
    );

    expect(test.result.current.drag?.cards.map((c) => c.cardId)).toEqual(["n1", "n2"]);
  });

  it("opens the hovered tab after the hold delay and then follows the pointer on window", async () => {
    vi.useFakeTimers();
    const test = harness();
    at(fakeElement({ tabBoardId: "board-b" }));

    act(() =>
      test.result.current.onDragMove({ cardId: "n1", clientX: 10, clientY: 20 }),
    );
    expect(test.navigateTo).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(test.navigateTo).toHaveBeenCalledWith("board-b", { tabMode: "open" });
    expect(test.result.current.drag?.phase).toBe("previewing");

    // React Flow stops firing drags once the snapshot swaps: the window takes
    // over and resolves the drop on release.
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(test.resolver).toHaveBeenCalledTimes(1);
  });

  it("does not start a second, separate hover timer while the tab stays hovered", async () => {
    vi.useFakeTimers();
    const test = harness();
    at(fakeElement({ tabBoardId: "board-b" }));

    act(() => test.result.current.onDragMove({ cardId: "n1", clientX: 10, clientY: 20 }));
    act(() => test.result.current.onDragMove({ cardId: "n1", clientX: 12, clientY: 22 }));

    await act(async () => {
      vi.advanceTimersByTime(600);
      // Let the hover-open's navigation settle, so its state update is in act.
      await Promise.resolve();
    });

    expect(test.navigateTo).toHaveBeenCalledTimes(1);
  });

  it("resolves a preview into a drop frame, and cancelling keeps the source", async () => {
    vi.useFakeTimers();
    const test = harness({ screenToFlow: () => ({ x: 500, y: 600 }) });
    at(fakeElement({ tabBoardId: "board-b" }));

    act(() => test.result.current.onDragMove({ cardId: "n1", clientX: 10, clientY: 20 }));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    // The hover opened board B, so the pointer is now over board B's canvas.
    act(() => {
      test.boardRef.current = { id: "board-b" };
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 60 }));
    });
    vi.useRealTimers();

    let drop: ReturnType<typeof test.result.current.takeDragEnd> | null = null;
    act(() => {
      drop = test.result.current.takeDragEnd();
    });
    const resolved = drop as unknown as ReturnType<typeof test.result.current.takeDragEnd>;

    expect(resolved.cardId).toBe("n1");
    expect(resolved.crossBoard?.drag.phase).toBe("previewing");
    expect(resolved.crossBoard?.targetBoardId).toBe("board-b");
    // The ghost is centered on the pointer.
    expect(resolved.crossBoard?.frame).toEqual({ x: 400, y: 560, width: 200, height: 80 });

    act(() => resolved.cancelCrossBoard());
    expect(test.result.current.drag?.phase).toBe("cancelled");
    expect(test.result.current.dropTargetBoardId).toBeNull();
  });

  it("returns no cross-board drop when the drag never previewed", () => {
    const test = harness();
    at(fakeElement({ dropId: "board-b" }));

    act(() => test.result.current.onDragMove({ cardId: "n1", clientX: 10, clientY: 20 }));

    let drop: ReturnType<typeof test.result.current.takeDragEnd> | null = null;
    act(() => {
      drop = test.result.current.takeDragEnd();
    });
    const ended = drop as unknown as ReturnType<typeof test.result.current.takeDragEnd>;

    expect(ended.crossBoard).toBeNull();
    expect(ended.dropTargetBoardId).toBe("board-b");
    expect(ended.groupIds).toEqual(["n1"]);
    // The gesture is cleared, so a second drag-end cannot re-consume it.
    expect(test.result.current.drag).toBeNull();
  });
});
