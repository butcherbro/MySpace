import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} actions={actions} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("presentation", () => {
    afterEach(() => document.documentElement.removeAttribute("data-platform"));

    const sectioned: ContextMenuAction[] = [
      { id: "copy", label: "Copy MySpace Link", onSelect: vi.fn(), section: "copy" },
      { id: "copy-image", label: "Copy Image", onSelect: vi.fn(), section: "copy", shortcut: "Mod+C" },
      { id: "group", label: "Group", onSelect: vi.fn(), section: "arrange", shortcut: "Mod+G" },
      { id: "delete", label: "Delete", onSelect: vi.fn(), section: "delete", shortcut: "Delete", danger: true },
    ];

    it("draws a divider between sections, not inside one", () => {
      render(<ContextMenu x={0} y={0} actions={sectioned} onClose={vi.fn()} />);
      expect(screen.getAllByRole("separator")).toHaveLength(2);
    });

    it("shows shortcut chips outside the button's accessible name", () => {
      document.documentElement.setAttribute("data-platform", "macos");
      render(<ContextMenu x={0} y={0} actions={sectioned} onClose={vi.fn()} />);
      const group = screen.getByRole("button", { name: "Group" });
      expect(group).toHaveTextContent("⌘G");
      expect(group).toHaveAttribute("aria-keyshortcuts", "Meta+G");
      expect(screen.getByRole("button", { name: "Delete" })).toHaveTextContent("⌫");
    });

    it("spells Ctrl out off macOS", () => {
      document.documentElement.setAttribute("data-platform", "windows");
      render(<ContextMenu x={0} y={0} actions={sectioned} onClose={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Copy Image" })).toHaveTextContent("Ctrl+C");
    });

    it("marks destructive actions", () => {
      render(<ContextMenu x={0} y={0} actions={sectioned} onClose={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("context-menu__item--danger");
      expect(screen.getByRole("button", { name: "Group" })).not.toHaveClass("context-menu__item--danger");
    });

    it("renders the footer under a divider", () => {
      render(<ContextMenu x={0} y={0} actions={actions} onClose={vi.fn()} footer="Created 24 Aug 2025" />);
      expect(screen.getByTestId("context-menu-footer")).toHaveTextContent("Created 24 Aug 2025");
      expect(screen.getAllByRole("separator")).toHaveLength(1);
    });

    it("keeps the menu inside the window near the bottom-right edge", () => {
      const rect = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue({ width: 220, height: 200 } as DOMRect);
      render(
        <ContextMenu x={window.innerWidth - 10} y={window.innerHeight - 10} actions={actions} onClose={vi.fn()} />,
      );
      const menu = screen.getByTestId("context-menu");
      expect(menu.style.left).toBe(`${window.innerWidth - 220 - 8}px`);
      expect(menu.style.top).toBe(`${window.innerHeight - 200 - 8}px`);
      rect.mockRestore();
    });
  });
});
