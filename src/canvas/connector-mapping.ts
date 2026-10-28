// Чистое отображение связей в независимые от рендерера рёбра. React Flow здесь
// не появляется; адаптер сам превращает `EdgeLike` в рёбра React Flow.

import type { CanvasCard, CanvasConnector, CanvasConnectorArrowEnds } from "./canvas-types";

/** Форма ребра, не зависящая от рендерера; принадлежит приложению. */
export interface EdgeLike {
  id: string;
  source: string;
  target: string;
  colorToken: string;
  arrowEnds: CanvasConnectorArrowEnds;
}

/**
 * Рёбра для отрисовки: связи, у которых оба конца — карточки на холсте. Связь
 * карточки, локально удалённой (или унесённой), просто не рисуется; есть ли она
 * ещё на самом деле, скажет следующий снимок.
 */
export function connectorsToEdgeLikes(connectors: CanvasConnector[], cards: CanvasCard[]): EdgeLike[] {
  if (connectors.length === 0) return [];
  const onCanvas = new Set(cards.map((c) => c.id));
  return connectors
    .filter((c) => c.fromCardId !== c.toCardId && onCanvas.has(c.fromCardId) && onCanvas.has(c.toCardId))
    .map((c) => ({
      id: c.id,
      source: c.fromCardId,
      target: c.toCardId,
      colorToken: c.colorToken,
      arrowEnds: c.arrowEnds,
    }));
}
