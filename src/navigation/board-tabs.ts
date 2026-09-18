// Browser-like open-board tabs (session-only).
//
// A tab is just an open Board: its id, title, and visual identity (color/symbol
// or cover) for the strip. Tabs are stable references to Boards, never copies,
// and closing a tab never deletes its Board (it only removes the tab). Home is
// always the leftmost tab and cannot be closed, so there is always at least one
// tab.
//
// This model is independent of the active board's content projection: switching
// a tab re-runs the existing `navigateTo` path. Per-tab viewport/selection
// persistence is intentionally out of scope for this slice (the board reopens
// pinned to its top-left origin anyway, per the current store).

import type { AssetDto } from "../services/workspace-gateway";

/** The visual identity of a Board: color/symbol fallback or a cover image. */
export interface BoardVisualIdentity {
  colorToken: string;
  symbol: string | null;
  coverAsset: AssetDto | null;
}

export interface BoardTab extends BoardVisualIdentity {
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

export function createBoardTabs(homeTab: BoardTab): BoardTabsState {
  return {
    homeBoardId: homeTab.boardId,
    tabs: [homeTab],
    activeBoardId: homeTab.boardId,
  };
}

/** Opens (or activates) a board tab. Already-open boards activate in place. */
export function openBoardTab(state: BoardTabsState, tab: BoardTab): BoardTabsState {
  const existing = state.tabs.find((t) => t.boardId === tab.boardId);
  if (existing) {
    return {
      ...state,
      tabs: state.tabs.map((t) => (t.boardId === tab.boardId ? { ...t, ...tab } : t)),
      activeBoardId: tab.boardId,
    };
  }
  return {
    homeBoardId: state.homeBoardId,
    tabs: [...state.tabs, tab],
    activeBoardId: tab.boardId,
  };
}

/** Syncs the identity of an already-open tab without opening or reordering tabs. */
export function syncBoardTab(state: BoardTabsState, tab: BoardTab): BoardTabsState {
  if (!state.tabs.some((t) => t.boardId === tab.boardId)) {
    return state;
  }
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.boardId === tab.boardId ? { ...t, ...tab } : t)),
  };
}

/** Applies a navigation intent to tabs. Open recreates missing tabs; sync does not. */
export function navigateBoardTab(
  state: BoardTabsState,
  tab: BoardTab,
  mode: "open" | "sync",
): BoardTabsState {
  return mode === "open" ? openBoardTab(state, tab) : syncBoardTab(state, tab);
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

/**
 * Moves a tab to `toIndex` (browser-tab drag reorder). Home stays pinned at
 * index 0 and can neither move nor be displaced — `toIndex` is clamped to
 * at least 1, and moving Home itself is a no-op.
 */
export function reorderBoardTabs(
  state: BoardTabsState,
  boardId: string,
  toIndex: number,
): BoardTabsState {
  if (boardId === state.homeBoardId) {
    return state;
  }
  const fromIndex = state.tabs.findIndex((t) => t.boardId === boardId);
  if (fromIndex < 0) {
    return state;
  }
  const clamped = Math.max(1, Math.min(toIndex, state.tabs.length - 1));
  if (clamped === fromIndex) {
    return state;
  }
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  tabs.splice(clamped, 0, moved);
  return { ...state, tabs };
}
