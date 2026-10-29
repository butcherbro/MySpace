import { useEffect } from "react";
import { isDraftHandoffActive } from "../editor/draft-handoff";

/**
 * Global keyboard shortcuts for the workspace: Cmd+[ / Cmd+] navigate
 * back/forward, Cmd+Z / Cmd+Shift+Z undo/redo, Cmd+C copies the selection,
 * Backspace/Delete deletes it, Cmd+G / Cmd+Shift+G group / ungroup it, and
 * Escape closes the trash drawer — unless an editor or another text-entry
 * control owns focus.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 12).
 */

export interface WorkspaceShortcutsDeps {
  handleNavigateBack: () => void;
  handleNavigateForward: () => void;
  handleWorkspaceUndo: () => Promise<void>;
  handleWorkspaceRedo: () => Promise<void>;
  handleDeleteSelection: () => Promise<void>;
  handleCopySelection: () => void;
  /** Cmd/Ctrl+G: обвести выделение группой (ADR-0013). */
  handleGroupSelection?: () => Promise<void>;
  /** Cmd/Ctrl+Shift+G: разгруппировать выделенные группы. */
  handleUngroupSelection?: () => Promise<void>;
  trashOpen: boolean;
  closeTrashDrawer: () => void;
}

/**
 * Whether `e` is the shortcut key `char` (physical key `code` on a US layout).
 *
 * Латинскую раскладку (QWERTY, AZERTY, Dvorak) узнаём по символу, как меню
 * macOS. На нелатинской (русская: Cmd+G даёт «п», Cmd+[ — «х») символ не
 * совпадёт никогда, поэтому там — по физической клавише.
 */
export function isShortcutKey(e: Pick<KeyboardEvent, "key" | "code">, char: string, code: string): boolean {
  if (e.key.toLowerCase() === char) return true;
  const printableAscii = /^[\x20-\x7e]$/.test(e.key);
  return !printableAscii && e.code === code;
}

export function useWorkspaceShortcuts(deps: WorkspaceShortcutsDeps): void {
  const {
    handleNavigateBack,
    handleNavigateForward,
    handleWorkspaceUndo,
    handleWorkspaceRedo,
    handleDeleteSelection,
    handleCopySelection,
    handleGroupSelection,
    handleUngroupSelection,
    trashOpen,
    closeTrashDrawer,
  } = deps;

  // Cmd+[ / Cmd+] navigate back/forward, Cmd+Z / Cmd+Shift+Z undo/redo,
  // unless an editor owns focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      // The top-bar search field is a plain <input>, not a Tiptap editor or a
      // textarea. Backspace/Delete inside it must edit text, not trash canvas
      // selection, so treat any text-entry control as owning focus.
      const inTextEntry =
        target &&
        (target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.tagName === "INPUT");
      if (inTextEntry) return;
      if (e.key === "Escape") {
        if (trashOpen) {
          e.preventDefault();
          closeTrashDrawer();
        }
        return;
      }
      // Клавиши, адресованные тексту, не действуют на холст, пока фокус в поле
      // ввода (событие могло прийти не из него) или правка переходит в копию
      // конфликта и фокус ни на каком редакторе: выделена правимая карточка.
      // Сам факт правки не в счёт: у правимой карточки может не быть
      // редактора (копия за краем экрана не смонтирована, повреждённая заметка).
      const active = document.activeElement;
      const editingText =
        (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea"))) ||
        isDraftHandoffActive();
      if (e.key === "Backspace" || e.key === "Delete") {
        if (editingText) return;
        e.preventDefault();
        // Зажатая клавиша не удаляет повторно: одно нажатие — одно удаление.
        if (e.repeat) return;
        void handleDeleteSelection();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (isShortcutKey(e, "[", "BracketLeft")) {
        e.preventDefault();
        handleNavigateBack();
      } else if (isShortcutKey(e, "]", "BracketRight")) {
        e.preventDefault();
        handleNavigateForward();
      } else if (isShortcutKey(e, "z", "KeyZ")) {
        if (editingText) return;
        e.preventDefault();
        if (e.shiftKey) {
          void handleWorkspaceRedo();
        } else {
          void handleWorkspaceUndo();
        }
      } else if (isShortcutKey(e, "c", "KeyC")) {
        e.preventDefault();
        handleCopySelection();
      } else if (isShortcutKey(e, "g", "KeyG")) {
        if (editingText) return;
        e.preventDefault();
        if (e.repeat) return;
        if (e.shiftKey) void handleUngroupSelection?.();
        else void handleGroupSelection?.();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNavigateBack, handleNavigateForward, handleWorkspaceUndo, handleWorkspaceRedo, handleDeleteSelection, handleCopySelection, handleGroupSelection, handleUngroupSelection, trashOpen, closeTrashDrawer]);
}
