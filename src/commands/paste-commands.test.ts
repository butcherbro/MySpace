import { describe, expect, it, vi } from "vitest";
import { PasteCardsCommand, type PasteCardSpec } from "./paste-commands";
import type { WorkspaceGateway } from "../services/workspace-gateway";

function gatewaySpy() {
  const calls: { fn: string; args: unknown }[] = [];
  const gateway = {
    createNote: vi.fn(async (input) => {
      calls.push({ fn: "createNote", args: input });
    }),
    createImageCard: vi.fn(async (input) => {
      calls.push({ fn: "createImageCard", args: input });
    }),
    setNoteColor: vi.fn(async (input) => {
      calls.push({ fn: "setNoteColor", args: input });
    }),
    duplicateBoard: vi.fn(async (input) => {
      calls.push({ fn: "duplicateBoard", args: input });
      return {
        newBoardId: input.newBoardId,
        portal: {
          kind: "board_portal",
          id: input.newPortalCardId,
          boardId: input.targetBoardId,
          frame: input.frame,
          zIndex: 0,
          revision: 1,
          target: {
            id: input.newBoardId,
            boardRevision: 1,
            title: "Template copy",
            colorToken: "terracotta",
            symbol: null,
            childBoardCount: 0,
            childCardCount: 0,
            coverAsset: null,
          },
        },
      };
    }),
    createBoardShortcut: vi.fn(async (input) => {
      calls.push({ fn: "createBoardShortcut", args: input });
      return {
        kind: "board_shortcut",
        id: input.id,
        boardId: input.boardId,
        frame: input.frame,
        zIndex: input.zIndex,
        revision: 1,
        targetBoardId: input.targetBoardId,
        target: {
          id: input.targetBoardId,
          boardRevision: 1,
          title: "Books",
          colorToken: "terracotta",
          symbol: null,
          coverAsset: null,
        },
      };
    }),
    trashSelection: vi.fn(async (input) => {
      calls.push({ fn: "trashSelection", args: input });
      return "batch-1";
    }),
    restoreTrashBatch: vi.fn(async (batchId: string) => {
      calls.push({ fn: "restoreTrashBatch", args: batchId });
    }),
  } as unknown as WorkspaceGateway;
  return { gateway, calls };
}

const noteFrame = { x: 100, y: 100, width: 240, height: 120 };
const imageFrame = { x: 340, y: 100, width: 200, height: 150 };

function specs(): PasteCardSpec[] {
  return [
    {
      kind: "note",
      id: "note-copy-1",
      boardId: "board-a",
      frame: noteFrame,
      zIndex: 0,
      documentJson: { type: "doc" },
      plainText: "hello",
      colorToken: "yellow",
    },
    {
      kind: "image",
      id: "image-copy-1",
      boardId: "board-a",
      frame: imageFrame,
      zIndex: 1,
      assetId: "asset-shared-1",
      captionJson: { type: "doc" },
      captionPlainText: "",
    },
  ];
}

const boardSpec: PasteCardSpec = {
  kind: "board",
  id: "portal-copy-1",
  boardId: "board-a",
  frame: { x: 40, y: 40, width: 120, height: 112 },
  zIndex: 2,
  sourceBoardId: "template",
  newBoardId: "board-copy-1",
};

const shortcutSpec: PasteCardSpec = {
  kind: "shortcut",
  id: "shortcut-copy-1",
  boardId: "board-a",
  frame: { x: 40, y: 40, width: 120, height: 112 },
  zIndex: 2,
  targetBoardId: "board-x",
};

