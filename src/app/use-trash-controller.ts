import { useCallback, useEffect, useState, type RefObject } from "react";
import { errorMessage } from "../services/error-message";
import type { TrashSummaryDto, WorkspaceGateway } from "../services/workspace-gateway";

/**
 * Trash controller: the recoverable-Trash surface as one state machine.
 *
 * It owns the summary the rail badge and the drawer both read, the drawer's own
 * loading/error state, the "empty trash" confirmation flow, and which batch is
 * currently being restored. Loads use then/catch chaining (like the Quick Boards
 * loader) so every state update happens inside an asynchronous callback.
 *
 * What it does not own is what a restore *means* elsewhere: reconciling the open
 * board and the Quick Boards rail is the caller's job, injected as callbacks.
 *
 * Extracted from `App.tsx` unchanged (Task 17, extraction 5 of 6).
 */

export interface TrashControllerOptions {
  gateway: WorkspaceGateway;
  /**
   * Reconciles the open board after a restore or an empty. A ref, not a
   * function: this controller is created before navigation exists in the
   * component, and the caller fills the ref once it does.
   */
  reloadBoardRef: RefObject<(() => Promise<void>) | null>;
  /** Reconcile the Quick Boards rail after a restore or an empty. */
  reloadQuickBoards: () => void;
}

export interface TrashController {
  summary: TrashSummaryDto | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  /** The batch currently being restored, for the drawer's busy row. */
  restoringBatchId: string | null;
  emptyDialogOpen: boolean;
  emptyBusy: boolean;
  emptyError: string | null;
  /** Reloads the summary; the badge consumes it too. */
  refresh: () => Promise<void>;
  openDrawer: () => void;
  closeDrawer: () => void;
  restoreBatch: (batchId: string) => Promise<void>;
  /** Opens the confirmation dialog, clearing the previous failure. */
  requestEmpty: () => void;
  cancelEmpty: () => void;
  confirmEmpty: (confirmation: string) => Promise<void>;
}

export function useTrashController(options: TrashControllerOptions): TrashController {
  const { gateway, reloadBoardRef, reloadQuickBoards } = options;

  const [summary, setSummary] = useState<TrashSummaryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [restoringBatchId, setRestoringBatchId] = useState<string | null>(null);
  const [emptyDialogOpen, setEmptyDialogOpen] = useState(false);
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);

  // Load the recoverable Trash summary. The badge and drawer both consume the
  // full summary. Refreshed on startup, after delete/restore, and on
  // cross-process refresh.
  const refresh = useCallback(() => {
    return gateway
      .listTrash()
      .then((next) => {
        setSummary(next);
        setError(null);
      })
      .catch((e) => {
        setError(errorMessage(e));
      });
  }, [gateway]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openDrawer = useCallback(() => {
    setOpen(true);
    setLoading(true);
    setError(null);
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const closeDrawer = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);

  const restoreBatch = useCallback(
    async (batchId: string) => {
      setRestoringBatchId(batchId);
      try {
        await gateway.restoreTrashBatch(batchId);
        setRestoringBatchId(null);
        await refresh();
        // The restored Board subtree/portal may re-enter the open Board or the
        // Quick Boards rail; reload both to reconcile.
        await reloadBoardRef.current?.();
        reloadQuickBoards();
      } catch (e) {
        setRestoringBatchId(null);
        setError(errorMessage(e));
      }
    },
    [gateway, refresh, reloadBoardRef, reloadQuickBoards],
  );

  const requestEmpty = useCallback(() => {
    setEmptyError(null);
    setEmptyDialogOpen(true);
  }, []);

  const cancelEmpty = useCallback(() => {
    setEmptyDialogOpen(false);
  }, []);

  const confirmEmpty = useCallback(
    async (confirmation: string) => {
      setEmptyBusy(true);
      setEmptyError(null);
      try {
        await gateway.emptyTrash(confirmation);
        setEmptyBusy(false);
        setEmptyDialogOpen(false);
        await refresh();
        await reloadBoardRef.current?.();
        reloadQuickBoards();
      } catch (e) {
        setEmptyBusy(false);
        setEmptyError(errorMessage(e));
      }
    },
    [gateway, refresh, reloadBoardRef, reloadQuickBoards],
  );

  return {
    summary,
    loading,
    error,
    open,
    restoringBatchId,
    emptyDialogOpen,
    emptyBusy,
    emptyError,
    refresh,
    openDrawer,
    closeDrawer,
    restoreBatch,
    requestEmpty,
    cancelEmpty,
    confirmEmpty,
  };
}
