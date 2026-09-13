import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SearchResultDto, WorkspaceGateway } from "../services/workspace-gateway";
import { useWorkspaceSearch } from "./use-workspace-search";

type Invoke = ReturnType<typeof vi.fn>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hit(entityId: string): SearchResultDto {
  return {
    entityId,
    kind: "note",
    title: entityId,
    excerpt: null,
    boardId: "home",
    boardTrail: [{ id: "home", title: "Home" }],
    boardColorToken: "default",
    boardSymbol: null,
    boardCoverAsset: null,
    thumbnailAsset: null,
    createdAt: 0,
  };
}

function gatewayWith(searchWorkspace: Invoke): WorkspaceGateway {
  return { searchWorkspace } as unknown as WorkspaceGateway;
}

/** Wait until the gateway has seen `count` requests (deterministic under load). */
async function flushUntil(searchWorkspace: Invoke, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (searchWorkspace.mock.calls.length >= count) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error(`gateway saw ${searchWorkspace.mock.calls.length} requests, expected ${count}`);
}

/**
 * Settle a deferred request and let the hook's `.then/.catch/.finally` chain run
 * to completion. Awaiting the original promise is not enough: the chain continues
 * in later microtasks, and a macrotask tick flushes all of them.
 */
async function settle(settle: () => void): Promise<void> {
  await act(async () => {
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function twoPendingRequests() {
  const older = deferred<SearchResultDto[]>();
  const newer = deferred<SearchResultDto[]>();
  const searchWorkspace = vi
    .fn()
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);
  return { older, newer, searchWorkspace };
}

describe("useWorkspaceSearch", () => {
  it("keeps the newest results when the older request resolves last", async () => {
    const { older, newer, searchWorkspace } = twoPendingRequests();
    const gateway = gatewayWith(searchWorkspace);
    const { result: hook } = renderHook(() => useWorkspaceSearch(gateway, 0));

    act(() => hook.current.setQuery("pro"));
    await flushUntil(searchWorkspace, 1);
    act(() => hook.current.setQuery("project"));
    await flushUntil(searchWorkspace, 2);
    expect(searchWorkspace.mock.calls.map((call) => call[0])).toEqual(["pro", "project"]);

    // The newer query answers first ...
    await settle(() => newer.resolve([hit("project-hit")]));
    expect(hook.current.results.map((r) => r.entityId)).toEqual(["project-hit"]);
    expect(hook.current.loading).toBe(false);

    // ... and the stale answer must not replace it.
    await settle(() => older.resolve([hit("pro-hit")]));
    expect(hook.current.results.map((r) => r.entityId)).toEqual(["project-hit"]);
    expect(hook.current.loading).toBe(false);
  });

  it("does not let a stale response clear loading while a newer request is in flight", async () => {
    const { older, newer, searchWorkspace } = twoPendingRequests();
    const gateway = gatewayWith(searchWorkspace);
    const { result: hook } = renderHook(() => useWorkspaceSearch(gateway, 0));

    act(() => hook.current.setQuery("pro"));
    await flushUntil(searchWorkspace, 1);
    act(() => hook.current.setQuery("project"));
    await flushUntil(searchWorkspace, 2);
    expect(hook.current.loading).toBe(true);

    // The stale request settles while the newer one is still pending.
    await settle(() => older.resolve([hit("pro-hit")]));
    expect(hook.current.loading).toBe(true);
    expect(hook.current.results).toEqual([]);

    await settle(() => newer.resolve([hit("project-hit")]));
    expect(hook.current.loading).toBe(false);
    expect(hook.current.results.map((r) => r.entityId)).toEqual(["project-hit"]);
  });

  it("ignores a stale failure instead of reporting it", async () => {
    const { older, newer, searchWorkspace } = twoPendingRequests();
    const gateway = gatewayWith(searchWorkspace);
    const { result: hook } = renderHook(() => useWorkspaceSearch(gateway, 0));

    act(() => hook.current.setQuery("pro"));
    await flushUntil(searchWorkspace, 1);
    act(() => hook.current.setQuery("project"));
    await flushUntil(searchWorkspace, 2);
    older.promise.catch(() => undefined);

    await settle(() => older.reject(new Error("stale failure")));
    expect(hook.current.error).toBeNull();

    await settle(() => newer.resolve([hit("project-hit")]));
    expect(hook.current.error).toBeNull();
    expect(hook.current.results.map((r) => r.entityId)).toEqual(["project-hit"]);
  });

  it("invalidates pending requests and clears results when the query empties", async () => {
    const pending = deferred<SearchResultDto[]>();
    const searchWorkspace = vi.fn().mockReturnValueOnce(pending.promise);
    const gateway = gatewayWith(searchWorkspace);
    const { result: hook } = renderHook(() => useWorkspaceSearch(gateway, 0));

    act(() => hook.current.setQuery("pro"));
    await flushUntil(searchWorkspace, 1);
    expect(hook.current.loading).toBe(true);

    act(() => hook.current.setQuery(""));
    expect(hook.current.results).toEqual([]);
    expect(hook.current.loading).toBe(false);

    // A late answer for the abandoned query must not repopulate the list.
    await settle(() => pending.resolve([hit("pro-hit")]));
    expect(hook.current.results).toEqual([]);
    expect(hook.current.loading).toBe(false);
  });
});
