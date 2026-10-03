// Note frame sizing rules shared by creation (canvas paste) and the in-card
// auto-grow (NoteCard). Pure, so the thresholds are unit-tested in one place.

/**
 * Upper height bound the backend enforces on every frame write
 * (`Frame::MAX_HEIGHT`, src-tauri/src/domain/models.rs). An auto-grow past it
 * is rejected, the store keeps the old (smaller) height while the DOM card is
 * taller, and React Flow's viewport culling unmounts the note mid-scroll.
 */
export const NOTE_MAX_HEIGHT = 10000;

export const NOTE_DEFAULT_WIDTH = 240;
/** Width for a note that receives a long text: ~60 characters per line. */
export const NOTE_LONG_TEXT_WIDTH = 480;
/** From this many characters a text counts as "long" (a few paragraphs). */
export const LONG_TEXT_CHARS = 400;

export function isLongText(text: string): boolean {
  return text.trim().length >= LONG_TEXT_CHARS;
}

/** Initial width for a note created with `text` (empty for a blank note). */
export function noteWidthForText(text: string): number {
  return isLongText(text) ? NOTE_LONG_TEXT_WIDTH : NOTE_DEFAULT_WIDTH;
}

/**
 * Width after pasting `pastedText` into a note that is `currentWidth` wide:
 * a long paste widens a narrow note so it never becomes a till receipt; a note
 * already at least that wide keeps the user's width.
 */
export function widthAfterPaste(currentWidth: number, pastedText: string): number {
  return isLongText(pastedText) ? Math.max(currentWidth, NOTE_LONG_TEXT_WIDTH) : currentWidth;
}

/**
 * Auto-grow target for a card `appliedHeight` tall whose content overflows by
 * `overflow` px, capped at `NOTE_MAX_HEIGHT` (the rest scrolls inside the
 * card). Null when there is nothing to grow.
 */
export function autoGrowHeight(appliedHeight: number, overflow: number): number | null {
  if (overflow <= 0) return null;
  const needed = Math.min(Math.ceil(appliedHeight + overflow), NOTE_MAX_HEIGHT);
  return needed > appliedHeight ? needed : null;
}
