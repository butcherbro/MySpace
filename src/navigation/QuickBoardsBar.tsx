import { useState } from "react";
import type { QuickBoardDto } from "../services/workspace-gateway";
import "./quick-boards-bar.css";

interface QuickBoardsBarProps {
  quickBoards: QuickBoardDto[];
  onOpen: (boardId: string) => void;
  onRemove: (boardId: string) => void;
  /** Reports a new full order of board ids after a drag-reorder. */
  onReorder: (boardIds: string[]) => void;
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
  onReorder,
  dropActive = false,
}: QuickBoardsBarProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Empty renders nothing — except during a Board Portal drag, when the region
  // must reveal a drop target so the user can pin a first reference.
  if (quickBoards.length === 0 && !dropActive) return null;

  const visible = quickBoards.slice(0, MAX_VISIBLE);
  const overflow = quickBoards.slice(MAX_VISIBLE);

  function handleDragStart(boardId: string) {
    setDraggedId(boardId);
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    setDropIndex(index);
  }

  function handleDrop(boardId: string) {
    if (!draggedId || draggedId === boardId) {
      reset();
      return;
    }
    const ids = quickBoards.map((qb) => qb.boardId);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(boardId);
    if (from < 0 || to < 0) {
      reset();
      return;
    }
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, draggedId);
    onReorder(next);
    reset();
  }

  function reset() {
    setDraggedId(null);
    setDropIndex(null);
  }

  return (
    <div
      className={
        "quick-boards" + (dropActive ? " quick-boards--drop" : "") +
        (quickBoards.length === 0 ? " quick-boards--empty" : "")
      }
      data-testid="quick-boards"
      data-quick-boards-drop="true"
      onDragEnd={reset}
      role="navigation"
      aria-label="Quick boards"
    >
      {quickBoards.length === 0 && dropActive && (
        <span className="quick-boards__hint">Drop to pin</span>
      )}
      {visible.map((qb, index) => {
        const color = COLOR_VARS[qb.colorToken] ?? COLOR_VARS.ink;
        const dragging = qb.boardId === draggedId;
        return (
          <span
            key={qb.boardId}
            className={
              "quick-boards__chip" +
              (dragging ? " quick-boards__chip--dragging" : "") +
              (dropIndex === index ? " quick-boards__chip--drop-before" : "")
            }
            data-testid="quick-board"
            data-board-id={qb.boardId}
            title={qb.title}
            draggable
            onDragStart={() => handleDragStart(qb.boardId)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={() => handleDrop(qb.boardId)}
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
