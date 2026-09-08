import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolRail } from "./ToolRail";

function renderRail(overrides: Partial<React.ComponentProps<typeof ToolRail>> = {}) {
  const props = {
    mode: "create" as const,
    onNewNote: vi.fn(),
    onNewLink: vi.fn(),
    onNewBoardDragStart: vi.fn(),
    onAddImage: vi.fn(),
    trashBatchCount: 0,
    onOpenTrash: vi.fn(),
    onBold: vi.fn(),
    boldActive: false,
    onBackToCreate: vi.fn(),
    textColor: "default" as const,
    onTextColor: vi.fn(),
    noteColor: "default" as const,
    onNoteColor: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ToolRail {...props} />) };
}

describe("ToolRail", () => {
  it("renders the creation tools and trash in create mode", () => {
    renderRail();

    const toolbar = screen.getByRole("toolbar", { name: "Tools" });
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Note",
      "Link",
      "Board",
      "Image",
      "Trash",
    ]);
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Trash" })).toBeInTheDocument();
  });

  it("renders note tools (back + bold + color swatches) plus trash in note mode", () => {
    renderRail({ mode: "note" });

    expect(screen.getByRole("button", { name: "Back to tools" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Trash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).not.toBeInTheDocument();
  });

  it("calls onBold and onBackToCreate from note mode", async () => {
    const user = userEvent.setup();
    const { props } = renderRail({ mode: "note" });

    await user.click(screen.getByRole("button", { name: "Bold" }));
    await user.click(screen.getByRole("button", { name: "Back to tools" }));

    expect(props.onBold).toHaveBeenCalledTimes(1);
    expect(props.onBackToCreate).toHaveBeenCalledTimes(1);
  });

  it("marks the bold button active", () => {
    renderRail({ mode: "note", boldActive: true });
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the text-color swatches in note mode and reports a selection", async () => {
    const user = userEvent.setup();
    const { props } = renderRail({ mode: "note" });

    const blue = screen.getByRole("button", { name: "Blue" });
    expect(blue).toBeInTheDocument();
    await user.click(blue);
    expect(props.onTextColor).toHaveBeenCalledWith("blue");
  });

  it("marks the active text color swatch", () => {
    renderRail({ mode: "note", textColor: "red" });
    expect(screen.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the badge at zero and shows the count above zero", () => {
    const { rerender } = renderRail({ trashBatchCount: 0 });
    expect(screen.queryByTestId("trash-badge")).not.toBeInTheDocument();

    rerender(
      <ToolRail
        mode="create"
        onNewNote={vi.fn()}
        onNewLink={vi.fn()}
        onAddImage={vi.fn()}
        trashBatchCount={3}
        onOpenTrash={vi.fn()}
        onBold={vi.fn()}
        boldActive={false}
        onBackToCreate={vi.fn()}
        textColor="default"
        onTextColor={vi.fn()}
        noteColor="default"
        onNoteColor={vi.fn()}
      />,
    );

    expect(screen.getByTestId("trash-badge").textContent).toBe("3");
  });
});