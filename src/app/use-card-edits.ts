import { useCallback, type Dispatch, type RefObject } from "react";
import { plainTextToDocument } from "../editor/document-codec";
import type { DocumentSaveOptions } from "../editor/corrupt-document";
import { classifyLinkConversion } from "../cards/link/link-conversion";
import { errorMessage } from "../services/error-message";
import type { CardDto, EmbedCardDto, ImageCardDto, NoteCardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import type { MutationQueue } from "../persistence/entity-write-queue";

/**
 * Card content edits: persisting a note/caption/embed-description save to its
 * card, note->embed finalize conversion, and frame resize — one card at a
 * time, serialized through the shared mutation queue.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 7).
 */

export interface CardEditsOptions {
  gateway: WorkspaceGateway;
  dispatch: Dispatch<CurrentBoardAction>;
  queueRef: RefObject<MutationQueue>;
  cardsRef: RefObject<CardDto[]>;
}

export interface CardEditsController {
  handleUpdateNote: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleFinalizeNote: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleUpdateImageCaption: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleUpdateEmbedDescription: (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;
  handleResizeNote: (id: string, width: number, height: number) => void;
}

/** The `acknowledgeCorrupt` flag of a text write, present only when set (P1.7). */
function acknowledgeCorrupt(options?: DocumentSaveOptions): { acknowledgeCorrupt?: true } {
  return options?.acknowledgeCorrupt ? { acknowledgeCorrupt: true } : {};
}

/** A short, human-friendly URL for display (strips scheme and trailing slash). */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return path ? `${host}${path}` : host;
  } catch {
    return raw;
  }
}

export function useCardEdits(deps: CardEditsOptions): CardEditsController {
  const { gateway, dispatch, queueRef, cardsRef } = deps;

  const handleUpdateNote = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions): Promise<void> => {
      return queueRef.current.run(async () => {
        const note = cardsRef.current.find(
          (n): n is NoteCardDto => n.kind === "note" && n.id === id,
        );
        if (!note) return;
        // Defensive check before persisting: never write a non-object document
        // into SQLite. A structurally unusual (but still object) document is
        // preserved as-is — validation is protective, not a source of user-facing
        // save failures.
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Note content is not a valid document");
        }

        const receipt = await gateway.updateNote({
          id,
          expectedRevision: note.revision,
          documentJson: document,
          ...acknowledgeCorrupt(options),
        });
        // Keep the ref authoritative *inside this microtask*: the note's own
        // auto-grow (NoteCard) debounces a resize write off the same keystroke
        // and can land right behind this one in the queue, before React's
        // effect has re-synced `cardsRef` from state (see `useEmbedMetadata`'s
        // request handler for the same pattern).
        cardsRef.current = cardsRef.current.map((c) =>
          c.id === id
            ? { ...c, revision: receipt.revision, documentJson: document, plainText: receipt.plainText, corrupt: false }
            : c,
        );
        dispatch({
          type: "cardContentUpdated",
          id,
          revision: receipt.revision,
          documentJson: document,
          plainText: receipt.plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway, dispatch, queueRef, cardsRef],
  );

  const handleFinalizeNote = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions): Promise<void> => {
      return queueRef.current.run(async () => {
        const note = cardsRef.current.find(
          (n): n is NoteCardDto => n.kind === "note" && n.id === id,
        );
        if (!note) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Note content is not a valid document");
        }

        const classification = classifyLinkConversion(document);
        if (classification.qualifies) {
          const embed = await gateway.convertNoteToEmbed({
            id,
            expectedRevision: note.revision,
            sourceUrl: classification.url,
            displayUrl: displayUrl(classification.url),
            title: classification.url,
            descriptionJson: plainTextToDocument(""),
          });
          cardsRef.current = cardsRef.current.map((c) => (c.id === id ? embed : c));
          dispatch({ type: "cardReplaced", id, card: embed });
          return;
        }

        const receipt = await gateway.updateNote({
          id,
          expectedRevision: note.revision,
          documentJson: document,
          ...acknowledgeCorrupt(options),
        });
        // Same ref-staleness guard as handleUpdateNote above: a pending
        // auto-grow resize can be queued right behind this finalize.
        cardsRef.current = cardsRef.current.map((c) =>
          c.id === id
            ? { ...c, revision: receipt.revision, documentJson: document, plainText: receipt.plainText, corrupt: false }
            : c,
        );
        dispatch({
          type: "cardContentUpdated",
          id,
          revision: receipt.revision,
          documentJson: document,
          plainText: receipt.plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway, dispatch, queueRef, cardsRef],
  );

  const handleUpdateImageCaption = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions): Promise<void> => {
      return queueRef.current.run(async () => {
        const image = cardsRef.current.find(
          (c): c is ImageCardDto => c.kind === "image" && c.id === id,
        );
        if (!image) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Image caption is not a valid document");
        }
        const receipt = await gateway.updateImageCaption({
          id,
          expectedRevision: image.revision,
          captionJson: document,
          ...acknowledgeCorrupt(options),
        });
        dispatch({
          type: "imageCaptionUpdated",
          id,
          revision: receipt.revision,
          captionJson: document,
          captionPlainText: receipt.plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway, dispatch, queueRef, cardsRef],
  );

  const handleUpdateEmbedDescription = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions): Promise<void> => {
      return queueRef.current.run(async () => {
        const embed = cardsRef.current.find(
          (c): c is EmbedCardDto => c.kind === "embed" && c.id === id,
        );
        if (!embed) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Link description is not a valid document");
        }
        const receipt = await gateway.updateEmbedDescription({
          id,
          expectedRevision: embed.revision,
          descriptionJson: document,
          ...acknowledgeCorrupt(options),
        });
        dispatch({
          type: "embedDescriptionUpdated",
          id,
          revision: receipt.revision,
          descriptionJson: document,
          descriptionPlainText: receipt.plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway, dispatch, queueRef, cardsRef],
  );

  const handleResizeNote = useCallback(
    (id: string, width: number, height: number) => {
      const card = cardsRef.current.find((c) => c.id === id);
      if (!card) return;
      void queueRef.current
        .run(async () => {
          const current = cardsRef.current.find((c) => c.id === id);
          if (!current) return;
          const frame = { ...current.frame, width, height };
          const receipt = await gateway.moveCard({
            id,
            expectedRevision: current.revision,
            frame,
          });
          // Same ref-staleness guard as content saves above: NoteCard's
          // auto-grow can queue a resize right behind a content autosave for
          // the same keystroke, and the two must not read the same stale
          // revision (tasks/lessons.md 2026-09-08).
          cardsRef.current = cardsRef.current.map((c) =>
            c.id === id ? { ...c, revision: receipt.revision, frame } : c,
          );
          dispatch({ type: "cardMoved", id, revision: receipt.revision, frame });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway, dispatch, queueRef, cardsRef],
  );

  return {
    handleUpdateNote,
    handleFinalizeNote,
    handleUpdateImageCaption,
    handleUpdateEmbedDescription,
    handleResizeNote,
  };
}
