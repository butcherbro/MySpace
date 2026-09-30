import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssetDto,
  BoardPortalDto,
  BoardShortcutDto,
  BoardSummary,
  CardDto,
  EmbedCardDto,
  ImageCardDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { clearCardClipboard, readCardClipboard } from "./card-clipboard";
import { useCopyActions, type CopyActionsOptions } from "./use-copy-actions";

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
}));

vi.mock("../services/clipboard", () => ({
  copyText: mocks.copyText,
}));

function asset(overrides: Partial<AssetDto> = {}): AssetDto {
  return {
    id: "asset-1",
    fileName: "photo.png",
    mimeType: "image/png",
    width: 100,
    height: 100,
    sizeBytes: 1000,
    filePath: "/assets/photo.png",
    ...overrides,
  };
}

function note(overrides: Partial<NoteCardDto> = {}): NoteCardDto {
  return {
    kind: "note",
    id: "note-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 100 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc", content: [] },
    plainText: "hello",
    colorToken: "default",
    ...overrides,
  };
}

function image(overrides: Partial<ImageCardDto> = {}): ImageCardDto {
  return {
    kind: "image",
    id: "image-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 100 },
    zIndex: 0,
    revision: 1,
    asset: asset(),
    captionJson: { type: "doc", content: [] },
    captionPlainText: "",
    ...overrides,
  };
}

function embed(overrides: Partial<EmbedCardDto> = {}): EmbedCardDto {
  return {
    kind: "embed",
    id: "embed-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 320, height: 180 },
    zIndex: 0,
    revision: 1,
    sourceUrl: "https://example.com",
    displayUrl: "example.com",
    siteName: null,
    title: "https://example.com",
    provider: null,
    descriptionJson: { type: "doc", content: [] },
    descriptionPlainText: "",
    descriptionOrigin: null,
    faviconAsset: null,
    previewAsset: null,
    previewOrigin: null,
    metadataStatus: "ready",
    metadataError: null,
    ...overrides,
  };
}

function portal(overrides: Partial<BoardPortalDto["target"]> = {}): BoardPortalDto {
  return {
    kind: "board_portal",
    id: "portal-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 200 },
    zIndex: 0,
    revision: 1,
    target: {
      id: "child-board-1",
      boardRevision: 1,
      title: "Child",
      colorToken: "default",
      symbol: null,
      childBoardCount: 0,
      childCardCount: 0,
      coverAsset: null,
      ...overrides,
    },
  };
}

function shortcut(overrides: Partial<BoardShortcutDto> = {}): BoardShortcutDto {
  return {
    kind: "board_shortcut",
    id: "shortcut-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 200 },
    zIndex: 0,
    revision: 1,
    targetBoardId: "child-board-1",
    target: {
      id: "child-board-1",
      boardRevision: 1,
      title: "Child",
      colorToken: "default",
      symbol: null,
      coverAsset: null,
    },
    ...overrides,
  };
}

function board(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: "home",
    title: "Home",
    parentBoardId: null,
    revision: 1,
    colorToken: "default",
    symbol: null,
    coverAsset: null,
    ...overrides,
  };
}

