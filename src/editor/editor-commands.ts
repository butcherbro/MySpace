// The command surface a rich-text editor exposes to the contextual rail.
//
// This is intentionally Tiptap-free: the rail talks to `NoteEditor` through
// these methods only, so editor internals never leak into the tool rail or App.

import type { TextColorId } from "./text-color";

export interface NoteEditorCommands {
  /** Toggle bold on the current selection / next-typed text. */
  toggleBold(): void;
  /** Whether bold is active at the current cursor/selection. */
  isBoldActive(): boolean;
  /** Apply a text color (or `default` to clear) to the selection / next text. */
  setTextColor(color: TextColorId): void;
  /** The text color active at the current cursor/selection (`default` = none). */
  getTextColor(): TextColorId;
}
