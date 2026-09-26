import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetNoteColorCommand } from "../commands/card-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { NoteEditorCommands } from "../editor/editor-commands";
import type { TextColorId } from "../editor/text-color";
import type { IdGenerator } from "../services/id-generator";
import type { NoteCardDto } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { useNoteFormatting, type NoteFormattingOptions } from "./use-note-formatting";

function note(overrides: Partial<NoteCardDto> = {}): NoteCardDto {
  return {
    kind: "note",
    id: "note-1",
    boardId: "board-1",
    frame: { x: 0, y: 0, width: 200, height: 200 },
    zIndex: 0,
    revision: 1,
    documentJson: {},
    plainText: "",
    colorToken: "default",
    ...overrides,
  };
}

function fakeCommands(): NoteEditorCommands {
  return {
    toggleBold: vi.fn(),
    isBoldActive: vi.fn(() => false),
    toggleItalic: vi.fn(),
    isItalicActive: vi.fn(() => false),
    toggleStrike: vi.fn(),
    isStrikeActive: vi.fn(() => false),
    setTextColor: vi.fn(),
    getTextColor: vi.fn((): TextColorId => "default"),
  };
}

function harness(overrides: { activeNote?: NoteCardDto; execute?: ReturnType<typeof vi.fn> } = {}) {
  const execute = overrides.execute ?? vi.fn(async () => undefined);
  const dispatcher = { execute } as unknown as CommandDispatcher;
  const idGenerator: IdGenerator = { nextId: () => "generated-id" };
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();

  const { result, rerender } = renderHook(
    (props: NoteFormattingOptions) => useNoteFormatting(props),
    { initialProps: { activeNote: overrides.activeNote, dispatcher, idGenerator, dispatch } },
  );

  return { result, rerender, execute, dispatch };
}

describe("useNoteFormatting", () => {
  it("forwards commands from the active note's editor to bold/italic/strike/textColor", () => {
    const test = harness();
    const commands = fakeCommands();

    act(() => test.result.current.handleNoteCommands(commands));
    test.result.current.handleBold();
    test.result.current.handleItalic();
    test.result.current.handleStrike();
    test.result.current.handleTextColor("blue");

    expect(commands.toggleBold).toHaveBeenCalledTimes(1);
    expect(commands.toggleItalic).toHaveBeenCalledTimes(1);
    expect(commands.toggleStrike).toHaveBeenCalledTimes(1);
    expect(commands.setTextColor).toHaveBeenCalledWith("blue");
  });

  it("does nothing when the toggles fire with no editor registered", () => {
    const test = harness();

    // Ничего не должно бросить: до регистрации команд (или после её сброса)
    // мост пуст, и клики по Rail — no-op.
    expect(() => {
      test.result.current.handleBold();
      test.result.current.handleItalic();
      test.result.current.handleStrike();
      test.result.current.handleTextColor("green");
    }).not.toThrow();
  });

  it("clears the bold/italic/strike toggle state when the editor unmounts", () => {
    const test = harness();
    const commands = fakeCommands();

    act(() => test.result.current.handleNoteCommands(commands));
    act(() => test.result.current.handleNoteBoldStateChange(true));
    act(() => test.result.current.handleNoteItalicStateChange(true));
    act(() => test.result.current.handleNoteStrikeStateChange(true));
    expect(test.result.current.boldActive).toBe(true);
    expect(test.result.current.italicActive).toBe(true);
    expect(test.result.current.strikeActive).toBe(true);

    act(() => test.result.current.handleNoteCommands(null));

    expect(test.result.current.boldActive).toBe(false);
    expect(test.result.current.italicActive).toBe(false);
    expect(test.result.current.strikeActive).toBe(false);
  });

  it("updates the returned toggle state from the editor's state-change callbacks", () => {
    const test = harness();

    act(() => test.result.current.handleNoteBoldStateChange(true));
    expect(test.result.current.boldActive).toBe(true);

    act(() => test.result.current.handleNoteItalicStateChange(true));
    expect(test.result.current.italicActive).toBe(true);

    act(() => test.result.current.handleNoteStrikeStateChange(true));
    expect(test.result.current.strikeActive).toBe(true);

    act(() => test.result.current.handleNoteTextColorChange("orange"));
    expect(test.result.current.textColor).toBe("orange");
  });

  it("does nothing when there is no active note", async () => {
    const test = harness({ activeNote: undefined });

    await act(async () => {
      await test.result.current.handleNoteColor("pink");
    });

    expect(test.execute).not.toHaveBeenCalled();
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it("changes the active note's color through the command dispatcher, then dispatches the change", async () => {
    const activeNote = note({ colorToken: "yellow" });
    const test = harness({ activeNote, execute: vi.fn(async () => undefined) });

    // handleNoteColor не async: сама функция не ждёт цепочку execute().then(),
    // поэтому проверяем результат через waitFor, а не await на её вызове.
    act(() => {
      test.result.current.handleNoteColor("pink");
    });

    await waitFor(() => expect(test.dispatch).toHaveBeenCalled());
    expect(test.execute).toHaveBeenCalledTimes(1);
    const command = test.execute.mock.calls[0][0];
    expect(command).toBeInstanceOf(SetNoteColorCommand);
    expect(test.dispatch).toHaveBeenCalledWith({
      type: "noteColorChanged",
      id: activeNote.id,
      colorToken: "pink",
    });
  });

  it("dispatches a failure instead of throwing when the command rejects", async () => {
    const activeNote = note();
    const test = harness({
      activeNote,
      execute: vi.fn(async () => {
        throw new Error("note not found");
      }),
    });

    act(() => {
      test.result.current.handleNoteColor("blue");
    });

    await waitFor(() =>
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "note not found" }),
    );
  });
});
