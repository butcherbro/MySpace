import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { WorkspaceCommand } from "../commands/workspace-command";
import {
  CreateFileCardCommand,
  CreateFolderShortcutCommand,
  CreateImageCardCommand,
} from "../commands/card-commands";
import type { IdGenerator } from "../services/id-generator";
import type {
  AssetDto,
  BoardSummary,
  CardDto,
  FileCardDto,
  FilesystemAliasDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { createCardWrites } from "../state/card-writes";
import { useCardCreation, type CardCreationDeps } from "./use-card-creation";

const mocks = vi.hoisted(() => ({
  pickFolder: vi.fn(),
  pickImageFile: vi.fn(),
  loadNaturalImageSize: vi.fn(),
}));

vi.mock("../services/asset-picker", () => ({
  pickFolder: mocks.pickFolder,
  pickImageFile: mocks.pickImageFile,
}));

vi.mock("../cards/image/image-card-geometry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/image/image-card-geometry")>();
  return { ...actual, loadNaturalImageSize: mocks.loadNaturalImageSize };
});

function board(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: "board-1",
    title: "Board",
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
    execute?: (command: WorkspaceCommand<unknown>) => Promise<unknown>;
    createImageCard?: ReturnType<typeof vi.fn>;
    importAsset?: ReturnType<typeof vi.fn>;
    createFolderAlias?: ReturnType<typeof vi.fn>;
    createFileCard?: ReturnType<typeof vi.fn>;
    openFileCard?: ReturnType<typeof vi.fn>;
    revealFileCard?: ReturnType<typeof vi.fn>;
    screenToFlow?: ((x: number, y: number) => { x: number; y: number }) | null;
  } = {},
) {
  const currentBoard = overrides.board === undefined ? board() : overrides.board;
  const notes = overrides.notes ?? [];
  const cards = overrides.cards ?? [];
  // По умолчанию диспетчер действительно исполняет команду против шлюза ниже,
  // чтобы проверки вызовов шлюза проходили через тот же путь, что и в App.
  const execute = vi.fn(
    overrides.execute ?? ((command: WorkspaceCommand<unknown>) => command.execute(gateway)),
  );
  const dispatcher = { execute } as unknown as CommandDispatcher;
  const idGenerator = idGeneratorFixture();
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();

  const createImageCard = overrides.createImageCard ?? vi.fn(async () => undefined);
  const importAsset = overrides.importAsset ?? vi.fn(async () => asset());
  const createFolderAlias =
    overrides.createFolderAlias ??
    vi.fn(
      async (): Promise<FilesystemAliasDto> => ({
        kind: "filesystem_alias",
        id: "alias-1",
        boardId: currentBoard?.id ?? "board-1",
        frame: { x: 0, y: 0, width: 360, height: 300 },
        zIndex: 0,
        revision: 1,
        targetKind: "folder",
        pathHint: "/Users/x/Folder",
        displayName: "Folder",
        originDeviceId: "device-1",
        originDeviceName: "This Mac",
        local: true,
      }),
    );
  const createFileCardGw =
    overrides.createFileCard ??
    vi.fn(
      async (): Promise<FileCardDto> => ({
        kind: "file",
        id: "file-1",
        boardId: currentBoard?.id ?? "board-1",
        frame: { x: 0, y: 0, width: 320, height: 240 },
        zIndex: 0,
        revision: 1,
        asset: asset(),
        previewText: "",
        previewAsset: null,
      }),
    );
  const openFileCard = overrides.openFileCard ?? vi.fn(async () => undefined);
  const revealFileCard = overrides.revealFileCard ?? vi.fn(async () => undefined);

  const gateway = {
    createNote: vi.fn(async () => undefined),
    createChildBoard: vi.fn(async () => undefined),
    createImageCard,
    importAsset,
    createFolderAlias,
    createFileCard: createFileCardGw,
    openFileCard,
    revealFileCard,
  } as unknown as WorkspaceGateway;

  const boardRef: RefObject<BoardSummary | null> = { current: currentBoard };
  const cardsRef: RefObject<CardDto[]> = { current: cards };
  const screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null> = {
    current: overrides.screenToFlow === undefined ? null : overrides.screenToFlow,
  };

  const deps: CardCreationDeps = {
    board: currentBoard,
    boardRef,
    notes,
    cards,
    cardsRef,
    screenToFlowRef,
    gateway,
    dispatcher,
    idGenerator,
    dispatch,
    cardWrites: createCardWrites(cardsRef, { current: [] }, dispatch),
  };

  const { result } = renderHook(() => useCardCreation(deps));

  return {
    result,
    dispatch,
    execute,
    gateway,
    createImageCard,
    importAsset,
    createFolderAlias,
    createFileCardGw,
    openFileCard,
    revealFileCard,
    cardsRef,
    boardRef,
  };
}

