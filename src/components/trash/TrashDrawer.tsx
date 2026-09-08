import type { TrashSummaryDto } from "../../services/workspace-gateway";
import "./trash-drawer.css";

interface TrashDrawerProps {
  summary: TrashSummaryDto | null;
  loading: boolean;
  error: string | null;
  restoringBatchId: string | null;
  onClose: () => void;
  onRestore: (batchId: string) => void;
  /** Open the empty-Trash confirmation dialog. */
  onEmptyTrash?: () => void;
}

function formatDeletedAt(millis: number): string {
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function batchLabel(boardCount: number, cardCount: number): string {
  const parts: string[] = [];
  if (boardCount > 0) parts.push(`${boardCount} ${boardCount === 1 ? "Board" : "Boards"}`);
  if (cardCount > 0) parts.push(`${cardCount} ${cardCount === 1 ? "card" : "cards"}`);
  return parts.join(" · ");
}

export function TrashDrawer({
  summary,
  loading,
  error,
  restoringBatchId,
  onClose,
  onRestore,
  onEmptyTrash = () => {},
}: TrashDrawerProps) {
  const empty = !loading && !error && summary && summary.batches.length === 0;
  const populated = !loading && !error && summary && summary.batches.length > 0;
  const hasBatches = summary ? summary.batchCount > 0 : false;

  return (
    <div className="trash-drawer" role="dialog" aria-label="Trash" data-testid="trash-drawer">
      <header className="trash-drawer__header">
        <h2 className="trash-drawer__title">Trash</h2>
        <button
          type="button"
          className="trash-drawer__close"
          aria-label="Close Trash"
          onClick={onClose}
          autoFocus
        >
          ✕
        </button>
      </header>
      <div className="trash-drawer__body">
        {loading && <p className="trash-drawer__status">Loading…</p>}
        {error && (
          <p className="trash-drawer__error" data-testid="trash-error">
            {error}
          </p>
        )}
        {empty && <p className="trash-drawer__empty">Trash is empty</p>}
        {populated && (
          <ul className="trash-drawer__list">
            {summary!.batches.map((batch) => {
              const restoring = restoringBatchId === batch.batchId;
              return (
                <li key={batch.batchId} className="trash-drawer__batch" data-testid="trash-batch">
                  <div className="trash-drawer__batch-meta">
                    <span className="trash-drawer__batch-counts">
                      {batchLabel(batch.boardCount, batch.cardCount)}
                    </span>
                    <time
                      className="trash-drawer__batch-time"
                      dateTime={new Date(batch.deletedAt).toISOString()}
                    >
                      {formatDeletedAt(batch.deletedAt)}
                    </time>
                  </div>
                  <ul className="trash-drawer__items">
                    {batch.items.map((item) => (
                      <li key={`${batch.batchId}:${item.id}`} className="trash-drawer__item">
                        <span className={`trash-drawer__kind trash-drawer__kind--${item.kind}`}>
                          {item.kind}
                        </span>
                        <span className="trash-drawer__item-title">
                          {item.title || "(no title)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="trash-drawer__restore"
                    onClick={() => onRestore(batch.batchId)}
                    disabled={restoring}
                  >
                    {restoring ? "Restoring…" : "Restore"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <footer className="trash-drawer__footer">
        <button
          type="button"
          className="trash-drawer__empty"
          onClick={onEmptyTrash}
          disabled={!hasBatches}
        >
          Empty Trash…
        </button>
      </footer>
    </div>
  );
}