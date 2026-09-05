import type { QuickBoardDto } from "../services/workspace-gateway";
import "./quick-boards-bar.css";

interface QuickBoardsBarProps {
  quickBoards: QuickBoardDto[];
  onOpen: (boardId: string) => void;
  onRemove: (boardId: string) => void;
  /** Whether a Board Portal is being dragged and the bar should reveal a drop target. */
  dropActive?: boolean;
}

// Mirrors BoardPortalCard color mapping so a Quick Board tile reuses the same
// material accent as its Board Portal (no second token namespace).
const COLOR_VARS: Record<string, string> = {
  terracotta: "var(--portal-terracotta)",
  moss: "var(--portal-moss)",
  sky: "var(--portal-sky)",
  sand: "var(--portal-sand)",
  ink: "var(--portal-ink)",
};

const MAX_VISIBLE = 8;

/** First grapheme, spanning surrogate pairs so emoji don't split. */
function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "·";
  return Array.from(trimmed)[0] ?? "·";
}

/**
 * A persistent strip of Quick Board references, rendered immediately after the
 * breadcrumbs in the shared navigation row. Empty list renders nothing; a
 * pinned tile is a compact color/symbol chip with a short title, an on-hover
 * remove affordance, and click-through to open/activate a board tab.
 */
export function QuickBoardsBar({
  quickBoards,
  onOpen,
  onRemove,
  dropActive = false,
}: QuickBoardsBarProps) {
  // Empty renders nothing — except during a Board Portal drag, when the region
  // must reveal a drop target so the user can pin a first reference.
  if (quickBoards.length === 0 && !dropActive) return null;

  const visible = quickBoards.slice(0, MAX_VISIBLE);
  const overflow = quickBoards.slice(MAX_VISIBLE);

  return (
    <div
      className={
        "quick-boards" + (dropActive ? " quick-boards--drop" : "") +
        (quickBoards.length === 0 ? " quick-boards--empty" : "")
      }
      data-testid="quick-boards"
      data-quick-boards-drop="true"
      role="navigation"
      aria-label="Quick boards"
    >
      {quickBoards.length === 0 && dropActive && (
        <span className="quick-boards__hint">Drop to pin</span>
      )}
      {visible.map((qb) => {
        const color = COLOR_VARS[qb.colorToken] ?? COLOR_VARS.ink;
        return (
          <span
            key={qb.boardId}
            className="quick-boards__chip"
            data-testid="quick-board"
            data-board-id={qb.boardId}
            title={qb.title}
          >
            <button
              type="button"
              className="quick-boards__open"
              onClick={() => onOpen(qb.boardId)}
            >
              <span className="quick-boards__tile" style={{ background: color }}>
                {firstGrapheme(qb.title)}
              </span>
              <span className="quick-boards__title">{qb.title}</span>
            </button>
            <button
              type="button"
              className="quick-boards__remove"
              aria-label={`Remove quick board ${qb.title}`}
              title={`Remove ${qb.title}`}
              onClick={() => onRemove(qb.boardId)}
            >
              ×
            </button>
          </span>
        );
      })}
      {overflow.length > 0 && (
        <span className="quick-boards__chip quick-boards__overflow" data-testid="quick-boards-overflow">
          <button type="button" className="quick-boards__overflow-toggle" title={`${overflow.length} more`}>
            +{overflow.length}
          </button>
          <span className="quick-boards__overflow-menu">
            {overflow.map((qb) => {
              const color = COLOR_VARS[qb.colorToken] ?? COLOR_VARS.ink;
              return (
                <button
                  key={qb.boardId}
                  type="button"
                  className="quick-boards__overflow-item"
                  onClick={() => onOpen(qb.boardId)}
                >
                  <span className="quick-boards__tile" style={{ background: color }}>
                    {firstGrapheme(qb.title)}
                  </span>
                  <span className="quick-boards__title">{qb.title}</span>
                </button>
              );
            })}
          </span>
        </span>
      )}
    </div>
  );
}
