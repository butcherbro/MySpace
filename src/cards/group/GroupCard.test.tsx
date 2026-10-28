import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroupCard } from "./GroupCard";
import type { GroupCardDto } from "../../services/workspace-gateway";

const group: GroupCardDto = {
  kind: "group",
  id: "g",
  boardId: "home",
  frame: { x: 0, y: 0, width: 640, height: 320 },
  zIndex: 0,
  revision: 1,
  groupId: null,
  title: "Проект",
  colorToken: "pink",
};

function renderGroup(overrides: Partial<Parameters<typeof GroupCard>[0]> = {}) {
  const props = {
    group,
    renaming: false,
    onStartRename: vi.fn(),
    onRename: vi.fn(),
    onDeactivate: vi.fn(),
    onResize: vi.fn(),
    onContextMenu: vi.fn(),
    ...overrides,
  };
  render(<GroupCard {...props} />);
  return props;
}

describe("GroupCard", () => {
  it("renders the frame at its size and colour with the title chip", () => {
    renderGroup();
    const card = screen.getByTestId("group-card");
    expect(card).toHaveAttribute("data-color-token", "pink");
    expect(card).toHaveStyle({ width: "640px", height: "320px" });
    expect(screen.getByTestId("group-title")).toHaveTextContent("Проект");
  });

  it("shows «Группа без названия» for an empty title", () => {
    renderGroup({ group: { ...group, title: "" } });
    expect(screen.getByTestId("group-title")).toHaveTextContent("Группа без названия");
  });

  it("double-clicking the chip asks to rename", () => {
    const props = renderGroup();
    fireEvent.doubleClick(screen.getByTestId("group-title"));
    expect(props.onStartRename).toHaveBeenCalledWith("g");
  });

  it("Enter commits the trimmed title once and leaves rename mode", () => {
    const props = renderGroup({ renaming: true });
    const input = screen.getByTestId("group-title-input");
    fireEvent.change(input, { target: { value: "  Идеи " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(props.onRename).toHaveBeenCalledWith("g", "Идеи");
    expect(props.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels without saving", () => {
    const cancelled = renderGroup({ renaming: true });
    const input = screen.getByTestId("group-title-input");
    fireEvent.change(input, { target: { value: "Другое" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancelled.onRename).not.toHaveBeenCalled();
    expect(cancelled.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("blur commits a changed title", () => {
    const props = renderGroup({ renaming: true });
    const input = screen.getByTestId("group-title-input");
    fireEvent.change(input, { target: { value: "Идеи" } });
    fireEvent.blur(input);
    expect(props.onRename).toHaveBeenCalledWith("g", "Идеи");
  });

  it("the corner handle resizes and commits the final size once", () => {
    const props = renderGroup();
    const handle = screen.getByTestId("group-resize");
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 160 });
    expect(screen.getByTestId("group-card")).toHaveStyle({ width: "940px", height: "380px" });
    fireEvent.pointerUp(window);
    expect(props.onResize).toHaveBeenCalledWith("g", 940, 380);
  });

  it("limits the rename input to 200 characters", () => {
    renderGroup({ renaming: true });
    expect(screen.getByTestId("group-title-input")).toHaveAttribute("maxLength", "200");
  });

  it("removes its window listeners when unmounted mid-resize", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const props = {
      group,
      renaming: false,
      onStartRename: vi.fn(),
      onRename: vi.fn(),
      onDeactivate: vi.fn(),
      onResize: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { unmount } = render(<GroupCard {...props} />);
    const handle = screen.getByTestId("group-resize");
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
    unmount();

    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("pointerup", expect.any(Function));
    fireEvent.pointerUp(window);
    expect(props.onResize).not.toHaveBeenCalled();
    remove.mockRestore();
  });

  it("right-click asks for the group's context menu", () => {
    const props = renderGroup();
    fireEvent.contextMenu(screen.getByTestId("group-card"), { clientX: 5, clientY: 6 });
    expect(props.onContextMenu).toHaveBeenCalledWith("g", 5, 6);
  });
});
