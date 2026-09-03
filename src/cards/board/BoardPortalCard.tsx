import type { BoardPortalDto } from "../../services/workspace-gateway";
import "./board-portal-card.css";

interface BoardPortalCardProps {
  portal: BoardPortalDto;
  onOpen: (boardId: string) => void;
}

// Maps a color token to a CSS custom property name. The palette is the
// board-identity set from the plan (Visual Interface Contract).
const COLOR_VARS: Record<string, string> = {
  terracotta: "#c77b55",
  moss: "#899b71",
  sky: "#72a9c7",
  sand: "#c3a66d",
  ink: "#657482",
};

/** First grapheme, spanning surrogate pairs so emoji don't split. */
function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "·";
  return Array.from(trimmed)[0] ?? "·";
}

/**
 * The signature "doorway" card: a compact colored tile that opens a child
 * board. Single click selects (canvas), double click/Enter opens.
 */
export function BoardPortalCard({ portal, onOpen }: BoardPortalCardProps) {
  const color = COLOR_VARS[portal.target.colorToken] ?? COLOR_VARS.ink;
  const symbol = portal.target.symbol ?? firstGrapheme(portal.target.title);
  const childCount = portal.target.childBoardCount;
  const cardCount = portal.target.childCardCount;

  return (
    <div
      className="board-portal-card"
      data-testid="board-portal-card"
      data-board-id={portal.target.id}
      role="button"
      tabIndex={0}
      aria-label={`Open board ${portal.target.title}`}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen(portal.target.id);
        }
      }}
    >
      <div className="board-portal-card__tile" style={{ backgroundColor: color }}>
        <span className="board-portal-card__symbol">{symbol}</span>
      </div>
      <div className="board-portal-card__title">{portal.target.title}</div>
      <div className="board-portal-card__count" data-testid="portal-count">
        {childCount > 0 || cardCount > 0
          ? `${childCount} board${childCount === 1 ? "" : "s"} · ${cardCount} card${cardCount === 1 ? "" : "s"}`
          : "Empty"}
      </div>
    </div>
  );
}
