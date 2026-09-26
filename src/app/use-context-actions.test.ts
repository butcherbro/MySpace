import { act, renderHook } from "@testing-library/react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { TrashSelectionCommand } from "../commands/trash-commands";
import type { IdGenerator } from "../services/id-generator";
import type {
  BoardPortalDto,
  BoardShortcutDto,
  CardDto,
  FilesystemAliasDto,
  FolderPreviewDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { useContextActions, type ContextActionsDeps } from "./use-context-actions";

const mocks = vi.hoisted(() => ({
  pickFolder: vi.fn(),
}));

vi.mock("../services/asset-picker", () => ({
  pickFolder: mocks.pickFolder,
}));

/** Sequential ids ("id-0", "id-1", …), predictable for assertions. */
function idGeneratorFixture(): IdGenerator {
  let counter = 0;
  return { nextId: vi.fn(() => `id-${counter++}`) };
}

function note(overrides: Partial<NoteCardDto> = {}): NoteCardDto {
  return {
    kind: "note",
    id: "note-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 240, height: 120 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc", content: [] },
    plainText: "",
    colorToken: "default",
    ...overrides,
  };
}

function portal(overrides: Partial<BoardPortalDto> = {}): BoardPortalDto {
  return {
    kind: "board_portal",
    id: "portal-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 120, height: 112 },
    zIndex: 0,
    revision: 1,
    target: {
      id: "board-A",
      boardRevision: 1,
      title: "Child",
      colorToken: "terracotta",
      symbol: null,
      childBoardCount: 0,
      childCardCount: 0,
      coverAsset: null,
    },
    ...overrides,
  };
}

function shortcut(overrides: Partial<BoardShortcutDto> = {}): BoardShortcutDto {
  return {
    kind: "board_shortcut",
    id: "shortcut-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 120, height: 112 },
    zIndex: 0,
    revision: 1,
    targetBoardId: "board-A",
    target: {
      id: "board-A",
      boardRevision: 1,
      title: "Child",
      colorToken: "terracotta",
      symbol: null,
      coverAsset: null,
    },
    ...overrides,
  };
}

function alias(overrides: Partial<FilesystemAliasDto> = {}): FilesystemAliasDto {
  return {
    kind: "filesystem_alias",
    id: "alias-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 360, height: 300 },
    zIndex: 0,
    revision: 1,
    targetKind: "folder",
    pathHint: "/Users/x/Folder",
    displayName: "Folder",
    originDeviceId: "device-1",
    originDeviceName: "This Mac",
    local: true,
    ...overrides,
  };
}

function harness(
  overrides: {
    cards?: CardDto[];
    selection?: string[];
    contextMenu?: { cardId: string; x: number; y: number } | null;
    execute?: () => Promise<unknown>;
    listFolderPreview?: ReturnType<typeof vi.fn>;
    openFolderInFinder?: ReturnType<typeof vi.fn>;
    setFilesystemAliasLocalTarget?: ReturnType<typeof vi.fn>;
    refreshTrash?: ReturnType<typeof vi.fn<() => Promise<void>>>;
    screenToFlow?: ((x: number, y: number) => { x: number; y: number }) | null;
  } = {},
) {
  const cards = overrides.cards ?? [note()];
  const execute = vi.fn(overrides.execute ?? (async () => undefined));
  const dispatcher = { execute } as unknown as CommandDispatcher;
  const idGenerator = idGeneratorFixture();
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const setContextMenu = vi.fn() as unknown as Dispatch<
    SetStateAction<{ cardId: string; x: number; y: number } | null>
  >;
  const refreshTrash = overrides.refreshTrash ?? vi.fn<() => Promise<void>>(async () => undefined);
  const listFolderPreview =
    overrides.listFolderPreview ?? vi.fn(async () => ({}) as FolderPreviewDto);
  const openFolderInFinder = overrides.openFolderInFinder ?? vi.fn(async () => undefined);
  const setFilesystemAliasLocalTarget =
    overrides.setFilesystemAliasLocalTarget ?? vi.fn(async () => alias());
  const gateway = {
    listFolderPreview,
    openFolderInFinder,
    setFilesystemAliasLocalTarget,
  } as unknown as WorkspaceGateway;
  const screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null> = {
    current: overrides.screenToFlow === undefined ? null : overrides.screenToFlow,
  };

  const deps: ContextActionsDeps = {
    cards,
    selection: overrides.selection ?? [],
    contextMenu: overrides.contextMenu ?? null,
    setContextMenu,
    screenToFlowRef,
    gateway,
    dispatcher,
    idGenerator,
    dispatch,
    refreshTrash,
  };

  const { result } = renderHook(() => useContextActions(deps));

  return {
    result,
    dispatch,
    setContextMenu,
    execute,
    refreshTrash,
    listFolderPreview,
    openFolderInFinder,
    setFilesystemAliasLocalTarget,
  };
}

