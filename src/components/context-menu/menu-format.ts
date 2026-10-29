import type { ShellPlatform } from "../../app/platform";

/**
 * A keyboard shortcut as the app's key handlers spell it: `Mod` is Cmd on
 * macOS and Ctrl elsewhere (the handlers accept either), keys joined by `+`.
 */
export type ShortcutSpec = "Mod+C" | "Mod+G" | "Mod+Shift+G" | "Delete";

/** The chip text for `spec`: `⇧⌘G` / `⌫` on macOS, `Ctrl+Shift+G` / `Delete` elsewhere. */
export function formatShortcut(spec: ShortcutSpec, platform: ShellPlatform): string {
  const keys = spec.split("+");
  if (platform !== "macos") return keys.map((k) => (k === "Mod" ? "Ctrl" : k)).join("+");
  // Как в меню macOS: символы слитно, ⇧ перед ⌘; клавиша Delete там подписана ⌫.
  const key = keys[keys.length - 1];
  return (keys.includes("Shift") ? "⇧" : "") + (keys.includes("Mod") ? "⌘" : "") + (key === "Delete" ? "⌫" : key);
}

/** `aria-keyshortcuts` value for `spec` (`Meta+G` on macOS, `Control+G` elsewhere). */
export function ariaShortcut(spec: ShortcutSpec, platform: ShellPlatform): string {
  return spec.replace("Mod", platform === "macos" ? "Meta" : "Control");
}

// en-US: короткий месяц всегда трёхбуквенный (en-GB в свежих ICU пишет «Sept»);
// порядок «день месяц год» собираем сами из частей.
const DATE_PARTS = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" });

/** `24 Aug 2025` in local time. */
export function formatMenuDate(millis: number): string {
  const parts = DATE_PARTS.formatToParts(new Date(millis));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}`;
}

/** The card menu footer: `Created 24 Aug 2025`. */
export function formatCreatedDate(createdAt: number): string {
  return `Created ${formatMenuDate(createdAt)}`;
}
