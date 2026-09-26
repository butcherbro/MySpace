import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StartupGate } from "./StartupGate";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";

// P1.7: the entry guard renders the app only after the backend reports a
// healthy start; in recovery mode it renders only the recovery dialog and the
// app (which would call workspace commands) never mounts.

describe("StartupGate", () => {
  it("mounts the app when there is no startup failure", async () => {
    const gateway = new MockWorkspaceGateway();
    render(
      <StartupGate gateway={gateway}>
        <div data-testid="the-app" />
      </StartupGate>,
    );
    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByTestId("recovery-dialog")).toBeNull();
  });

  it("renders only the recovery dialog and calls no workspace command in recovery mode", async () => {
    const user = userEvent.setup();
    const gateway = new MockWorkspaceGateway();
    gateway.startupFailure = {
      code: "db_open_failed",
      message: "[db_open_failed/sqlite_26] The workspace database could not be opened.",
    };
    const getHomeBoard = vi.spyOn(gateway, "getHomeBoard");
    const loadBoardSnapshot = vi.spyOn(gateway, "loadBoardSnapshot");
    const requestRestore = vi.spyOn(gateway, "requestRestore");
    const onQuit = vi.fn();
    const App = vi.fn(() => <div data-testid="the-app" />);

    render(
      <StartupGate gateway={gateway} onQuit={onQuit}>
        <App />
      </StartupGate>,
    );

    expect(await screen.findByTestId("recovery-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-dialog-message")).toHaveTextContent("db_open_failed");
    expect(screen.queryByTestId("the-app")).toBeNull();
    expect(App).not.toHaveBeenCalled();

    // The mock's newest valid snapshot is offered as a one-click restore.
    const restore = await screen.findByTestId("recovery-dialog-restore");
    expect(restore).toHaveTextContent(/^Restore from /);
    await user.click(restore);
    expect(requestRestore).toHaveBeenCalledWith("2026-09-23T09-00-00Z");
    expect(screen.getByTestId("restore-dialog-restarting")).toBeInTheDocument();

    expect(getHomeBoard).not.toHaveBeenCalled();
    expect(loadBoardSnapshot).not.toHaveBeenCalled();
  });

  it("offers Quit", async () => {
    const user = userEvent.setup();
    const gateway = new MockWorkspaceGateway();
    gateway.startupFailure = { code: "db_open_failed", message: "[db_open_failed] broken" };
    vi.spyOn(gateway, "listBackups").mockResolvedValue([]);
    const onQuit = vi.fn();
    render(
      <StartupGate gateway={gateway} onQuit={onQuit}>
        <div data-testid="the-app" />
      </StartupGate>,
    );
    expect(await screen.findByTestId("recovery-dialog-no-backups")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quit" }));
    await waitFor(() => expect(onQuit).toHaveBeenCalled());
  });
});
