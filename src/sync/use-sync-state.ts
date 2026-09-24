import { useEffect, useRef, useState } from "react";
import type { SyncState, WorkspaceGateway } from "../services/workspace-gateway";

/**
 * The LAN sync state (ADR-0011 S3): read once, then kept current by the
 * backend's `sync-state` event. `null` until the first read; stays `null`
 * when sync is unavailable (the read rejects, e.g. in recovery mode).
 */
export function useSyncState(gateway: WorkspaceGateway): [SyncState | null, (s: SyncState) => void] {
  const [state, setState] = useState<SyncState | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // An event is always newer than the initial read: once one arrived, a
    // late answer to the read must not overwrite it.
    let eventSeen = false;
    gateway
      .onSyncState((s) => {
        eventSeen = true;
        if (!disposed) setState(s);
      })
      .then(
        (remove) => {
          if (disposed) remove();
          else unlisten = remove;
        },
        () => {},
      );
    gateway.getSyncState().then(
      (s) => {
        if (!disposed && !eventSeen) setState(s);
      },
      () => {},
    );
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [gateway]);
  return [state, setState];
}

/**
 * Reloads the open board when a sync pass changed it (`sync-applied` carries
 * the touched local board ids). Replays commit on the app's own writer, so
 * the external-change poll does not see them; this is their reload path.
 * `onApplied` runs for every event (the trash may have changed too).
 */
export function useSyncAppliedReload(
  gateway: WorkspaceGateway,
  openBoardId: string | null,
  reloadBoard: (boardId: string) => void,
  onApplied?: () => void,
): void {
  // Read through a ref so the subscription is made once per gateway while
  // always seeing the current board and callbacks.
  const latest = useRef({ openBoardId, reloadBoard, onApplied });
  useEffect(() => {
    latest.current = { openBoardId, reloadBoard, onApplied };
  });
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    gateway
      .onSyncApplied((boardIds) => {
        if (disposed) return;
        const { openBoardId: open, reloadBoard: reload, onApplied: applied } = latest.current;
        if (open !== null && boardIds.includes(open)) reload(open);
        applied?.();
      })
      .then(
        (remove) => {
          if (disposed) remove();
          else unlisten = remove;
        },
        () => {},
      );
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [gateway]);
}

export type SyncPillState = "no-peers" | "syncing" | "error" | "idle" | "unavailable";

/** What the top-bar pill shows for a state. */
export function pillState(state: SyncState | null): SyncPillState {
  if (state === null) return "unavailable";
  if (state.peers.length === 0) return "no-peers";
  if (state.syncing) return "syncing";
  if (state.peers.some((p) => p.lastError !== null)) return "error";
  return "idle";
}

/** Strips the IPC error code prefix for display ("sync: wrong code" → "wrong code"). */
export function syncErrorText(message: string): string {
  return message.replace(/^(sync|constraint_violation|database|not_found): /, "");
}

/** "Never", "just now", "3 min ago", or a date for older syncs. */
export function formatLastSync(at: number | null, now: number = Date.now()): string {
  if (at === null) return "Never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
