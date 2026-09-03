import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasErrorBanner } from "./CanvasErrorBanner";

describe("CanvasErrorBanner", () => {
  it("renders the message", () => {
    render(<CanvasErrorBanner message="Save failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("offers Retry and Copy text when handlers are provided", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onCopy = vi.fn();
    render(<CanvasErrorBanner message="boom" onRetry={onRetry} onCopyText={onCopy} />);

    await user.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();

    await user.click(screen.getByText("Copy text"));
    expect(onCopy).toHaveBeenCalled();
  });

  it("hides Copy text when no handler is given", () => {
    render(<CanvasErrorBanner message="boom" onRetry={vi.fn()} />);
    expect(screen.queryByText("Copy text")).not.toBeInTheDocument();
  });
});
