import { act, renderHook } from "@testing-library/react";
import type { SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdGenerator } from "../services/id-generator";
import type { AssetDto, BoardPortalDto, QuickBoardDto, WorkspaceGateway } from "../services/workspace-gateway";
import {
  initialState,
  reducer,
  type CurrentBoardAction,
  type CurrentBoardState,
} from "../state/current-board-store";
import { useBoardCover, type BoardCoverOptions } from "./use-board-cover";

const mocks = vi.hoisted(() => ({
  pickImageFile: vi.fn(),
}));

vi.mock("../services/asset-picker", () => ({
  pickImageFile: mocks.pickImageFile,
}));

function asset(overrides: Partial<AssetDto> = {}): AssetDto {
  return {
    id: "asset-1",
    fileName: "cover.png",
    mimeType: "image/png",
    width: 100,
    height: 100,
    sizeBytes: 1000,
    filePath: "/assets/cover.png",
    ...overrides,
  };
}

function portal(overrides: Partial<BoardPortalDto["target"]> = {}): BoardPortalDto {
  return {
    kind: "board_portal",
    id: "portal-1",
    boardId: "board-1",
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

function quickBoard(overrides: Partial<QuickBoardDto> = {}): QuickBoardDto {
  return {
    boardId: "child-board-1",
    title: "Child",
    colorToken: "default",
    symbol: null,
    sortOrder: 0,
    coverAsset: null,
    ...overrides,
  };
}

function harness(
  overrides: {
    contextMenu?: { cardId: string } | null;
    cards?: BoardCoverOptions["cards"];
    importClipboardImage?: ReturnType<typeof vi.fn>;
    setBoardCover?: ReturnType<typeof vi.fn>;
    importAsset?: ReturnType<typeof vi.fn>;
    removeBoardCover?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const importClipboardImage = overrides.importClipboardImage ?? vi.fn(async () => asset());
  const setBoardCover = overrides.setBoardCover ?? vi.fn(async () => undefined);
  const importAsset = overrides.importAsset ?? vi.fn(async () => asset());
  const removeBoardCover = overrides.removeBoardCover ?? vi.fn(async () => undefined);
  const gateway = {
    importClipboardImage,
    setBoardCover,
    importAsset,
    removeBoardCover,
  } as unknown as WorkspaceGateway;
  const idGenerator: IdGenerator = { nextId: () => "generated-id" };
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const setQuickBoards = vi.fn<(updater: SetStateAction<QuickBoardDto[]>) => void>();
  const cards = overrides.cards ?? [portal()];
  const contextMenu = overrides.contextMenu === undefined ? { cardId: "portal-1" } : overrides.contextMenu;

  const { result } = renderHook(() =>
    useBoardCover({ contextMenu, cards, gateway, idGenerator, dispatch, setQuickBoards }),
  );

  return {
    result,
    dispatch,
    setQuickBoards,
    importClipboardImage,
    setBoardCover,
    importAsset,
    removeBoardCover,
  };
}

/** Достаёт функцию-апдейтер из последнего вызова setQuickBoards и применяет её. */
function appliedQuickBoards(
  setQuickBoards: ReturnType<typeof vi.fn<(updater: SetStateAction<QuickBoardDto[]>) => void>>,
  previous: QuickBoardDto[],
): QuickBoardDto[] {
  const updater = setQuickBoards.mock.calls[0][0] as (prev: QuickBoardDto[]) => QuickBoardDto[];
  return updater(previous);
}

describe("useBoardCover", () => {
  // vi.hoisted создаёт mocks один раз на файл — сбрасываем перед каждым тестом.
  beforeEach(() => {
    mocks.pickImageFile.mockReset();
  });

  describe("handleSetCoverFromClipboard", () => {
    it("imports the clipboard image, sets the board cover, and updates the portal + quick board", async () => {
      const clipboardAsset = asset({ id: "asset-clipboard" });
      const test = harness({ importClipboardImage: vi.fn(async () => clipboardAsset) });

      await act(async () => {
        await test.result.current.handleSetCoverFromClipboard();
      });

      expect(test.setBoardCover).toHaveBeenCalledWith({ boardId: "child-board-1", assetId: "asset-clipboard" });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "boardCoverChanged",
        boardId: "child-board-1",
        coverAsset: clipboardAsset,
      });
      const boards = appliedQuickBoards(test.setQuickBoards, [quickBoard()]);
      expect(boards).toEqual([quickBoard({ coverAsset: clipboardAsset })]);
    });

    it("dispatches a failure instead of throwing when the clipboard has no image", async () => {
      const test = harness({
        importClipboardImage: vi.fn(async () => {
          throw new Error("clipboard is empty");
        }),
      });

      await act(async () => {
        await test.result.current.handleSetCoverFromClipboard();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "clipboard is empty" });
      expect(test.setBoardCover).not.toHaveBeenCalled();
      expect(test.setQuickBoards).not.toHaveBeenCalled();
    });
  });

  describe("handleChooseCover", () => {
    it("shows the cover even when the portal was moved (new revision) while the file was being imported", async () => {
      mocks.pickImageFile.mockResolvedValue({
        path: "/tmp/picked.png",
        fileName: "picked.png",
        mimeType: "image/png",
      });
      const pickedAsset = asset({ id: "asset-picked" });
      const captured = portal();
      // Пока шёл импорт, перемещение из очереди подняло портал до ревизии 2.
      const moved = { ...captured, revision: 2, frame: { x: 300, y: 40, width: 200, height: 200 } };
      const test = harness({ cards: [captured], importAsset: vi.fn(async () => pickedAsset) });

      await act(async () => {
        await test.result.current.handleChooseCover();
      });

      const state = test.dispatch.mock.calls.reduce<CurrentBoardState>(
        (s, [action]) => reducer(s, action),
        { ...initialState, cards: [moved] },
      );
      expect(state.cards).toEqual([{ ...moved, target: { ...moved.target, coverAsset: pickedAsset } }]);
    });

    it("imports the picked file, sets the board cover, and updates the portal + quick board", async () => {
      mocks.pickImageFile.mockResolvedValue({
        path: "/tmp/picked.png",
        fileName: "picked.png",
        mimeType: "image/png",
      });
      const pickedAsset = asset({ id: "asset-picked" });
      const test = harness({ importAsset: vi.fn(async () => pickedAsset) });

      await act(async () => {
        await test.result.current.handleChooseCover();
      });

      expect(test.importAsset).toHaveBeenCalledWith({
        id: "generated-id",
        sourcePath: "/tmp/picked.png",
        fileName: "picked.png",
        mimeType: "image/png",
      });
      expect(test.setBoardCover).toHaveBeenCalledWith({ boardId: "child-board-1", assetId: "asset-picked" });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "boardCoverChanged",
        boardId: "child-board-1",
        coverAsset: pickedAsset,
      });
      const boards = appliedQuickBoards(test.setQuickBoards, [quickBoard()]);
      expect(boards).toEqual([quickBoard({ coverAsset: pickedAsset })]);
    });

    it("does nothing when the user cancels the file picker", async () => {
      mocks.pickImageFile.mockResolvedValue(null);
      const test = harness();

      await act(async () => {
        await test.result.current.handleChooseCover();
      });

      expect(test.importAsset).not.toHaveBeenCalled();
      expect(test.setBoardCover).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
      expect(test.setQuickBoards).not.toHaveBeenCalled();
    });
  });

  describe("handleRemoveCover", () => {
    it("removes the board cover and clears it on the portal + quick board", async () => {
      const test = harness({
        cards: [portal({ coverAsset: asset() })],
      });

      await act(async () => {
        await test.result.current.handleRemoveCover();
      });

      expect(test.removeBoardCover).toHaveBeenCalledWith("child-board-1");
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "boardCoverChanged",
        boardId: "child-board-1",
        coverAsset: null,
      });
      const boards = appliedQuickBoards(test.setQuickBoards, [quickBoard({ coverAsset: asset() })]);
      expect(boards).toEqual([quickBoard({ coverAsset: null })]);
    });

    it("dispatches a failure instead of throwing when the gateway call rejects", async () => {
      const test = harness({
        removeBoardCover: vi.fn(async () => {
          throw new Error("board not found");
        }),
      });

      await act(async () => {
        await test.result.current.handleRemoveCover();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "board not found" });
      expect(test.setQuickBoards).not.toHaveBeenCalled();
    });
  });
});
