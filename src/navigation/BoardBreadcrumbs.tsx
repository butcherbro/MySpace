import type { Breadcrumb } from "../services/workspace-gateway";
import "./board-breadcrumbs.css";

interface BoardBreadcrumbsProps {
  breadcrumbs: Breadcrumb[];
  /** The id of the currently-open board. Marked with `aria-current="page"`. */
  currentBoardId: string;
  onNavigate: (boardId: string) => void;
  /** When true, show the full path without collapsing (used during drag). */
  dragActive?: boolean;
}

const MAX_VISIBLE = 3;

/**
 * Breadcrumb trail (Home ... current). Keeps Home and the current/tail boards,
 * collapsing the middle ancestors behind an ellipsis when deep (plan G). Every
 * visible crumb is an enabled navigation button; the current board is marked
 * with `aria-current` rather than disabled so activating it is a safe same-board
 * navigation.
 */
export function BoardBreadcrumbs({
  breadcrumbs,
  currentBoardId,
  onNavigate,
  dragActive = false,
}: BoardBreadcrumbsProps) {
  if (breadcrumbs.length === 0) return null;

  const crumbs = dragActive ? breadcrumbs : collapseMiddle(breadcrumbs);

  return (
    <nav className="breadcrumbs" aria-label="Board path" data-testid="breadcrumbs">
      {crumbs.map((item, i) =>
        item === null ? (
          <span key={`gap-${i}`} className="breadcrumbs__gap" aria-hidden>
            …
          </span>
        ) : (
          <span key={item.id} className="breadcrumbs__item">
            {i > 0 && <span className="breadcrumbs__sep">/</span>}
            <button
              type="button"
              className="breadcrumbs__link"
              aria-current={item.id === currentBoardId ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              {item.title}
            </button>
          </span>
        ),
      )}
    </nav>
  );
}

/** Collapses inner breadcrumbs so total visible items is at most MAX_VISIBLE. */
function collapseMiddle(items: Breadcrumb[]): Array<Breadcrumb | null> {
  if (items.length <= MAX_VISIBLE) return items.slice();

  const first = items[0];
  const lastTwo = items.slice(-2);
  return [first, null, ...lastTwo];
}
