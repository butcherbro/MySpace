import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandDispatcher } from "../commands/command-dispatcher";
import type { WorkspaceCommand } from "../commands/workspace-command";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import { UndoRedoControls } from "./UndoRedoControls";

function command(label: string): WorkspaceCommand {
  return {
    id: label,
    label,
    execute: async () => {},
    undo: async () => {},
  };
}

describe("UndoRedoControls", () => {
  it("reacts to dispatcher history and exposes accessible disabled states", async () => {
    const user = userEvent.setup();
    const dispatcher = new CommandDispatcher(new MockWorkspaceGateway());
    const onUndo = vi.fn(async () => { await dispatcher.undo(); });
    const onRedo = vi.fn(async () => { await dispatcher.redo(); });
    render(<UndoRedoControls dispatcher={dispatcher} onUndo={onUndo} onRedo={onRedo} />);

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();

    await act(async () => { await dispatcher.execute(command("Move card")); });
    const undo = screen.getByRole("button", { name: "Undo Move card" });
    expect(undo).toBeEnabled();
    expect(undo).toHaveAttribute("title", "Undo Move card (⌘Z)");

    await user.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Redo Move card" })).toBeEnabled();
  });
});
