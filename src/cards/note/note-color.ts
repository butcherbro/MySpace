// Note background color presets (semantic ids only; colors come from CSS tokens).

export type NoteColorId =
  | "default"
  | "yellow"
  | "pink"
  | "lavender"
  | "blue"
  | "green"
  | "gray";

export interface NoteColorOption {
  id: NoteColorId;
  label: string;
}

export const NOTE_COLOR_OPTIONS: NoteColorOption[] = [
  { id: "default", label: "Default" },
  { id: "yellow", label: "Pale yellow" },
  { id: "pink", label: "Pale pink" },
  { id: "lavender", label: "Pale lavender" },
  { id: "blue", label: "Pale blue" },
  { id: "green", label: "Pale green" },
  { id: "gray", label: "Light gray" },
];
