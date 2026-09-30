import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("Copy report", () => {
    afterEach(() => {
      document.documentElement.removeAttribute("data-platform");
    });

    it("is hidden when no handler is given", () => {
      render(<CanvasErrorBanner message="boom" />);
      expect(screen.queryByText("Copy report")).not.toBeInTheDocument();
    });

    it("copies on click and then shows the confirmation", async () => {
      const user = userEvent.setup();
      const onCopyReport = vi.fn(async () => {});
      render(<CanvasErrorBanner message="boom" onCopyReport={onCopyReport} />);

      expect(screen.queryByText(/Report copied/)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Copy report" }));

      expect(onCopyReport).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("Report copied — send it to the developer")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Copy report" })).not.toBeInTheDocument();
    });

    it("offers the button again for a new error", async () => {
      const user = userEvent.setup();
      const onCopyReport = vi.fn(async () => {});
      const { rerender } = render(<CanvasErrorBanner message="boom" onCopyReport={onCopyReport} />);
      await user.click(screen.getByRole("button", { name: "Copy report" }));
      await screen.findByText("Report copied — send it to the developer");

      rerender(<CanvasErrorBanner message="another" onCopyReport={onCopyReport} />);
      expect(screen.getByRole("button", { name: "Copy report" })).toBeInTheDocument();
    });

    it("keeps the button when copying fails", async () => {
      const user = userEvent.setup();
      const onCopyReport = vi.fn(async () => Promise.reject(new Error("clipboard denied")));
      render(<CanvasErrorBanner message="boom" onCopyReport={onCopyReport} />);

      await user.click(screen.getByRole("button", { name: "Copy report" }));

      expect(onCopyReport).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Copy report" })).toBeInTheDocument();
      expect(screen.queryByText(/Report copied/)).not.toBeInTheDocument();
    });

    it("shows the send-to-developer hint on Windows", () => {
      document.documentElement.setAttribute("data-platform", "windows");
      render(<CanvasErrorBanner message="boom" onCopyReport={vi.fn(async () => {})} />);
      expect(screen.getByText("Press Copy report and send it to the developer.")).toBeInTheDocument();
    });

    it("shows no hint on macOS", () => {
      document.documentElement.setAttribute("data-platform", "macos");
      render(<CanvasErrorBanner message="boom" onCopyReport={vi.fn(async () => {})} />);
      expect(screen.queryByText("Press Copy report and send it to the developer.")).not.toBeInTheDocument();
    });
  });
});
