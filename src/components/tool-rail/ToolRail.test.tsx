import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolRail } from "./ToolRail";

function renderRail(overrides: Partial<Parameters<typeof ToolRail>[0]> = {}) {
  const props = {
    onNewNote: vi.fn(),
    onNewLink: vi.fn(),
    onNewBoard: vi.fn(),
    onAddImage: vi.fn(),
    trashBatchCount: 0,
    onOpenTrash: vi.fn(),
    ...overrides,
  };
  return {
    user: userEvent.setup(),
    props,
    ...render(<ToolRail {...props} />),
  };
}

describe("ToolRail", () => {
  it("renders the creation tools in order with accessible labels", () => {
    renderRail();

    const toolbar = screen.getByRole("toolbar", { name: "Creation tools" });
    const buttons = within(toolbar).getAllByRole("button");

    expect(buttons).toHaveLength(5);
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Note",
      "Link",
      "Board",
      "Image",
      "Trash",
    ]);
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New board" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Trash" })).toBeInTheDocument();
    expect(toolbar.querySelectorAll("svg")).toHaveLength(5);
  });

  it("calls the matching callback when each creation button is activated", async () => {
    const { user, props } = renderRail();

    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.click(screen.getByRole("button", { name: "New link" }));
    await user.click(screen.getByRole("button", { name: "New board" }));
    await user.click(screen.getByRole("button", { name: "Add image" }));

    expect(props.onNewNote).toHaveBeenCalledTimes(1);
    expect(props.onNewLink).toHaveBeenCalledTimes(1);
    expect(props.onNewBoard).toHaveBeenCalledTimes(1);
    expect(props.onAddImage).toHaveBeenCalledTimes(1);
    expect(props.onOpenTrash).not.toHaveBeenCalled();
  });

  it("opens Trash when the bottom button is activated", async () => {
    const { user, props } = renderRail();

    await user.click(screen.getByRole("button", { name: "Open Trash" }));

    expect(props.onOpenTrash).toHaveBeenCalledTimes(1);
  });

  it("hides the badge at zero and shows the batch count above zero", () => {
    const { rerender } = renderRail({ trashBatchCount: 0 });
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trash-badge")).not.toBeInTheDocument();

    rerender(
      <ToolRail
        onNewNote={vi.fn()}
        onNewLink={vi.fn()}
        onNewBoard={vi.fn()}
        onAddImage={vi.fn()}
        trashBatchCount={3}
        onOpenTrash={vi.fn()}
      />,
    );

    const badge = screen.getByTestId("trash-badge");
    expect(badge.textContent).toBe("3");
  });
});