describe("PasteCardsCommand", () => {
  it("pastes a copied shortcut via createBoardShortcut, pointing at the SAME target, and returns its DTO", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new PasteCardsCommand("paste-1", [shortcutSpec]);

    const { shortcuts } = await cmd.execute(gateway);

    expect(calls).toEqual([
      {
        fn: "createBoardShortcut",
        args: {
          id: "shortcut-copy-1",
          boardId: "board-a",
          frame: shortcutSpec.frame,
          zIndex: 2,
          targetBoardId: "board-x",
        },
      },
    ]);
    expect(shortcuts).toHaveLength(1);
    expect(shortcuts[0]).toMatchObject({ id: "shortcut-copy-1", targetBoardId: "board-x" });
  });

  it("undo of a pasted shortcut sends its own card id as a board_shortcut trash item (the target board is untouched)", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new PasteCardsCommand("paste-1", [shortcutSpec]);
    await cmd.execute(gateway);

    await cmd.undo(gateway);

    const trash = calls.find((c) => c.fn === "trashSelection");
    expect(trash?.args).toEqual({
      items: [{ id: "shortcut-copy-1", kind: "board_shortcut" }],
    });
  });

  it("duplicates a copied board via the atomic backend call and returns its portal DTO", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new PasteCardsCommand("paste-1", [boardSpec]);

    const { portals } = await cmd.execute(gateway);

    expect(calls).toEqual([
      {
        fn: "duplicateBoard",
        args: {
          sourceBoardId: "template",
          targetBoardId: "board-a",
          newBoardId: "board-copy-1",
          newPortalCardId: "portal-copy-1",
          frame: boardSpec.frame,
        },
      },
    ]);
    expect(portals).toHaveLength(1);
    expect(portals[0]).toMatchObject({ id: "portal-copy-1", target: { id: "board-copy-1", title: "Template copy" } });
  });

  it("undo of a copied board sends the new board id as a board_portal trash item", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new PasteCardsCommand("paste-1", [boardSpec]);
    await cmd.execute(gateway);

    await cmd.undo(gateway);

    const trash = calls.find((c) => c.fn === "trashSelection");
    expect(trash?.args).toEqual({
      items: [{ id: "board-copy-1", kind: "board_portal" }],
    });
  });


  it("creates every card in the group, with a follow-up color write for a non-default note", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new PasteCardsCommand("paste-1", specs());

    await cmd.execute(gateway);

    expect(calls).toEqual([
      {
        fn: "createNote",
        args: {
          id: "note-copy-1",
          boardId: "board-a",
          frame: noteFrame,
          zIndex: 0,
          documentJson: { type: "doc" },
        },
      },
      { fn: "setNoteColor", args: { id: "note-copy-1", colorToken: "yellow" } },
      {
        fn: "createImageCard",
        args: {
          id: "image-copy-1",
          boardId: "board-a",
          frame: imageFrame,
          zIndex: 1,
          assetId: "asset-shared-1",
          captionJson: { type: "doc" },
        },
      },
    ]);
  });

  it("skips the color write for a default-colored note", async () => {
    const { gateway, calls } = gatewaySpy();
    const s = specs();
    (s[0] as { colorToken: string }).colorToken = "default";
    const cmd = new PasteCardsCommand("paste-1", s);

    await cmd.execute(gateway);

    expect(calls.some((c) => c.fn === "setNoteColor")).toBe(false);
  });

  it("undo trashes every created card as a single batch", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new PasteCardsCommand("paste-1", specs());
    await cmd.execute(gateway);

    await cmd.undo(gateway);

    const trash = calls.find((c) => c.fn === "trashSelection");
    expect(trash?.args).toEqual({
      items: [
        { id: "note-copy-1", kind: "note" },
        { id: "image-copy-1", kind: "image" },
      ],
    });
  });

  it("redo (re-execute after undo) restores the trashed batch instead of recreating", async () => {
    const { gateway, calls } = gatewaySpy();
    const cmd = new PasteCardsCommand("paste-1", specs());
    await cmd.execute(gateway);
    await cmd.undo(gateway);
    calls.length = 0;

    await cmd.execute(gateway);

    expect(calls).toEqual([{ fn: "restoreTrashBatch", args: "batch-1" }]);
  });
});
