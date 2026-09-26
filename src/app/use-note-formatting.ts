import { useCallback, useRef, useState, type Dispatch } from "react";
import { SetNoteColorCommand } from "../commands/card-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { NoteColorId } from "../cards/note/note-color";
import type { NoteEditorCommands } from "../editor/editor-commands";
import type { TextColorId } from "../editor/text-color";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import type { NoteCardDto } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";

/**
 * Note formatting: the contextual note rail's command bridge and toggle state.
 *
 * The active note's Tiptap-free editor hands over a `NoteEditorCommands`
 * bridge plus bold/italic/strike/colour change notifications; this hook holds
 * the resulting toggle state and forwards Rail clicks back through the
 * bridge. The bridge itself lives in a ref, not state: swapping editors must
 * not force a render.
 *
 * `handleNoteColor` is the one command that is not just a bridge call: it
 * changes the note's own colour token via the undo/redo command stack, so it
 * needs the active note, the dispatcher, the ID generator, and the board
 * reducer's dispatch.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 1).
 */

export interface NoteFormattingOptions {
  /** The single active note (editing, or the lone selection), if any. */
  activeNote: NoteCardDto | undefined;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  dispatch: Dispatch<CurrentBoardAction>;
}

export interface NoteFormattingController {
  boldActive: boolean;
  italicActive: boolean;
  strikeActive: boolean;
  textColor: TextColorId;
  handleNoteCommands: (commands: NoteEditorCommands | null) => void;
  handleNoteBoldStateChange: (active: boolean) => void;
  handleNoteItalicStateChange: (active: boolean) => void;
  handleNoteStrikeStateChange: (active: boolean) => void;
  handleNoteTextColorChange: (color: TextColorId) => void;
  handleBold: () => void;
  handleItalic: () => void;
  handleStrike: () => void;
  handleTextColor: (color: TextColorId) => void;
  handleNoteColor: (color: NoteColorId) => void;
}

export function useNoteFormatting(options: NoteFormattingOptions): NoteFormattingController {
  const { activeNote, dispatcher, idGenerator, dispatch } = options;

  const noteCommandsRef = useRef<NoteEditorCommands | null>(null);
  const [boldActive, setBoldActive] = useState(false);
  const [italicActive, setItalicActive] = useState(false);
  const [strikeActive, setStrikeActive] = useState(false);
  const [textColor, setTextColor] = useState<TextColorId>("default");

  const handleNoteCommands = useCallback((commands: NoteEditorCommands | null) => {
    noteCommandsRef.current = commands;
    if (!commands) {
      setBoldActive(false);
      setItalicActive(false);
      setStrikeActive(false);
    }
  }, []);

  const handleNoteBoldStateChange = useCallback((active: boolean) => {
    setBoldActive(active);
  }, []);

  const handleNoteItalicStateChange = useCallback((active: boolean) => {
    setItalicActive(active);
  }, []);

  const handleNoteStrikeStateChange = useCallback((active: boolean) => {
    setStrikeActive(active);
  }, []);

  const handleNoteTextColorChange = useCallback((color: TextColorId) => {
    setTextColor(color);
  }, []);

  const handleBold = useCallback(() => {
    noteCommandsRef.current?.toggleBold();
  }, []);

  const handleItalic = useCallback(() => {
    noteCommandsRef.current?.toggleItalic();
  }, []);

  const handleStrike = useCallback(() => {
    noteCommandsRef.current?.toggleStrike();
  }, []);

  const handleTextColor = useCallback((color: TextColorId) => {
    noteCommandsRef.current?.setTextColor(color);
  }, []);

  const handleNoteColor = useCallback(
    (color: NoteColorId) => {
      const note = activeNote;
      if (!note) return;
      const prevColor = (note.colorToken as NoteColorId) ?? "default";
      void dispatcher
        .execute(new SetNoteColorCommand(idGenerator.nextId(), note.id, color, prevColor))
        .then(() => {
          dispatch({ type: "noteColorChanged", id: note.id, colorToken: color });
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    // dispatch стабилен (useReducer), но вне App линтер этого не видит — указываем явно.
    [activeNote, dispatcher, idGenerator, dispatch],
  );

  return {
    boldActive,
    italicActive,
    strikeActive,
    textColor,
    handleNoteCommands,
    handleNoteBoldStateChange,
    handleNoteItalicStateChange,
    handleNoteStrikeStateChange,
    handleNoteTextColorChange,
    handleBold,
    handleItalic,
    handleStrike,
    handleTextColor,
    handleNoteColor,
  };
}
