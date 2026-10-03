// Note frame sizing rules shared by creation (canvas paste) and the in-card
// auto-grow (NoteCard). Pure, so the thresholds are unit-tested in one place.

/**
 * Frame bounds the backend enforces on every write (`Frame::validate`,
 * src-tauri/src/domain/models.rs). A write outside them is rejected, the store
 * keeps the old size while the DOM card has the new one, and React Flow's
 * viewport culling then unmounts the note mid-scroll.
 */
export const NOTE_MIN_WIDTH = 120;
export const NOTE_MAX_WIDTH = 1600;
export const NOTE_MIN_HEIGHT = 48;
export const NOTE_MAX_HEIGHT = 10000;

export const NOTE_DEFAULT_WIDTH = 240;

/**
 * Auto-grow stops here (about one screen): a longer text scrolls inside the
 * card instead of turning it into a strip many screens tall. The user can
 * still drag the card taller, up to `NOTE_MAX_HEIGHT`.
 */
export const NOTE_AUTO_MAX_HEIGHT = 720;

/**
 * Width by text length: the longer the text, the wider the note, so it reads
 * like a page rather than a till receipt. 800px (~90 characters a line) is the
 * readable limit; wider lines are hard to follow.
 */
const WIDTH_STEPS: ReadonlyArray<{ minChars: number; width: number }> = [
  { minChars: 4000, width: 800 },
  { minChars: 1500, width: 640 },
  { minChars: 400, width: 480 },
];

/** Initial width for a note created with `text` (empty for a blank note). */
export function noteWidthForText(text: string): number {
  const length = text.trim().length;
  return WIDTH_STEPS.find((step) => length >= step.minChars)?.width ?? NOTE_DEFAULT_WIDTH;
}

/**
 * Width after pasting `pastedText` into a note that is `currentWidth` wide:
 * a long paste widens a narrower note; a wider note keeps the user's width.
 */
export function widthAfterPaste(currentWidth: number, pastedText: string): number {
  return Math.max(currentWidth, noteWidthForText(pastedText));
}

/**
 * Auto-grow target for a card `appliedHeight` tall whose content overflows by
 * `overflow` px, capped at `NOTE_AUTO_MAX_HEIGHT` (the rest scrolls inside the
 * card). Null when there is nothing to grow — also for a card the user already
 * dragged taller than the cap.
 */
export function autoGrowHeight(appliedHeight: number, overflow: number): number | null {
  if (overflow <= 0) return null;
  const needed = Math.min(Math.ceil(appliedHeight + overflow), NOTE_AUTO_MAX_HEIGHT);
  return needed > appliedHeight ? needed : null;
}

/** A manual resize, clamped to the frame bounds the backend accepts. */
export function clampNoteSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.min(Math.max(width, NOTE_MIN_WIDTH), NOTE_MAX_WIDTH),
    height: Math.min(Math.max(height, NOTE_MIN_HEIGHT), NOTE_MAX_HEIGHT),
  };
}

/**
 * Whether a vertical wheel step of `deltaY` scrolls the card's own text rather
 * than the canvas: only while there is text left to scroll in that direction,
 * so at the top/bottom edge the wheel hands over to the canvas again.
 */
export function wheelScrollsNote(
  box: { scrollTop: number; scrollHeight: number; clientHeight: number },
  deltaY: number,
): boolean {
  if (deltaY > 0) return box.scrollTop + box.clientHeight < box.scrollHeight - 1;
  if (deltaY < 0) return box.scrollTop > 0;
  return false;
}
