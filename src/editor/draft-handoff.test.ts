import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDraftHandoff,
  endDraftHandoff,
  HANDOFF_MS,
  isDraftHandoffActive,
  offerDraftHandoff,
  readDraftHandoff,
  takeDraftHandoffInput,
} from "./draft-handoff";

/** Presses `key` on the page; returns whether something past the hand-off saw it. */
function press(key: string, modifiers: KeyboardEventInit = {}): boolean {
  let reached = false;
  const onKeyDown = () => {
    reached = true;
  };
  window.addEventListener("keydown", onKeyDown);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  window.removeEventListener("keydown", onKeyDown);
  return reached;
}

afterEach(() => {
  takeDraftHandoffInput("copy");
  endDraftHandoff("copy");
  vi.useRealTimers();
});

describe("draft hand-off", () => {
  it("reads the newest offered document until it is cleared", () => {
    const lineage = { latest: "a" as unknown };
    offerDraftHandoff("copy", () => lineage.latest);
    lineage.latest = "ab";
    expect(readDraftHandoff("copy")).toBe("ab");
    clearDraftHandoff("copy");
    expect(readDraftHandoff("copy")).toBeUndefined();
  });

  it("holds keystrokes that land on no editor until the copy's editor takes them", () => {
    offerDraftHandoff("copy", () => null);
    press("h");
    press("x");
    press("Backspace");
    press("i");
    expect(isDraftHandoffActive()).toBe(true);
    expect(takeDraftHandoffInput("copy")).toBe("hi");
    expect(isDraftHandoffActive()).toBe(false);
    // Taken: later keystrokes are the page's again.
    expect(press("z")).toBe(true);
    expect(takeDraftHandoffInput("copy")).toBe("");
  });

  it("never lets Backspace, Delete or undo reach the canvas, where the copy is selected", () => {
    offerDraftHandoff("copy", () => null);

    expect(press("Backspace")).toBe(false);
    expect(press("Delete")).toBe(false);
    expect(press("z", { metaKey: true })).toBe(false);
    expect(press("z", { ctrlKey: true })).toBe(false);
    expect(press("Backspace", { metaKey: true })).toBe(false);
    expect(press("a")).toBe(false);
    expect(press("Delete")).toBe(false);
    expect(press("Backspace", { ctrlKey: true })).toBe(false);
    // Other shortcuts are the page's.
    expect(press("c", { metaKey: true })).toBe(true);

    expect(takeDraftHandoffInput("copy")).toBe("a");
  });

  it("holds Enter as a new line and characters typed with Option or AltGr", () => {
    offerDraftHandoff("copy", () => null);
    press("a");
    press("Enter");
    press("å", { altKey: true });
    press("@", { ctrlKey: true, altKey: true });
    press("😀");
    expect(takeDraftHandoffInput("copy")).toBe("a\nå@😀");
  });

  it("leaves keystrokes in a text field alone", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    offerDraftHandoff("copy", () => null);
    field.focus();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    field.remove();
    expect(takeDraftHandoffInput("copy")).toBe("");
  });

  it("after a while drops the offer and hands keystrokes nobody took to onUnclaimed", () => {
    vi.useFakeTimers();
    const onUnclaimed = vi.fn();
    offerDraftHandoff("copy", () => "draft", onUnclaimed);
    press("a");
    press("Enter");
    vi.advanceTimersByTime(HANDOFF_MS);

    expect(onUnclaimed).toHaveBeenCalledWith("a\n");
    expect(readDraftHandoff("copy")).toBeUndefined();
    expect(press("b")).toBe(true);
    expect(takeDraftHandoffInput("copy")).toBe("");
  });

  it("ends when the copy's card goes away (a board switch), so the next board gets its keys", () => {
    const onUnclaimed = vi.fn();
    offerDraftHandoff("copy", () => "draft", onUnclaimed);
    press("a");
    endDraftHandoff("copy");

    expect(onUnclaimed).toHaveBeenCalledWith("a");
    expect(readDraftHandoff("copy")).toBeUndefined();
    expect(press("Backspace")).toBe(true);
    expect(isDraftHandoffActive()).toBe(false);
  });

  it("does not call onUnclaimed when everything typed was taken", () => {
    vi.useFakeTimers();
    const onUnclaimed = vi.fn();
    offerDraftHandoff("copy", () => "draft", onUnclaimed);
    press("a");
    takeDraftHandoffInput("copy");
    vi.advanceTimersByTime(HANDOFF_MS);
    expect(onUnclaimed).not.toHaveBeenCalled();
  });
});
