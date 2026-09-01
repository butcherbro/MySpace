// Internal card registry: maps persisted domain card kinds to renderers.
//
// This is composition, not a plugin SDK (ADR/repo guidance): it has no
// filesystem, Tauri, SQL, or network behavior. It lets `App` render a mixed
// board of notes and board portals through one typed entry point.

import type { ReactNode } from "react";
import type { CardDto } from "../services/workspace-gateway";
import { BoardPortalCard } from "./board/BoardPortalCard";
import { NoteCard } from "./note/NoteCard";

export interface CardRenderContext {
  /** Whether the card (if a note) is currently being edited. */
  editing: boolean;
  /** Exit note editing. */
  onDeactivate: () => void;
  /** Persist note content. */
  onUpdateNote: (id: string, plainText: string) => Promise<void>;
  /** Open a board portal. */
  onOpenBoard: (boardId: string) => void;
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
      />
    );
  }

  return <BoardPortalCard portal={card} onOpen={ctx.onOpenBoard} />;
}
