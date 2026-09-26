import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const win = vi.hoisted(() => {
  let resized: (() => void) | undefined;
  return {
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    startDragging: vi.fn(() => Promise.resolve()),
    onResized: vi.fn((handler: () => void) => {
      resized = handler;
      return Promise.resolve(() => {
        resized = undefined;
      });
    }),
    fireResized: () => resized?.(),
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
}));

function renderShell() {
  return render(
    <AppShell topBar={<span>Trail</span>} toolRail={null}>
      <span>Desk</span>
    </AppShell>,
  );
}

describe("WindowControls in the app shell", () => {
  beforeEach(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    vi.clearAllMocks();
    win.isMaximized.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-platform");
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it.each(["windows", "linux"])("renders min/max/close on %s and marks the bar as a drag region", async (platform) => {
    document.documentElement.setAttribute("data-platform", platform);
    renderShell();

    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByTestId("title-bar-region")).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(screen.getByTestId("window-controls")).toHaveAttribute("data-tauri-drag-region", "false");
  });

  it.each(["macos", "unknown"])("renders no window controls on %s", (platform) => {
    document.documentElement.setAttribute("data-platform", platform);
    renderShell();

    expect(screen.queryByTestId("window-controls")).not.toBeInTheDocument();
    expect(screen.getByTestId("title-bar-region")).not.toHaveAttribute("data-tauri-drag-region");
  });

  it("calls the Tauri window API and swaps the maximize glyph on resize", async () => {
    document.documentElement.setAttribute("data-platform", "windows");
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Minimize" }));
    expect(win.minimize).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Maximize" }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(win.close).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(win.onResized).toHaveBeenCalledTimes(1));
    win.isMaximized.mockImplementation(() => Promise.resolve(true));
    await act(async () => {
      win.fireResized();
    });
    expect(await screen.findByRole("button", { name: "Restore" })).toHaveAttribute("data-maximized", "true");
  });

  it("leaves dragging to Tauri's drag-region script on Windows", async () => {
    document.documentElement.setAttribute("data-platform", "windows");
    renderShell();

    screen.getByTestId("title-bar-region").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    await Promise.resolve();
    expect(win.startDragging).not.toHaveBeenCalled();
  });

  it("reacts when the platform attribute changes after mount", async () => {
    document.documentElement.setAttribute("data-platform", "macos");
    renderShell();
    expect(screen.queryByTestId("window-controls")).not.toBeInTheDocument();

    await act(async () => {
      document.documentElement.setAttribute("data-platform", "windows");
    });
    expect(await screen.findByTestId("window-controls")).toBeInTheDocument();
  });

  it("is a no-op outside Tauri", async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    document.documentElement.setAttribute("data-platform", "windows");
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(win.close).not.toHaveBeenCalled();
    expect(win.onResized).not.toHaveBeenCalled();
  });
});