describe("useContextActions", () => {
  beforeEach(() => {
    mocks.pickFolder.mockReset();
  });

  describe("handleDeleteSelection", () => {
    it("does nothing when nothing is selected", async () => {
      const test = harness({ selection: [] });

      await act(async () => {
        await test.result.current.handleDeleteSelection();
      });

      expect(test.execute).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
    });

    it("trashes the selection and removes it plus every cascaded shortcut", async () => {
      const p = portal();
      const s = shortcut(); // points at the same board as the portal, but not selected itself
      const test = harness({ cards: [p, s], selection: [p.id] });

      await act(async () => {
        await test.result.current.handleDeleteSelection();
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      // TrashSelectionCommand keeps its item list private, so assert the
      // command type here and the resulting dispatch below.
      expect(test.execute).toHaveBeenCalledWith(expect.any(TrashSelectionCommand));
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "cardsRemoved",
        ids: [p.id, s.id],
      });
      expect(test.refreshTrash).toHaveBeenCalledTimes(1);
    });

    it("does nothing when every selected id is gone from cards", async () => {
      const test = harness({ cards: [], selection: ["missing"] });

      await act(async () => {
        await test.result.current.handleDeleteSelection();
      });

      expect(test.execute).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the trash command rejects", async () => {
      const test = harness({
        cards: [note()],
        selection: ["note-1"],
        execute: async () => {
          throw new Error("stale_revision");
        },
      });

      await act(async () => {
        await test.result.current.handleDeleteSelection();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
      expect(test.refreshTrash).not.toHaveBeenCalled();
    });
  });

  describe("handleCardsSelected", () => {
    it("dispatches selectionChanged when the id set changes", () => {
      const test = harness({ selection: ["a"] });

      act(() => {
        test.result.current.handleCardsSelected({ ids: ["a", "b"] });
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "selectionChanged", ids: ["a", "b"] });
    });

    it("is a no-op when the id set is unchanged", () => {
      const test = harness({ selection: ["a", "b"] });

      act(() => {
        test.result.current.handleCardsSelected({ ids: ["a", "b"] });
      });

      expect(test.dispatch).not.toHaveBeenCalled();
    });
  });

  describe("handleCardActivated", () => {
    it("dispatches editingStarted for a note", () => {
      const test = harness({ cards: [note({ id: "note-1" })] });

      act(() => {
        test.result.current.handleCardActivated("note-1");
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "editingStarted", id: "note-1" });
    });

    it("does nothing for a non-note card", () => {
      const test = harness({ cards: [portal({ id: "portal-1" })] });

      act(() => {
        test.result.current.handleCardActivated("portal-1");
      });

      expect(test.dispatch).not.toHaveBeenCalled();
    });
  });

  describe("handleRequestContextMenu", () => {
    it("selects the card and opens the menu when it isn't already selected", () => {
      const test = harness({ selection: ["other"] });

      act(() => {
        test.result.current.handleRequestContextMenu("card-1", 10, 20);
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "selectionChanged", ids: ["card-1"] });
      expect(test.setContextMenu).toHaveBeenCalledWith({ cardId: "card-1", x: 10, y: 20 });
    });

    it("only opens the menu, without reselecting, when the card is already selected", () => {
      const test = harness({ selection: ["card-1"] });

      act(() => {
        test.result.current.handleRequestContextMenu("card-1", 10, 20);
      });

      expect(test.dispatch).not.toHaveBeenCalled();
      expect(test.setContextMenu).toHaveBeenCalledWith({ cardId: "card-1", x: 10, y: 20 });
    });
  });

  describe("handleLoadFolderPreview", () => {
    it("delegates to the gateway with the fixed 50-entry limit", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleLoadFolderPreview("alias-1");
      });

      expect(test.listFolderPreview).toHaveBeenCalledWith("alias-1", 50);
    });
  });

  describe("handleOpenFolderInFinder", () => {
    it("opens the folder via the gateway", () => {
      const test = harness();

      act(() => {
        test.result.current.handleOpenFolderInFinder("alias-1");
      });

      expect(test.openFolderInFinder).toHaveBeenCalledWith("alias-1");
    });

    it("dispatches a failure when the gateway call rejects", async () => {
      const test = harness({
        openFolderInFinder: vi.fn(async () => {
          throw new Error("not found");
        }),
      });

      await act(async () => {
        test.result.current.handleOpenFolderInFinder("alias-1");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "not found" });
    });
  });

  describe("handlePointFolderShortcutHere", () => {
    it("does nothing when the picker is cancelled", async () => {
      mocks.pickFolder.mockResolvedValue(null);
      const test = harness();

      await act(async () => {
        test.result.current.handlePointFolderShortcutHere("alias-1");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.setFilesystemAliasLocalTarget).not.toHaveBeenCalled();
    });

    it("points the shortcut at the picked folder and dispatches filesystemAliasUpdated", async () => {
      mocks.pickFolder.mockResolvedValue("/Users/x/Picked");
      const updated = alias({ local: true });
      const test = harness({ setFilesystemAliasLocalTarget: vi.fn(async () => updated) });

      await act(async () => {
        test.result.current.handlePointFolderShortcutHere("alias-1");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.setFilesystemAliasLocalTarget).toHaveBeenCalledWith("alias-1", "/Users/x/Picked");
      expect(test.dispatch).toHaveBeenCalledWith({ type: "filesystemAliasUpdated", alias: updated });
    });

    it("dispatches a failure when the gateway call rejects", async () => {
      mocks.pickFolder.mockResolvedValue("/Users/x/Picked");
      const test = harness({
        setFilesystemAliasLocalTarget: vi.fn(async () => {
          throw new Error("io error");
        }),
      });

      await act(async () => {
        test.result.current.handlePointFolderShortcutHere("alias-1");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "io error" });
    });
  });

  describe("handleContextDelete", () => {
    it("does nothing when the context menu is closed", () => {
      const test = harness({ contextMenu: null });

      act(() => {
        test.result.current.handleContextDelete();
      });

      expect(test.execute).not.toHaveBeenCalled();
    });

    it("trashes the current selection (not just the clicked card) and cascades shortcuts", async () => {
      const p = portal();
      const s = shortcut();
      const test = harness({
        cards: [p, s],
        selection: [p.id],
        contextMenu: { cardId: s.id, x: 1, y: 2 },
      });

      await act(async () => {
        test.result.current.handleContextDelete();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.setContextMenu).toHaveBeenCalledWith(null);
      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: [p.id, s.id] });
      expect(test.refreshTrash).toHaveBeenCalledTimes(1);
    });

    it("falls back to the right-clicked card when the selection is empty", async () => {
      const p = portal();
      const test = harness({ cards: [p], selection: [], contextMenu: { cardId: p.id, x: 1, y: 2 } });

      await act(async () => {
        test.result.current.handleContextDelete();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: [p.id] });
    });

    it("dispatches a failure when the trash command rejects", async () => {
      const test = harness({
        cards: [note()],
        selection: ["note-1"],
        contextMenu: { cardId: "note-1", x: 1, y: 2 },
        execute: async () => {
          throw new Error("stale_revision");
        },
      });

      await act(async () => {
        test.result.current.handleContextDelete();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("pane context menu", () => {
    it("starts closed", () => {
      const test = harness();

      expect(test.result.current.paneContextMenu).toBeNull();
    });

    it("opens at the converted flow coordinates when a converter is available", () => {
      const screenToFlow = vi.fn((x: number, y: number) => ({ x: x * 2, y: y * 2 }));
      const test = harness({ screenToFlow });

      act(() => {
        test.result.current.handlePaneContextMenu(10, 20);
      });

      expect(test.result.current.paneContextMenu).toEqual({ x: 10, y: 20, flowX: 20, flowY: 40 });
    });

    it("falls back to the screen coordinates when no converter is ready yet", () => {
      const test = harness({ screenToFlow: null });

      act(() => {
        test.result.current.handlePaneContextMenu(10, 20);
      });

      expect(test.result.current.paneContextMenu).toEqual({ x: 10, y: 20, flowX: 10, flowY: 20 });
    });

    it("closes via setPaneContextMenu", () => {
      const test = harness();

      act(() => {
        test.result.current.handlePaneContextMenu(10, 20);
      });
      act(() => {
        test.result.current.setPaneContextMenu(null);
      });

      expect(test.result.current.paneContextMenu).toBeNull();
    });
  });

  describe("handleDuplicatePortal", () => {
    it("duplicates the board and dispatches cardAdded with the new portal", async () => {
      const created = portal({ id: "portal-2" });
      const test = harness({ execute: async () => ({ newBoardId: "board-B", portal: created }) });

      await act(async () => {
        test.result.current.handleDuplicatePortal(portal());
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardAdded", card: created });
    });

    it("dispatches a failure when the duplicate command rejects", async () => {
      const test = harness({
        execute: async () => {
          throw new Error("boom");
        },
      });

      await act(async () => {
        test.result.current.handleDuplicatePortal(portal());
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "boom" });
    });
  });

  describe("handleCreateShortcut", () => {
    it("creates a shortcut pointing at a portal's target board", async () => {
      const created = shortcut({ id: "shortcut-2" });
      const test = harness({ execute: async () => created });

      await act(async () => {
        test.result.current.handleCreateShortcut(portal());
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardAdded", card: created });
    });

    it("creates a shortcut pointing at the SAME target as a source shortcut, not the source card", async () => {
      const created = shortcut({ id: "shortcut-3" });
      const test = harness({ execute: async () => created });

      await act(async () => {
        test.result.current.handleCreateShortcut(shortcut());
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
    });

    it("does nothing for a broken shortcut (no target)", async () => {
      const test = harness();

      await act(async () => {
        test.result.current.handleCreateShortcut(shortcut({ target: null }));
        await Promise.resolve();
      });

      expect(test.execute).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the create command rejects", async () => {
      const test = harness({
        execute: async () => {
          throw new Error("boom");
        },
      });

      await act(async () => {
        test.result.current.handleCreateShortcut(portal());
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "boom" });
    });
  });
});
