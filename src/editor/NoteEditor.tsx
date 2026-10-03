import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { createEditorExtensions } from "./editor-extensions";
import { openExternalUrl } from "../services/url-opener";
import { classifyLinkConversion } from "../cards/link/link-conversion";
import { setSearchHighlight } from "./search-highlight";
import type { NoteEditorCommands } from "./editor-commands";
import type { TextColorId } from "./text-color";
import "./note-editor.css";

interface NoteEditorProps {
  /** The authoritative ProseMirror document (initial content). */
  document: unknown;
  /** Whether the editor is editable. */
  editable: boolean;
  /** Called with the full ProseMirror JSON whenever content changes. */
  onChange: (document: unknown) => void;
  /** Called when the editor loses focus. */
  onBlur?: () => void;
  /** Called when Enter should finalize a bare-URL note instead of inserting a line. */
  onFinalize?: () => void;
  /** Transient search phrase to highlight (UI-only; never persisted). */
  highlightQuery?: string;
  /** Called with the editing command surface (or null when leaving edit mode). */
  onCommandsReady?: (commands: NoteEditorCommands | null) => void;
  /** Called with the current bold-active state whenever it changes. */
  onBoldStateChange?: (active: boolean) => void;
  /** Called with the current italic-active state whenever it changes. */
  onItalicStateChange?: (active: boolean) => void;
  /** Called with the current strike-active state whenever it changes. */
  onStrikeStateChange?: (active: boolean) => void;
  /** Called with the current text color whenever it changes. */
  onTextColorChange?: (color: TextColorId) => void;
  /**
   * Screen point (client coordinates) of the click that started editing. Idle
   * notes render static HTML (P1.8), so the editor mounts *after* that click
   * and cannot have seen it; placing the caret at this point keeps "the caret
   * lands where the user clicked". Read once, when editing begins. `"end"`
   * puts the caret after the last character.
   */
  initialCaretPoint?: { x: number; y: number } | "end" | null;
  /** Keystrokes typed while editing was passing to this editor; typed in when it takes focus. */
  takeHandedInput?: () => string;
  /** Called with the clipboard's plain text right before a paste is inserted. */
  onPasteText?: (text: string) => void;
}

/**
 * The open-source Tiptap editor, isolated behind this component. `NoteCard`
 * (and future cards) talk to `NoteEditor` via a `document` + `onChange`
 * contract, so Tiptap types never leak outside this file.
 */
