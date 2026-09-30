import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AssetDto,
  BoardSummary,
  CardDto,
  EmbedCardDto,
  ImageCardDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import { initialState, reducer, type CurrentBoardAction, type CurrentBoardState } from "../state/current-board-store";
import { createCardWrites } from "../state/card-writes";
import { MutationQueue } from "../persistence/entity-write-queue";
import { COPY_RETRY_MS, useCardEdits, type CardEditsOptions } from "./use-card-edits";
import { createStaleRevisionReload } from "./stale-revision-reload";
import { endDraftHandoff, readDraftHandoff } from "../editor/draft-handoff";
import type { DocumentSaveOptions, DraftLineage } from "../editor/corrupt-document";
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
    readCard?: ReturnType<typeof vi.fn>;
    createNote?: ReturnType<typeof vi.fn>;
    recordErrorReport?: CardEditsOptions["recordErrorReport"];
    wrapGateway?: (gateway: WorkspaceGateway) => WorkspaceGateway;
  } = {},
) {
  const updateNote = overrides.updateNote ?? vi.fn(async () => ({ id: "note-1", revision: 2, plainText: "edited" }));
  const convertNoteToEmbed = overrides.convertNoteToEmbed ?? vi.fn(async () => embed());
  const updateImageCaption =
    overrides.updateImageCaption ?? vi.fn(async () => ({ id: "image-1", revision: 2, plainText: "caption" }));
  const updateEmbedDescription =
    overrides.updateEmbedDescription ?? vi.fn(async () => ({ id: "embed-1", revision: 2, plainText: "description" }));
  const moveCard = overrides.moveCard ?? vi.fn(async () => ({ id: "note-1", revision: 2 }));
  const readCard = overrides.readCard ?? vi.fn(async () => note());
  const createNote = overrides.createNote ?? vi.fn(async (): Promise<unknown> => ({ id: "copy", revision: 1 }));
  const setNoteColor = vi.fn(async (): Promise<void> => {});
  const bareGateway = {
    updateNote,
    convertNoteToEmbed,
    updateImageCaption,
    updateEmbedDescription,
    moveCard,
    readCard,
    createNote,
    setNoteColor,
  } as unknown as WorkspaceGateway;
  const gateway = overrides.wrapGateway ? overrides.wrapGateway(bareGateway) : bareGateway;
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const cardsRef: CardEditsOptions["cardsRef"] = { current: overrides.cards ?? [note()] };
  const queueRef: CardEditsOptions["queueRef"] = { current: new MutationQueue() };
  const record = vi.fn<(command: WorkspaceCommand<unknown>) => Promise<void>>(async () => {});
  const execute = vi.fn(async (command: WorkspaceCommand<unknown>) => command.execute(gateway));
  const dispatcher = { record, execute } as unknown as CommandDispatcher;
  let nextId = 0;
  const idGenerator = { nextId: () => `cmd-${++nextId}` };

  const cardWrites = createCardWrites(cardsRef, { current: [] }, dispatch);

  const { result } = renderHook(() =>
    useCardEdits({
      gateway,
      dispatch,
      cardWrites,
      queueRef,
      cardsRef,
      dispatcher,
      idGenerator,
      recordErrorReport: overrides.recordErrorReport,
    }),
  );

  return {
    result,
    dispatch,
    cardsRef,
    cardWrites,
    record,
    execute,
    updateNote,
    convertNoteToEmbed,
    updateImageCaption,
    updateEmbedDescription,
    moveCard,
    readCard,
    createNote,
    setNoteColor,
  };
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

  describe("note text conflicts", () => {
    const base = note().documentJson;
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const text = (t: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
    const stale = () => ({ code: "stale_revision", message: { expected: 1, actual: 2 } });
    const copyOf = (doc: { content: unknown[] }) => ({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Conflict copy", marks: [{ type: "bold" }] }] },
        ...doc.content,
      ],
    });

    /** What `useDocumentDraft` sends: one lineage, the base read when the save runs and moved on confirmation. */
    function draftOf(start: unknown) {
      let persisted = start;
      const draft: DraftLineage = { latest: start };
      return {
        draft,
        options: (doc: unknown): DocumentSaveOptions => {
          draft.latest = doc;
          return {
            base: () => persisted,
            confirmed: (stored) => {
              persisted = stored;
            },
            draft,
          };
        },
      };
    }

    /** The ledger adds cards only to the board it has open. */
    function openHome(test: ReturnType<typeof harness>, cards: CardDto[]) {
      test.cardWrites.applySnapshot(
        {
          board: { id: "home" } as BoardSummary,
          breadcrumbs: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          viewportRevision: 1,
          cards,
          unsortedCards: [],
        },
        0,
      );
    }

    it("does not take the client's own earlier save for another writer's change", async () => {
      let revision = 1;
      const updateNote = vi.fn(async () => ({ id: "note-1", revision: ++revision, plainText: "x" }));
      const test = harness({ updateNote });
      const d = draftOf(base);
      const first = text("first");
      const second = text("second");

      // The autosave is still in the queue when the blur's finalize is queued with the same base.
      await act(async () => {
        await Promise.all([
          test.result.current.handleUpdateNote("note-1", first, d.options(first)),
          test.result.current.handleFinalizeNote("note-1", second, d.options(second)),
        ]);
      });

      expect(test.createNote).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "failed" }));
      expect(updateNote).toHaveBeenLastCalledWith({ id: "note-1", expectedRevision: 2, documentJson: second });
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 3, documentJson: second });
    });

    it("writes again at the stored revision, silently, when only other fields of the refused note changed", async () => {
      const moved = note({ revision: 2, frame: { x: 500, y: 0, width: 240, height: 120 }, zIndex: 9 });
      const updateNote = vi
        .fn()
        .mockRejectedValueOnce(stale())
        .mockResolvedValueOnce({ id: "note-1", revision: 3, plainText: "edited" });
      const test = harness({ updateNote, readCard: vi.fn(async () => moved) });
      let result: unknown;

      await act(async () => {
        result = await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
      });

      expect(result).toBeUndefined();
      expect(updateNote).toHaveBeenLastCalledWith({ id: "note-1", expectedRevision: 2, documentJson: doc });
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 3, documentJson: doc, frame: moved.frame, zIndex: 9 });
      expect(test.createNote).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "failed" }));
    });

    it("keeps another writer's text and saves the refused one as a conflict copy that is edited next", async () => {
      const stored = note({ revision: 2, documentJson: theirs, plainText: "theirs" });
      const held = note({ colorToken: "blue" });
      const test = harness({
        cards: [held],
        updateNote: vi.fn().mockRejectedValueOnce(stale()),
        readCard: vi.fn(async () => stored),
      });
      openHome(test, [held]);
      let result: unknown;

      await act(async () => {
        result = await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.createNote).toHaveBeenCalledWith({
        id: "cmd-1",
        boardId: "home",
        frame: { x: 264, y: 0, width: 240, height: 120 },
        zIndex: 1,
        documentJson: copyOf(doc),
      });
      expect(test.setNoteColor).toHaveBeenCalledWith({ id: "cmd-1", colorToken: "blue" });
      expect(result).toEqual({ stored: theirs, copyId: "cmd-1", editingMovedTo: "cmd-1" });
      expect(test.cardsRef.current).toEqual([
        expect.objectContaining({ id: "note-1", revision: 2, documentJson: theirs }),
        expect.objectContaining({ id: "cmd-1", documentJson: copyOf(doc), plainText: "Conflict copy\nedited", colorToken: "blue" }),
      ]);
      // The copy appears already being edited, in one action.
      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "cardAdded", card: expect.objectContaining({ id: "cmd-1" }), startEditing: true }),
      );
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editingStarted" }));
      expect(readDraftHandoff("cmd-1")).toEqual(copyOf(doc));
      expect(test.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "failed", outlivesBoardSwitch: true }));
      expect(test.updateNote).toHaveBeenCalledTimes(1);
      endDraftHandoff("cmd-1");
    });

    it("reports every lost hand-off input with its own text, even within the dedupe window", async () => {
      const stored = note({ revision: 2, documentJson: theirs, plainText: "theirs" });
      const recordErrorReport = vi.fn();
      const test = harness({
        cards: [note()],
        updateNote: vi.fn().mockRejectedValueOnce(stale()),
        readCard: vi.fn(async () => stored),
        recordErrorReport,
      });
      openHome(test, [note()]);

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
      });
      // Keys on no editor are held for the copy, which never takes them.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
      act(() => endDraftHandoff("cmd-1"));

      expect(recordErrorReport).toHaveBeenCalledWith(
        expect.objectContaining({ supersede: true, detail: "Typed text:\nx" }),
      );
    });

    it("never shows the copy idle before editing moves to it, however slow the writes are", async () => {
      const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
      const held = note({ revision: 2, documentJson: theirs });
      const test = harness({ cards: [held] });
      // Every state the store passes through is one a render can show.
      let state: CurrentBoardState = initialState;
      const states: CurrentBoardState[] = [];
      test.dispatch.mockImplementation((action) => {
        state = reducer(state, action);
        states.push(state);
      });
      openHome(test, [held]);
      test.dispatch({ type: "editingStarted", id: "note-1" });
      const d = draftOf(base);
      test.createNote.mockImplementation(async () => {
        await delay();
        // The user types on while the copy is being created: it is written into the copy after.
        d.draft.latest = text("ab");
        return { id: "cmd-1", revision: 1 };
      });
      test.updateNote.mockImplementation(async () => {
        await delay();
        return { id: "cmd-1", revision: 2, plainText: "x" };
      });

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", text("a"), d.options(text("a")));
      });

      const withCopy = states.filter((s) => s.cards.some((c) => c.id === "cmd-1"));
      expect(withCopy.length).toBeGreaterThan(1);
      for (const s of withCopy) {
        expect(s.editingCardId).toBe("cmd-1");
        expect(s.selection).toEqual(["cmd-1"]);
      }
      endDraftHandoff("cmd-1");
    });

    it("keeps the copy, in the default color, when only setting its color fails", async () => {
      const held = note({ revision: 2, documentJson: theirs, colorToken: "blue" });
      const test = harness({ cards: [held] });
      test.setNoteColor.mockRejectedValueOnce(new Error("color failed"));
      openHome(test, [held]);
      let result: unknown;

      await act(async () => {
        result = await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
      });

      expect(result).toMatchObject({ copyId: "cmd-1" });
      expect(test.execute).toHaveBeenCalledTimes(1);
      expect(test.cardsRef.current[1]).toMatchObject({ id: "cmd-1", colorToken: "default" });
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("could not") }));
    });

    it("ends editing as after a save when the refused save was the final one", async () => {
      const test = harness({
        updateNote: vi.fn().mockRejectedValueOnce(stale()),
        readCard: vi.fn(async () => note({ revision: 2, documentJson: theirs })),
      });
      openHome(test, [note()]);
      let result: unknown;

      await act(async () => {
        result = await test.result.current.handleFinalizeNote("note-1", doc, draftOf(base).options(doc));
      });

      expect(result).toMatchObject({ stored: theirs, editingMovedTo: null });
      expect(test.createNote).toHaveBeenCalledTimes(1);
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editingStarted" }));
    });

    it("does not write over another writer's text the held note already shows", async () => {
      const test = harness({ cards: [note({ revision: 2, documentJson: theirs })] });

      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
      });

      expect(test.updateNote).not.toHaveBeenCalled();
      expect(test.createNote).toHaveBeenCalledTimes(1);
    });

    it("moves editing to the copy only when it landed on the open board", async () => {
      // No board is open in the ledger (the user left it): the copy is created but not added here.
      const test = harness({ cards: [note({ revision: 2, documentJson: theirs })] });
      let result: unknown;

      await act(async () => {
        result = await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
      });

      expect(result).toMatchObject({ copyId: "cmd-1", editingMovedTo: null });
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "editingStarted" }));
    });

    it("makes no copy when the refused text is the stored one", async () => {
      const test = harness({
        updateNote: vi.fn().mockRejectedValueOnce(stale()),
        readCard: vi.fn(async () => note({ revision: 2, documentJson: doc })),
      });
      let result: unknown;

      await act(async () => {
        result = await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
      });

      expect(result).toEqual({ stored: doc, copyId: null, editingMovedTo: null });
      expect(test.createNote).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "failed" }));
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 2, documentJson: doc });
    });

    it("writes what was typed during and after the copy's creation into the copy", async () => {
      const test = harness({ cards: [note({ revision: 2, documentJson: theirs })] });
      openHome(test, [note({ revision: 2, documentJson: theirs })]);
      const d = draftOf(base);
      const typed = [text("a"), text("ab"), text("abc"), text("abcd")];
      // The user types on while the copy is being created.
      test.createNote.mockImplementation(async () => {
        d.draft.latest = typed[1];
        return { id: "cmd-1", revision: 1 };
      });
      let copyRevision = 1;
      test.updateNote.mockImplementation(async () => ({ id: "cmd-1", revision: ++copyRevision, plainText: "x" }));
      const results: unknown[] = [];

      await act(async () => {
        results.push(await test.result.current.handleUpdateNote("note-1", typed[0], d.options(typed[0])));
      });
      const copyNow = () => (test.cardsRef.current.find((c) => c.id === "cmd-1") as NoteCardDto).documentJson;
      expect(copyNow()).toEqual(copyOf(typed[1]));
      // Saves of the same draft that were already queued, or come before its editor closes.
      await act(async () => {
        results.push(await test.result.current.handleUpdateNote("note-1", typed[2], d.options(typed[2])));
        results.push(await test.result.current.handleFinalizeNote("note-1", typed[3], d.options(typed[3])));
      });

      expect(test.createNote).toHaveBeenCalledTimes(1);
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
      expect(copyNow()).toEqual(copyOf(typed[3]));
      // The original was never written.
      expect(test.updateNote).not.toHaveBeenCalledWith(expect.objectContaining({ id: "note-1" }));
    });

    it("does not take text this client forwarded into the copy for another writer's change of the copy", async () => {
      const test = harness({ cards: [note({ revision: 2, documentJson: theirs })] });
      openHome(test, [note({ revision: 2, documentJson: theirs })]);
      const d = draftOf(base);
      let copyRevision = 1;
      test.updateNote.mockImplementation(async () => ({ id: "cmd-1", revision: ++copyRevision, plainText: "x" }));
      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", text("a"), d.options(text("a")));
      });
      // The copy's own draft starts from the copy as created; then the original forwards more text.
      const copyDraft = draftOf(copyOf(text("a")));
      await act(async () => {
        await test.result.current.handleUpdateNote("note-1", text("ab"), d.options(text("ab")));
      });

      const typedInCopy = copyOf(text("ab and on"));
      await act(async () => {
        await test.result.current.handleUpdateNote("cmd-1", typedInCopy, copyDraft.options(typedInCopy));
      });

      expect(test.createNote).toHaveBeenCalledTimes(1);
      expect(test.updateNote).toHaveBeenLastCalledWith({ id: "cmd-1", expectedRevision: 2, documentJson: typedInCopy });
    });

    it("keeps the user's text in the error report, not in the banner, when the copy cannot be created", async () => {
      const recordErrorReport = vi.fn();
      const test = harness({
        updateNote: vi.fn().mockRejectedValueOnce(stale()),
        readCard: vi.fn(async () => note({ revision: 2, documentJson: theirs })),
        createNote: vi.fn(async () => {
          throw new Error("disk full");
        }),
        recordErrorReport,
      });
      let thrown: unknown;

      await act(async () => {
        try {
          await test.result.current.handleUpdateNote("note-1", doc, draftOf(base).options(doc));
        } catch (e) {
          thrown = e;
        }
      });

      const message = (thrown as Error).message;
      expect(message).toContain("could not be saved");
      expect(message).not.toContain("edited");
      expect(recordErrorReport).toHaveBeenCalledWith(
        expect.objectContaining({ message, detail: expect.stringMatching(/disk full[\s\S]*Your text:\nedited/) }),
      );
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message, outlivesBoardSwitch: true });
      // The original keeps the draft's base, so the next save tries the copy again.
      expect(test.cardsRef.current[0]).toMatchObject({ revision: 1, documentJson: base });
    });

    it("while the copy cannot be created, autosaves retry it only after a growing pause and report the text once", async () => {
      let now = 10_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const recordErrorReport = vi.fn();
      const createNote = vi.fn(async () => {
        throw new Error("disk full");
      });
      const test = harness({ cards: [note({ revision: 2, documentJson: theirs })], createNote, recordErrorReport });
      const d = draftOf(base);
      const save = async (t: string, finalize = false) => {
        await act(async () => {
          const handle = finalize ? test.result.current.handleFinalizeNote : test.result.current.handleUpdateNote;
          await handle("note-1", text(t), d.options(text(t))).catch(() => undefined);
        });
      };

      try {
        await save("a");
        now += 250;
        await save("ab");
        now += 250;
        await save("abc");
        expect(createNote).toHaveBeenCalledTimes(1);
        expect(recordErrorReport).toHaveBeenCalledTimes(1);
        expect(recordErrorReport).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringMatching(/Your text:\na$/) }));
        // Every save still says the text was not saved.
        expect(test.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "failed", message: expect.stringContaining("could not be saved") }));

        now += COPY_RETRY_MS;
        await save("abcd");
        expect(createNote).toHaveBeenCalledTimes(2);
        expect(recordErrorReport).toHaveBeenCalledTimes(1);
        // The pause doubles.
        now += COPY_RETRY_MS;
        await save("abcde");
        expect(createNote).toHaveBeenCalledTimes(2);

        // Ending the edit (blur, leaving the board) tries at once and reports the newer text.
        await save("abcdef", true);
        expect(createNote).toHaveBeenCalledTimes(3);
        expect(recordErrorReport).toHaveBeenCalledTimes(2);
        expect(recordErrorReport).toHaveBeenLastCalledWith(
          expect.objectContaining({ supersede: true, detail: expect.stringMatching(/Your text:\nabcdef$/) }),
        );
        await save("abcdef", true);
        expect(recordErrorReport).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
    });

    describe("writing on into a copy another writer changed since", () => {
      /** A settled conflict: the copy `cmd-1` holds `copyOf(text("a"))`, written by this client. */
      async function settled(test: ReturnType<typeof harness>) {
        openHome(test, [note({ revision: 2, documentJson: theirs })]);
        const d = draftOf(base);
        await act(async () => {
          await test.result.current.handleFinalizeNote("note-1", text("a"), d.options(text("a")));
        });
        expect(test.createNote).toHaveBeenCalledTimes(1);
        return d;
      }

      it("does not overwrite the other writer's text the held copy shows, and puts the draft's text in a new copy", async () => {
        const test = harness({ cards: [note({ revision: 2, documentJson: theirs })] });
        const d = await settled(test);
        const foreign = copyOf(text("changed on another device"));
        test.cardWrites.apply({ type: "cardContentUpdated", id: "cmd-1", revision: 5, documentJson: foreign, plainText: "x" });
        test.updateNote.mockClear();
        let result: unknown;

        await act(async () => {
          result = await test.result.current.handleUpdateNote("note-1", text("ab"), d.options(text("ab")));
        });

        expect(test.updateNote).not.toHaveBeenCalled();
        expect(test.createNote).toHaveBeenCalledTimes(2);
        expect(test.createNote).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: "cmd-2", documentJson: copyOf(text("ab")), frame: { x: 528, y: 0, width: 240, height: 120 } }),
        );
        expect(result).toEqual({ stored: theirs, copyId: "cmd-2", editingMovedTo: null });
        expect(test.cardsRef.current.find((c) => c.id === "cmd-1")).toMatchObject({ documentJson: foreign });

        // Later text of the same draft goes to the new copy.
        test.updateNote.mockResolvedValueOnce({ id: "cmd-2", revision: 2, plainText: "x" });
        await act(async () => {
          await test.result.current.handleUpdateNote("note-1", text("abc"), d.options(text("abc")));
        });
        expect(test.updateNote).toHaveBeenLastCalledWith({ id: "cmd-2", expectedRevision: 1, documentJson: copyOf(text("abc")) });
      });

      it("reads the copy back when the write is refused as stale, and makes a new copy for another writer's text", async () => {
        const reload = vi.fn(async () => {});
        const test = harness({
          cards: [note({ revision: 2, documentJson: theirs })],
          wrapGateway: (gateway) => {
            const wrapped = createStaleRevisionReload(gateway);
            wrapped.setReload(reload);
            return wrapped.gateway;
          },
        });
        const d = await settled(test);
        const foreign = copyOf(text("changed on another device"));
        test.updateNote.mockRejectedValueOnce(stale());
        test.readCard.mockResolvedValueOnce(note({ id: "cmd-1", revision: 4, documentJson: foreign }));
        let result: unknown;

        await act(async () => {
          result = await test.result.current.handleUpdateNote("note-1", text("ab"), d.options(text("ab")));
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(result).toMatchObject({ copyId: "cmd-2" });
        expect(test.createNote).toHaveBeenLastCalledWith(expect.objectContaining({ documentJson: copyOf(text("ab")) }));
        expect(test.cardsRef.current.find((c) => c.id === "cmd-1")).toMatchObject({ revision: 4, documentJson: foreign });
        // Handled here: the refusal does not reload the board.
        expect(reload).not.toHaveBeenCalled();
      });

      it("writes again at the stored revision when the stale copy still holds this client's text", async () => {
        const test = harness({ cards: [note({ revision: 2, documentJson: theirs })] });
        const d = await settled(test);
        test.updateNote.mockRejectedValueOnce(stale()).mockResolvedValueOnce({ id: "cmd-1", revision: 5, plainText: "x" });
        test.readCard.mockResolvedValueOnce(note({ id: "cmd-1", revision: 4, documentJson: copyOf(text("a")) }));

        await act(async () => {
          await test.result.current.handleUpdateNote("note-1", text("ab"), d.options(text("ab")));
        });

        expect(test.createNote).toHaveBeenCalledTimes(1);
        expect(test.updateNote).toHaveBeenLastCalledWith({ id: "cmd-1", expectedRevision: 4, documentJson: copyOf(text("ab")) });
        expect(test.cardsRef.current.find((c) => c.id === "cmd-1")).toMatchObject({ revision: 5, documentJson: copyOf(text("ab")) });
      });
    });

    it("gives a conflict copy that itself meets a conflict one Conflict copy heading, not two", async () => {
      const copy = note({ id: "copy-1", documentJson: copyOf(text("mine")) });
      const test = harness({
        cards: [copy],
        updateNote: vi.fn().mockRejectedValueOnce(stale()),
        readCard: vi.fn(async () => note({ id: "copy-1", revision: 2, documentJson: copyOf(text("theirs")) })),
      });
      openHome(test, [copy]);
      const typed = copyOf(text("mine and more"));

      await act(async () => {
        await test.result.current.handleFinalizeNote("copy-1", typed, draftOf(copy.documentJson).options(typed));
      });

      expect(test.createNote).toHaveBeenCalledWith(expect.objectContaining({ documentJson: typed }));
    });
  });
});
