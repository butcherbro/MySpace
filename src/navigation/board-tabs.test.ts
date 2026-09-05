import { describe, expect, it } from "vitest";
import {
  activateBoardTab,
  closeBoardTab,
  createBoardTabs,
  navigateBoardTab,
  openBoardTab,
  syncBoardTab,
} from "./board-tabs";

describe("BoardTabs", () => {
  it("starts with Home as the only tab", () => {
    const s = createBoardTabs("home", "Home");
    expect(s.tabs).toEqual([{ boardId: "home", title: "Home" }]);
    expect(s.activeBoardId).toBe("home");
  });

  it("opening a board appends a tab and activates it", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "Books");
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("opening an already-open board activates it in place without duplicating", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "Books");
    s = openBoardTab(s, "b", "Notes");
    s = openBoardTab(s, "a", "Books");
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a", "b"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("opening an already-open board updates its title in place", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "Books");
    s = openBoardTab(s, "a", "Renamed Books");
    expect(s.tabs).toEqual([
      { boardId: "home", title: "Home" },
      { boardId: "a", title: "Renamed Books" },
    ]);
    expect(s.activeBoardId).toBe("a");
  });

  it("closing a non-active tab leaves the active tab unchanged", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "A");
    s = openBoardTab(s, "b", "B");
    s = openBoardTab(s, "a", "A"); // active = a
    s = closeBoardTab(s, "b");
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("closing the active tab activates its right neighbor when present", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "A");
    s = openBoardTab(s, "b", "B");
    s = closeBoardTab(s, "a"); // active was a, right neighbor b exists
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "b"]);
    expect(s.activeBoardId).toBe("b");
  });

  it("closing the last active tab activates its left neighbor", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "A");
    s = openBoardTab(s, "b", "B");
    s = closeBoardTab(s, "b"); // active was b (opened last), no right neighbor
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("Home can never be closed", () => {
    const homeId = "0199f4f0-1234-7abc-8def-0123456789ab";
    const s = createBoardTabs(homeId, "Home");
    const after = closeBoardTab(s, homeId);
    expect(after.tabs.map((t) => t.boardId)).toEqual([homeId]);
    expect(after.activeBoardId).toBe(homeId);
  });

  it("closing an unknown tab is a no-op", () => {
    const s = createBoardTabs("home", "Home");
    expect(closeBoardTab(s, "missing")).toEqual(s);
  });

  it("activating a closed/unknown tab is a no-op", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "A");
    const before = s;
    s = activateBoardTab(s, "missing");
    expect(s).toEqual(before);
  });

  it("syncing an existing tab updates its title without changing order", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "Books");
    const synced = syncBoardTab(s, "a", "Renamed Books");
    expect(synced.tabs).toEqual([
      { boardId: "home", title: "Home" },
      { boardId: "a", title: "Renamed Books" },
    ]);
    expect(synced.activeBoardId).toBe("a");
  });

  it("syncing an unknown tab is a no-op", () => {
    const s = createBoardTabs("home", "Home");
    expect(syncBoardTab(s, "missing", "Nope")).toEqual(s);
  });

  it("navigating with open mode recreates a closed board tab", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "A");
    s = closeBoardTab(s, "a");

    const next = navigateBoardTab(s, "a", "A v2", "open");

    expect(next.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(next.tabs[1]).toEqual({ boardId: "a", title: "A v2" });
    expect(next.activeBoardId).toBe("a");
  });

  it("navigating with sync mode does not recreate a closed board tab", () => {
    let s = createBoardTabs("home", "Home");
    s = openBoardTab(s, "a", "A");
    s = closeBoardTab(s, "a");

    const next = navigateBoardTab(s, "a", "A v2", "sync");

    expect(next).toEqual(s);
  });
});