describe("useCardCreation", () => {
  // vi.hoisted создаёт mocks один раз на файл — сбрасываем перед каждым тестом.
  beforeEach(() => {
    mocks.pickFolder.mockReset();
    mocks.pickImageFile.mockReset();
    mocks.loadNaturalImageSize.mockReset();
  });

  describe("handleCreateNote", () => {
    it("creates the note via CreateNoteCommand and dispatches cardAdded", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleCreateNote({ x: 10, y: 20 });
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "cardAdded",
          card: expect.objectContaining({ kind: "note", frame: { x: 10, y: 20, width: 240, height: 120 } }),
        }),
      );
    });

    it("cascades the default position from the note count when none is given", async () => {
      const test = harness({ notes: [{ id: "n1" } as NoteCardDto] });

      await act(async () => {
        await test.result.current.handleCreateNote();
      });

      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          card: expect.objectContaining({ frame: { x: 40, y: 64, width: 240, height: 120 } }),
        }),
      );
    });

    it("dispatches editingStarted when startEditing is requested", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleCreateNote(undefined, { startEditing: true });
      });

      expect(test.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "editingStarted" }));
    });

    it("does nothing without a board", async () => {
      const test = harness({ board: null });

      await act(async () => {
        await test.result.current.handleCreateNote();
      });

      expect(test.execute).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the command rejects", async () => {
      const test = harness({ execute: async () => { throw new Error("boom"); } });

      await act(async () => {
        await test.result.current.handleCreateNote();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "boom" });
    });
  });

  describe("handleCreateLink", () => {
    it("creates a note and starts editing it", async () => {
      const test = harness();

      await act(async () => {
        test.result.current.handleCreateLink({ x: 5, y: 5 });
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "editingStarted" }));
    });
  });

  describe("handleCreateChildBoard", () => {
    it("creates a board portal at the given position and dispatches cardAdded", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleCreateChildBoard({ x: 30, y: 40 });
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "cardAdded",
          card: expect.objectContaining({
            kind: "board_portal",
            frame: { x: 30, y: 40, width: 120, height: 112 },
          }),
        }),
      );
    });

    it("centers on the viewport via screenToFlowRef when no position is given", async () => {
      const flow = vi.fn(() => ({ x: 200, y: 120 }));
      const test = harness({ screenToFlow: flow });

      await act(async () => {
        await test.result.current.handleCreateChildBoard();
      });

      expect(flow).toHaveBeenCalled();
      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          card: expect.objectContaining({ frame: { x: 140, y: 64, width: 120, height: 112 } }),
        }),
      );
    });

    it("does nothing without a board", async () => {
      const test = harness({ board: null });

      await act(async () => {
        await test.result.current.handleCreateChildBoard();
      });

      expect(test.execute).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the command rejects", async () => {
      const test = harness({ execute: async () => { throw new Error("stale_revision"); } });

      await act(async () => {
        await test.result.current.handleCreateChildBoard({ x: 0, y: 0 });
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("placeImageAsset", () => {
    it("creates the card through the dispatcher so it is undoable", async () => {
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness();

      await act(async () => {
        await test.result.current.placeImageAsset(asset(), 100, 50, "image-1");
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.execute.mock.calls[0][0]).toBeInstanceOf(CreateImageCardCommand);
      expect(test.execute.mock.calls[0][0]).toMatchObject({ id: "image-1" });
    });

    it("dispatches a failure instead of cardAdded when the command rejects", async () => {
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness({ execute: async () => { throw new Error("disk full"); } });

      await act(async () => {
        await test.result.current.placeImageAsset(asset(), 100, 50, "image-1").catch(() => {});
      });

      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cardAdded" }));
    });

    it("creates an image card with the fallback size when natural size fails to load", async () => {
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness({ cards: [{ id: "c1" } as CardDto] });

      await act(async () => {
        await test.result.current.placeImageAsset(asset(), 100, 50, "image-1");
      });

      expect(test.createImageCard).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "image-1",
          assetId: "asset-1",
          frame: { x: 100, y: 50, width: 320, height: 240 },
          zIndex: 1,
        }),
      );
      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "cardAdded", card: expect.objectContaining({ kind: "image" }) }),
      );
    });

    it("centers the frame around x/y when centered is true", async () => {
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness();

      await act(async () => {
        await test.result.current.placeImageAsset(asset(), 100, 50, "image-1", true);
      });

      expect(test.createImageCard).toHaveBeenCalledWith(
        expect.objectContaining({ frame: { x: 0, y: 0, width: 320, height: 240 } }),
      );
    });

    it("does nothing without a board", async () => {
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness({ board: null });

      await act(async () => {
        await test.result.current.placeImageAsset(asset(), 0, 0, "image-1");
      });

      expect(test.createImageCard).not.toHaveBeenCalled();
    });
  });

  describe("importImageCard", () => {
    it("imports the asset then places it", async () => {
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness();

      await act(async () => {
        await test.result.current.importImageCard("/tmp/photo.png", "photo.png", "image/png", 10, 20);
      });

      expect(test.importAsset).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePath: "/tmp/photo.png", fileName: "photo.png", mimeType: "image/png" }),
      );
      expect(test.createImageCard).toHaveBeenCalledWith(expect.objectContaining({ frame: { x: 10, y: 20, width: 320, height: 240 } }));
    });

    it("falls back to a safe position for non-finite coordinates", async () => {
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness();

      await act(async () => {
        await test.result.current.importImageCard("/tmp/photo.png", "photo.png", "image/png", NaN, Infinity);
      });

      expect(test.createImageCard).toHaveBeenCalledWith(expect.objectContaining({ frame: { x: 80, y: 80, width: 320, height: 240 } }));
    });

    it("does nothing without a board", async () => {
      const test = harness({ board: null });

      await act(async () => {
        await test.result.current.importImageCard("/tmp/photo.png", "photo.png", "image/png", 0, 0);
      });

      expect(test.importAsset).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the import rejects", async () => {
      const test = harness({ importAsset: vi.fn(async () => { throw new Error("import failed"); }) });

      await act(async () => {
        await test.result.current.importImageCard("/tmp/photo.png", "photo.png", "image/png", 0, 0);
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "import failed" });
    });
  });

  describe("handleCreateImage", () => {
    it("does nothing when no file is picked", async () => {
      mocks.pickImageFile.mockResolvedValueOnce(null);
      const test = harness();

      await act(async () => {
        await test.result.current.handleCreateImage();
      });

      expect(test.importAsset).not.toHaveBeenCalled();
    });

    it("imports the picked file at a cascading position", async () => {
      mocks.pickImageFile.mockResolvedValueOnce({ path: "/tmp/a.png", fileName: "a.png", mimeType: "image/png" });
      mocks.loadNaturalImageSize.mockResolvedValueOnce(null);
      const test = harness({ cards: [{ id: "c1" } as CardDto, { id: "c2" } as CardDto] });

      await act(async () => {
        await test.result.current.handleCreateImage();
      });

      expect(test.importAsset).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: "/tmp/a.png" }));
      expect(test.createImageCard).toHaveBeenCalledWith(expect.objectContaining({ frame: { x: 80, y: 128, width: 320, height: 240 } }));
    });
  });

  describe("createFolderShortcut vs createFileCard", () => {
    it("both create through the dispatcher so they are undoable", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.createFolderShortcut("/Users/x/Folder", 10, 20);
        await test.result.current.createFileCard({ path: "/tmp/x.txt", fileName: "x.txt", mimeType: "text/plain" }, 10, 20);
      });

      expect(test.execute.mock.calls.map((c) => c[0].constructor)).toEqual([
        CreateFolderShortcutCommand,
        CreateFileCardCommand,
      ]);
    });

    it("createFolderShortcut creates a filesystem_alias card and dispatches cardAdded", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.createFolderShortcut("/Users/x/Folder", 10, 20);
      });

      expect(test.createFolderAlias).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePath: "/Users/x/Folder", frame: { x: 10, y: 20, width: 360, height: 300 } }),
      );
      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "cardAdded", card: expect.objectContaining({ kind: "filesystem_alias" }) }),
      );
    });

    it("createFileCard creates a file card and dispatches cardAdded", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.createFileCard({ path: "/tmp/x.txt", fileName: "x.txt", mimeType: "text/plain" }, 10, 20);
      });

      expect(test.createFileCardGw).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePath: "/tmp/x.txt", frame: { x: 10, y: 20, width: 320, height: 240 } }),
      );
      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "cardAdded", card: expect.objectContaining({ kind: "file" }) }),
      );
    });

    it("neither creates a card without a board", async () => {
      const test = harness({ board: null });

      await act(async () => {
        await test.result.current.createFolderShortcut("/Users/x/Folder", 0, 0);
        await test.result.current.createFileCard({ path: "/tmp/x.txt", fileName: "x.txt", mimeType: "text/plain" }, 0, 0);
      });

      expect(test.createFolderAlias).not.toHaveBeenCalled();
      expect(test.createFileCardGw).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the folder alias gateway call rejects", async () => {
      const test = harness({ createFolderAlias: vi.fn(async () => { throw new Error("disk error"); }) });

      await act(async () => {
        await test.result.current.createFolderShortcut("/Users/x/Folder", 0, 0);
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "disk error" });
    });

    it("dispatches a failure when the file card gateway call rejects", async () => {
      const test = harness({ createFileCard: vi.fn(async () => { throw new Error("disk error"); }) });

      await act(async () => {
        await test.result.current.createFileCard({ path: "/tmp/x.txt", fileName: "x.txt", mimeType: "text/plain" }, 0, 0);
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "disk error" });
    });
  });

  describe("handleAddFolderShortcutViaDialog", () => {
    it("does nothing when no folder is picked", async () => {
      mocks.pickFolder.mockResolvedValueOnce(null);
      const test = harness();

      await act(async () => {
        await test.result.current.handleAddFolderShortcutViaDialog(0, 0);
      });

      expect(test.createFolderAlias).not.toHaveBeenCalled();
    });

    it("creates a folder shortcut at the picked folder", async () => {
      mocks.pickFolder.mockResolvedValueOnce("/Users/x/Picked");
      const test = harness();

      await act(async () => {
        await test.result.current.handleAddFolderShortcutViaDialog(15, 25);
      });

      expect(test.createFolderAlias).toHaveBeenCalledWith(
        expect.objectContaining({ sourcePath: "/Users/x/Picked", frame: { x: 15, y: 25, width: 360, height: 300 } }),
      );
    });
  });

  describe("openFileCard / revealFileCard", () => {
    it("opens the file card", async () => {
      const test = harness();

      await act(async () => {
        test.result.current.openFileCard("file-1");
        await Promise.resolve();
      });

      expect(test.openFileCard).toHaveBeenCalledWith("file-1");
      expect(test.dispatch).not.toHaveBeenCalled();
    });

    it("dispatches a failure when opening rejects", async () => {
      const test = harness({ openFileCard: vi.fn(async () => { throw new Error("missing"); }) });

      await act(async () => {
        test.result.current.openFileCard("file-1");
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "missing" });
    });

    it("reveals the file card", async () => {
      const test = harness();

      await act(async () => {
        test.result.current.revealFileCard("file-1");
        await Promise.resolve();
      });

      expect(test.revealFileCard).toHaveBeenCalledWith("file-1");
      expect(test.dispatch).not.toHaveBeenCalled();
    });

    it("dispatches a failure when revealing rejects", async () => {
      const test = harness({ revealFileCard: vi.fn(async () => { throw new Error("missing"); }) });

      await act(async () => {
        test.result.current.revealFileCard("file-1");
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "missing" });
    });
  });
});
