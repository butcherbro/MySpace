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

describe("PasteCardsCommand", () => {
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
          plainText: "hello",
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
          captionPlainText: "",
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
