import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BackupSummary, WorkspaceGateway } from "../services/workspace-gateway";
import { RestoreDialog } from "./restore-dialog";

const SNAPSHOTS: BackupSummary[] = [
  {
    dirName: "2026-09-23T09-00-00Z",
    createdAtSecs: 1_790_240_400,
    schemaVersion: 4,
    assetCount: 18,
    totalBytes: 6_291_456,
    valid: true,
  },
  {
    dirName: "2026-09-10T09-00-00Z",
    createdAtSecs: 1_789_027_200,
    schemaVersion: 3,
    assetCount: 9,
    totalBytes: 2_097_152,
    valid: false,
  },
];

function harness(overrides: { listBackups?: ReturnType<typeof vi.fn>; requestRestore?: ReturnType<typeof vi.fn> } = {}) {
  const listBackups = overrides.listBackups ?? vi.fn(async () => SNAPSHOTS);
  const requestRestore = overrides.requestRestore ?? vi.fn(() => new Promise<never>(() => {}));
  const gateway = { listBackups, requestRestore } as unknown as WorkspaceGateway;
  const onClose = vi.fn();
  return { gateway, listBackups, requestRestore, onClose };
}

describe("RestoreDialog", () => {
  it("renders the snapshot list with formatted size and asset count", async () => {
    const { gateway, onClose } = harness();
    render(<RestoreDialog gateway={gateway} onClose={onClose} />);

    const rows = await screen.findAllByTestId("restore-dialog-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("18 assets");
    expect(rows[0]).toHaveTextContent("6.0 MB");
  });

  it("disables invalid snapshots and marks them with a badge", async () => {
    const { gateway, onClose } = harness();
    render(<RestoreDialog gateway={gateway} onClose={onClose} />);

    const rows = await screen.findAllByTestId("restore-dialog-row");
    expect(rows[1]).toBeDisabled();
    expect(screen.getAllByTestId("restore-dialog-invalid-badge")).toHaveLength(1);
  });

  it("requires a valid selection before Restore… is enabled, then confirms and restores", async () => {
    const user = userEvent.setup();
    const { gateway, onClose, requestRestore } = harness();
    render(<RestoreDialog gateway={gateway} onClose={onClose} />);

    const rows = await screen.findAllByTestId("restore-dialog-row");
    expect(screen.getByRole("button", { name: "Restore…" })).toBeDisabled();

    // The invalid snapshot cannot be selected at all.
    await user.click(rows[1]);
    expect(screen.getByRole("button", { name: "Restore…" })).toBeDisabled();

    await user.click(rows[0]);
    expect(screen.getByRole("button", { name: "Restore…" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Restore…" }));

    // Confirmation step, plain copy, two buttons.
    expect(screen.getByText(/The app will restart/i)).toBeInTheDocument();
    expect(screen.getByText(/kept under backups\//i)).toBeInTheDocument();
    expect(requestRestore).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(requestRestore).toHaveBeenCalledWith("2026-09-23T09-00-00Z");
    expect(await screen.findByTestId("restore-dialog-restarting")).toHaveTextContent("Restarting…");
  });

  it("returns to the confirm step with an error when requestRestore rejects", async () => {
    const user = userEvent.setup();
    const requestRestore = vi.fn().mockRejectedValue(new Error("snapshot failed validation"));
    const { gateway, onClose } = harness({ requestRestore });
    render(<RestoreDialog gateway={gateway} onClose={onClose} />);

    const rows = await screen.findAllByTestId("restore-dialog-row");
    await user.click(rows[0]);
    await user.click(screen.getByRole("button", { name: "Restore…" }));
    await user.click(screen.getByRole("button", { name: "Restore" }));

    expect(await screen.findByTestId("restore-dialog-error")).toHaveTextContent(
      "snapshot failed validation",
    );
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { gateway, onClose } = harness();
    render(<RestoreDialog gateway={gateway} onClose={onClose} />);
    await screen.findAllByTestId("restore-dialog-row");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("cancelling from the list closes the dialog", async () => {
    const user = userEvent.setup();
    const { gateway, onClose } = harness();
    render(<RestoreDialog gateway={gateway} onClose={onClose} />);
    await screen.findAllByTestId("restore-dialog-row");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces a load error", async () => {
    const listBackups = vi.fn().mockRejectedValue(new Error("disk unreadable"));
    const { gateway, onClose } = harness({ listBackups });
    render(<RestoreDialog gateway={gateway} onClose={onClose} />);

    await waitFor(() =>
      expect(screen.getByTestId("restore-dialog-error")).toHaveTextContent("disk unreadable"),
    );
  });
});
