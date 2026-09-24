import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import type { SyncState, WorkspaceGateway } from "../services/workspace-gateway";
import { DevicesDialog } from "./DevicesDialog";

function setup() {
  const gateway = new MockWorkspaceGateway();
  const onClose = vi.fn();
  render(<DevicesDialog gateway={gateway} onClose={onClose} />);
  return { gateway, onClose, user: userEvent.setup() };
}

describe("DevicesDialog", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/?fixture=sync-peers");
  });
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("shows this device, no paired devices, and the devices on the network", async () => {
    setup();
    expect(await screen.findByTestId("devices-this-name")).toHaveTextContent("This Mac");
    expect(await screen.findByTestId("devices-no-peers")).toBeInTheDocument();
    const rows = await screen.findAllByTestId("discovered-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Studio Mac"),
      expect.stringContaining("Windows PC"),
    ]);
    expect(screen.getByTestId("devices-addresses")).toHaveTextContent("192.168.1.20:52000");
  });

  it("shows a pairing code in large type after 'Pair a device'", async () => {
    const { user } = setup();
    await user.click(await screen.findByTestId("devices-begin-pairing"));
    expect(await screen.findByTestId("devices-pairing-code")).toHaveTextContent("123 456");
    expect(screen.getByTestId("devices-pairing")).toHaveTextContent(/Expires in [45]:\d\d/);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("devices-pairing-code")).not.toBeInTheDocument();
  });

  it("rejects a wrong code, then pairs a discovered device with the right one", async () => {
    const { user } = setup();
    const row = (await screen.findAllByTestId("discovered-row")).find((r) =>
      r.textContent?.includes("Windows PC"),
    )!;
    await user.click(within(row).getByTestId("discovered-pair"));
    const input = within(row).getByTestId("pair-code-input");
    await user.type(input, "999999");
    await user.click(within(row).getByTestId("pair-submit"));
    expect(await screen.findByTestId("devices-error")).toHaveTextContent("wrong code");

    await user.clear(input);
    await user.type(input, "123 456");
    await user.click(within(row).getByTestId("pair-submit"));
    const paired = await screen.findByTestId("paired-row");
    expect(paired).toHaveTextContent("Windows PC");
    expect(within(paired).getByTestId("paired-online")).toHaveAttribute("data-online", "true");
    expect(within(paired).getByTestId("paired-last-sync")).toHaveTextContent("Last sync: Never");
    await waitFor(() =>
      expect(screen.getAllByTestId("discovered-row").map((r) => r.textContent)).toEqual([
        expect.stringContaining("Studio Mac"),
      ]),
    );
    expect(screen.queryByTestId("devices-error")).not.toBeInTheDocument();
  });

  it("'Sync now' stamps the last sync time and 'Unpair' removes the device", async () => {
    const { gateway, user } = setup();
    await gateway.syncPairWith({ deviceId: "mock-studio-mac", code: "123456" });
    const paired = await screen.findByTestId("paired-row");
    await user.click(within(paired).getByTestId("paired-sync-now"));
    await waitFor(() =>
      expect(within(screen.getByTestId("paired-row")).getByTestId("paired-last-sync")).toHaveTextContent(
        "Last sync: just now",
      ),
    );
    await user.click(within(screen.getByTestId("paired-row")).getByTestId("paired-unpair"));
    expect(await screen.findByTestId("devices-no-peers")).toBeInTheDocument();
  });

  it("pairs by address", async () => {
    const { user } = setup();
    await user.type(await screen.findByTestId("devices-address-input"), "10.0.0.5:52010");
    const submit = screen.getByTestId("devices-address-submit");
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId("devices-address-code"), "123456");
    await user.click(submit);
    expect(await screen.findByTestId("paired-row")).toHaveTextContent("10.0.0.5:52010");
  });

  it("renames this device inline", async () => {
    const { user } = setup();
    await user.click(await screen.findByTestId("devices-rename"));
    const input = screen.getByTestId("devices-name-input");
    await user.clear(input);
    await user.type(input, "Desk Mac{Enter}");
    expect(await screen.findByTestId("devices-this-name")).toHaveTextContent("Desk Mac");
  });

  it("shows a paired device's last error and follows sync-state events", async () => {
    const state: SyncState = {
      peers: [
        {
          deviceId: "pc",
          name: "Windows PC",
          online: false,
          discovered: false,
          lastSyncAt: null,
          lastError: "refused by the peer (403)",
          lastAddress: "10.0.0.9:5000",
        },
      ],
      discovering: false,
      discoveryError: "discovery unavailable: no multicast",
      syncing: false,
      port: 5000,
      addresses: [],
    };
    let push: ((s: SyncState) => void) | null = null;
    const gateway = {
      getDeviceIdentity: vi.fn(async () => ({ deviceId: "me", deviceName: "Mac" })),
      getSyncState: vi.fn(async () => state),
      onSyncState: vi.fn(async (handler: (s: SyncState) => void) => {
        push = handler;
        return () => {};
      }),
      syncListDiscovered: vi.fn(async () => []),
    } as unknown as WorkspaceGateway;
    render(<DevicesDialog gateway={gateway} onClose={() => {}} />);
    const row = await screen.findByTestId("paired-row");
    expect(within(row).getByTestId("paired-last-error")).toHaveTextContent("403");
    expect(within(row).getByTestId("paired-online")).toHaveAttribute("data-online", "false");
    expect(screen.getByTestId("devices-discovery-unavailable")).toHaveTextContent("no multicast");

    push!({ ...state, peers: [{ ...state.peers[0], online: true, lastError: null, lastSyncAt: Date.now() }] });
    await waitFor(() => expect(screen.queryByTestId("paired-last-error")).not.toBeInTheDocument());
    expect(screen.getByTestId("paired-online")).toHaveAttribute("data-online", "true");
  });

  it("closes on Escape", async () => {
    const { onClose, user } = setup();
    await screen.findByTestId("devices-this-name");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
