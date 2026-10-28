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
 * Рамки пересекаются, но ни одна не лежит целиком в другой. Касание краями
 * без общей площади пересечением не считается.
 */
export function overlapsPartially(a: CanvasFrame, b: CanvasFrame): boolean {
  const intersects =
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  return intersects && !isInsideGroup(a, b) && !isInsideGroup(b, a);
}

/**
 * Id карточек, которые едут вместе с группой `groupId`, в порядке `cards`.
 *
 * Внутри рамки — член; вложенные группы входят (их собственные члены и так
 * лежат внутри внешней рамки); сама группа — никогда. Исключение — спорные
 * карточки: если рамку группы лишь частично перекрывает другая группа, то
 * карточка, лежащая внутри обеих, не принадлежит ни одной и остаётся на месте
 * (иначе наезд одной группы на другую утаскивал бы чужие заметки). Группа,
 * целиком вложенная в нашу или целиком содержащая нашу, спора не создаёт.
 * Неизвестный id или карточка не-группа — пусто.
 */
export function groupMembers(groupId: string, cards: readonly CanvasCard[]): string[] {
  const group = cards.find((c) => c.id === groupId);
  if (!group || group.kind !== "group") return [];
  const rivals = cards.filter(
    (c) => c.kind === "group" && c.id !== groupId && overlapsPartially(c.frame, group.frame),
  );
  return cards
    .filter(
      (c) =>
        c.id !== groupId &&
        isInsideGroup(c.frame, group.frame) &&
        !rivals.some((rival) => isInsideGroup(c.frame, rival.frame)),
    )
    .map((c) => c.id);
}
