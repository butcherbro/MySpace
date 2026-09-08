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
import { EmbedCard } from "./link/EmbedCard";

export interface CardRenderContext {
  /** Whether the card (if a note) is currently being edited. */
  editing: boolean;
  /** Exit note editing. */
  onDeactivate: () => void;
  /** Persist note content as an authoritative document. */
  onUpdateNote: (id: string, document: unknown) => Promise<void>;
  /** Finalize note editing and optionally convert the note into a Link Card. */
  onFinalizeNote: (id: string, document: unknown) => Promise<void>;
  /** Persist an image card's caption. */
  onUpdateImageCaption: (id: string, document: unknown) => Promise<void>;
  /** Persist an embed (Link) card's description body. */
  onUpdateEmbedDescription: (id: string, document: unknown) => Promise<void>;
  /** Retry metadata enrichment for a failed Link Card. */
  onRetryEmbedMetadata: (id: string) => void;
  /** Open a board portal. */
  onOpenBoard: (boardId: string) => void;
  /** Rename a board. */
  onRenameBoard: (boardId: string, title: string) => void;
  /** Request a context menu (right-click) for a card. */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Persist a manual resize (width/height). */
  onResizeNote: (id: string, width: number, height: number) => void;
  /** Persist a manual resize for image cards. */
  onResizeImage: (id: string, width: number, height: number) => void;
  /** Persist a manual resize for embed (Link) cards. */
  onResizeEmbed: (id: string, width: number, height: number) => void;
  /** The portal currently being hovered during a card drag, if any. */
  highlightedPortalId: string | null;
  /** Transient search phrase to highlight inside cards (UI-only). */
  highlightQuery: string;
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
        onFinalize={ctx.onFinalizeNote}
        onContextMenu={ctx.onContextMenu}
        onResize={ctx.onResizeNote}
        highlightQuery={ctx.highlightQuery}
      />
    );
  }

  if (card.kind === "image") {
    return (
      <ImageCard
        image={card}
        onUpdate={ctx.onUpdateImageCaption}
        onResize={ctx.onResizeImage}
        onContextMenu={ctx.onContextMenu}
        highlightQuery={ctx.highlightQuery}
      />
    );
  }

  if (card.kind === "embed") {
    return (
      <EmbedCard
        embed={card}
        onUpdate={ctx.onUpdateEmbedDescription}
        onResize={ctx.onResizeEmbed}
        onContextMenu={ctx.onContextMenu}
        onRetryMetadata={ctx.onRetryEmbedMetadata}
        highlightQuery={ctx.highlightQuery}
      />
    );
  }

  return (
    <BoardPortalCard
      portal={card}
      onOpen={ctx.onOpenBoard}
      onRename={ctx.onRenameBoard}
      onContextMenu={ctx.onContextMenu}
      highlighted={card.id === ctx.highlightedPortalId}
    />
  );
}
