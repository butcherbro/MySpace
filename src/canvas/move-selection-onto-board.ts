import { MoveSelectionCommand } from "../commands/board-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { IdGenerator } from "../services/id-generator";
import type { MoveSelectionToBoardReceipt, WorkspaceGateway } from "../services/workspace-gateway";

/** The minimal leaf-card shape both call sites have on hand: a live `CardDto`
 * (on-canvas portal drop) or a drag-start snapshot (breadcrumb/tab drop). */
interface LeafRef {
  id: string;
  revision: number;
}

/** The minimal board-portal shape both call sites have on hand. */
interface PortalRef {
  boardId: string;
  boardRevision: number;
  portalRevision: number;
}

/** True for the `{ code: "stale_revision", message: {...} }` shape the Rust
 * `WorkspaceError::StaleRevision` variant serialises as (see
 * `src-tauri/src/domain/errors.rs`, serde tag/content). */
function isStaleRevisionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "stale_revision"
  );
}

/**
 * Drops a selection (leaf cards + board portals) onto a target board's
 * Unsorted panel, as one atomic backend call (ADR-0007).
 *
 * Each leaf's revision is refreshed via `readCard` right before the call,
 * because a draft autosave (blur flush) can bump a card's revision after the
 * drag started (tasks/lessons.md, 2026-09-08). That refresh narrows the race
 * but does not close it: the flush can still land in the gap between the
 * `readCard` response and the move's own IPC round-trip — the larger the note
 * (the slower the flush write), the wider that gap. A stale-revision refusal
 * there used to just fail the whole move with an opaque "stale_revision"
 * banner and no second attempt, which reads to the user as the card having
 * vanished (it is still on the source board, but nothing tells them that, and
 * the retry they'd need to do by hand is not obvious).
 *
 * One bounded retry re-reads the now-settled revisions and tries again, so a
 * genuine race resolves itself instead of surfacing as a lost card.
 */
export async function moveSelectionOntoBoard(params: {
  gateway: WorkspaceGateway;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  targetBoardId: string;
  leafCards: LeafRef[];
  portals: PortalRef[];
  maxAttempts?: number;
}): Promise<MoveSelectionToBoardReceipt> {
  const { gateway, dispatcher, idGenerator, targetBoardId, leafCards, portals } = params;
  const maxAttempts = params.maxAttempts ?? 2;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const cards = await Promise.all(
      leafCards.map((c) =>
        gateway
          .readCard(c.id)
          .then((fresh) => ({
            id: c.id,
            expectedRevision:
              fresh && "revision" in fresh ? (fresh as { revision: number }).revision : c.revision,
          }))
          .catch(() => ({ id: c.id, expectedRevision: c.revision })),
      ),
    );

    try {
      return await dispatcher.execute(
        new MoveSelectionCommand(idGenerator.nextId(), {
          idempotencyKey: idGenerator.nextId(),
          targetBoardId,
          cards,
          boards: portals.map((p) => ({
            boardId: p.boardId,
            expectedBoardRevision: p.boardRevision,
            expectedPortalRevision: p.portalRevision,
          })),
          leafPlacement: "unsorted",
        }),
      );
    } catch (err) {
      lastError = err;
      if (!isStaleRevisionError(err) || attempt >= maxAttempts) {
        throw err;
      }
      // Одна безопасная повторная попытка: перечитываем ревизии заново — к
      // этому моменту гонка с draft-flush уже разрешилась (запись либо
      // закоммитилась, либо нет), так что второе чтение видит фактическое
      // состояние и повтор либо пройдёт, либо откажет по другой причине.
    }
  }
  // Unreachable in practice (the loop always returns or throws), but keeps
  // the function total for TypeScript.
  throw lastError;
}
