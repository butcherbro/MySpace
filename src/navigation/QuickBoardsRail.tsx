import { useState, type CSSProperties } from "react";
import type { QuickBoardDto } from "../services/workspace-gateway";
import "./quick-boards-rail.css";
import { assetUrl } from "../services/asset-url";

interface QuickBoardsRailProps {
  quickBoards: QuickBoardDto[];
  onOpen: (boardId: string) => void;
  onRemove: (boardId: string) => void;
  onReorder: (boardIds: string[]) => void;
  dropActive?: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const COLOR_VARS: Record<string, string> = {
  terracotta: "var(--portal-terracotta)",
  moss: "var(--portal-moss)",
  sky: "var(--portal-sky)",
  sand: "var(--portal-sand)",
  ink: "var(--portal-ink)",
};

/** First letters of up to three words; a one-word title contributes one letter. */
function boardAcronym(title: string): string {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "·";
  return words
    .slice(0, 3)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
}

/** Persistent bookmark-like board navigation at the right edge of the Desk. */
export function QuickBoardsRail({
  quickBoards,
  onOpen,
  onRemove,
  onReorder,
  dropActive = false,
  collapsed,
  onToggleCollapsed,
}: QuickBoardsRailProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function resetDrag() {
    setDraggedId(null);
    setDropIndex(null);
  }

  function handleDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) {
      resetDrag();
      return;
    }
    const ids = quickBoards.map((board) => board.boardId);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      resetDrag();
      return;
    }
    const next = [...ids];
    next.splice(from, 1);
    const insertAt = from < to ? to - 1 : to;
    next.splice(insertAt, 0, draggedId);
    onReorder(next);
    resetDrag();
  }

  return (
    <nav
      className={`quick-boards-rail${collapsed ? " quick-boards-rail--collapsed" : ""}${dropActive ? " quick-boards-rail--drop" : ""}`}
      aria-label="Quick boards"
      data-testid="quick-boards"
      data-quick-boards-drop="true"
      data-collapsed={collapsed ? "true" : "false"}
      onDragEnd={resetDrag}
    >
      <div className="quick-boards-rail__header">
        {!collapsed && <div className="quick-boards-rail__heading">Quick Boards</div>}
        <button
          type="button"
          className="quick-boards-rail__toggle"
          aria-label={collapsed ? "Expand quick boards" : "Collapse quick boards"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand Quick Boards" : "Collapse Quick Boards"}
          onClick={onToggleCollapsed}
        >
          <span aria-hidden="true">{collapsed ? "‹" : "›"}</span>
        </button>
      </div>
      <div className="quick-boards-rail__list">
        {quickBoards.length === 0 && !collapsed && (
          <div className="quick-boards-rail__empty">
            {dropActive ? "Drop to pin" : "Pin boards here"}
          </div>
        )}
        {quickBoards.map((board, index) => {
          const color = COLOR_VARS[board.colorToken] ?? COLOR_VARS.ink;
          const identity = board.symbol?.trim() || boardAcronym(board.title);
          return (
            <div
              key={board.boardId}
              className={
                "quick-boards-rail__row" +
                (board.boardId === draggedId ? " quick-boards-rail__row--dragging" : "") +
                (dropIndex === index ? " quick-boards-rail__row--drop-before" : "")
              }
              data-testid="quick-board"
              data-board-id={board.boardId}
              draggable
              onDragStart={() => setDraggedId(board.boardId)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropIndex(index);
              }}
              onDrop={() => handleDrop(board.boardId)}
            >
              <button
                type="button"
                className="quick-boards-rail__open"
                aria-label={`Open quick board ${board.title}`}
                title={board.title}
                onClick={() => onOpen(board.boardId)}
              >
                <span
                  className="quick-boards-rail__identity"
                  data-testid={`quick-board-identity-${board.boardId}`}
                  style={{ "--quick-board-accent": color } as CSSProperties}
                >
                  {board.coverAsset ? (
                    <img
                      className="quick-boards-rail__cover"
                      src={assetUrl(board.coverAsset.filePath)}
                      alt=""
                      draggable={false}
                    />
                  ) : (
                    identity
                  )}
                </span>
                {!collapsed && <span className="quick-boards-rail__title">{board.title}</span>}
              </button>
              {!collapsed && (
                <button
                  type="button"
                  className="quick-boards-rail__remove"
                  aria-label={`Remove quick board ${board.title}`}
                  title={`Remove ${board.title}`}
                  onClick={() => onRemove(board.boardId)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
