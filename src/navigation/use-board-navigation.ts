import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardSnapshot, WorkspaceGateway } from "../services/workspace-gateway";
import { BoardHistory } from "./board-history";
import {
  activateBoardTab,
  closeBoardTab,
  createBoardTabs,
  navigateBoardTab,
  reorderBoardTabs,
  type BoardTab,
  type BoardTabsState,
} from "./board-tabs";

/**
 * Board navigation controller: the spine that loads a board's snapshot, keeps
 * the open-board tabs and the back/forward history in step with it, and refuses
 * to let a slow load overwrite a newer navigation.
 *
 * The controller owns navigation state only. Pending writes are drained through
 * an injected barrier (the queue and viewport flushes belong to their own
 * controllers), and the loaded snapshot is handed to the caller, which owns how
 * the store is shaped — note documents are normalized there.
 *
 * Extracted from `App.tsx` unchanged (Task 17, extraction 6 of 6).
 */

export interface BoardNavigationOptions {
  gateway: WorkspaceGateway;
  /**
   * Drains pending writes before the projection is replaced, so a debounced
   * save cannot be abandoned by navigation.
   */
  drainPendingWrites: () => Promise<void>;
  /** Taken right before the snapshot is requested; handed back with it. */
  stampSnapshotRequest: () => number;
  /** Applies a loaded snapshot to the store. */
  onSnapshotLoaded: (snapshot: BoardSnapshot, requestStamp: number) => void;
}

type NavigateOptions = Parameters<BoardNavigation["navigateTo"]>[1];

export interface BoardNavigation {
  /** Open-board tabs, or null until `initialize` has run. */
  tabs: BoardTabsState | null;
  /** Seeds the tabs and the history with the first board that loaded. */
  initialize: (snapshot: BoardSnapshot) => void;
  navigateTo: (
    boardId: string,
    options?: {
      pushHistory?: boolean;
      tabMode?: "open" | "sync";
      /**
       * A reload of the board already open (stale answer, change poll, sync,
       * undo). It never supersedes a user navigation in flight, only an older
       * reload. Next to a user navigation to the same board it is dropped (that
       * navigation loads a fresh snapshot anyway); next to one to another board
       * it waits and runs only if that navigation ends without switching boards.
       */
      reload?: boolean;
    },
  ) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  activateTab: (boardId: string) => void;
  closeTab: (boardId: string) => void;
  reorderTabs: (boardId: string, toIndex: number) => void;
}

function tabFrom(snapshot: BoardSnapshot): BoardTab {
  return {
    boardId: snapshot.board.id,
    title: snapshot.board.title,
    colorToken: snapshot.board.colorToken,
    symbol: snapshot.board.symbol,
    coverAsset: snapshot.board.coverAsset,
  };
}