function harness(
  overrides: {
    contextMenu?: CopyActionsOptions["contextMenu"];
    selection?: string[];
    cards?: CardDto[];
    board?: BoardSummary | null;
    resolveAssetPath?: ReturnType<typeof vi.fn>;
    copyImageCards?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const resolveAssetPath = overrides.resolveAssetPath ?? vi.fn(async () => "/assets/photo.png");
  const copyImageCards = overrides.copyImageCards ?? vi.fn(async () => undefined);
  const gateway = { resolveAssetPath, copyImageCards } as unknown as WorkspaceGateway;
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const setPaneContextMenu = vi.fn();
  const cards = overrides.cards ?? [];
  const contextMenu = overrides.contextMenu === undefined ? { cardId: "card-1" } : overrides.contextMenu;
  const selection = overrides.selection ?? [];
  const currentBoard = overrides.board === undefined ? board() : overrides.board;

  const { result } = renderHook(() =>
    useCopyActions({
      contextMenu,
      selection,
      cards,
      board: currentBoard,
      gateway,
      dispatch,
      setPaneContextMenu,
    }),
  );

  return { result, dispatch, setPaneContextMenu, resolveAssetPath, copyImageCards };
}

describe("useCopyActions", () => {
  beforeEach(() => {
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(undefined);
    clearCardClipboard();
  });

  describe("handleCopyLink", () => {
    it("copies the board address for a board_portal card", async () => {
      const test = harness({ contextMenu: { cardId: "portal-1" }, cards: [portal()] });

      await act(async () => {
        await test.result.current.handleCopyLink();
      });

      expect(mocks.copyText).toHaveBeenCalledWith("myspace://board/child-board-1");
    });

    it("copies the target board's address for a board_shortcut with a target", async () => {
      const test = harness({ contextMenu: { cardId: "shortcut-1" }, cards: [shortcut()] });

      await act(async () => {
        await test.result.current.handleCopyLink();
      });

      expect(mocks.copyText).toHaveBeenCalledWith("myspace://board/child-board-1");
    });

    it("copies the card address for any other card kind", async () => {
      const test = harness({ contextMenu: { cardId: "note-1" }, cards: [note()] });

      await act(async () => {
        await test.result.current.handleCopyLink();
      });

      expect(mocks.copyText).toHaveBeenCalledWith("myspace://card/note-1");
    });

    it("does nothing without an open context menu", async () => {
      const test = harness({ contextMenu: null, cards: [note()] });

      await act(async () => {
        await test.result.current.handleCopyLink();
      });

      expect(mocks.copyText).not.toHaveBeenCalled();
    });

    it("dispatches a failure instead of throwing when the clipboard write rejects", async () => {
      mocks.copyText.mockRejectedValueOnce(new Error("clipboard unavailable"));
      const test = harness({ contextMenu: { cardId: "note-1" }, cards: [note()] });

      await act(async () => {
        await test.result.current.handleCopyLink();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "clipboard unavailable" });
    });
  });

  describe("handleCopyFilePath", () => {
    it("resolves and copies the asset path for an image card", async () => {
      const test = harness({
        contextMenu: { cardId: "image-1" },
        cards: [image()],
        resolveAssetPath: vi.fn(async () => "/assets/photo.png"),
      });

      await act(async () => {
        await test.result.current.handleCopyFilePath();
      });

      expect(test.resolveAssetPath).toHaveBeenCalledWith("asset-1");
      expect(mocks.copyText).toHaveBeenCalledWith("/assets/photo.png");
    });

    it("does nothing for a non-image card", async () => {
      const test = harness({ contextMenu: { cardId: "note-1" }, cards: [note()] });

      await act(async () => {
        await test.result.current.handleCopyFilePath();
      });

      expect(test.resolveAssetPath).not.toHaveBeenCalled();
      expect(mocks.copyText).not.toHaveBeenCalled();
    });

    it("does nothing without an open context menu", async () => {
      const test = harness({ contextMenu: null, cards: [image()] });

      await act(async () => {
        await test.result.current.handleCopyFilePath();
      });

      expect(test.resolveAssetPath).not.toHaveBeenCalled();
    });

    it("dispatches a failure instead of throwing when resolving the path rejects", async () => {
      const test = harness({
        contextMenu: { cardId: "image-1" },
        cards: [image()],
        resolveAssetPath: vi.fn(async () => {
          throw new Error("asset missing");
        }),
      });

      await act(async () => {
        await test.result.current.handleCopyFilePath();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "asset missing" });
    });
  });

  describe("handleCopySourceUrl", () => {
    it("copies the embed's source URL", async () => {
      const test = harness({
        contextMenu: { cardId: "embed-1" },
        cards: [embed({ sourceUrl: "https://example.com/page" })],
      });

      await act(async () => {
        await test.result.current.handleCopySourceUrl();
      });

      expect(mocks.copyText).toHaveBeenCalledWith("https://example.com/page");
    });

    it("does nothing for a non-embed card", async () => {
      const test = harness({ contextMenu: { cardId: "note-1" }, cards: [note()] });

      await act(async () => {
        await test.result.current.handleCopySourceUrl();
      });

      expect(mocks.copyText).not.toHaveBeenCalled();
    });

    it("does nothing without an open context menu", async () => {
      const test = harness({ contextMenu: null, cards: [embed()] });

      await act(async () => {
        await test.result.current.handleCopySourceUrl();
      });

      expect(mocks.copyText).not.toHaveBeenCalled();
    });

    it("dispatches a failure instead of throwing when the clipboard write rejects", async () => {
      mocks.copyText.mockRejectedValueOnce(new Error("clipboard unavailable"));
      const test = harness({ contextMenu: { cardId: "embed-1" }, cards: [embed()] });

      await act(async () => {
        await test.result.current.handleCopySourceUrl();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "clipboard unavailable" });
    });
  });

  describe("handleCopyBoardLink", () => {
    it("closes the pane context menu and copies the current board's address", async () => {
      const test = harness({ board: board({ id: "board-42" }) });

      await act(async () => {
        await test.result.current.handleCopyBoardLink();
      });

      expect(test.setPaneContextMenu).toHaveBeenCalledWith(null);
      expect(mocks.copyText).toHaveBeenCalledWith("myspace://board/board-42");
    });

    it("still closes the pane context menu but copies nothing without a current board", async () => {
      const test = harness({ board: null });

      await act(async () => {
        await test.result.current.handleCopyBoardLink();
      });

      expect(test.setPaneContextMenu).toHaveBeenCalledWith(null);
      expect(mocks.copyText).not.toHaveBeenCalled();
    });

    it("dispatches a failure instead of throwing when the clipboard write rejects", async () => {
      mocks.copyText.mockRejectedValueOnce(new Error("clipboard unavailable"));
      const test = harness({ board: board() });

      await act(async () => {
        await test.result.current.handleCopyBoardLink();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "clipboard unavailable" });
    });
  });

  describe("handleCopySelectionImages", () => {
    it("copies only the image cards in the selection", () => {
      const test = harness({
        selection: ["note-1", "image-1"],
        cards: [note(), image()],
      });

      act(() => {
        test.result.current.handleCopySelectionImages();
      });

      expect(test.copyImageCards).toHaveBeenCalledWith({ cardIds: ["image-1"] });
    });

    it("does nothing when the selection has no images", () => {
      const test = harness({ selection: ["note-1"], cards: [note()] });

      act(() => {
        test.result.current.handleCopySelectionImages();
      });

      expect(test.copyImageCards).not.toHaveBeenCalled();
    });

    it("dispatches a failure instead of throwing when the gateway call rejects", async () => {
      const test = harness({
        selection: ["image-1"],
        cards: [image()],
        copyImageCards: vi.fn(async () => {
          throw new Error("copy failed");
        }),
      });

      await act(async () => {
        test.result.current.handleCopySelectionImages();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "copy failed" });
    });
  });

  describe("handleCopySelection", () => {
    it("writes note/image/portal/shortcut cards to the card clipboard, relative to the group's top-left", () => {
      const test = harness({
        selection: ["note-1", "image-1", "portal-1", "shortcut-1"],
        // portal/shortcut fixtures default to frame x:0,y:0 (their top-left set the group's origin).
        cards: [
          note({ frame: { x: 100, y: 100, width: 200, height: 100 } }),
          image({ frame: { x: 150, y: 120, width: 200, height: 100 } }),
          portal(),
          shortcut(),
        ],
      });

      act(() => {
        test.result.current.handleCopySelection();
      });

      const copied = readCardClipboard();
      expect(copied).not.toBeNull();
      expect(copied).toHaveLength(4);
      // top-left of the group is (0,0) from the portal/shortcut fixtures.
      const byKind = Object.fromEntries((copied ?? []).map((c) => [c.kind, c]));
      expect(byKind.note).toMatchObject({ kind: "note", dx: 100, dy: 100, plainText: "hello" });
      expect(byKind.image).toMatchObject({ kind: "image", dx: 150, dy: 120 });
      expect(byKind.board).toMatchObject({ kind: "board", dx: 0, dy: 0, sourceBoardId: "child-board-1" });
      expect(byKind.shortcut).toMatchObject({ kind: "shortcut", dx: 0, dy: 0, targetBoardId: "child-board-1" });
    });

    it("excludes a broken shortcut (no target) from the card clipboard", () => {
      const test = harness({
        selection: ["shortcut-1"],
        cards: [shortcut({ target: null })],
      });

      act(() => {
        test.result.current.handleCopySelection();
      });

      expect(readCardClipboard()).toBeNull();
    });

    it("also copies any selected images to the system clipboard via the gateway", () => {
      const test = harness({
        selection: ["image-1"],
        cards: [image()],
      });

      act(() => {
        test.result.current.handleCopySelection();
      });

      expect(test.copyImageCards).toHaveBeenCalledWith({ cardIds: ["image-1"] });
    });

    it("does nothing to the card clipboard for an empty selection", () => {
      const test = harness({ selection: [], cards: [] });

      act(() => {
        test.result.current.handleCopySelection();
      });

      expect(readCardClipboard()).toBeNull();
      expect(test.copyImageCards).not.toHaveBeenCalled();
    });
  });
});