export function NoteEditor({
  document,
  editable,
  onChange,
  onBlur,
  onFinalize,
  highlightQuery = "",
  onCommandsReady,
  onBoldStateChange,
  onItalicStateChange,
  onStrikeStateChange,
  onTextColorChange,
  initialCaretPoint = null,
  takeHandedInput,
  onPasteText,
}: NoteEditorProps) {
  const takeHandedInputRef = useRef(takeHandedInput);
  useLayoutEffect(() => {
    takeHandedInputRef.current = takeHandedInput;
  }, [takeHandedInput]);
  const onPasteTextRef = useRef(onPasteText);
  useLayoutEffect(() => {
    onPasteTextRef.current = onPasteText;
  }, [onPasteText]);
  const initialCaretPointRef = useRef(initialCaretPoint);
  // Layout effect: synced before the passive focus effect below reads it.
  useLayoutEffect(() => {
    initialCaretPointRef.current = initialCaretPoint;
  }, [initialCaretPoint]);
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: document as JSONContent,
    editable,
    editorProps: {
      // Только наблюдаем: `false` оставляет вставку самому ProseMirror.
      handlePaste: (_view, event) => {
        onPasteTextRef.current?.(event.clipboardData?.getData("text/plain") ?? "");
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON());
    },
    onBlur: () => {
      onBlur?.();
    },
    onFocus: ({ editor }) => {
      const typed = takeHandedInputRef.current?.();
      if (!typed) return;
      // Текстом, а не строкой-HTML: «<» остаётся символом, а Enter — новым абзацем.
      typed.split("\n").forEach((line, i) => {
        if (i > 0) editor.commands.splitBlock();
        if (line) editor.commands.insertContent({ type: "text", text: line });
      });
    },
  });

  // Reflect external document changes (e.g. a snapshot reload) into the editor.
  useEffect(() => {
    if (!editor) return;
    const doc = document as { type?: string } | null;
    if (doc && doc.type === "doc") {
      const current = JSON.stringify(editor.getJSON());
      const incoming = JSON.stringify(document);
      if (current !== incoming) {
        // Не пользовательская правка: без onUpdate черновик не становится грязным
        // и не пишет чужой документ обратно.
        editor.commands.setContent(document as JSONContent, { emitUpdate: false });
      }
    }
  }, [document, editor]);

  // Apply (or clear) the transient highlight. This dispatches a meta-only
  // transaction, so `onUpdate`/`onChange` never fire and the document is never
  // rewritten. The plugin itself is registered at editor creation via the
  // extension list, so no state-replacing `registerPlugin` call happens here.
  useEffect(() => {
    if (!editor) return;
    setSearchHighlight(editor, highlightQuery);
  }, [editor, highlightQuery]);

  // Keep the editable flag in sync with the external prop. `useEditor` only
  // applies `editable` at creation time, so toggling it after mount requires an
  // explicit setEditable call.
  useEffect(() => {
    editor?.setEditable(editable);
    // Focus the editor the moment editing begins, mirroring the old textarea
    // autofocus, so that a subsequent click-outside fires a clean blur. The
    // caret lands where the user clicked; otherwise it goes to the end.
    if (editable && editor) {
      const point = initialCaretPointRef.current;
      let pos: number | null = null;
      if (point && point !== "end") {
        try {
          pos = editor.view.posAtCoords({ left: point.x, top: point.y })?.pos ?? null;
        } catch {
          // No layout (jsdom) or a point outside the view: caret at the end below.
          pos = null;
        }
      }
      if (pos !== null) {
        editor.chain().focus().setTextSelection(pos).run();
      } else {
        // Клик мимо текста (поле карточки под ним) или вход без клика: каретка
        // в конец явно. Голый focus() оставил бы её в начале документа, а в конец
        // её раньше уводил только побочный setContent при монтировании.
        editor.commands.focus("end");
      }
      // Tiptap переводит DOM-фокус в requestAnimationFrame, и клавиши, нажатые
      // до этого кадра, уходят мимо редактора (End теряется, первые буквы
      // пропадают). Фокус сразу — редактор владеет вводом с первого нажатия.
      editor.view.focus();
    }
  }, [editor, editable]);

  // Expose a Tiptap-free command surface while editing, and clear it on exit.
  useEffect(() => {
    if (!editor) return;
    if (!editable) {
      onCommandsReady?.(null);
      return;
    }
    onCommandsReady?.({
      toggleBold: () => {
        // `focus()` re-establishes the caret/selection before the command, so a
        // rail button click never collapses the user's selection.
        editor.chain().focus().toggleBold().run();
      },
      isBoldActive: () => editor.isActive("bold"),
      toggleItalic: () => {
        editor.chain().focus().toggleItalic().run();
      },
      isItalicActive: () => editor.isActive("italic"),
      toggleStrike: () => {
        editor.chain().focus().toggleStrike().run();
      },
      isStrikeActive: () => editor.isActive("strike"),
      setTextColor: (color) => {
        if (color === "default") {
          editor.chain().focus().unsetMark("textColor").run();
        } else {
          editor.chain().focus().setMark("textColor", { color }).run();
        }
      },
      getTextColor: () => {
        const color = editor.getAttributes("textColor").color as TextColorId | null | undefined;
        return color ?? "default";
      },
    });
  }, [editor, editable, onCommandsReady]);

  // Idle notes unmount their editor instead of flipping it to read-only
  // (P1.8), so the "leaving edit mode" signal above never runs for them:
  // clear the command surface on unmount too. When editing moves from one note
  // to another in a single commit, this cleanup runs before the new editor's
  // effect publishes its commands, so the new surface wins.
  const onCommandsReadyRef = useRef(onCommandsReady);
  useEffect(() => {
    onCommandsReadyRef.current = onCommandsReady;
  }, [onCommandsReady]);
  useEffect(() => {
    return () => {
      if (editable) onCommandsReadyRef.current?.(null);
    };
  }, [editable]);

  // Report formatting state (bold/italic/strike + text color) changes.
  useEffect(() => {
    if (!editor || !editable) return;
    const handler = () => {
      onBoldStateChange?.(editor.isActive("bold"));
      onItalicStateChange?.(editor.isActive("italic"));
      onStrikeStateChange?.(editor.isActive("strike"));
      const color = editor.getAttributes("textColor").color as TextColorId | null | undefined;
      onTextColorChange?.(color ?? "default");
    };
    editor.on("selectionUpdate", handler);
    handler();
    return () => {
      editor.off("selectionUpdate", handler);
    };
  }, [editor, editable, onBoldStateChange, onItalicStateChange, onStrikeStateChange, onTextColorChange]);

  // In display mode (not editing), a click on an inline link should open it in
  // the OS browser and must NOT bubble up into React Flow as a drag or an
  // edit-entry. We attach a capture listener on the editor root: it only acts on
  // `a[href]` clicks while `!editable`, opening the URL and stopping propagation.
  // (Tiptap's Link `openOnClick` only fires while editable and uses `window.open`,
  // which is wrong for a spatial card and the Tauri WebView, so we handle it here.)
  useEffect(() => {
    if (!editor || editable) return;
    const root = editor.view.dom;

    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !root.contains(anchor)) return;

      e.preventDefault();
      e.stopPropagation();
      void openExternalUrl(anchor.href);
    }

    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [editor, editable]);

  if (!editor) return null;

  // `nodrag`/`nopan` are only applied while editing so text selection never
  // collides with card drag; in display mode the card's whole surface must remain
  // draggable. No `nowheel` here either, to avoid swallowing pointer events that
  // React Flow needs for click/selection/drag.
  const interactiveClass = editable ? " nodrag nopan" : "";

  return (
    <EditorContent
      editor={editor}
      className={`note-editor${interactiveClass}`}
      onKeyDownCapture={(event) => {
        if (!editable || !onFinalize) return;
        if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
          return;
        }
        if (event.nativeEvent.isComposing) return;

        const classification = classifyLinkConversion(editor.getJSON());
        if (!classification.qualifies) return;

        event.preventDefault();
        event.stopPropagation();
        onFinalize();
      }}
    />
  );
}
