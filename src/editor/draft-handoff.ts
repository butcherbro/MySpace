// Hand-off of an open draft to another card (a note conflict copy, see
// `useCardEdits`). Editing moves to the copy while the user may be typing:
//
// - the copy's draft must not start from the copy as stored when it was
//   created, but from the original's newest text, read when editing passes to
//   the copy (`readDraftHandoff`);
// - between the original's editor closing and the copy's editor taking focus
//   (a new canvas node is focusable only once it is laid out), keystrokes land
//   on no editor. They are held here and typed into the copy's editor when it
//   takes focus (`takeDraftHandoffInput`). While they are held, keys that would
//   act on the canvas instead (Backspace/Delete trash the selection, which is
//   the copy; Cmd/Ctrl+Z undoes its creation) are swallowed.
//
// A hand-off lasts `HANDOFF_MS` at most, or until the copy's card unmounts
// (`endDraftHandoff`, a board switch): the offer is dropped, so a later editing
// of the copy does not start from this draft, and keystrokes still held go to
// `onUnclaimed` instead of being lost.

interface Handoff {
  seed: () => unknown;
  typed: string;
  /** Whether keystrokes on no editor are still held. */
  capturing: boolean;
  onUnclaimed: (typed: string) => void;
  timer: ReturnType<typeof setTimeout>;
  onKeyDown: (e: KeyboardEvent) => void;
}
const handoffs = new Map<string, Handoff>();

/** How long a hand-off waits for the copy's editor to take focus. */
export const HANDOFF_MS = 2_000;

function onTextEntry(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea"));
}

/** `text` without its last character (a whole code point, not half a surrogate pair). */
function withoutLastChar(text: string): string {
  return Array.from(text).slice(0, -1).join("");
}

function stopCapture(handoff: Handoff): void {
  if (!handoff.capturing) return;
  handoff.capturing = false;
  document.removeEventListener("keydown", handoff.onKeyDown, true);
}

/**
 * Offers `cardId`'s draft the document `seed` returns when its editing starts,
 * and holds keystrokes that land on no editor until `cardId`'s editor takes
 * them. Keystrokes nobody took go to `onUnclaimed`.
 */
export function offerDraftHandoff(
  cardId: string,
  seed: () => unknown,
  onUnclaimed: (typed: string) => void = () => undefined,
): void {
  endDraftHandoff(cardId);
  const handoff: Handoff = {
    seed,
    typed: "",
    capturing: true,
    onUnclaimed,
    timer: setTimeout(() => endDraftHandoff(cardId), HANDOFF_MS),
    onKeyDown: (e) => {
      if (onTextEntry() || e.isComposing) return;
      // Ctrl+Alt — это AltGr на Windows: он печатает символ, а не сочетание.
      // Option на macOS тоже печатает символ, поэтому altKey не отсекаем.
      const shortcut = e.metaKey || (e.ctrlKey && !e.altKey);
      if (e.key === "Backspace" || e.key === "Delete") {
        // Глотаем всегда: иначе клавиша дойдёт до удаления выделения, а выделена копия.
        if (e.key === "Backspace" && !shortcut) handoff.typed = withoutLastChar(handoff.typed);
      } else if (shortcut) {
        // Cmd/Ctrl+Z отменил бы создание копии; прочие сочетания не трогаем.
        if (e.key.toLowerCase() !== "z") return;
      } else if (e.key === "Enter") {
        handoff.typed += "\n";
      } else if (Array.from(e.key).length === 1) {
        handoff.typed += e.key;
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
  };
  document.addEventListener("keydown", handoff.onKeyDown, true);
  handoffs.set(cardId, handoff);
}

/** The document offered to `cardId`'s draft, if any. Reading does not consume it. */
export function readDraftHandoff(cardId: string): unknown {
  return handoffs.get(cardId)?.seed();
}

/** The offered document is used: later editing of `cardId` starts from the card itself. */
export function clearDraftHandoff(cardId: string): void {
  const handoff = handoffs.get(cardId);
  if (!handoff) return;
  handoff.seed = () => undefined;
  if (!handoff.capturing) endDraftHandoff(cardId);
}

/** The keystrokes held for `cardId`'s editor ("" when none); holding stops. */
export function takeDraftHandoffInput(cardId: string): string {
  const handoff = handoffs.get(cardId);
  if (!handoff) return "";
  stopCapture(handoff);
  const typed = handoff.typed;
  handoff.typed = "";
  return typed;
}

/** Whether keystrokes are being held for a copy's editor now. */
export function isDraftHandoffActive(): boolean {
  for (const handoff of handoffs.values()) if (handoff.capturing) return true;
  return false;
}

/** Ends `cardId`'s hand-off: the offer is dropped, and keystrokes nobody took go to `onUnclaimed`. */
export function endDraftHandoff(cardId: string): void {
  const handoff = handoffs.get(cardId);
  if (!handoff) return;
  handoffs.delete(cardId);
  clearTimeout(handoff.timer);
  stopCapture(handoff);
  if (handoff.typed) handoff.onUnclaimed(handoff.typed);
}
