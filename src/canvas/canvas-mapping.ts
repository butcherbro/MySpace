// Pure mapping functions between `CanvasCard` frames and a renderer-neutral
// "node-like" shape. React Flow never appears here; the adapter converts
// NodeLike into actual React Flow nodes in one thin, isolated step.

import type { CanvasCard, CanvasFrame } from "./canvas-types";

/** Renderer-neutral node shape, owned by the application (not React Flow). */
export interface NodeLike {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  zIndex: number;
}

/** Converts a domain card into a renderer-neutral node. */
export function cardToNodeLike(card: CanvasCard): NodeLike {
  return {
    id: card.id,
    position: { x: card.frame.x, y: card.frame.y },
    width: card.frame.width,
    height: card.frame.height,
    zIndex: card.zIndex,
  };
}

/** Converts a renderer-neutral node back into a domain card frame. */
export function nodeLikeToFrame(node: NodeLike): CanvasFrame {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width,
    height: node.height,
  };
}

/** Applies a moved node's new position to a card, preserving size. */
export function movedNodeToCard(
  node: NodeLike,
  source: CanvasCard,
): CanvasCard {
  return {
    ...source,
    frame: {
      x: node.position.x,
      y: node.position.y,
      width: node.width,
      height: node.height,
    },
  };
}

/**
 * The fraction of the smaller frame that is covered by the overlapping area of
 * two frames. 0 = no overlap, 1 = the smaller frame is fully inside the larger.
 * Used to decide a portal drop by surface overlap rather than by a single
 * center point, so a wide note reliably "covers" a smaller portal.
 */
export function frameIntersectionRatio(a: CanvasFrame, b: CanvasFrame): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlap = xOverlap * yOverlap;
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? overlap / minArea : 0;
}

/** Whether two projections of the same card would produce the same node. */
export function canvasNodeInputsEqual(a: CanvasCard, b: CanvasCard): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.revision === b.revision &&
    a.zIndex === b.zIndex &&
    a.frame.x === b.frame.x &&
    a.frame.y === b.frame.y &&
    a.frame.width === b.frame.width &&
    a.frame.height === b.frame.height &&
    a.targetBoardId === b.targetBoardId &&
    a.portalTitle === b.portalTitle &&
    a.portalCoverAssetId === b.portalCoverAssetId
  );
}

export interface NodeBuildInputs {
  cards: CanvasCard[];
  editingCardId: string | null;
  highlightQuery: string;
}

/**
 * Ids of the cards whose node must be rebuilt going from `prev` to `next`
 * inputs, or `null` when no node changes at all (same cards in the same order,
 * nothing edited, nothing re-highlighted). A card missing from `prev` is
 * always stale. The highlight query affects every card's text, so changing it
 * marks all of them.
 */
export function staleNodeIds(prev: NodeBuildInputs, next: NodeBuildInputs): Set<string> | null {
  const stale = new Set<string>();
  const highlightChanged = prev.highlightQuery !== next.highlightQuery;
  const prevById = prev.cards === next.cards ? null : new Map(prev.cards.map((c) => [c.id, c]));
  let reordered = prev.cards.length !== next.cards.length;
  next.cards.forEach((card, i) => {
    if (prevById) {
      const before = prevById.get(card.id);
      if (prev.cards[i]?.id !== card.id) reordered = true;
      if (!before || !canvasNodeInputsEqual(before, card)) stale.add(card.id);
    }
    if (highlightChanged) stale.add(card.id);
  });
  if (prev.editingCardId !== next.editingCardId) {
    if (prev.editingCardId !== null) stale.add(prev.editingCardId);
    if (next.editingCardId !== null) stale.add(next.editingCardId);
  }
  return stale.size === 0 && !reordered ? null : stale;
}
