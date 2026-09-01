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
