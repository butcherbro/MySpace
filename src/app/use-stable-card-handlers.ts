import { useLayoutEffect, useMemo, useRef } from "react";
import type { CardRenderContext } from "../cards/card-registry";
import type { DocumentSaveOptions } from "../editor/corrupt-document";
import type { ResizeOptions } from "../cards/resize-options";
import type { NoteEditorCommands } from "../editor/editor-commands";
import type { TextColorId } from "../editor/text-color";

/**
 * Card callbacks handed to the canvas, as stable wrappers over the latest
 * handlers (P1.8). The canvas keeps a card's rendered element until that card
 * itself changes, so a handler captured at build time must never go stale
 * (several close over `state`), and stable identities let the memoised card
 * components skip re-rendering. Values (editing flag, highlight) are not
 * here: they are read when a card is (re)built, so this hook only covers the
 * handler-shaped fields of `CardRenderContext`.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 13).
 */

export type StableCardHandlersDeps = Omit<
  CardRenderContext,
  "editing" | "highlightedPortalId" | "highlightQuery"
>;

export function useStableCardHandlers(deps: StableCardHandlersDeps): StableCardHandlersDeps {
  const cardHandlersRef = useRef(deps);
  useLayoutEffect(() => {
    cardHandlersRef.current = deps;
  });
  return useMemo(() => {
    const latest = () => cardHandlersRef.current;
    return {
      onDeactivate: () => latest().onDeactivate(),
      onUpdateNote: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onUpdateNote(id, document, options),
      onFinalizeNote: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onFinalizeNote(id, document, options),
      onUpdateImageCaption: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onUpdateImageCaption(id, document, options),
      onFinalizeImageCaption: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onFinalizeImageCaption(id, document, options),
      onUpdateEmbedDescription: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onUpdateEmbedDescription(id, document, options),
      onFinalizeEmbedDescription: (id: string, document: unknown, options?: DocumentSaveOptions) =>
        latest().onFinalizeEmbedDescription(id, document, options),
      onRetryEmbedMetadata: (id: string) => latest().onRetryEmbedMetadata(id),
      onOpenBoard: (boardId: string) => latest().onOpenBoard(boardId),
      onRenameBoard: (boardId: string, title: string) => latest().onRenameBoard(boardId, title),
      onContextMenu: (cardId: string, x: number, y: number) => latest().onContextMenu(cardId, x, y),
      onResizeNote: (id: string, w: number, h: number, options?: ResizeOptions) =>
        latest().onResizeNote(id, w, h, options),
      onResizeImage: (id: string, w: number, h: number) => latest().onResizeImage(id, w, h),
      onResizeEmbed: (id: string, w: number, h: number, options?: ResizeOptions) =>
        latest().onResizeEmbed(id, w, h, options),
      onResizeFilesystemAlias: (id: string, w: number, h: number) => latest().onResizeFilesystemAlias(id, w, h),
      onLoadFolderPreview: (id: string) => latest().onLoadFolderPreview(id),
      onOpenFolderInFinder: (id: string) => latest().onOpenFolderInFinder(id),
      onPointFolderShortcutHere: (id: string) => latest().onPointFolderShortcutHere(id),
      onOpenFileCard: (id: string) => latest().onOpenFileCard(id),
      onRevealFileCard: (id: string) => latest().onRevealFileCard(id),
      onResizeFileCard: (id: string, w: number, h: number) => latest().onResizeFileCard(id, w, h),
      onNoteCommands: (commands: NoteEditorCommands | null) => latest().onNoteCommands(commands),
      onNoteBoldStateChange: (active: boolean) => latest().onNoteBoldStateChange(active),
      onNoteItalicStateChange: (active: boolean) => latest().onNoteItalicStateChange(active),
      onNoteStrikeStateChange: (active: boolean) => latest().onNoteStrikeStateChange(active),
      onNoteTextColorChange: (color: TextColorId) => latest().onNoteTextColorChange(color),
    } satisfies StableCardHandlersDeps;
  }, []);
}
