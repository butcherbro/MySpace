import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrashDrawer } from "./TrashDrawer";
import type { TrashSummaryDto } from "../../services/workspace-gateway";

const summary: TrashSummaryDto = {
  batches: [
    {
      batchId: "batch-1",
      deletedAt: 1_700_000_000_000,
      items: [
        { id: "n1", kind: "note", title: "Remember to ship", thumbnailAsset: null, colorToken: null, symbol: null },
        { id: "b1", kind: "board", title: "Research", thumbnailAsset: null, colorToken: "moss", symbol: null },
      ],
      boardCount: 1,
      cardCount: 2,
    },
  ],
  batchCount: 1,
  boardCount: 1,
  cardCount: 2,
};

describe("TrashDrawer", () => {
  it("renders a loading state", () => {
    render(
      <TrashDrawer
        summary={null}
        loading
        error={null}
        restoringBatchId={null}
        onClose={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the empty state", () => {
    const empty = { batches: [], batchCount: 0, boardCount: 0, cardCount: 0 };
    render(
      <TrashDrawer
        summary={empty}
        loading={false}
        error={null}
        restoringBatchId={null}
        onClose={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByText("Trash is empty")).toBeInTheDocument();
  });

  it("renders batches with representative items and counts", () => {
    render(
      <TrashDrawer
        summary={summary}
        loading={false}
        error={null}
        restoringBatchId={null}
        onClose={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByText("Remember to ship")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("1 Board · 2 cards")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("renders an error message", () => {
    render(
      <TrashDrawer
        summary={null}
        loading={false}
        error="boom"
        restoringBatchId={null}
        onClose={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.getByTestId("trash-error")).toHaveTextContent("boom");
  });

  it("calls onClose when the close button is activated", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <TrashDrawer
        summary={summary}
        loading={false}
        error={null}
        restoringBatchId={null}
        onClose={onClose}
        onRestore={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Close Trash" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables only the active batch while restoring", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <TrashDrawer
        summary={summary}
        loading={false}
        error={null}
        restoringBatchId="batch-1"
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );
    const button = screen.getByRole("button", { name: "Restoring…" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("calls onRestore with the batch id", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <TrashDrawer
        summary={summary}
        loading={false}
        error={null}
        restoringBatchId={null}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith("batch-1");
  });
});