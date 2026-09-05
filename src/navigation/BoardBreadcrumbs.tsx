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

/**
 * Breadcrumb trail (Home ... current), always shown in full root-to-leaf order.
 * Every crumb is an enabled navigation button; the current board is marked with
 * `aria-current` rather than disabled so activating it is a safe same-board
 * navigation. Paths are intentionally never collapsed so any ancestor remains
 * reachable by a direct click.
 */
export function BoardBreadcrumbs({
  breadcrumbs,
  currentBoardId,
  onNavigate,
}: BoardBreadcrumbsProps) {
  if (breadcrumbs.length === 0) return null;

  return (
    <nav className="breadcrumbs" aria-label="Board path" data-testid="breadcrumbs">
      {breadcrumbs.map((item, i) => (
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
      ))}
    </nav>
  );
}
