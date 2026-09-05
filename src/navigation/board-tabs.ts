// Browser-like open-board tabs (session-only).
//
// A tab is just an open Board: its id and a title for the strip. Tabs are
// stable references to Boards, never copies, and closing a tab never deletes
// its Board (it only removes the tab). Home is always the leftmost tab and
// cannot be closed, so there is always at least one tab.
//
// This model is independent of the active board's content projection: switching
// a tab re-runs the existing `navigateTo` path. Per-tab viewport/selection
// persistence is intentionally out of scope for this slice (the board reopens
// pinned to its top-left origin anyway, per the current store).

export interface BoardTab {
  boardId: string;
  title: string;
}

export interface BoardTabsState {
  /** The id of the Home board; used so Home stays pinned even with UUID ids. */
  homeBoardId: string;
  /** Ordered tabs, left-to-right (Home first). */
  tabs: BoardTab[];
  /** The id of the active tab. Invariant: always set. */
  activeBoardId: string;
}

export function createBoardTabs(homeId: string, homeTitle: string): BoardTabsState {
  return {
    homeBoardId: homeId,
    tabs: [{ boardId: homeId, title: homeTitle }],
    activeBoardId: homeId,
  };
}

/** Opens (or activates) a board tab. Already-open boards activate in place. */
export function openBoardTab(
  state: BoardTabsState,
  boardId: string,
  title: string,
): BoardTabsState {
  const existing = state.tabs.find((t) => t.boardId === boardId);
  if (existing) {
    return {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.boardId === boardId ? { ...tab, title } : tab,
      ),
      activeBoardId: boardId,
    };
  }
  return {
    homeBoardId: state.homeBoardId,
    tabs: [...state.tabs, { boardId, title }],
    activeBoardId: boardId,
  };
}

/** Syncs the title of an already-open tab without opening or reordering tabs. */
export function syncBoardTab(
  state: BoardTabsState,
  boardId: string,
  title: string,
): BoardTabsState {
  if (!state.tabs.some((t) => t.boardId === boardId)) {
    return state;
  }
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.boardId === boardId ? { ...tab, title } : tab,
    ),
  };
}

/** Applies a navigation intent to tabs. Open recreates missing tabs; sync does not. */
export function navigateBoardTab(
  state: BoardTabsState,
  boardId: string,
  title: string,
  mode: "open" | "sync",
): BoardTabsState {
  return mode === "open"
    ? openBoardTab(state, boardId, title)
    : syncBoardTab(state, boardId, title);
}

/**
 * Closes a tab. Home cannot be closed. Closing the active tab activates its
 * nearest right neighbor if any, otherwise its left neighbor.
 */
export function closeBoardTab(
  state: BoardTabsState,
  boardId: string,
): BoardTabsState {
  if (boardId === state.homeBoardId) {
    return state;
  }
  const idx = state.tabs.findIndex((t) => t.boardId === boardId);
  if (idx < 0) {
    return state;
  }

  const tabs = state.tabs.filter((t) => t.boardId !== boardId);
  let activeBoardId = state.activeBoardId;
  if (state.activeBoardId === boardId) {
    // Prefer the tab now at the same index (the old right neighbor); fall back
    // to the previous tab; Home guarantees at least one tab remains.
    activeBoardId = tabs[Math.min(idx, tabs.length - 1)].boardId;
  }
  return { homeBoardId: state.homeBoardId, tabs, activeBoardId };
}

/** Activates a tab without changing the set of open tabs. */
export function activateBoardTab(
  state: BoardTabsState,
  boardId: string,
): BoardTabsState {
  if (!state.tabs.some((t) => t.boardId === boardId)) {
    return state;
  }
  return { ...state, activeBoardId: boardId };
}
