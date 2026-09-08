import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuAction } from "./ContextMenu";

const actions: ContextMenuAction[] = [
  { id: "copy", label: "Copy MySpace Link", onSelect: vi.fn() },
  { id: "delete", label: "Delete", onSelect: vi.fn() },
];

describe("ContextMenu", () => {
  it("renders each action and runs it on click, closing first", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={20} actions={actions} onClose={onClose} />);

    const copy = screen.getByRole("button", { name: "Copy MySpace Link" });
    const del = screen.getByRole("button", { name: "Delete" });
    expect(copy).toBeInTheDocument();
    expect(del).toBeInTheDocument();

    await user.click(copy);
    expect(actions[0].onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<ContextMenu x={0} y={0} actions={actions} onClose={onClose} />);
    await user.click(container.querySelector(".context-menu__backdrop") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});