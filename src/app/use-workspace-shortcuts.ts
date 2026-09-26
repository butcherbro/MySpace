import { useEffect } from "react";

/**
 * Global keyboard shortcuts for the workspace: Cmd+[ / Cmd+] navigate
 * back/forward, Cmd+Z / Cmd+Shift+Z undo/redo, Cmd+C copies the selection,
 * Backspace/Delete deletes it, and Escape closes the trash drawer — unless an
 * editor or another text-entry control owns focus.
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
  trashOpen: boolean;
  closeTrashDrawer: () => void;
}

export function useWorkspaceShortcuts(deps: WorkspaceShortcutsDeps): void {
  const {
    handleNavigateBack,
    handleNavigateForward,
    handleWorkspaceUndo,
    handleWorkspaceRedo,
    handleDeleteSelection,
    handleCopySelection,
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
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        void handleDeleteSelection();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[") {
        e.preventDefault();
        handleNavigateBack();
      } else if (e.key === "]") {
        e.preventDefault();
        handleNavigateForward();
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          void handleWorkspaceRedo();
        } else {
          void handleWorkspaceUndo();
        }
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        handleCopySelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNavigateBack, handleNavigateForward, handleWorkspaceUndo, handleWorkspaceRedo, handleDeleteSelection, handleCopySelection, trashOpen, closeTrashDrawer]);
}
