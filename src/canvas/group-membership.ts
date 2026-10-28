// Состав групп (ADR-0013, ревизия 2026-10-28). Состав хранится у членов
// (`groupId`) и меняется только действием над самой карточкой; геометрия нужна
// лишь в момент броска карточки (`groupForDrop`). Двигать или растягивать рамку
// состав не меняет — иначе рамка, проехавшая по чужой заметке, забирала её себе.

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
 * Id карточек, которые едут вместе с группой `groupId`, в порядке `cards`:
 * её члены и (транзитивно) члены вложенных групп. Сама группа — никогда.
 * Неизвестный id или карточка не-группа — пусто.
 */
export function groupMembers(groupId: string, cards: readonly CanvasCard[]): string[] {
  const group = cards.find((c) => c.id === groupId);
  if (!group || group.kind !== "group") return [];
  // visited: хранимые данные могут быть зациклены (синк), обход обязан кончиться.
  const visited = new Set<string>([groupId]);
  const members = new Set<string>();
  const queue = [groupId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const card of cards) {
      if (card.groupId !== current || visited.has(card.id)) continue;
      visited.add(card.id);
      members.add(card.id);
      if (card.kind === "group") queue.push(card.id);
    }
  }
  return cards.filter((c) => members.has(c.id)).map((c) => c.id);
}

/** Группа `groupId` и все группы, вложенные в неё транзитивно. */
export function descendantGroupIds(groupId: string, cards: readonly CanvasCard[]): Set<string> {
  const ids = new Set([groupId]);
  for (const id of groupMembers(groupId, cards)) {
    if (cards.find((c) => c.id === id)?.kind === "group") ids.add(id);
  }
  return ids;
}

/**
 * Группа, в которую попадает карточка, брошенная с рамкой `frame`: самая
 * маленькая по площади рамка-группа (не из `excluded`), целиком содержащая
 * `frame`; при равной площади — первая в порядке `cards`. `null` — ни одной.
 */
export function groupForDrop(
  frame: CanvasFrame,
  cards: readonly CanvasCard[],
  excluded: ReadonlySet<string>,
): string | null {
  let best: CanvasCard | null = null;
  for (const card of cards) {
    if (card.kind !== "group" || excluded.has(card.id) || !isInsideGroup(frame, card.frame)) continue;
    if (best === null || area(card.frame) < area(best.frame)) best = card;
  }
  return best?.id ?? null;
}

function area(frame: CanvasFrame): number {
  return frame.width * frame.height;
}
