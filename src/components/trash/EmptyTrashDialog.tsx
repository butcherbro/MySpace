import { useState } from "react";
import "./empty-trash-dialog.css";

interface EmptyTrashDialogProps {
  /** Current Trash summary: used only to show the affected counts. */
  batchCount: number;
  boardCount: number;
  cardCount: number;
  /** Called with the typed confirmation text; the caller performs the empty. */
  onConfirm: (typed: string) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}

/**
 * The irreversible empty-Trash confirmation. The user must type exactly `EMPTY`
 * before the destructive action is enabled; a backup notice explains the safety
 * gate. Cancelling leaves all data unchanged.
 */
export function EmptyTrashDialog({
  batchCount,
  boardCount,
  cardCount,
  onConfirm,
  onCancel,
  busy,
  error,
}: EmptyTrashDialogProps) {
  const [typed, setTyped] = useState("");
  const valid = typed === "EMPTY";

  return (
    <div className="empty-trash-dialog" role="dialog" aria-label="Empty Trash" data-testid="empty-trash-dialog">
      <h2 className="empty-trash-dialog__title">Empty Trash</h2>
      <p className="empty-trash-dialog__body">
        Permanently delete {batchCount} {batchCount === 1 ? "batch" : "batches"},{" "}
        {boardCount} {boardCount === 1 ? "board" : "boards"}, and {cardCount}{" "}
        {cardCount === 1 ? "card" : "cards"}? This cannot be undone. A fresh backup
        is created first.
      </p>
      <p className="empty-trash-dialog__hint">Type <strong>EMPTY</strong> to confirm.</p>
      <input
        className="empty-trash-dialog__input"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder="EMPTY"
        aria-label="Type EMPTY"
      />
      {error && (
        <p className="empty-trash-dialog__error" data-testid="empty-trash-error">
          {error}
        </p>
      )}
      <div className="empty-trash-dialog__actions">
        <button type="button" className="empty-trash-dialog__cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="empty-trash-dialog__confirm"
          disabled={!valid || busy}
          onClick={() => onConfirm(typed)}
        >
          {busy ? "Emptying…" : "Empty Trash"}
        </button>
      </div>
    </div>
  );
}