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
import { createCardWrites } from "../state/card-writes";
import { MutationQueue } from "../persistence/entity-write-queue";
import { useCardEdits, type CardEditsOptions } from "./use-card-edits";
import { EditCardTextCommand, ResizeCardCommand } from "../commands/card-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { WorkspaceCommand } from "../commands/workspace-command";

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
  const record = vi.fn<(command: WorkspaceCommand<unknown>) => Promise<void>>(async () => {});
  const dispatcher = { record } as unknown as CommandDispatcher;
  let nextId = 0;
  const idGenerator = { nextId: () => `cmd-${++nextId}` };

  const cardWrites = createCardWrites(cardsRef, { current: [] }, dispatch);

  const { result } = renderHook(() =>
    useCardEdits({ gateway, dispatch, cardWrites, queueRef, cardsRef, dispatcher, idGenerator }),
  );

  return { result, dispatch, cardsRef, record, updateNote, convertNoteToEmbed, updateImageCaption, updateEmbedDescription, moveCard };
}

describe("useCardEdits", () => {
  describe("handleUpdateNote", () => {
    it("persists the note and dispatches the receipt", async () => {
      const test = harness({
        cards: [note({ revision: 3 })],
        updateNote: vi.fn(async () => ({ id: "note-1", revision: 4, plainText: "edited" })),
      });

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
        revision: 4,
        documentJson: doc,
        plainText: "edited",
      });
      // Ref stays authoritative inside the same microtask (see comment in the hook).
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 4, documentJson: doc, plainText: "edited", corrupt: false });
    });

    it("does not move cardsRef back when a newer write landed while the save was in flight", async () => {
      const test = harness({ cards: [note({ revision: 4 })] });
      test.updateNote.mockImplementation(async () => {
        test.cardsRef.current = [note({ revision: 6 })];
        return { id: "note-1", revision: 5, plainText: "edited" };
      });

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", doc);
      });

      expect(test.cardsRef.current[0].revision).toBe(6);
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
      const converted = embed({ id: "note-1", revision: 6 });
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

    it("brings cardsRef to the receipt's revision together with the store, before any re-render", async () => {
      const test = harness({
        cards: [image({ revision: 4 })],
        updateImageCaption: vi.fn(async () => ({ id: "image-1", revision: 5, plainText: "caption" })),
      });

      await act(async () => {
        await test.result.current.handleUpdateImageCaption("image-1", doc);
      });

      // cardsRef здесь — простой объект, а не useLatestRef: его обновляет только сам обработчик.
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 5, captionJson: doc, captionPlainText: "caption" });
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
      const test = harness({
        cards: [note({ revision: 7, frame: { x: 10, y: 20, width: 240, height: 120 } })],
        moveCard: vi.fn(async () => ({ id: "note-1", revision: 8 })),
      });

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
        revision: 8,
        frame: { x: 10, y: 20, width: 300, height: 200 },
      });
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 8, frame: { width: 300, height: 200 } });
    });

    it("does not move cardsRef back when a newer write landed while the resize was in flight", async () => {
      let resolveMove!: (receipt: { id: string; revision: number }) => void;
      const moveCard = vi.fn(
        () =>
          new Promise<{ id: string; revision: number }>((resolve) => {
            resolveMove = resolve;
          }),
      );
      const test = harness({ cards: [note({ revision: 4 })], moveCard });

      act(() => {
        test.result.current.handleResizeNote("note-1", 300, 200);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(moveCard).toHaveBeenCalledTimes(1);
      // Метаданные ссылки (вне очереди) успели записать ревизию 6 и вернуться первыми.
      test.cardsRef.current = [note({ revision: 6 })];
      await act(async () => {
        resolveMove({ id: "note-1", revision: 5 });
        await Promise.resolve();
      });

      expect(test.cardsRef.current[0].revision).toBe(6);
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

  describe("undo history", () => {
    const typed = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    /** The single recorded command, asserting there is exactly one. */
    function recorded(test: ReturnType<typeof harness>) {
      expect(test.record).toHaveBeenCalledTimes(1);
      return test.record.mock.calls[0][0];
    }
    /** Lets the fire-and-forget resize task run. */
    async function settle() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it("records one note edit per session: from the document before the first save to the finalized one", async () => {
      const original = note().documentJson;
      const test = harness();

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", typed("h"));
        await test.result.current.handleUpdateNote("note-1", typed("he"));
        await test.result.current.handleFinalizeNote("note-1", typed("hey"));
      });

      const command = recorded(test);
      expect(command).toBeInstanceOf(EditCardTextCommand);
      expect(command).toMatchObject({ label: "Edit note", cardId: "note-1", before: original, after: typed("hey") });
    });

    it("records nothing for debounced saves until the session is finalized", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", typed("h"));
      });

      expect(test.record).not.toHaveBeenCalled();
    });

    it("records nothing when the finalized document equals the session start", async () => {
      const original = note().documentJson;
      const test = harness();

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", typed("typo"));
        await test.result.current.handleFinalizeNote("note-1", JSON.parse(JSON.stringify(original)));
      });

      expect(test.record).not.toHaveBeenCalled();
    });

    it("starts the next session from the previous session's result", async () => {
      const test = harness();

      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", typed("one"));
        await test.result.current.handleFinalizeNote("note-1", typed("two"));
      });

      expect(test.record).toHaveBeenCalledTimes(2);
      expect(test.record.mock.calls[1][0]).toMatchObject({ before: typed("one"), after: typed("two") });
    });

    it("keeps the session open when finalize fails and records once on the successful retry", async () => {
      const original = note().documentJson;
      let fail = true;
      const test = harness({
        updateNote: vi.fn(async () => {
          if (fail) throw new Error("offline");
          return { id: "note-1", revision: 2, plainText: "x" };
        }),
      });

      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", typed("x")).catch(() => {});
      });
      expect(test.record).not.toHaveBeenCalled();
      fail = false;
      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", typed("x"));
      });

      expect(recorded(test)).toMatchObject({ before: original, after: typed("x") });
    });

    it("records nothing when finalize converts the note into a link", async () => {
      const test = harness({ convertNoteToEmbed: vi.fn(async () => embed({ id: "note-1" })) });

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", typed("https://example.org/x"));
        await test.result.current.handleFinalizeNote("note-1", urlOnlyDoc);
      });

      expect(test.record).not.toHaveBeenCalled();
    });

    it("records nothing for a repair session of a corrupt note (undo would bring the damage back)", async () => {
      const test = harness({ cards: [note({ corrupt: true, documentJson: { type: "doc", content: [] } })] });

      await act(async () => {
        await test.result.current.handleFinalizeNote("note-1", typed("recovered"), { acknowledgeCorrupt: true });
      });

      expect(test.record).not.toHaveBeenCalled();
    });

    it("records one caption edit per session", async () => {
      const test = harness({ cards: [image()] });

      await act(async () => {
        await test.result.current.handleUpdateImageCaption("image-1", typed("ca"));
        await test.result.current.handleFinalizeImageCaption("image-1", typed("cat"));
      });

      expect(recorded(test)).toMatchObject({
        label: "Edit caption",
        cardId: "image-1",
        before: image().captionJson,
        after: typed("cat"),
      });
    });

    it("records one link description edit per session", async () => {
      const test = harness({ cards: [embed()] });

      await act(async () => {
        await test.result.current.handleUpdateEmbedDescription("embed-1", typed("d"));
        await test.result.current.handleFinalizeEmbedDescription("embed-1", typed("desc"));
      });

      expect(recorded(test)).toMatchObject({
        label: "Edit description",
        cardId: "embed-1",
        before: embed().descriptionJson,
        after: typed("desc"),
      });
    });

    it("records one resize per gesture, before frame to after frame", async () => {
      const test = harness({ cards: [note({ frame: { x: 10, y: 20, width: 240, height: 120 } })] });

      act(() => {
        test.result.current.handleResizeNote("note-1", 300, 200);
      });
      await settle();

      const command = recorded(test);
      expect(command).toBeInstanceOf(ResizeCardCommand);
      expect(command).toMatchObject({
        label: "Resize",
        cardId: "note-1",
        before: { x: 10, y: 20, width: 240, height: 120 },
        after: { x: 10, y: 20, width: 300, height: 200 },
      });
    });

    it("does not record an automatic fit-to-content resize", async () => {
      const test = harness();

      act(() => {
        test.result.current.handleResizeNote("note-1", 240, 400, { auto: true });
      });
      await settle();

      expect(test.moveCard).toHaveBeenCalledTimes(1);
      expect(test.record).not.toHaveBeenCalled();
    });

    it("does not record a resize that failed or changed nothing", async () => {
      const failing = harness({ moveCard: vi.fn(async () => { throw new Error("stale_revision"); }) });
      act(() => {
        failing.result.current.handleResizeNote("note-1", 300, 200);
      });
      await settle();
      expect(failing.record).not.toHaveBeenCalled();

      const same = harness();
      act(() => {
        same.result.current.handleResizeNote("note-1", 240, 120);
      });
      await settle();
      expect(same.record).not.toHaveBeenCalled();
    });
  });
});
