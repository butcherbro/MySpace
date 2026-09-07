import type { CardDto } from "../services/workspace-gateway";
import "./unsorted-panel.css";

interface UnsortedPanelProps {
  cards: CardDto[];
  onPlace: (cardId: string) => void;
}

/**
 * The Milanote-style Unsorted panel: cards moved into this Board without being
 * placed. It appears only when there is at least one unsorted card. Each row is
 * a compact thumbnail; clicking "Place" distributes the card onto the canvas at
 * a free slot.
 */
export function UnsortedPanel({ cards, onPlace }: UnsortedPanelProps) {
  if (cards.length === 0) return null;

  return (
    <div className="unsorted-panel" data-testid="unsorted-panel">
      <div className="unsorted-panel__heading">Unsorted</div>
      <div className="unsorted-panel__list">
        {cards.map((card) => (
          <div key={card.id} className="unsorted-panel__row" data-testid="unsorted-card">
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