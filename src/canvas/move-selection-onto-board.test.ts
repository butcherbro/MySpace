import { describe, expect, it, vi } from "vitest";
import { moveSelectionOntoBoard } from "./move-selection-onto-board";
import { CommandDispatcher } from "../commands/command-dispatcher";
import { UuidV7Generator } from "../services/id-generator";
import type { CardDto, MoveSelectionToBoardInput, WorkspaceGateway } from "../services/workspace-gateway";

function noteCard(id: string, revision: number): CardDto {
  return {
    kind: "note",
    id,
    boardId: "home",
    frame: { x: 0, y: 0, width: 320, height: 900 },
    zIndex: 0,
    revision,
    documentJson: {},
    plainText: "a large multiline note",
    colorToken: "default",
  } as unknown as CardDto;
}

describe("moveSelectionOntoBoard", () => {
  it("moves the card on the first try when nothing races it", async () => {
    const card = noteCard("note-1", 3);
    const readCard = vi.fn(async () => card);
    const moveSelectionToBoard = vi.fn(async (input: MoveSelectionToBoardInput) => ({
      operationId: "op-1",
      targetBoardId: input.targetBoardId,
      cards: input.cards.map((c) => ({
        id: c.id,
        previousBoardId: "home",
        previousUnsorted: false,
        previousFrame: card.frame,
        beforeRevision: c.expectedRevision,
        afterRevision: c.expectedRevision + 1,
      })),
      boards: [],
    }));
    const gateway = { readCard, moveSelectionToBoard } as unknown as WorkspaceGateway;
    const dispatcher = new CommandDispatcher(gateway);

    const receipt = await moveSelectionOntoBoard({
      gateway,
      dispatcher,
      idGenerator: new UuidV7Generator(),
      targetBoardId: "board-b",
      leafCards: [card],
      portals: [],
    });

    expect(receipt.cards.map((c) => c.id)).toEqual(["note-1"]);
    expect(moveSelectionToBoard).toHaveBeenCalledTimes(1);
  });

  /**
   * Reproduces the reported bug: a large multiline note's blur-triggered
   * draft flush (`update_note`) is still in flight when the drop's readCard
   * refresh runs, so the refresh sees the pre-flush revision. By the time the
   * move's own IPC call reaches the backend, the flush has landed and bumped
   * the real revision — the backend rightly refuses the stale expectation
   * (ADR-0007's atomic all-or-nothing guarantee). Without a retry, that
   * refusal was the end of the story: the card stays on the source board with
   * only an opaque "stale_revision" banner, and never reaches the target's
   * Unsorted panel — which reads to the user as the note having vanished.
   */
  it("retries once and still lands the card when a draft flush wins the race", async () => {
    const staleRevision = 3;
    const freshRevision = 4; // bumped by the in-flight draft flush landing between attempts
    let readCardCalls = 0;
    const readCard = vi.fn(async () => {
      readCardCalls += 1;
      // First read loses the race with the flush (sees the pre-flush revision);
      // the flush has landed by the second read.
      return noteCard("note-1", readCardCalls === 1 ? staleRevision : freshRevision);
    });

    let attempt = 0;
    const moveSelectionToBoard = vi.fn(async (input: MoveSelectionToBoardInput) => {
      attempt += 1;
      const expected = input.cards[0]?.expectedRevision;
      if (attempt === 1) {
        // The backend validated inside its transaction and found the flush
        // already committed: reject the whole atomic move (ADR-0007).
        throw { code: "stale_revision", message: { expected, actual: freshRevision } };
      }
      return {
        operationId: "op-2",
        targetBoardId: input.targetBoardId,
        cards: input.cards.map((c) => ({
          id: c.id,
          previousBoardId: "home",
          previousUnsorted: false,
          previousFrame: { x: 0, y: 0, width: 320, height: 900 },
          beforeRevision: c.expectedRevision,
          afterRevision: c.expectedRevision + 1,
        })),
        boards: [],
      };
    });
    const gateway = { readCard, moveSelectionToBoard } as unknown as WorkspaceGateway;
    const dispatcher = new CommandDispatcher(gateway);

    const receipt = await moveSelectionOntoBoard({
      gateway,
      dispatcher,
      idGenerator: new UuidV7Generator(),
      targetBoardId: "board-b",
      leafCards: [noteCard("note-1", staleRevision)],
      portals: [],
    });

    // The card actually moved — it is not lost.
    expect(receipt.cards.map((c) => c.id)).toEqual(["note-1"]);
    expect(moveSelectionToBoard).toHaveBeenCalledTimes(2);
    expect(readCard).toHaveBeenCalledTimes(2);
    // The second attempt used the settled (post-flush) revision.
    expect(moveSelectionToBoard.mock.calls[1][0].cards[0].expectedRevision).toBe(freshRevision);
  });

  it("still surfaces a persistent stale-revision refusal after exhausting retries", async () => {
    const readCard = vi.fn(async () => noteCard("note-1", 3));
    const moveSelectionToBoard = vi.fn(async () => {
      throw { code: "stale_revision", message: { expected: 3, actual: 99 } };
    });
    const gateway = { readCard, moveSelectionToBoard } as unknown as WorkspaceGateway;
    const dispatcher = new CommandDispatcher(gateway);

    await expect(
      moveSelectionOntoBoard({
        gateway,
        dispatcher,
        idGenerator: new UuidV7Generator(),
        targetBoardId: "board-b",
        leafCards: [noteCard("note-1", 3)],
        portals: [],
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(moveSelectionToBoard).toHaveBeenCalledTimes(2);
  });

  /**
   * Regression for the "Cmd+Z after a single-card drop onto a board portal
   * does nothing" bug (tasks/lessons.md 2026-09-18): the single-card drop
   * handler in App.tsx used to call `gateway.moveCardsToBoardUnsorted`
   * directly, bypassing the CommandDispatcher entirely, so that move never
   * entered undo history — Cmd+Z instead undid whatever older command
   * happened to be on top, which had usually gone stale, surfacing an
   * unrelated "stale_revision" toast. The handler now goes through
   * `moveSelectionOntoBoard` (this module) for a single leaf card with no
   * portals, exactly like the group-drop path, so it is recorded on the
   * dispatcher's undo stack and Cmd+Z reverses it cleanly.
   */
  it("leaves a single-leaf-card move (no portals) undoable via the dispatcher", async () => {
    // A tiny in-memory "backend": tracks the card's live revision so the
    // undo call can be checked against real post-move state, not a canned
    // response.
    let liveRevision = 3;
    const originalFrame = { x: 0, y: 0, width: 320, height: 900 };

    const readCard = vi.fn(async () => noteCard("note-1", liveRevision));
    const moveSelectionToBoard = vi.fn(async (input: MoveSelectionToBoardInput) => {
      const before = liveRevision;
      liveRevision += 1;
      return {
        operationId: "op-move",
        targetBoardId: input.targetBoardId,
        cards: input.cards.map((c) => ({
          id: c.id,
          previousBoardId: "home",
          previousUnsorted: false,
          previousFrame: originalFrame,
          beforeRevision: before,
          afterRevision: liveRevision,
        })),
        boards: [],
      };
    });
    const undoMoveSelection = vi.fn(async (receipt) => {
      const card = receipt.cards[0];
      if (card.afterRevision !== liveRevision) {
        throw { code: "stale_revision", message: { expected: card.afterRevision, actual: liveRevision } };
      }
      liveRevision += 1;
    });
    const gateway = {
      readCard,
      moveSelectionToBoard,
      undoMoveSelection,
    } as unknown as WorkspaceGateway;
    const dispatcher = new CommandDispatcher(gateway);

    await moveSelectionOntoBoard({
      gateway,
      dispatcher,
      idGenerator: new UuidV7Generator(),
      targetBoardId: "board-b",
      leafCards: [noteCard("note-1", 3)],
      portals: [],
    });

    // The move must have entered undo history...
    expect(dispatcher.canUndo()).toBe(true);

    // ...and Cmd+Z must reverse it cleanly, with no stale_revision.
    await expect(dispatcher.undo()).resolves.toBe(true);
    expect(undoMoveSelection).toHaveBeenCalledTimes(1);
  });

  /**
   * todo.md №20: a filesystem_alias (folder shortcut) card dropped onto a
   * board portal reportedly vanished — gone from the source board, missing
   * from the target's Unsorted panel. `moveSelectionOntoBoard` only ever
   * touches `{ id, revision }` (see the `LeafRef` type at the top of
   * move-selection-onto-board.ts) — it has no `kind` field to branch on, so a
   * `filesystem_alias` (or `file`, `image`, `embed`) leaf takes the exact same
   * path as a `note` leaf above. This pins that down for every non-note kind
   * the canvas can drag onto a portal, so a future kind-specific branch cannot
   * silently reintroduce the bug for one kind while the note tests stay green.
   */
  it.each(["image", "embed", "file", "filesystem_alias"] as const)(
    "moves a %s leaf the same way it moves a note leaf",
    async (kind) => {
      const readCard = vi.fn(async () => ({ kind, id: "leaf-1", revision: 3 }));
      const moveSelectionToBoard = vi.fn(async (input: MoveSelectionToBoardInput) => ({
        operationId: "op-kind",
        targetBoardId: input.targetBoardId,
        cards: input.cards.map((c) => ({
          id: c.id,
          previousBoardId: "home",
          previousUnsorted: false,
          previousFrame: { x: 0, y: 0, width: 320, height: 240 },
          beforeRevision: c.expectedRevision,
          afterRevision: c.expectedRevision + 1,
        })),
        boards: [],
      }));
      const gateway = { readCard, moveSelectionToBoard } as unknown as WorkspaceGateway;
      const dispatcher = new CommandDispatcher(gateway);

      const receipt = await moveSelectionOntoBoard({
        gateway,
        dispatcher,
        idGenerator: new UuidV7Generator(),
        targetBoardId: "board-b",
        leafCards: [{ id: "leaf-1", revision: 3 }],
        portals: [],
      });

      expect(receipt.cards.map((c) => c.id)).toEqual(["leaf-1"]);
      expect(receipt.targetBoardId).toBe("board-b");
      expect(moveSelectionToBoard).toHaveBeenCalledTimes(1);
    },
  );
});
