import "./icon.css";

interface BoardTileIconProps {
  className?: string;
}

/**
 * The colored Board glyph for the left rail: a board-blue rounded tile with a
 * soft darker 1px outline, holding three white "cards" of unequal size (one
 * wide card on top, a square and a shorter card below) so it reads as a board
 * with content rather than a generic 2×2 grid. All edges sit on whole or half
 * pixels of the 24px grid so it stays crisp at 1x and 2x.
 */
export function BoardTileIcon({ className }: BoardTileIconProps) {
  return (
    <svg
      className={["icon", "board-tile-icon", className].filter(Boolean).join(" ")}
      data-testid="board-tile-icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="board-tile-icon__tile" x="2.5" y="2.5" width="19" height="19" rx="4.5" strokeWidth="1" />
      <rect className="board-tile-icon__card" x="6" y="6" width="12" height="5" rx="1.25" />
      <rect className="board-tile-icon__card" x="6" y="13" width="5" height="5" rx="1.25" />
      <rect className="board-tile-icon__card" x="13" y="13" width="5" height="3" rx="1.25" />
    </svg>
  );
}
