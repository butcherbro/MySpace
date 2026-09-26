import { useEffect, useState } from "react";
import type { BackupSummary, StartupFailure, WorkspaceGateway } from "../services/workspace-gateway";
import { errorMessage } from "../services/error-message";
import { formatBackupDate } from "./format-backup-date";
import { RestoreDialog } from "./restore-dialog";
import "./restore-dialog.css";

interface RecoveryDialogProps {
  gateway: WorkspaceGateway;
  failure: StartupFailure;
  /** Quit the app (destroys the window in Tauri). */
  onQuit: () => void;
}

/**
 * P1.7: the blocking dialog shown instead of the app when the workspace
 * database could not be opened at startup. Offers a one-click restore from the
 * newest valid snapshot (`requestRestore` restarts the app), the full snapshot
 * list (the regular `RestoreDialog`), or Quit. Only `listBackups` and
 * `requestRestore` are called: no `Workspace` exists in this mode.
 */
export function RecoveryDialog({ gateway, failure, onQuit }: RecoveryDialogProps) {
  const [snapshots, setSnapshots] = useState<BackupSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    gateway
      .listBackups()
      .then((result) => {
        if (!cancelled) setSnapshots(result);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  // `listBackups` is newest first.
  const newest = snapshots?.find((s) => s.valid) ?? null;

  const restoreNewest = () => {
    if (!newest) return;
    setRestoreError(null);
    setRestoring(true);
    void gateway.requestRestore(newest.dirName).catch((e) => {
      setRestoreError(errorMessage(e));
      setRestoring(false);
    });
  };

  return (
    <div className="recovery-screen" data-testid="recovery-screen">
      {browsing ? (
        <RestoreDialog gateway={gateway} onClose={() => setBrowsing(false)} />
      ) : (
        <div
          className="restore-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-label="Workspace could not be opened"
          data-testid="recovery-dialog"
        >
          <h2 className="restore-dialog__title">Workspace could not be opened</h2>
          <p className="restore-dialog__body" data-testid="recovery-dialog-message">
            {failure.message}
          </p>
          {restoring ? (
            <p className="restore-dialog__status" data-testid="restore-dialog-restarting">
              Restarting…
            </p>
          ) : (
            <>
              {snapshots === null && !loadError && <p className="restore-dialog__status">Looking for backups…</p>}
              {loadError && <p className="restore-dialog__error">{loadError}</p>}
              {snapshots !== null && !newest && (
                <p className="restore-dialog__status" data-testid="recovery-dialog-no-backups">
                  No valid backup snapshot was found.
                </p>
              )}
              {restoreError && (
                <p className="restore-dialog__error" data-testid="restore-dialog-error">
                  {restoreError}
                </p>
              )}
              <div className="restore-dialog__actions">
                <button type="button" className="restore-dialog__cancel" onClick={onQuit}>
                  Quit
                </button>
                {snapshots !== null && snapshots.length > 0 && (
                  <button type="button" className="restore-dialog__cancel" onClick={() => setBrowsing(true)}>
                    Other snapshots…
                  </button>
                )}
                {newest && (
                  <button
                    type="button"
                    className="restore-dialog__confirm"
                    data-testid="recovery-dialog-restore"
                    onClick={restoreNewest}
                  >
                    Restore from {formatBackupDate(newest.createdAtSecs)}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
