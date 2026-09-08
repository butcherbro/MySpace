import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyTrashDialog } from "./EmptyTrashDialog";

function renderDialog(overrides: Partial<React.ComponentProps<typeof EmptyTrashDialog>> = {}) {
  const props = {
    batchCount: 2,
    boardCount: 3,
    cardCount: 4,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    busy: false,
    error: null,
    ...overrides,
  };
  return { props, ...render(<EmptyTrashDialog {...props} />) };
}

describe("EmptyTrashDialog", () => {
  it("shows the affected counts and disables confirm until EMPTY is typed", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByText(/2 batches/i)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Empty Trash" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Type EMPTY" }), "EMPTY");
    expect(confirm).toBeEnabled();
  });

  it("calls onConfirm with the exact typed value", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    await user.type(screen.getByRole("textbox", { name: "Type EMPTY" }), "EMPTY");
    await user.click(screen.getByRole("button", { name: "Empty Trash" }));
    expect(props.onConfirm).toHaveBeenCalledWith("EMPTY");
  });

  it("does not confirm a non-matching token", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ batchCount: 0 });
    await user.type(screen.getByRole("textbox", { name: "Type EMPTY" }), "empty");
    expect(screen.getByRole("button", { name: "Empty Trash" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("shows an error and keeps the dialog open", () => {
    renderDialog({ error: "backup failed" });
    expect(screen.getByTestId("empty-trash-error")).toHaveTextContent("backup failed");
  });
});