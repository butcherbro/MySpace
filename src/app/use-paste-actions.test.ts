import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { IdGenerator } from "../services/id-generator";
import type {
  AssetDto,
  BoardSummary,
  CardDto,
  NoteCardDto,
  PathClassificationDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { loadedCardWrites } from "../state/card-writes-fixture";
import { clearCardClipboard, setCardClipboard, type CopiedCard } from "./card-clipboard";
import { usePasteActions } from "./use-paste-actions";

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

function copiedNote(overrides: Partial<CopiedCard & { kind: "note" }> = {}): CopiedCard {
  return {
    kind: "note",
    dx: 0,
    dy: 0,
    width: 200,
    height: 100,
    documentJson: { type: "doc", content: [] },
    plainText: "hello",
    colorToken: "default",
    ...overrides,
  } as CopiedCard;
}

/** Sequential ids ("id-0", "id-1", …), predictable for assertions. */
function idGeneratorFixture(): IdGenerator {
  let counter = 0;
  return { nextId: vi.fn(() => `id-${counter++}`) };
}

function harness(
  overrides: {
    board?: BoardSummary | null;
    notes?: NoteCardDto[];
    cards?: CardDto[];
    lastCanvasPoint?: { x: number; y: number } | null;
    classifyPath?: (path: string) => Promise<PathClassificationDto>;
    importClipboardImage?: () => Promise<AssetDto>;
    execute?: () => Promise<{ portals: never[]; shortcuts: never[] }>;
  } = {},
) {
  const currentBoard = overrides.board === undefined ? board() : overrides.board;
  const notes = overrides.notes ?? [];
  const classifyPath = vi.fn(
    overrides.classifyPath ?? (async (): Promise<PathClassificationDto> => ({ kind: "missing", expandedPath: "" })),
  );
  const importClipboardImage = vi.fn(overrides.importClipboardImage ?? (async () => asset()));
  const gateway = { classifyPath, importClipboardImage } as unknown as WorkspaceGateway;
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const execute = vi.fn(overrides.execute ?? (async () => ({ portals: [], shortcuts: [] })));
  const dispatcher = { execute } as unknown as CommandDispatcher;
  const idGenerator = idGeneratorFixture();
  const createFolderShortcut = vi.fn<(sourcePath: string, boardX: number, boardY: number) => Promise<void>>(
    async () => undefined,
  );
  const createFileCard = vi.fn<
    (item: { path: string; fileName: string; mimeType: string }, boardX: number, boardY: number) => Promise<void>
  >(async () => undefined);
  const handleCreateNote = vi.fn<
    (
      position?: { x: number; y: number },
      options?: { startEditing?: boolean; content?: { documentJson: unknown; plainText: string } },
    ) => Promise<void>
  >(async () => undefined);
  const placeImageAsset = vi.fn<
    (asset: AssetDto, x: number, y: number, cardId: string, centered?: boolean) => Promise<void>
  >(async () => undefined);

  const lastCanvasPointRef: RefObject<{ x: number; y: number } | null> = {
    current: overrides.lastCanvasPoint === undefined ? null : overrides.lastCanvasPoint,
  };
  // Никогда не "готов" в этих тестах: fallbackPastePosition падает на
  // {40, 40 + notes.length*24}, как и в App без React Flow instance.
  const canvasRef: RefObject<HTMLDivElement | null> = { current: null };
  const screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null> = { current: null };
  const boardRef: RefObject<BoardSummary | null> = { current: currentBoard };
  const cardsRef: RefObject<CardDto[]> = { current: overrides.cards ?? [] };

  const { result } = renderHook(() =>
    usePasteActions({
      board: currentBoard,
      notes,
      gateway,
      dispatch,
      cardWrites: loadedCardWrites(cardsRef, dispatch),
      dispatcher,
      idGenerator,
      createFolderShortcut,
      createFileCard,
      handleCreateNote,
      placeImageAsset,
      lastCanvasPointRef,
      canvasRef,
      screenToFlowRef,
      boardRef,
      cardsRef,
    }),
  );

  return {
    result,
    dispatch,
    execute,
    classifyPath,
    importClipboardImage,
    createFolderShortcut,
    createFileCard,
    handleCreateNote,
    placeImageAsset,
  };
}

describe("usePasteActions", () => {
  beforeEach(() => {
    clearCardClipboard();
  });

  describe("handlePastePath", () => {
    it("does nothing without an open board", async () => {
      const test = harness({ board: null });

      const handled = await act(async () => test.result.current.handlePastePath("/tmp/a"));

      expect(handled).toBe(false);
      expect(test.classifyPath).not.toHaveBeenCalled();
    });

    it("reports unhandled for a missing path, without creating anything", async () => {
      const test = harness({
        classifyPath: async (): Promise<PathClassificationDto> => ({ kind: "missing", expandedPath: "" }),
      });

      const handled = await act(async () => test.result.current.handlePastePath("/does/not/exist"));

      expect(handled).toBe(false);
      expect(test.createFolderShortcut).not.toHaveBeenCalled();
      expect(test.createFileCard).not.toHaveBeenCalled();
    });

    it("creates a folder shortcut under the cursor for a folder path", async () => {
      const test = harness({
        lastCanvasPoint: { x: 300, y: 200 },
        classifyPath: async (): Promise<PathClassificationDto> => ({ kind: "folder", expandedPath: "/Users/bro/Projects" }),
      });

      const handled = await act(async () => test.result.current.handlePastePath("~/Projects"));

      expect(handled).toBe(true);
      expect(test.createFolderShortcut).toHaveBeenCalledWith("/Users/bro/Projects", 300 - 180, 200 - 150);
      expect(test.createFileCard).not.toHaveBeenCalled();
    });

    it("creates a file card under the cursor for a file path", async () => {
      const test = harness({
        lastCanvasPoint: { x: 300, y: 200 },
        classifyPath: async (): Promise<PathClassificationDto> => ({ kind: "file", expandedPath: "/Users/bro/report.txt" }),
      });

      const handled = await act(async () => test.result.current.handlePastePath("~/report.txt"));

      expect(handled).toBe(true);
      expect(test.createFileCard).toHaveBeenCalledWith(
        { path: "/Users/bro/report.txt", fileName: "report.txt", mimeType: "application/octet-stream" },
        300,
        200,
      );
      expect(test.createFolderShortcut).not.toHaveBeenCalled();
    });

    it("falls back to the canvas-center position when the cursor was never tracked", async () => {
      const test = harness({
        notes: [{ id: "n1" } as NoteCardDto],
        lastCanvasPoint: null,
        classifyPath: async (): Promise<PathClassificationDto> => ({ kind: "file", expandedPath: "/Users/bro/report.txt" }),
      });

      await act(async () => test.result.current.handlePastePath("~/report.txt"));

      // Ни React Flow, ни canvasRef не готовы в этом тесте — fallback это
      // {40, 40 + notes.length*24}, тот же расчёт, что был в App.
      expect(test.createFileCard).toHaveBeenCalledWith(
        { path: "/Users/bro/report.txt", fileName: "report.txt", mimeType: "application/octet-stream" },
        40,
        64,
      );
    });

    it("dispatches a failure and reports handled when the lookup itself rejects", async () => {
      const test = harness({
        classifyPath: async () => {
          throw new Error("lookup failed");
        },
      });

      const handled = await act(async () => test.result.current.handlePastePath("/tmp/a"));

      expect(handled).toBe(true);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "lookup failed" });
      expect(test.createFolderShortcut).not.toHaveBeenCalled();
      expect(test.createFileCard).not.toHaveBeenCalled();
    });
  });

  describe("handleCanvasPaste", () => {
    it("creates a note at the cursor from plain text when there is no html", () => {
      const test = harness({ lastCanvasPoint: { x: 10, y: 20 } });

      act(() => {
        test.result.current.handleCanvasPaste({ html: "", text: "hello world" });
      });

      expect(test.handleCreateNote).toHaveBeenCalledTimes(1);
      const [position, options] = test.handleCreateNote.mock.calls[0] as [
        { x: number; y: number },
        { content: { documentJson: unknown; plainText: string } },
      ];
      expect(position).toEqual({ x: 10, y: 20 });
      expect(options.content.plainText).toBe("hello world");
    });

    it("creates a note from html, keeping its formatting as plain text", () => {
      const test = harness({ lastCanvasPoint: { x: 10, y: 20 } });

      act(() => {
        test.result.current.handleCanvasPaste({ html: "<p><b>hi</b> there</p>", text: "hi there" });
      });

      const [, options] = test.handleCreateNote.mock.calls[0] as [
        unknown,
        { content: { documentJson: unknown; plainText: string } },
      ];
      expect(options.content.plainText).toBe("hi there");
    });
  });

  describe("handlePasteCards", () => {
    it("returns false and does nothing without an open board", () => {
      const test = harness({ board: null });
      setCardClipboard([copiedNote()]);

      const handled = test.result.current.handlePasteCards();

      expect(handled).toBe(false);
      expect(test.execute).not.toHaveBeenCalled();
    });

    it("returns false when the internal card clipboard is empty", () => {
      const test = harness();

      const handled = test.result.current.handlePasteCards();

      expect(handled).toBe(false);
      expect(test.execute).not.toHaveBeenCalled();
    });

    it("pastes under the last known cursor and dispatches the created card", async () => {
      const test = harness({ lastCanvasPoint: { x: 500, y: 400 }, cards: [{} as CardDto, {} as CardDto] });
      setCardClipboard([copiedNote({ dx: 5, dy: 7, plainText: "copied" })]);

      let handled = false;
      await act(async () => {
        handled = test.result.current.handlePasteCards();
        await Promise.resolve();
      });

      expect(handled).toBe(true);
      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "cardAdded",
        card: expect.objectContaining({
          kind: "note",
          boardId: "home",
          zIndex: 2, // baseZ = cardsRef.current.length
          frame: expect.objectContaining({ x: 505, y: 407 }),
          plainText: "copied",
        }),
      });
    });

    it("falls back to the canvas-center position when the cursor was never tracked", async () => {
      const test = harness({ notes: [{ id: "n1" } as NoteCardDto], lastCanvasPoint: null });
      setCardClipboard([copiedNote({ dx: 0, dy: 0 })]);

      await act(async () => {
        test.result.current.handlePasteCards();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({
        type: "cardAdded",
        card: expect.objectContaining({ frame: expect.objectContaining({ x: 40, y: 64 }) }),
      });
    });

    it("dispatches a failure instead of throwing when the paste command rejects", async () => {
      const test = harness({
        execute: async () => {
          throw new Error("paste failed");
        },
      });
      setCardClipboard([copiedNote()]);

      await act(async () => {
        test.result.current.handlePasteCards();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "paste failed" });
    });
  });

  describe("handlePasteImage", () => {
    it("imports the clipboard image and places it centered at the cursor", async () => {
      const importedAsset = asset({ id: "asset-42" });
      const test = harness({
        lastCanvasPoint: { x: 111, y: 222 },
        importClipboardImage: async () => importedAsset,
      });

      await act(async () => test.result.current.handlePasteImage());

      expect(test.placeImageAsset).toHaveBeenCalledWith(importedAsset, 111, 222, "id-0", true);
    });

    it("falls back to the canvas-center position when the cursor was never tracked", async () => {
      const test = harness({ notes: [{ id: "n1" } as NoteCardDto], lastCanvasPoint: null });

      await act(async () => test.result.current.handlePasteImage());

      expect(test.placeImageAsset).toHaveBeenCalledWith(expect.anything(), 40, 64, "id-0", true);
    });

    it("dispatches a failure instead of throwing when the import rejects", async () => {
      const test = harness({
        importClipboardImage: async () => {
          throw new Error("clipboard read failed");
        },
      });

      await act(async () => test.result.current.handlePasteImage());

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "clipboard read failed" });
      expect(test.placeImageAsset).not.toHaveBeenCalled();
    });

    it("stays silent when a speculative paste finds no image on the clipboard", async () => {
      const test = harness({
        importClipboardImage: async () => {
          throw { code: "not_found", message: "clipboard image" };
        },
      });

      await act(async () => test.result.current.handlePasteImage({ onlyIfPresent: true }));

      expect(test.dispatch).not.toHaveBeenCalled();
      expect(test.placeImageAsset).not.toHaveBeenCalled();
    });

    it("still reports other failures of a speculative paste", async () => {
      const test = harness({
        importClipboardImage: async () => {
          throw { code: "database", message: "disk full" };
        },
      });

      await act(async () => test.result.current.handlePasteImage({ onlyIfPresent: true }));

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "database: disk full" });
    });

    it("reports a missing image when the webview said there was one", async () => {
      const test = harness({
        importClipboardImage: async () => {
          throw { code: "not_found", message: "clipboard image" };
        },
      });

      await act(async () => test.result.current.handlePasteImage());

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "not_found: clipboard image" });
    });
  });
});
