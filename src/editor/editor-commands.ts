// The command surface a rich-text editor exposes to the contextual rail.
//
// This is intentionally Tiptap-free: the rail talks to `NoteEditor` through
// these methods only, so editor internals never leak into the tool rail or App.

export interface NoteEditorCommands {
  /** Toggle bold on the current selection / next-typed text. */
  toggleBold(): void;
  /** Whether bold is active at the current cursor/selection. */
  isBoldActive(): boolean;
}