export function useBoardNavigation(options: BoardNavigationOptions): BoardNavigation {
  const { gateway, drainPendingWrites, stampSnapshotRequest, onSnapshotLoaded } = options;

  const historyRef = useRef<BoardHistory | null>(null);
  // Browser-like open-board tabs (session-only). Initialized lazily once Home is
  // known; the active tab always mirrors the currently loaded board.
  const [tabs, setTabs] = useState<BoardTabsState | null>(null);
  const tabsRef = useRef<BoardTabsState | null>(null);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Latest-wins navigation guard: a slow snapshot load must never overwrite a
  // newer navigation. Each call claims a monotonically increasing token before
  // awaiting; the snapshot is applied only if no newer call has started.
  const navigationTokenRef = useRef(0);
  // The navigation holding the current token, until it finishes.
  const inFlightRef = useRef<{ target: string; reload: boolean } | null>(null);
  // A reload that yielded to a user navigation to another board; it runs if
  // that navigation ends without switching the board.
  const yieldedReloadRef = useRef<string | null>(null);

  const navigateTo = useCallback(
    (boardId: string, opts?: NavigateOptions): Promise<void> => {
      const go = async (boardId: string, opts?: NavigateOptions): Promise<void> => {
        // Перезагрузка не отменяет начатый пользователем переход: иначе теряется
        // клик по вкладке, а для той же доски — запись в истории и открытие
        // вкладки. Переход на ту же доску и так загрузит свежий снимок;
        // перезагрузку другой доски запоминаем на случай, если переход её не сменит.
        const inFlight = inFlightRef.current;
        if (opts?.reload && inFlight !== null && !inFlight.reload) {
          if (inFlight.target !== boardId) yieldedReloadRef.current = boardId;
          return;
        }
        const token = ++navigationTokenRef.current;
        inFlightRef.current = { target: boardId, reload: opts?.reload === true };
        let switched = false;
        try {
          // Flush any pending note/viewport writes before replacing the projection,
          // so a debounced save cannot be abandoned by navigation.
          await drainPendingWrites();
          if (navigationTokenRef.current !== token) return; // a newer navigation started
          const requestStamp = stampSnapshotRequest();
          const snapshot = await gateway.loadBoardSnapshot(boardId);
          if (navigationTokenRef.current !== token) return; // superseded while loading
          if (opts?.pushHistory && historyRef.current) {
            historyRef.current.push(boardId);
          }
          const tabMode = opts?.tabMode ?? "sync";
          // Track the board as an open tab: explicit navigation opens/activates a
          // tab; a reload just re-syncs the active id to the loaded board.
          setTabs((prev) => {
            const tab = tabFrom(snapshot);
            const base = prev ?? createBoardTabs(tab);
            const withHome = base.tabs.length === 0 ? createBoardTabs(tab) : base;
            const next = navigateBoardTab(withHome, tab, tabMode);
            return tabMode === "sync" ? activateBoardTab(next, snapshot.board.id) : next;
          });
          onSnapshotLoaded(snapshot, requestStamp);
          switched = true;
        } finally {
          if (navigationTokenRef.current === token) {
            inFlightRef.current = null;
            const yielded = yieldedReloadRef.current;
            yieldedReloadRef.current = null;
            // Переход упал — открыта всё ещё прежняя доска, и её перезагрузка нужна.
            if (yielded !== null && !switched) void go(yielded, { reload: true }).catch(() => undefined);
          }
        }
      };
      return go(boardId, opts);
    },
    [drainPendingWrites, gateway, stampSnapshotRequest, onSnapshotLoaded],
  );

  const initialize = useCallback((snapshot: BoardSnapshot) => {
    historyRef.current = new BoardHistory(snapshot.board.id);
    setTabs(createBoardTabs(tabFrom(snapshot)));
  }, []);

  const goBack = useCallback(() => {
    const previous = historyRef.current?.back();
    if (previous) void navigateTo(previous, { tabMode: "open" });
  }, [navigateTo]);

  const goForward = useCallback(() => {
    const next = historyRef.current?.forward();
    if (next) void navigateTo(next, { tabMode: "open" });
  }, [navigateTo]);

  // Tab interactions: switching loads the board (no history push); closing
  // removes the tab and, if it was active, navigates to the neighbor.
  const activateTab = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { tabMode: "sync" });
    },
    [navigateTo],
  );

  const closeTab = useCallback(
    (boardId: string) => {
      const previous = tabsRef.current;
      if (!previous) return;
      const next = closeBoardTab(previous, boardId);
      setTabs(next);
      if (next.activeBoardId !== previous.activeBoardId) {
        void navigateTo(next.activeBoardId, { tabMode: "sync" });
      }
    },
    [navigateTo],
  );

  // Tab drag reorder: purely local session state, no snapshot reload.
  const reorderTabs = useCallback((boardId: string, toIndex: number) => {
    setTabs((prev) => (prev ? reorderBoardTabs(prev, boardId, toIndex) : prev));
  }, []);

  return { tabs, initialize, navigateTo, goBack, goForward, activateTab, closeTab, reorderTabs };
}
