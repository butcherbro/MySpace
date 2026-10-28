// Пустое название группы хранится как '' (ADR-0013), а показывается этой строкой.
export const GROUP_UNTITLED = "Группа без названия";

/** Что показать вместо названия группы (рамка, корзина). */
export function groupDisplayTitle(title: string): string {
  return title.trim() === "" ? GROUP_UNTITLED : title;
}

/** Предел длины названия группы — как в Rust: в символах, не в байтах. */
export const GROUP_TITLE_MAX_CHARS = 200;
