import { useState, type CSSProperties } from "react";
import type { BoardPortalDto } from "../../services/workspace-gateway";
import { BoardIdentityThumbnail } from "../../boards/BoardIdentityThumbnail";
import "./board-portal-card.css";

interface BoardPortalCardProps {
  portal: BoardPortalDto;
  onOpen: (boardId: string) => void;
  onRename: (boardId: string, title: string) => void;
  onContextMenu: (boardId: string, x: number, y: number) => void;
  /** Whether a card is being dragged over this portal. */
  highlighted?: boolean;
}

// Maps a color token to its palette color (plan Visual Interface Contract).
const COLOR_VARS: Record<string, string> = {
  terracotta: "#c77b55",
  moss: "#899b71",
  sky: "#72a9c7",
  sand: "#c3a66d",
  ink: "#657482",
};

/**
 * The signature "doorway" card. Double-click the tile opens the child board;
 * double-click the title renames it inline; right-click opens a context menu.
 */
export function BoardPortalCard({
  portal,
  onOpen,
  onRename,
  onContextMenu,
  highlighted = false,
}: BoardPortalCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [titleText, setTitleText] = useState(portal.target.title);

  const color = COLOR_VARS[portal.target.colorToken] ?? COLOR_VARS.ink;
  const childCount = portal.target.childBoardCount;
  const cardCount = portal.target.childCardCount;

  function commitRename() {
    const next = titleText.trim();
    setRenaming(false);
    if (next && next !== portal.target.title) {
      onRename(portal.target.id, next);
    } else {
      setTitleText(portal.target.title);
    }
  }

  return (
    <div
      className={`board-portal-card ${highlighted ? "board-portal-card--highlighted" : ""}`}
      data-testid="board-portal-card"
      data-kind="board-portal"
      data-board-id={portal.target.id}
      tabIndex={0}
      aria-label={`Open board ${portal.target.title}`}
      style={{ "--portal-accent": color } as CSSProperties}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen(portal.target.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(portal.id, e.clientX, e.clientY);
      }}
    >
      <div
        className="board-portal-card__tile"
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpen(portal.target.id);
        }}
      >
        <BoardIdentityThumbnail
          title={portal.target.title}
          colorToken={portal.target.colorToken}
          symbol={portal.target.symbol}
          coverAsset={portal.target.coverAsset}
          size="portal"
        />
      </div>

      {renaming ? (
        <textarea
          className="board-portal-card__title-input"
          value={titleText}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTitleText(e.target.value)}
          onBlur={commitRename}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              setTitleText(portal.target.title);
              setRenaming(false);
            }
            e.stopPropagation();
          }}
        />
      ) : (
        <div
          className="board-portal-card__title"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setTitleText(portal.target.title);
            setRenaming(true);
          }}
        >
          {portal.target.title}
        </div>
      )}

      <div className="board-portal-card__count" data-testid="portal-count">
        {childCount > 0 || cardCount > 0
          ? `${childCount} board${childCount === 1 ? "" : "s"} · ${cardCount} card${cardCount === 1 ? "" : "s"}`
          : "Empty"}
      </div>
    </div>
  );
}
