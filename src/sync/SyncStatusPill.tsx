import { Icon } from "../components/icons/Icon";
import type { WorkspaceGateway } from "../services/workspace-gateway";
import { pillState, useSyncState, type SyncPillState } from "./use-sync-state";
import "./sync-status-pill.css";

const LABELS: Record<SyncPillState, string> = {
  "no-peers": "No devices",
  syncing: "Syncing…",
  error: "Sync error",
  idle: "Synced",
  unavailable: "Sync off",
};

interface SyncStatusPillProps {
  gateway: WorkspaceGateway;
  onOpen: () => void;
}

/** Top-bar sync status (ADR-0011 S3); opens the Devices dialog. */
export function SyncStatusPill({ gateway, onOpen }: SyncStatusPillProps) {
  const [state] = useSyncState(gateway);
  const status = pillState(state);
  const label = LABELS[status];
  return (
    <button
      type="button"
      className="sync-status-pill"
      data-state={status}
      data-testid="sync-status-pill"
      aria-label={`Devices: ${label}`}
      title={`Devices: ${label}`}
      onClick={onOpen}
    >
      <Icon name="sync" className="sync-status-pill__icon" />
      <span className="sync-status-pill__label">{label}</span>
    </button>
  );
}
