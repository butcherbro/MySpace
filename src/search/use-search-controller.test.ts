import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SearchResultDto, WorkspaceGateway } from "../services/workspace-gateway";
import { useSearchController } from "./use-search-controller";

function gatewayWith(results: SearchResultDto[]): WorkspaceGateway {
  return {
    searchWorkspace: vi.fn(async () => results),
  } as unknown as WorkspaceGateway;
}

function noteResult(): SearchResultDto {
  return {
    kind: "note",
    entityId: "note-1",
    boardId: "board-7",
    title: "Meeting notes",
    excerpt: null,
    boardTrail: [],
    thumbnailAsset: null,
    createdAt: 0,
  } as unknown as SearchResultDto;
}

function boardResult(): SearchResultDto {
  return {
    kind: "board",
    entityId: "board-9",
    boardId: "board-9",
    title: "Research",
    excerpt: null,
    boardTrail: [],
    thumbnailAsset: null,
    createdAt: 0,
  } as unknown as SearchResultDto;
}

describe("useSearchController", () => {
  it("navigates to the result's board, then focuses its card, then highlights the query", async () => {
    // Order matters: the card can only be focused once its board is rendered.
    const order: string[] = [];
    const navigateTo = vi.fn(async (boardId: string) => {
      order.push(`navigate:${boardId}`);
    });
    const { result } = renderHook(() =>
      useSearchController({
        gateway: gatewayWith([]),
        navigateTo,
        onError: vi.fn(),
      }),
    );

    act(() => result.current.onQueryChange("  meeting  "));
    await act(async () => {
      await result.current.onSelect(noteResult());
    });

    expect(order).toEqual(["navigate:board-7"]);
    expect(navigateTo).toHaveBeenCalledWith("board-7", { pushHistory: true, tabMode: "open" });
    expect(result.current.focusRequest).toEqual({ cardId: "note-1", token: 1 });
    expect(result.current.highlightQuery).toBe("meeting");
    // Selecting a result consumes the query.
    expect(result.current.query).toBe("");
  });

  it("does not focus a card for a board result", async () => {
    const navigateTo = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useSearchController({ gateway: gatewayWith([]), navigateTo, onError: vi.fn() }),
    );

    act(() => result.current.onQueryChange("research"));
    await act(async () => {
      await result.current.onSelect(boardResult());
    });

    expect(navigateTo).toHaveBeenCalledWith("board-9", { pushHistory: true, tabMode: "open" });
    expect(result.current.focusRequest).toBeNull();
    expect(result.current.highlightQuery).toBe("research");
  });

  it("gives every focus request a new token", async () => {
    const { result } = renderHook(() =>
      useSearchController({
        gateway: gatewayWith([]),
        navigateTo: vi.fn(async () => {}),
        onError: vi.fn(),
      }),
    );

    act(() => result.current.onQueryChange("a"));
    await act(async () => {
      await result.current.onSelect(noteResult());
    });
    act(() => result.current.onQueryChange("a"));
    await act(async () => {
      await result.current.onSelect(noteResult());
    });

    expect(result.current.focusRequest).toEqual({ cardId: "note-1", token: 2 });
  });

  it("drops the on-board highlight as soon as the query is edited", () => {
    const { result } = renderHook(() =>
      useSearchController({
        gateway: gatewayWith([]),
        navigateTo: vi.fn(async () => {}),
        onError: vi.fn(),
      }),
    );

    act(() => result.current.onQueryChange("first"));
    act(() => {
      result.current.onQueryChange("second");
    });

    expect(result.current.highlightQuery).toBe("");
  });

  it("reports a failed search to the caller's banner", async () => {
    const onError = vi.fn();
    const gateway = {
      searchWorkspace: vi.fn(async () => {
        throw new Error("search unavailable");
      }),
    } as unknown as WorkspaceGateway;

    const { result } = renderHook(() =>
      useSearchController({ gateway, navigateTo: vi.fn(async () => {}), onError }),
    );

    act(() => result.current.onQueryChange("boom"));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("search unavailable"));
  });
});
