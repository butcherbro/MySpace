import { describe, expect, it, vi, beforeEach } from "vitest";
import { TauriWorkspaceGateway } from "./tauri-workspace-gateway";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

describe("TauriWorkspaceGateway", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("calls get_home_board with no arguments", async () => {
    invokeMock.mockResolvedValue({ id: "home", title: "Home", parentBoardId: null, revision: 1 });
    const gw = new TauriWorkspaceGateway();
    await gw.getHomeBoard();
    expect(invokeMock).toHaveBeenCalledWith("get_home_board", {});
  });

  it("calls load_board_snapshot with a boardId payload", async () => {
    invokeMock.mockResolvedValue({});
    const gw = new TauriWorkspaceGateway();
    await gw.loadBoardSnapshot("home");
    expect(invokeMock).toHaveBeenCalledWith("load_board_snapshot", { boardId: "home" });
  });

  it("calls create_note with a wrapped input payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 200, height: 80 },
      zIndex: 0,
      documentJson: { type: "doc" },
      plainText: "hi",
    };
    await gw.createNote(input);
    expect(invokeMock).toHaveBeenCalledWith("create_note", { input });
  });

  it("calls update_note with a wrapped input payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const gw = new TauriWorkspaceGateway();
    const input = {
      id: "note-1",
      expectedRevision: 1,
      documentJson: { type: "doc" },
      plainText: "updated",
    };
    await gw.updateNote(input);
    expect(invokeMock).toHaveBeenCalledWith("update_note", { input });
  });
});
