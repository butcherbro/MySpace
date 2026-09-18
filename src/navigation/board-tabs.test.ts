import { describe, expect, it } from "vitest";
import {
  activateBoardTab,
  closeBoardTab,
  createBoardTabs,
  navigateBoardTab,
  openBoardTab,
  reorderBoardTabs,
  syncBoardTab,
  type BoardTab,
} from "./board-tabs";

function tab(boardId: string, title: string, overrides: Partial<BoardTab> = {}): BoardTab {
  return {
    boardId,
    title,
    colorToken: "terracotta",
    symbol: null,
    coverAsset: null,
    ...overrides,
  };
}

describe("BoardTabs", () => {
  it("starts with Home as the only tab", () => {
    const s = createBoardTabs(tab("home", "Home", { colorToken: "ink" }));
    expect(s.tabs).toEqual([tab("home", "Home", { colorToken: "ink" })]);
    expect(s.activeBoardId).toBe("home");
  });

  it("opening a board appends a tab and activates it", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "Books"));
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("opening an already-open board activates it in place without duplicating", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "Books"));
    s = openBoardTab(s, tab("b", "Notes"));
    s = openBoardTab(s, tab("a", "Books"));
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a", "b"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("opening an already-open board updates its title and identity in place", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "Books"));
    s = openBoardTab(s, tab("a", "Renamed Books", { colorToken: "sky", symbol: "R" }));
    expect(s.tabs).toEqual([
      tab("home", "Home", { colorToken: "terracotta" }),
      tab("a", "Renamed Books", { colorToken: "sky", symbol: "R" }),
    ]);
    expect(s.activeBoardId).toBe("a");
  });

  it("a cover change updates an already-open tab without changing order or active board", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "Books"));
    s = openBoardTab(s, tab("b", "Notes"));
    s = openBoardTab(s, tab("a", "Books")); // active = a

    const withCover = tab("a", "Books", {
      coverAsset: {
        id: "asset-1",
        fileName: "cover.png",
        mimeType: "image/png",
        width: null,
        height: null,
        sizeBytes: 0,
        filePath: "asset-1.png",
      },
    });
    const synced = syncBoardTab(s, withCover);

    expect(synced.tabs.map((t) => t.boardId)).toEqual(["home", "a", "b"]);
    expect(synced.activeBoardId).toBe("a");
    expect(synced.tabs[1].coverAsset?.id).toBe("asset-1");
  });

  it("closing a non-active tab leaves the active tab unchanged", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "A"));
    s = openBoardTab(s, tab("b", "B"));
    s = openBoardTab(s, tab("a", "A")); // active = a
    s = closeBoardTab(s, "b");
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("closing the active tab activates its right neighbor when present", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "A"));
    s = openBoardTab(s, tab("b", "B"));
    s = closeBoardTab(s, "a"); // active was a, right neighbor b exists
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "b"]);
    expect(s.activeBoardId).toBe("b");
  });

  it("closing the last active tab activates its left neighbor", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "A"));
    s = openBoardTab(s, tab("b", "B"));
    s = closeBoardTab(s, "b"); // active was b (opened last), no right neighbor
    expect(s.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(s.activeBoardId).toBe("a");
  });

  it("Home can never be closed", () => {
    const homeId = "0199f4f0-1234-7abc-8def-0123456789ab";
    const s = createBoardTabs(tab(homeId, "Home"));
    const after = closeBoardTab(s, homeId);
    expect(after.tabs.map((t) => t.boardId)).toEqual([homeId]);
    expect(after.activeBoardId).toBe(homeId);
  });

  it("closing an unknown tab is a no-op", () => {
    const s = createBoardTabs(tab("home", "Home"));
    expect(closeBoardTab(s, "missing")).toEqual(s);
  });

  it("activating a closed/unknown tab is a no-op", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "A"));
    const before = s;
    s = activateBoardTab(s, "missing");
    expect(s).toEqual(before);
  });

  it("syncing an existing tab updates its title without changing order", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "Books"));
    const synced = syncBoardTab(s, tab("a", "Renamed Books"));
    expect(synced.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(synced.tabs[1].title).toBe("Renamed Books");
    expect(synced.activeBoardId).toBe("a");
  });

  it("syncing an unknown tab is a no-op", () => {
    const s = createBoardTabs(tab("home", "Home"));
    expect(syncBoardTab(s, tab("missing", "Nope"))).toEqual(s);
  });

  it("navigating with open mode recreates a closed board tab", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "A"));
    s = closeBoardTab(s, "a");

    const next = navigateBoardTab(s, tab("a", "A v2"), "open");

    expect(next.tabs.map((t) => t.boardId)).toEqual(["home", "a"]);
    expect(next.tabs[1].title).toBe("A v2");
    expect(next.activeBoardId).toBe("a");
  });

  it("navigating with sync mode does not recreate a closed board tab", () => {
    let s = createBoardTabs(tab("home", "Home"));
    s = openBoardTab(s, tab("a", "A"));
    s = closeBoardTab(s, "a");

    const next = navigateBoardTab(s, tab("a", "A v2"), "sync");

    expect(next).toEqual(s);
  });

  describe("reorderBoardTabs", () => {
    it("moves a tab from i to j, keeping Home first", () => {
      let s = createBoardTabs(tab("home", "Home"));
      s = openBoardTab(s, tab("a", "A"));
      s = openBoardTab(s, tab("b", "B"));
      s = openBoardTab(s, tab("c", "C")); // home, a, b, c

      const next = reorderBoardTabs(s, "a", 3);
      expect(next.tabs.map((t) => t.boardId)).toEqual(["home", "b", "c", "a"]);
      // Active tab and tab identity/order elsewhere are untouched.
      expect(next.activeBoardId).toBe(s.activeBoardId);
    });

    it("moving a tab earlier shifts the tabs in between right", () => {
      let s = createBoardTabs(tab("home", "Home"));
      s = openBoardTab(s, tab("a", "A"));
      s = openBoardTab(s, tab("b", "B"));
      s = openBoardTab(s, tab("c", "C")); // home, a, b, c

      const next = reorderBoardTabs(s, "c", 1);
      expect(next.tabs.map((t) => t.boardId)).toEqual(["home", "c", "a", "b"]);
    });

    it("Home can never be moved", () => {
      let s = createBoardTabs(tab("home", "Home"));
      s = openBoardTab(s, tab("a", "A"));
      const before = s;
      expect(reorderBoardTabs(s, "home", 1)).toEqual(before);
    });

    it("clamps a target index that would displace Home", () => {
      let s = createBoardTabs(tab("home", "Home"));
      s = openBoardTab(s, tab("a", "A"));
      s = openBoardTab(s, tab("b", "B")); // home, a, b

      const next = reorderBoardTabs(s, "b", 0);
      // Clamped to index 1 (right after Home), not index 0.
      expect(next.tabs.map((t) => t.boardId)).toEqual(["home", "b", "a"]);
    });

    it("reordering an unknown tab is a no-op", () => {
      const s = createBoardTabs(tab("home", "Home"));
      expect(reorderBoardTabs(s, "missing", 0)).toEqual(s);
    });

    it("a no-op move (same index) returns tabs unchanged", () => {
      let s = createBoardTabs(tab("home", "Home"));
      s = openBoardTab(s, tab("a", "A"));
      s = openBoardTab(s, tab("b", "B")); // home, a, b
      const before = s;
      expect(reorderBoardTabs(s, "a", 1)).toEqual(before);
    });
  });
});