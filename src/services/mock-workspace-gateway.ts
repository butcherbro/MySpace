import type {
  BoardSnapshot,
  BoardSummary,
  CreateNoteInput,
  MoveCardInput,
  UpdateNoteInput,
  WorkspaceGateway,
} from "./workspace-gateway";

/**
 * In-memory gateway for browser-mode tests and fixtures. It keeps a single
 * Home board and persists notes only for the lifetime of the instance.
 */
export class MockWorkspaceGateway implements WorkspaceGateway {
  private board: BoardSummary = {
    id: "home",
    title: "Home",
    parentBoardId: null,
    revision: 1,
  };

  private snapshot: BoardSnapshot = {
    board: this.board,
    breadcrumbs: [{ id: "home", title: "Home" }],
    viewport: { x: 0, y: 0, zoom: 1, revision: 1 },
    cards: [],
  };

  getHomeBoard(): Promise<BoardSummary> {
    return Promise.resolve({ ...this.board });
  }

  loadBoardSnapshot(boardId: string): Promise<BoardSnapshot> {
    if (boardId !== this.board.id) {
      return Promise.reject(new Error(`boarding not found: ${boardId}`));
    }
    return Promise.resolve(structuredClone(this.snapshot));
  }

  createNote(input: CreateNoteInput): Promise<void> {
    const card = {
      kind: "note" as const,
      id: input.id,
      boardId: input.boardId,
      frame: { ...input.frame },
      zIndex: input.zIndex,
      revision: 1,
      documentJson: input.documentJson,
      plainText: input.plainText,
    };
    this.snapshot.cards.push(card);
    return Promise.resolve();
  }

  updateNote(input: UpdateNoteInput): Promise<void> {
    const card = this.snapshot.cards.find(
      (c) => c.kind === "note" && c.id === input.id,
    );
    if (!card || card.kind !== "note") {
      return Promise.reject(new Error(`note not found: ${input.id}`));
    }
    if (card.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }
    card.revision += 1;
    card.documentJson = input.documentJson;
    card.plainText = input.plainText;
    return Promise.resolve();
  }

  moveCard(input: MoveCardInput): Promise<void> {
    const card = this.snapshot.cards.find((c) => c.id === input.id);
    if (!card) {
      return Promise.reject(new Error(`card not found: ${input.id}`));
    }
    if (card.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }
    card.revision += 1;
    card.frame = { ...input.frame };
    return Promise.resolve();
  }
}
