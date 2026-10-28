// Геометрический состав групп (ADR-0013). Состав нигде не хранится: карточка
// входит в группу, пока вся её рамка лежит внутри рамки группы.

import type { CanvasCard, CanvasFrame } from "./canvas-types";

/**
 * Вся рамка `card` внутри рамки `group`: все четыре края, включительно, без
 * допуска. Карточка, касающаяся края изнутри, — внутри.
 */
export function isInsideGroup(card: CanvasFrame, group: CanvasFrame): boolean {
  return (
    card.x >= group.x &&
    card.y >= group.y &&
    card.x + card.width <= group.x + group.width &&
    card.y + card.height <= group.y + group.height
  );
}

/**
 * Id карточек внутри группы `groupId`, в порядке `cards`. Вложенные группы
 * входят (их собственные члены и так лежат внутри внешней рамки); сама группа —
 * никогда. Неизвестный id или карточка не-группа — пусто.
 */
export function groupMembers(groupId: string, cards: readonly CanvasCard[]): string[] {
  const group = cards.find((c) => c.id === groupId);
  if (!group || group.kind !== "group") return [];
  return cards.filter((c) => c.id !== groupId && isInsideGroup(c.frame, group.frame)).map((c) => c.id);
}
