import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AssetDto,
  CardDto,
  EmbedCardDto,
  ImageCardDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { MutationQueue } from "../persistence/entity-write-queue";
import { useCardEdits, type CardEditsOptions } from "./use-card-edits";

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
    frame: { x: 0, y: 0, width: 240, height: 120 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
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
    frame: { x: 0, y: 0, width: 320, height: 240 },
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

const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }] };
const urlOnlyDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "https://example.org/x" }] }] };
const emptyDoc = { type: "doc", content: [{ type: "paragraph", content: [] }] };

function harness(
  overrides: {
    cards?: CardDto[];
    updateNote?: ReturnType<typeof vi.fn>;
    convertNoteToEmbed?: ReturnType<typeof vi.fn>;
    updateImageCaption?: ReturnType<typeof vi.fn>;
    updateEmbedDescription?: ReturnType<typeof vi.fn>;
    moveCard?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const updateNote = overrides.updateNote ?? vi.fn(async () => ({ id: "note-1", revision: 2, plainText: "edited" }));
  const convertNoteToEmbed = overrides.convertNoteToEmbed ?? vi.fn(async () => embed());
  const updateImageCaption =
    overrides.updateImageCaption ?? vi.fn(async () => ({ id: "image-1", revision: 2, plainText: "caption" }));
  const updateEmbedDescription =
    overrides.updateEmbedDescription ?? vi.fn(async () => ({ id: "embed-1", revision: 2, plainText: "description" }));
  const moveCard = overrides.moveCard ?? vi.fn(async () => ({ id: "note-1", revision: 2 }));
  const gateway = {
    updateNote,
    convertNoteToEmbed,
    updateImageCaption,
    updateEmbedDescription,
    moveCard,
  } as unknown as WorkspaceGateway;
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const cardsRef: CardEditsOptions["cardsRef"] = { current: overrides.cards ?? [note()] };
  const queueRef: CardEditsOptions["queueRef"] = { current: new MutationQueue() };

  const { result } = renderHook(() => useCardEdits({ gateway, dispatch, queueRef, cardsRef }));

  return { result, dispatch, cardsRef, updateNote, convertNoteToEmbed, updateImageCaption, updateEmbedDescription, moveCard };
}

describe("useCardEdits", () => {
  describe("handleUpdateNote", () => {
    it("persists the note and dispatches the receipt", async () => {
      const test = harness({ cards: [note({ revision: 3 })] });

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", doc);
      });

      expect(test.updateNote).toHaveBeenCalledWith({
        id: "note-1",
        expectedRevision: 3,
        documentJson: doc,
      });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "cardContentUpdated",
        id: "note-1",
        revision: 2,
        documentJson: doc,
        plainText: "edited",
      });
      // Ref stays authoritative inside the same microtask (see comment in the hook).
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 2, documentJson: doc, plainText: "edited", corrupt: false });
    });

    it("forwards acknowledgeCorrupt only when set", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", doc, { acknowledgeCorrupt: true });
      });

      expect(test.updateNote).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeCorrupt: true }),
      );
    });

    it("resolves without a gateway call when the note is gone from cardsRef", async () => {
      const test = harness({ cards: [] });

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", doc);
      });

      expect(test.updateNote).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
    });

    it("dispatches a failure and rethrows for a non-document payload", async () => {
      const test = harness();
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleUpdateNote("note-1", { not: "a doc" });
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.updateNote).not.toHaveBeenCalled();
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "failed",
        message: "Note content is not a valid document",
      });
    });

    it("dispatches a failure and rethrows when the gateway write rejects", async () => {
      const test = harness({ updateNote: vi.fn(async () => { throw new Error("stale_revision"); }) });
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleUpdateNote("note-1", doc);
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("handleFinalizeNote", () => {
    it("converts a bare-URL note to an embed and dispatches cardReplaced", async () => {
      const converted = embed({ id: "note-1" });
      const test = harness({
        cards: [note({ id: "note-1", revision: 5 })],
        convertNoteToEmbed: vi.fn(async () => converted),
      });

      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", urlOnlyDoc);
      });

      expect(test.convertNoteToEmbed).toHaveBeenCalledWith({
        id: "note-1",
        expectedRevision: 5,
        sourceUrl: "https://example.org/x",
        displayUrl: "example.org/x",
        title: "https://example.org/x",
        descriptionJson: { type: "doc", content: [{ type: "paragraph", content: [] }] },
      });
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardReplaced", id: "note-1", card: converted });
      expect(test.cardsRef.current[0]).toEqual(converted);
      expect(test.updateNote).not.toHaveBeenCalled();
    });

    it("persists a non-qualifying (empty) note as a normal update, not a conversion", async () => {
      const test = harness({ cards: [note({ revision: 3 })] });

      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", emptyDoc);
      });

      expect(test.convertNoteToEmbed).not.toHaveBeenCalled();
      expect(test.updateNote).toHaveBeenCalledWith({
        id: "note-1",
        expectedRevision: 3,
        documentJson: emptyDoc,
      });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "cardContentUpdated",
        id: "note-1",
        revision: 2,
        documentJson: emptyDoc,
        plainText: "edited",
      });
    });

    it("forwards acknowledgeCorrupt on the plain-update (corrupt-document) branch", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", doc, { acknowledgeCorrupt: true });
      });

      expect(test.updateNote).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeCorrupt: true }),
      );
    });

    it("resolves without a gateway call when the note is gone from cardsRef", async () => {
      const test = harness({ cards: [] });

      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", doc);
      });

      expect(test.updateNote).not.toHaveBeenCalled();
      expect(test.convertNoteToEmbed).not.toHaveBeenCalled();
    });

    it("dispatches a failure and rethrows for a non-document payload", async () => {
      const test = harness();
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleFinalizeNote("note-1", null);
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "failed",
        message: "Note content is not a valid document",
      });
    });

    it("dispatches a failure and rethrows when the gateway write rejects", async () => {
      const test = harness({ updateNote: vi.fn(async () => { throw new Error("stale_revision"); }) });
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleFinalizeNote("note-1", emptyDoc);
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("handleUpdateImageCaption", () => {
    it("persists the caption and dispatches the receipt", async () => {
      const test = harness({ cards: [image({ revision: 4 })] });

      await act(async () => {
        await test.result.current.handleUpdateImageCaption("image-1", doc);
      });

      expect(test.updateImageCaption).toHaveBeenCalledWith({
        id: "image-1",
        expectedRevision: 4,
        captionJson: doc,
      });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "imageCaptionUpdated",
        id: "image-1",
        revision: 2,
        captionJson: doc,
        captionPlainText: "caption",
      });
    });

    it("forwards acknowledgeCorrupt only when set", async () => {
      const test = harness({ cards: [image()] });

      await act(async () => {
        await test.result.current.handleUpdateImageCaption("image-1", doc, { acknowledgeCorrupt: true });
      });

      expect(test.updateImageCaption).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeCorrupt: true }),
      );
    });

    it("resolves without a gateway call for a non-image card", async () => {
      const test = harness({ cards: [note()] });

      await act(async () => {
        await test.result.current.handleUpdateImageCaption("image-1", doc);
      });

      expect(test.updateImageCaption).not.toHaveBeenCalled();
    });

    it("dispatches a failure and rethrows for a non-document payload", async () => {
      const test = harness({ cards: [image()] });
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleUpdateImageCaption("image-1", "not a doc");
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "failed",
        message: "Image caption is not a valid document",
      });
    });

    it("dispatches a failure and rethrows when the gateway write rejects", async () => {
      const test = harness({
        cards: [image()],
        updateImageCaption: vi.fn(async () => { throw new Error("stale_revision"); }),
      });
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleUpdateImageCaption("image-1", doc);
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("handleUpdateEmbedDescription", () => {
    it("persists the description and dispatches the receipt", async () => {
      const test = harness({ cards: [embed({ revision: 6 })] });

      await act(async () => {
        await test.result.current.handleUpdateEmbedDescription("embed-1", doc);
      });

      expect(test.updateEmbedDescription).toHaveBeenCalledWith({
        id: "embed-1",
        expectedRevision: 6,
        descriptionJson: doc,
      });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "embedDescriptionUpdated",
        id: "embed-1",
        revision: 2,
        descriptionJson: doc,
        descriptionPlainText: "description",
      });
    });

    it("forwards acknowledgeCorrupt only when set", async () => {
      const test = harness({ cards: [embed()] });

      await act(async () => {
        await test.result.current.handleUpdateEmbedDescription("embed-1", doc, { acknowledgeCorrupt: true });
      });

      expect(test.updateEmbedDescription).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeCorrupt: true }),
      );
    });

    it("resolves without a gateway call for a non-embed card", async () => {
      const test = harness({ cards: [note()] });

      await act(async () => {
        await test.result.current.handleUpdateEmbedDescription("embed-1", doc);
      });

      expect(test.updateEmbedDescription).not.toHaveBeenCalled();
    });

    it("dispatches a failure and rethrows for a non-document payload", async () => {
      const test = harness({ cards: [embed()] });
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleUpdateEmbedDescription("embed-1", undefined);
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "failed",
        message: "Link description is not a valid document",
      });
    });

    it("dispatches a failure and rethrows when the gateway write rejects", async () => {
      const test = harness({
        cards: [embed()],
        updateEmbedDescription: vi.fn(async () => { throw new Error("stale_revision"); }),
      });
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleUpdateEmbedDescription("embed-1", doc);
        } catch (e) {
          thrown = e;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("handleResizeNote", () => {
    it("persists the new frame and dispatches cardMoved", async () => {
      const test = harness({ cards: [note({ revision: 7, frame: { x: 10, y: 20, width: 240, height: 120 } })] });

      act(() => {
        test.result.current.handleResizeNote("note-1", 300, 200);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.moveCard).toHaveBeenCalledWith({
        id: "note-1",
        expectedRevision: 7,
        frame: { x: 10, y: 20, width: 300, height: 200 },
      });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "cardMoved",
        id: "note-1",
        revision: 2,
        frame: { x: 10, y: 20, width: 300, height: 200 },
      });
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 2, frame: { width: 300, height: 200 } });
    });

    it("does nothing when the card is gone from cardsRef", () => {
      const test = harness({ cards: [] });

      act(() => {
        test.result.current.handleResizeNote("note-1", 300, 200);
      });

      expect(test.moveCard).not.toHaveBeenCalled();
    });

    it("dispatches a failure without throwing when the gateway write rejects", async () => {
      const test = harness({ moveCard: vi.fn(async () => { throw new Error("stale_revision"); }) });

      act(() => {
        test.result.current.handleResizeNote("note-1", 300, 200);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });
});
