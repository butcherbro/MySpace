import { useCallback, useEffect, useState } from "react";
import type {
  DeviceIdentity,
  DiscoveredDevice,
  PairingCode,
  SyncPeerState,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import { errorMessage } from "../services/error-message";
import { formatLastSync, syncErrorText, useSyncState } from "./use-sync-state";
import "./devices-dialog.css";

interface DevicesDialogProps {
  gateway: WorkspaceGateway;
  onClose: () => void;
}

/** How often the discovered list is refreshed while the dialog is open. */
const DISCOVERY_REFRESH_MS = 2000;

function describeError(e: unknown): string {
  return syncErrorText(errorMessage(e));
}

function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Devices and LAN sync (ADR-0011 S3): this device's name, "Pair a device"
 * (shows a 6-digit code for the other device to type), devices seen on the
 * network, paired devices with their sync status, and pairing by address.
 */
export function DevicesDialog({ gateway, onClose }: DevicesDialogProps) {
  const [syncState, setSyncState] = useSyncState(gateway);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pairTarget, setPairTarget] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const [address, setAddress] = useState("");
  const [addressCode, setAddressCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gateway.getDeviceIdentity().then(
      (id) => {
        if (!cancelled) setIdentity(id);
      },
      (e) => {
        if (!cancelled) setError(describeError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  const refreshDiscovered = useCallback(() => {
    gateway.syncListDiscovered().then(setDiscovered, () => {});
  }, [gateway]);

  useEffect(() => {
    refreshDiscovered();
    const id = setInterval(refreshDiscovered, DISCOVERY_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshDiscovered, syncState]);

  // Clock for the code countdown (every second while a code is shown) and
  // the "Last sync" labels. An expired code is simply not shown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), pairing ? 1000 : 10_000);
    return () => clearInterval(id);
  }, [pairing]);
  const shownCode = pairing && now < pairing.expiresAt ? pairing : null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const saveName = () =>
    run("rename", async () => {
      const renamed = await gateway.renameDevice(nameDraft);
      setIdentity(renamed);
      setRenaming(false);
    });

  const beginPairing = () =>
    run("begin", async () => {
      const code = await gateway.syncBeginPairing();
      setNow(Date.now());
      setPairing(code);
    });

  const endPairing = () => {
    setPairing(null);
    void gateway.syncCancelPairing().catch(() => {});
  };

  const pairDiscovered = (deviceId: string) =>
    run("pair", async () => {
      await gateway.syncPairWith({ deviceId, code: codeDraft });
      setPairTarget(null);
      setCodeDraft("");
      setSyncState(await gateway.getSyncState());
      refreshDiscovered();
    });

  const pairAddress = () =>
    run("address", async () => {
      await gateway.syncPairWith({ address: address.trim(), code: addressCode });
      setAddress("");
      setAddressCode("");
      setSyncState(await gateway.getSyncState());
      refreshDiscovered();
    });

  const syncNow = () =>
    run("sync", async () => {
      setSyncState(await gateway.syncNow());
    });

  const unpair = (peer: SyncPeerState) =>
    run(`unpair:${peer.deviceId}`, async () => {
      await gateway.syncUnpair(peer.deviceId);
      setSyncState(await gateway.getSyncState());
      refreshDiscovered();
    });

  const peers = syncState?.peers ?? [];
  const unpaired = discovered.filter((d) => !d.paired);

  return (
    <div className="devices-dialog" role="dialog" aria-label="Devices" data-testid="devices-dialog">
      <div className="devices-dialog__header">
        <h2 className="devices-dialog__title">Devices</h2>
        <button type="button" className="devices-dialog__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <section className="devices-dialog__section" aria-label="This device">
        <h3 className="devices-dialog__heading">This device</h3>
        {renaming ? (
          <form
            className="devices-dialog__inline"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input
              className="devices-dialog__input"
              aria-label="Device name"
              data-testid="devices-name-input"
              value={nameDraft}
              maxLength={64}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setRenaming(false);
                }
              }}
            />
            <button type="submit" className="devices-dialog__button" disabled={busy === "rename"}>
              Save
            </button>
          </form>
        ) : (
          <div className="devices-dialog__inline">
            <span className="devices-dialog__name" data-testid="devices-this-name">
              {identity?.deviceName ?? "…"}
            </span>
            <button
              type="button"
              className="devices-dialog__link"
              data-testid="devices-rename"
              disabled={!identity}
              onClick={() => {
                setNameDraft(identity?.deviceName ?? "");
                setRenaming(true);
              }}
            >
              Rename
            </button>
          </div>
        )}
        {syncState && syncState.addresses.length > 0 && (
          <p className="devices-dialog__hint" data-testid="devices-addresses">
            Address: {syncState.addresses.join(", ")}
          </p>
        )}
        {shownCode ? (
          <div className="devices-dialog__pairing" data-testid="devices-pairing">
            <p className="devices-dialog__hint">Type this code on the other device:</p>
            <p className="devices-dialog__code" data-testid="devices-pairing-code" aria-label={`Pairing code ${shownCode.code}`}>
              {formatCode(shownCode.code)}
            </p>
            <p className="devices-dialog__hint">Expires in {formatRemaining(shownCode.expiresAt - now)}</p>
            <button type="button" className="devices-dialog__button" onClick={endPairing}>
              Done
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="devices-dialog__button devices-dialog__button--primary"
            data-testid="devices-begin-pairing"
            disabled={busy === "begin" || !syncState}
            onClick={() => void beginPairing()}
          >
            Pair a device
          </button>
        )}
      </section>

      <section className="devices-dialog__section" aria-label="Paired devices">
        <h3 className="devices-dialog__heading">Paired devices</h3>
        {peers.length === 0 ? (
          <p className="devices-dialog__hint" data-testid="devices-no-peers">
            No paired devices yet.
          </p>
        ) : (
          <ul className="devices-dialog__list">
            {peers.map((peer) => (
              <li key={peer.deviceId} className="devices-dialog__row" data-testid="paired-row" data-device-id={peer.deviceId}>
                <span
                  className={`devices-dialog__dot${peer.online ? " devices-dialog__dot--online" : ""}`}
                  data-testid="paired-online"
                  data-online={peer.online ? "true" : "false"}
                  aria-label={peer.online ? "Online" : "Offline"}
                  role="img"
                />
                <span className="devices-dialog__row-main">
                  <span className="devices-dialog__row-name">{peer.name}</span>
                  <span
                    className="devices-dialog__row-meta"
                    data-testid="paired-last-sync"
                    data-last-sync-at={peer.lastSyncAt ?? ""}
                  >
                    Last sync: {formatLastSync(peer.lastSyncAt, now)}
                  </span>
                  {peer.lastError && (
                    <span className="devices-dialog__row-error" data-testid="paired-last-error">
                      {peer.lastError}
                    </span>
                  )}
                </span>
                <span className="devices-dialog__row-actions">
                  <button
                    type="button"
                    className="devices-dialog__button"
                    data-testid="paired-sync-now"
                    disabled={busy === "sync" || syncState?.syncing === true}
                    onClick={() => void syncNow()}
                  >
                    {busy === "sync" || syncState?.syncing ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    type="button"
                    className="devices-dialog__button devices-dialog__button--danger"
                    data-testid="paired-unpair"
                    disabled={busy === `unpair:${peer.deviceId}`}
                    onClick={() => void unpair(peer)}
                  >
                    Unpair
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="devices-dialog__section" aria-label="On this network">
        <h3 className="devices-dialog__heading">On this network</h3>
        {syncState && !syncState.discovering && (
          <p className="devices-dialog__hint" data-testid="devices-discovery-unavailable">
            Discovery unavailable{syncState.discoveryError ? ` (${syncErrorText(syncState.discoveryError)})` : ""}. Add
            the other device by address below.
          </p>
        )}
        {unpaired.length === 0 ? (
          <p className="devices-dialog__hint" data-testid="devices-no-discovered">
            No other device found. Open MySpace on the other computer, on the same network.
          </p>
        ) : (
          <ul className="devices-dialog__list">
            {unpaired.map((device) => (
              <li key={device.deviceId} className="devices-dialog__row" data-testid="discovered-row" data-device-id={device.deviceId}>
                <span className="devices-dialog__row-main">
                  <span className="devices-dialog__row-name">{device.name}</span>
                  <span className="devices-dialog__row-meta">{device.addresses[0] ?? ""}</span>
                </span>
                {pairTarget === device.deviceId ? (
                  <form
                    className="devices-dialog__inline"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void pairDiscovered(device.deviceId);
                    }}
                  >
                    <input
                      className="devices-dialog__input devices-dialog__input--code"
                      aria-label={`Code shown on ${device.name}`}
                      data-testid="pair-code-input"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="123 456"
                      maxLength={7}
                      autoFocus
                      value={codeDraft}
                      onChange={(e) => setCodeDraft(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="devices-dialog__button devices-dialog__button--primary"
                      data-testid="pair-submit"
                      disabled={busy === "pair" || codeDraft.replace(/\s/g, "").length !== 6}
                    >
                      {busy === "pair" ? "Pairing…" : "Pair"}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="devices-dialog__button"
                    data-testid="discovered-pair"
                    onClick={() => {
                      setPairTarget(device.deviceId);
                      setCodeDraft("");
                      setError(null);
                    }}
                  >
                    Pair…
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="devices-dialog__section" aria-label="Add by address">
        <h3 className="devices-dialog__heading">Add by address</h3>
        <form
          className="devices-dialog__inline devices-dialog__inline--wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void pairAddress();
          }}
        >
          <input
            className="devices-dialog__input"
            aria-label="Address (host:port)"
            data-testid="devices-address-input"
            placeholder="192.168.1.20:52000"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <input
            className="devices-dialog__input devices-dialog__input--code"
            aria-label="Code shown on the other device"
            data-testid="devices-address-code"
            inputMode="numeric"
            autoComplete="off"
            placeholder="123 456"
            maxLength={7}
            value={addressCode}
            onChange={(e) => setAddressCode(e.target.value)}
          />
          <button
            type="submit"
            className="devices-dialog__button"
            data-testid="devices-address-submit"
            disabled={busy === "address" || !address.trim() || addressCode.replace(/\s/g, "").length !== 6}
          >
            Pair
          </button>
        </form>
      </section>

      {error && (
        <p className="devices-dialog__error" role="alert" data-testid="devices-error">
          {error}
        </p>
      )}
    </div>
  );
}
