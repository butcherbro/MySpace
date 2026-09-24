import { useEffect, useState } from "react";
import type { BackupSummary, WorkspaceGateway } from "../services/workspace-gateway";
import { errorMessage } from "../services/error-message";
import "./restore-dialog.css";

interface RestoreDialogProps {
  gateway: WorkspaceGateway;
  onClose: () => void;
}

function formatBackupDate(createdAtSecs: number): string {
  const date = new Date(createdAtSecs * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSizeMb(totalBytes: number): string {
  return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Step = "list" | "confirm" | "restoring";

/**
 * "Restore from backup" flow: pick a snapshot from `listBackups`, confirm the
 * destructive swap, then call `requestRestore`. On success the app restarts
 * itself and the call never resolves, so the "Restarting…" step is terminal;
 * only a rejection (bad snapshot, failed validation) brings the dialog back
 * to the confirmation step with an error.
 */
export function RestoreDialog({ gateway, onClose }: RestoreDialogProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<BackupSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("list");
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gateway
      .listBackups()
      .then((result) => {
        if (cancelled) return;
        setSnapshots(result);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(errorMessage(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  useEffect(() => {
    if (step === "restoring") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, step]);

  const selectedSnapshot = snapshots.find((s) => s.dirName === selected) ?? null;

  const handleRestore = () => {
    if (!selectedSnapshot) return;
    setRestoreError(null);
    setStep("restoring");
    void gateway.requestRestore(selectedSnapshot.dirName).catch((e) => {
      setRestoreError(errorMessage(e));
      setStep("confirm");
    });
  };

  return (
    <div className="restore-dialog" role="dialog" aria-label="Restore from backup" data-testid="restore-dialog">
      {step === "list" && (
        <>
          <h2 className="restore-dialog__title">Restore from backup</h2>
          {loading && <p className="restore-dialog__status">Loading…</p>}
          {loadError && (
            <p className="restore-dialog__error" data-testid="restore-dialog-error">
              {loadError}
            </p>
          )}
          {!loading && !loadError && snapshots.length === 0 && (
            <p className="restore-dialog__status">No backups yet.</p>
          )}
          {!loading && !loadError && snapshots.length > 0 && (
            <ul className="restore-dialog__list" role="radiogroup" aria-label="Backup snapshots">
              {snapshots.map((snapshot) => (
                <li key={snapshot.dirName}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected === snapshot.dirName}
                    className="restore-dialog__row"
                    disabled={!snapshot.valid}
                    onClick={() => setSelected(snapshot.dirName)}
                    data-testid="restore-dialog-row"
                  >
                    <span className="restore-dialog__row-main">
                      <span className="restore-dialog__row-date">{formatBackupDate(snapshot.createdAtSecs)}</span>
                      <span className="restore-dialog__row-meta">
                        {snapshot.assetCount} {snapshot.assetCount === 1 ? "asset" : "assets"} ·{" "}
                        {formatSizeMb(snapshot.totalBytes)}
                      </span>
                    </span>
                    {!snapshot.valid && (
                      <span className="restore-dialog__badge" data-testid="restore-dialog-invalid-badge">
                        Invalid
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="restore-dialog__actions">
            <button type="button" className="restore-dialog__cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="restore-dialog__confirm"
              disabled={!selectedSnapshot}
              onClick={() => setStep("confirm")}
            >
              Restore…
            </button>
          </div>
        </>
      )}

      {step === "confirm" && selectedSnapshot && (
        <>
          <h2 className="restore-dialog__title">Restore from backup</h2>
          <p className="restore-dialog__body">
            The app will restart and replace the current workspace with the snapshot from{" "}
            {formatBackupDate(selectedSnapshot.createdAtSecs)}. The current state is kept under backups/.
          </p>
          {restoreError && (
            <p className="restore-dialog__error" data-testid="restore-dialog-error">
              {restoreError}
            </p>
          )}
          <div className="restore-dialog__actions">
            <button type="button" className="restore-dialog__cancel" onClick={() => setStep("list")}>
              Cancel
            </button>
            <button type="button" className="restore-dialog__confirm" onClick={handleRestore}>
              Restore
            </button>
          </div>
        </>
      )}

      {step === "restoring" && (
        <>
          <h2 className="restore-dialog__title">Restore from backup</h2>
          <p className="restore-dialog__status" data-testid="restore-dialog-restarting">
            Restarting…
          </p>
        </>
      )}
    </div>
  );
}
