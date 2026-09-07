import type { CardDto } from "../services/workspace-gateway";
import "./unsorted-panel.css";

interface UnsortedPanelProps {
  cards: CardDto[];
  /** Place a card at a free slot (button fallback). */
  onPlace: (cardId: string) => void;
  /** Begin dragging a card out of the panel onto the canvas. */
  onDragStartCard?: (cardId: string) => void;
}

/**
 * The Milanote-style Unsorted panel: cards moved into this Board without being
 * placed. It appears only when there is at least one unsorted card. Each row is
 * a compact thumbnail; drag it onto the canvas to place it exactly there, or
 * use Place to drop it at a free slot.
 */
export function UnsortedPanel({ cards, onPlace, onDragStartCard }: UnsortedPanelProps) {
  if (cards.length === 0) return null;

  return (
    <div className="unsorted-panel" data-testid="unsorted-panel">
      <div className="unsorted-panel__heading">Unsorted</div>
      <div className="unsorted-panel__list">
        {cards.map((card) => (
          <div
            key={card.id}
            className="unsorted-panel__row"
            data-testid="unsorted-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", card.id);
              e.dataTransfer.effectAllowed = "move";
              onDragStartCard?.(card.id);
            }}
          >
            <span className="unsorted-panel__thumb">{cardTitle(card)}</span>
            <button
              type="button"
              className="unsorted-panel__place"
              onClick={() => onPlace(card.id)}
            >
              Place
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function cardTitle(card: CardDto): string {
  switch (card.kind) {
    case "note":
      return card.plainText.trim() || "Note";
    case "image":
      return card.asset.fileName || "Image";
    case "embed":
      return card.title || "Link";
    case "board_portal":
      return card.target.title;
  }
}