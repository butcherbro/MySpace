// Геометрия «плавающей» связи: прямая между центрами двух карточек, обрезанная
// по границе каждой. Чистые функции; React Flow здесь не появляется.

import type { Rect } from "./canvas-types";

export interface ConnectorSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Параметр t, при котором луч `центр + t·d` из центра `rect` выходит за его
 * границу.
 */
function exitParameter(rect: Rect, dx: number, dy: number): number {
  const tx = dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy);
  return Math.min(tx, ty);
}

/**
 * Часть прямой от центра `from` к центру `to`, лежащая вне обоих
 * прямоугольников: начинается там, где прямая выходит из `from`, и кончается
 * там, где входит в `to`. `null`, если такого отрезка нет — центры совпадают
 * или прямоугольники перекрываются (касаются) на этой прямой, например одна
 * карточка вложена в другую.
 */
export function connectorEndpoints(from: Rect, to: Rect): ConnectorSegment | null {
  const cx1 = from.x + from.width / 2;
  const cy1 = from.y + from.height / 2;
  const cx2 = to.x + to.width / 2;
  const cy2 = to.y + to.height / 2;
  const dx = cx2 - cx1;
  const dy = cy2 - cy1;
  if (dx === 0 && dy === 0) return null;

  // Параметр t бежит от центра `from` (0) к центру `to` (1). Линия выходит из
  // `from` в tStart и входит в `to` в tEnd; если tStart >= tEnd, прямоугольники
  // перекрываются на этой линии и рисовать нечего.
  const tStart = exitParameter(from, dx, dy);
  const tEnd = 1 - exitParameter(to, dx, dy);
  if (tStart >= tEnd) return null;

  return {
    x1: cx1 + tStart * dx,
    y1: cy1 + tStart * dy,
    x2: cx1 + tEnd * dx,
    y2: cy1 + tEnd * dy,
  };
}
