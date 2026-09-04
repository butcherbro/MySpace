// Internal card registry: maps persisted domain card kinds to renderers.
//
// This is composition, not a plugin SDK (ADR/repo guidance): it has no
// filesystem, Tauri, SQL, or network behavior. It lets `App` render a mixed
// board of notes and board portals through one typed entry point.

import type { ReactNode } from "react";
import type { CardDto } from "../services/workspace-gateway";
import { BoardPortalCard } from "./board/BoardPortalCard";
import { NoteCard } from "./note/NoteCard";
import { ImageCard } from "./image/ImageCard";

export interface CardRenderContext {
  /** Whether the card (if a note) is currently being edited. */
  editing: boolean;
  /** Exit note editing. */
  onDeactivate: () => void;
  /** Persist note content as an authoritative document. */
  onUpdateNote: (id: string, document: unknown) => Promise<void>;
  /** Open a board portal. */
  onOpenBoard: (boardId: string) => void;
  /** Rename a board. */
  onRenameBoard: (boardId: string, title: string) => void;
  /** Request a context menu (right-click) for a card. */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Persist a manual resize (width/height). */
  onResizeNote: (id: string, width: number, height: number) => void;
}

/** Renders a persisted card into the canvas. */
export function renderCard(card: CardDto, ctx: CardRenderContext): ReactNode {
  if (card.kind === "note") {
    return (
      <NoteCard
        note={card}
        editing={ctx.editing}
        onDeactivate={ctx.onDeactivate}
        onUpdate={ctx.onUpdateNote}
        onContextMenu={ctx.onContextMenu}
        onResize={ctx.onResizeNote}
      />
    );
  }

  if (card.kind === "image") {
    return <ImageCard asset={card.asset} captionPlainText={card.captionPlainText} />;
  }

  return (
    <BoardPortalCard
      portal={card}
      onOpen={ctx.onOpenBoard}
      onRename={ctx.onRenameBoard}
      onContextMenu={ctx.onContextMenu}
    />
  );
}
