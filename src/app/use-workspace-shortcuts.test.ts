import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceShortcuts, type WorkspaceShortcutsDeps } from "./use-workspace-shortcuts";

function makeDeps(overrides: Partial<WorkspaceShortcutsDeps> = {}): WorkspaceShortcutsDeps {
  return {
    handleNavigateBack: vi.fn(),
    handleNavigateForward: vi.fn(),
    handleWorkspaceUndo: vi.fn(async () => {}),
    handleWorkspaceRedo: vi.fn(async () => {}),
    handleDeleteSelection: vi.fn(async () => {}),
    handleCopySelection: vi.fn(),
    trashOpen: false,
    closeTrashDrawer: vi.fn(),
    ...overrides,
  };
}

function dispatchKeyDown(init: KeyboardEventInit, target?: EventTarget) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(event, "target", { value: target });
  window.dispatchEvent(event);
  return event;
}

describe("useWorkspaceShortcuts", () => {
  it("Cmd+Z triggers undo", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "z", metaKey: true });
    });

    expect(deps.handleWorkspaceUndo).toHaveBeenCalledTimes(1);
    expect(deps.handleWorkspaceRedo).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+Z triggers redo", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "z", metaKey: true, shiftKey: true });
    });

    expect(deps.handleWorkspaceRedo).toHaveBeenCalledTimes(1);
    expect(deps.handleWorkspaceUndo).not.toHaveBeenCalled();
  });

  it("Ctrl+Z triggers undo too (non-mac: the guard is metaKey OR ctrlKey)", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "z", ctrlKey: true });
    });

    expect(deps.handleWorkspaceUndo).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Shift+Z triggers redo too", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "z", ctrlKey: true, shiftKey: true });
    });

    expect(deps.handleWorkspaceRedo).toHaveBeenCalledTimes(1);
  });

  it("Cmd+[ navigates back", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "[", metaKey: true });
    });

    expect(deps.handleNavigateBack).toHaveBeenCalledTimes(1);
  });

  it("Cmd+] navigates forward", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "]", metaKey: true });
    });

    expect(deps.handleNavigateForward).toHaveBeenCalledTimes(1);
  });

  it("Cmd+C copies the selection", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "c", metaKey: true });
    });

    expect(deps.handleCopySelection).toHaveBeenCalledTimes(1);
  });

  it("Backspace deletes the selection without a modifier key", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "Backspace" });
    });

    expect(deps.handleDeleteSelection).toHaveBeenCalledTimes(1);
  });

  it("Delete deletes the selection", () => {
    const deps = makeDeps();
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "Delete" });
    });

    expect(deps.handleDeleteSelection).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the trash drawer when it is open", () => {
    const deps = makeDeps({ trashOpen: true });
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "Escape" });
    });

    expect(deps.closeTrashDrawer).toHaveBeenCalledTimes(1);
  });

  it("Escape does nothing when the trash drawer is closed", () => {
    const deps = makeDeps({ trashOpen: false });
    renderHook(() => useWorkspaceShortcuts(deps));

    act(() => {
      dispatchKeyDown({ key: "Escape" });
    });

    expect(deps.closeTrashDrawer).not.toHaveBeenCalled();
  });

  describe("ignored while a text-entry control owns focus", () => {
    it("ignores Cmd+Z targeting a contenteditable element", () => {
      const deps = makeDeps();
      renderHook(() => useWorkspaceShortcuts(deps));

      const editable = document.createElement("div");
      editable.contentEditable = "true";
      // jsdom does not compute `isContentEditable` from the attribute (same gap noted
      // in use-canvas-paste.ts), so the guard's actual property is set by hand here.
      Object.defineProperty(editable, "isContentEditable", { value: true });
      document.body.appendChild(editable);

      act(() => {
        dispatchKeyDown({ key: "z", metaKey: true }, editable);
      });

      expect(deps.handleWorkspaceUndo).not.toHaveBeenCalled();
      editable.remove();
    });

    it("ignores Backspace targeting a textarea", () => {
      const deps = makeDeps();
      renderHook(() => useWorkspaceShortcuts(deps));

      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      act(() => {
        dispatchKeyDown({ key: "Backspace" }, textarea);
      });

      expect(deps.handleDeleteSelection).not.toHaveBeenCalled();
      textarea.remove();
    });

    it("ignores Delete targeting an input (the top-bar search field)", () => {
      const deps = makeDeps();
      renderHook(() => useWorkspaceShortcuts(deps));

      const input = document.createElement("input");
      document.body.appendChild(input);

      act(() => {
        dispatchKeyDown({ key: "Delete" }, input);
      });

      expect(deps.handleDeleteSelection).not.toHaveBeenCalled();
      input.remove();
    });

    it("ignores Escape targeting an input, even while the trash drawer is open", () => {
      const deps = makeDeps({ trashOpen: true });
      renderHook(() => useWorkspaceShortcuts(deps));

      const input = document.createElement("input");
      document.body.appendChild(input);

      act(() => {
        dispatchKeyDown({ key: "Escape" }, input);
      });

      expect(deps.closeTrashDrawer).not.toHaveBeenCalled();
      input.remove();
    });
  });

  it("removes the listener on unmount", () => {
    const deps = makeDeps();
    const { unmount } = renderHook(() => useWorkspaceShortcuts(deps));

    unmount();

    act(() => {
      dispatchKeyDown({ key: "z", metaKey: true });
    });

    expect(deps.handleWorkspaceUndo).not.toHaveBeenCalled();
  });
});
