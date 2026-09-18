import type { CardDto } from "../services/workspace-gateway";
import { BoardIdentityThumbnail } from "../boards/BoardIdentityThumbnail";
import "./unsorted-panel.css";

interface UnsortedPanelProps {
  cards: CardDto[];
  /** Place a card at a free slot (button fallback). */
  onPlace: (cardId: string) => void;
  /** Begin dragging a card out of the panel onto the canvas (pointer-based). */
  onDragStartCard?: (cardId: string, clientX: number, clientY: number) => void;
  /** Hide the panel (cards stay unsorted in the backend). */
  onClose: () => void;
}

/**
 * The Milanote-style Unsorted drawer: a right-side panel over the canvas where
 * cards dropped into a board without opening it land as compact previews. Each
 * preview is drag-out-of-panel to place exactly; `Place` falls back to a free
 * slot. The drawer is an overlay, not a grid column.
 */
export function UnsortedPanel({ cards, onPlace, onDragStartCard, onClose }: UnsortedPanelProps) {
  if (cards.length === 0) return null;

  return (
    <aside className="unsorted-panel" data-testid="unsorted-panel">
      <header className="unsorted-panel__header">
        <span className="unsorted-panel__title">Unsorted</span>
        <button type="button" className="unsorted-panel__close" aria-label="Close Unsorted" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="unsorted-panel__list">
        {cards.map((card) => (
          <div
            key={card.id}
            className="unsorted-panel__card"
            data-testid="unsorted-card"
            data-kind={card.kind}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              onDragStartCard?.(card.id, e.clientX, e.clientY);
            }}
          >
            {card.kind === "board_portal" && (
              <div className="unsorted-panel__board">
                <BoardIdentityThumbnail
                  title={card.target.title}
                  colorToken={card.target.colorToken}
                  symbol={card.target.symbol}
                  coverAsset={card.target.coverAsset}
                  size="search"
                  decorative
                />
                <div className="unsorted-panel__board-meta">
                  <span className="unsorted-panel__board-title">{card.target.title}</span>
                  <span className="unsorted-panel__board-count">
                    {card.target.childBoardCount} boards · {card.target.childCardCount} cards
                  </span>
                </div>
              </div>
            )}
            {card.kind === "board_shortcut" && (
              <div className="unsorted-panel__board">
                {card.target ? (
                  <>
                    <BoardIdentityThumbnail
                      title={card.target.title}
                      colorToken={card.target.colorToken}
                      symbol={card.target.symbol}
                      coverAsset={card.target.coverAsset}
                      size="search"
                      decorative
                    />
                    <div className="unsorted-panel__board-meta">
                      <span className="unsorted-panel__board-title">{card.target.title}</span>
                      <span className="unsorted-panel__board-count">Shortcut</span>
                    </div>
                  </>
                ) : (
                  <div className="unsorted-panel__board-meta">
                    <span className="unsorted-panel__board-title">Board is in Trash</span>
                  </div>
                )}
              </div>
            )}
            {card.kind === "image" && (
              <div className="unsorted-panel__image">
                <img
                  className="unsorted-panel__image-img"
                  src={`myspace-asset://localhost/${card.asset.filePath}`}
                  alt=""
                  draggable={false}
                />
                {card.captionPlainText.trim() && (
                  <span className="unsorted-panel__caption">{card.captionPlainText}</span>
                )}
              </div>
            )}
            {card.kind === "embed" && (
              <div className="unsorted-panel__link">
                {card.previewAsset && (
                  <img
                    className="unsorted-panel__link-preview"
                    src={`myspace-asset://localhost/${card.previewAsset.filePath}`}
                    alt=""
                    draggable={false}
                  />
                )}
                <div className="unsorted-panel__link-body">
                  <span className="unsorted-panel__link-source">{card.displayUrl}</span>
                  <span className="unsorted-panel__link-title">{card.title || card.sourceUrl}</span>
                  {card.descriptionPlainText.trim() && (
                    <span className="unsorted-panel__link-desc">{card.descriptionPlainText}</span>
                  )}
                </div>
              </div>
            )}
            {card.kind === "note" && (
              <div className="unsorted-panel__note">{card.plainText.trim() || "Note"}</div>
            )}
            {card.kind === "filesystem_alias" && (
              <div className="unsorted-panel__folder">
                <span className="unsorted-panel__folder-icon" aria-hidden="true" />
                <span className="unsorted-panel__folder-meta">
                  <strong>{card.displayName}</strong>
                  <span>{card.pathHint}</span>
                </span>
              </div>
            )}
            {card.kind === "file" && (
              <div className="unsorted-panel__folder">
                <span className="unsorted-panel__folder-icon" aria-hidden="true" />
                <span className="unsorted-panel__folder-meta">
                  <strong>{card.asset.fileName}</strong>
                  <span>{card.asset.filePath}</span>
                </span>
              </div>
            )}
            <button
              type="button"
              className="unsorted-panel__place"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onPlace(card.id)}
            >
              Place
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
