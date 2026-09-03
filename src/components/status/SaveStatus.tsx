import "./save-status.css";

export type SaveState = "idle" | "saving" | "saved" | "error";

interface SaveStatusProps {
  state: SaveState;
}

const LABELS: Record<SaveState, string | null> = {
  idle: null,
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

/** A quiet, non-blocking save indicator shown only while saving or on error. */
export function SaveStatus({ state }: SaveStatusProps) {
  if (state === "idle" || state === "saved") return null;

  return (
    <span className={`save-status save-status--${state}`} data-testid="save-status">
      {LABELS[state]}
    </span>
  );
}
