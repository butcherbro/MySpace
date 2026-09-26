import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import type { SyncState } from "../services/workspace-gateway";
import { formatLastSync, pillState, syncErrorText, useSyncAppliedReload } from "./use-sync-state";
import { SyncStatusPill } from "./SyncStatusPill";

function Reloader(props: {
  gateway: MockWorkspaceGateway;
  openBoardId: string | null;
  reload: (id: string) => void;
  applied: () => void;
}) {
  useSyncAppliedReload(props.gateway, props.openBoardId, props.reload, props.applied);
  return null;
}

const base: SyncState = {
  peers: [],
  discovering: true,
  discoveryError: null,
  syncing: false,
  port: 1,
  addresses: [],
};
const peer = {
  deviceId: "p",
  name: "P",
  online: true,
  discovered: true,
  lastSyncAt: 1,
  lastError: null,
  lastAddress: null,
};

describe("useSyncAppliedReload", () => {
  it("reloads the open board only when sync-applied names it", async () => {
    const gateway = new MockWorkspaceGateway();
    const reload = vi.fn();
    const applied = vi.fn();
    const { rerender } = render(
      <Reloader gateway={gateway} openBoardId="board-a" reload={reload} applied={applied} />,
    );
    await act(async () => {});
    act(() => gateway.emitSyncApplied(["board-b"]));
    expect(reload).not.toHaveBeenCalled();
    expect(applied).toHaveBeenCalledTimes(1);

    act(() => gateway.emitSyncApplied(["board-b", "board-a"]));
    expect(reload).toHaveBeenCalledWith("board-a");

    // Follows the open board without resubscribing.
    rerender(<Reloader gateway={gateway} openBoardId="board-b" reload={reload} applied={applied} />);
    act(() => gateway.emitSyncApplied(["board-b"]));
    expect(reload).toHaveBeenLastCalledWith("board-b");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("stops listening on unmount", async () => {
    const gateway = new MockWorkspaceGateway();
    const reload = vi.fn();
    const { unmount } = render(
      <Reloader gateway={gateway} openBoardId="board-a" reload={reload} applied={() => {}} />,
    );
    await act(async () => {});
    unmount();
    gateway.emitSyncApplied(["board-a"]);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("sync status", () => {
  it("derives the pill state", () => {
    expect(pillState(null)).toBe("unavailable");
    expect(pillState(base)).toBe("no-peers");
    expect(pillState({ ...base, peers: [peer] })).toBe("idle");
    expect(pillState({ ...base, peers: [peer], syncing: true })).toBe("syncing");
    expect(pillState({ ...base, peers: [{ ...peer, lastError: "x" }] })).toBe("error");
  });

  it("formats the last sync time", () => {
    expect(formatLastSync(null)).toBe("Never");
    expect(formatLastSync(1000, 3000)).toBe("just now");
    expect(formatLastSync(0, 30_000)).toBe("30 s ago");
    expect(formatLastSync(0, 5 * 60_000)).toBe("5 min ago");
    expect(syncErrorText("sync: wrong code")).toBe("wrong code");
  });

  it("the pill follows sync-state and opens the dialog", async () => {
    const gateway = new MockWorkspaceGateway();
    const onOpen = vi.fn();
    render(<SyncStatusPill gateway={gateway} onOpen={onOpen} />);
    const pill = await screen.findByTestId("sync-status-pill");
    await waitFor(() => expect(pill).toHaveAttribute("data-state", "no-peers"));
    await act(async () => {
      await gateway.syncPairWith({ address: "10.0.0.2:1", code: "123456" });
    });
    expect(pill).toHaveAttribute("data-state", "idle");
    expect(pill).toHaveTextContent("Synced");
    pill.click();
    expect(onOpen).toHaveBeenCalled();
  });
});
