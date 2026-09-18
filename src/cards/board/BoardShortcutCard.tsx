import type { CSSProperties } from "react";
import type { BoardShortcutDto } from "../../services/workspace-gateway";
import { BoardIdentityThumbnail } from "../../boards/BoardIdentityThumbnail";
import { Icon } from "../../components/icons/Icon";
import "./board-portal-card.css";
import "./board-shortcut-card.css";

interface BoardShortcutCardProps {
  shortcut: BoardShortcutDto;
  onOpen: (boardId: string) => void;
  onContextMenu: (cardId: string, x: number, y: number) => void;
}

// Same palette as BoardPortalCard (plan Visual Interface Contract) — a
// shortcut mirrors the target board's own tile exactly, plus the corner badge.
const COLOR_VARS: Record<string, string> = {
  terracotta: "#c77b55",
  moss: "#899b71",
  sky: "#72a9c7",
  sand: "#c3a66d",
  ink: "#657482",
};

/**
 * A board shortcut (todo.md №17): looks exactly like the target board's
 * portal tile — same cover/color/symbol/title, read live — plus a small
 * arrow badge in the corner (Finder-alias style) that marks it as an alias,
 * not the board's real place. A target that is gone or trashed (`target:
 * null`) renders as a grey, inert "broken" tile instead of crashing.
 */
export function BoardShortcutCard({ shortcut, onOpen, onContextMenu }: BoardShortcutCardProps) {
  const broken = shortcut.target === null;
  const color = broken ? COLOR_VARS.ink : COLOR_VARS[shortcut.target!.colorToken] ?? COLOR_VARS.ink;

  return (
    <div
      className={`board-portal-card board-shortcut-card ${broken ? "board-shortcut-card--broken" : ""}`}
      data-testid="board-shortcut-card"
      data-kind="board-shortcut"
      data-broken={broken}
      data-board-id={shortcut.target?.id ?? ""}
      tabIndex={0}
      aria-label={broken ? "Board shortcut (target is in Trash)" : `Open board ${shortcut.target!.title}`}
      style={{ "--portal-accent": color } as CSSProperties}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !broken) {
          e.preventDefault();
          onOpen(shortcut.target!.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(shortcut.id, e.clientX, e.clientY);
      }}
    >
      <div
        className="board-portal-card__tile"
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!broken) onOpen(shortcut.target!.id);
        }}
      >
        {broken ? (
          <div className="board-shortcut-card__broken-tile" data-testid="board-shortcut-broken-tile" />
        ) : (
          <BoardIdentityThumbnail
            title={shortcut.target!.title}
            colorToken={shortcut.target!.colorToken}
            symbol={shortcut.target!.symbol}
            coverAsset={shortcut.target!.coverAsset}
            size="portal"
          />
        )}
        <span className="board-shortcut-card__badge" aria-hidden="true">
          <Icon name="shortcut-arrow" />
        </span>
      </div>

      <div className="board-portal-card__title">
        {broken ? "Board is in Trash" : shortcut.target!.title}
      </div>
    </div>
  );
}
