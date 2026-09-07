import type {
  AddQuickBoardInput,
  AssetDto,
  BoardSnapshot,
  BoardSummary,
  CardDto,
  ConvertNoteToEmbedInput,
  CopyImageCardsInput,
  CreateChildBoardInput,
  CreateImageCardInput,
  CreateNoteInput,
  EmbedCardDto,
  EnrichEmbedMetadataInput,
  ImportAssetInput,
  MoveBoardInput,
  MoveCardInput,
  MoveCardsInput,
  MoveCardToBoardInput,
  MoveCardsToUnsortedInput,
  PlaceUnsortedCardInput,
  QuickBoardDto,
  ReorderQuickBoardsInput,
  SaveViewportInput,
  SetBoardCoverInput,
  TrashSelectionInput,
  UpdateEmbedDescriptionInput,
  UpdateImageCaptionInput,
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
    colorToken: "ink",
    symbol: null,
    coverAsset: null,
  };
  private boards = new Map<string, BoardSummary>([[this.board.id, this.board]]);

  private snapshot: BoardSnapshot = {
    board: this.board,
    breadcrumbs: [{ id: "home", title: "Home" }],
    viewport: { x: 0, y: 0, zoom: 1, revision: 1 },
    cards: [],
    unsortedCards: [],
  };

  private quickBoards: QuickBoardDto[] = [];

  private dataVersion = 0;

  getHomeBoard(): Promise<BoardSummary> {
    return Promise.resolve({ ...this.board });
  }

  getDataVersion(): Promise<number> {
    return Promise.resolve(this.dataVersion);
  }

  readCard(cardId: string): Promise<CardDto> {
    const card = this.snapshot.cards.find((c) => c.id === cardId);
    if (!card) return Promise.reject(new Error(`card not found: ${cardId}`));
    return Promise.resolve({ ...card });
  }

  loadBoardSnapshot(boardId: string): Promise<BoardSnapshot> {
    const board = this.boards.get(boardId);
    if (!board) {
      return Promise.reject(new Error(`boarding not found: ${boardId}`));
    }

    return Promise.resolve({
      board: { ...board },
      breadcrumbs: this.buildBreadcrumbs(boardId),
      viewport:
        boardId === this.board.id
          ? structuredClone(this.snapshot.viewport)
          : { x: 0, y: 0, zoom: 1, revision: 1 },
      cards: structuredClone(
        this.snapshot.cards.filter(
          (card) => card.boardId === boardId && !(card as { unsorted?: boolean }).unsorted,
        ),
      ),
      unsortedCards: structuredClone(
        this.snapshot.cards.filter(
          (card) => card.boardId === boardId && (card as { unsorted?: boolean }).unsorted,
        ),
      ),
    });
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

  moveCards(input: MoveCardsInput): Promise<void> {
    for (const item of input.cards) {
      const card = this.snapshot.cards.find((c) => c.id === item.id);
      if (!card) {
        return Promise.reject(new Error(`card not found: ${item.id}`));
      }
      if (card.revision !== item.expectedRevision) {
        return Promise.reject(new Error(`stale revision for ${item.id}`));
      }
    }
    for (const item of input.cards) {
      const card = this.snapshot.cards.find((c) => c.id === item.id)!;
      card.revision += 1;
      card.frame = { ...item.frame };
    }
    return Promise.resolve();
  }

  moveCardToBoard(input: MoveCardToBoardInput): Promise<void> {
    const card = this.snapshot.cards.find((c) => c.id === input.id);
    if (!card) {
      return Promise.reject(new Error(`card not found: ${input.id}`));
    }
    if (card.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }
    card.revision += 1;
    card.boardId = input.targetBoardId;
    card.frame = input.frame
      ? { ...card.frame, x: input.frame.x, y: input.frame.y }
      : { ...card.frame, x: 40, y: 40 };
    return Promise.resolve();
  }

  moveBoard(input: MoveBoardInput): Promise<void> {
    const board = this.boards.get(input.boardId);
    if (!board) {
      return Promise.reject(new Error(`board not found: ${input.boardId}`));
    }
    const portal = this.snapshot.cards.find(
      (c) => c.kind === "board_portal" && c.target.id === input.boardId,
    );
    if (!portal || portal.kind !== "board_portal") {
      return Promise.reject(new Error(`portal not found for board: ${input.boardId}`));
    }
    board.parentBoardId = input.targetParentBoardId;
    board.revision += 1;
    portal.boardId = input.targetParentBoardId;
    portal.frame = { ...input.frame };
    portal.revision += 1;
    if (portal.target.id === input.boardId) {
      portal.target.boardRevision = board.revision;
    }
    return Promise.resolve();
  }

  saveViewport(input: SaveViewportInput): Promise<void> {
    if (this.snapshot.viewport.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for viewport`));
    }
    this.snapshot.viewport = {
      x: input.x,
      y: input.y,
      zoom: input.zoom,
      revision: this.snapshot.viewport.revision + 1,
    };
    return Promise.resolve();
  }

  createChildBoard(input: CreateChildBoardInput): Promise<void> {
    const childBoard: BoardSummary = {
      id: input.boardId,
      title: input.title,
      parentBoardId: input.parentBoardId,
      revision: 1,
      colorToken: "terracotta",
      symbol: null,
      coverAsset: null,
    };
    this.boards.set(childBoard.id, childBoard);

    const portal = {
      kind: "board_portal" as const,
      id: input.portalCardId,
      boardId: input.parentBoardId,
      frame: { ...input.frame },
      zIndex: 0,
      revision: 1,
      target: {
        id: input.boardId,
        boardRevision: 1,
        title: input.title,
        colorToken: "terracotta",
        symbol: null,
        childBoardCount: 0,
        childCardCount: 0,
        coverAsset: null,
      },
    };
    this.snapshot.cards.push(portal);
    return Promise.resolve();
  }

  renameBoard(boardId: string, title: string): Promise<void> {
    const board = this.boards.get(boardId);
    if (board) {
      board.title = title;
      board.revision += 1;
    }
    const portal = this.snapshot.cards.find(
      (c) => c.kind === "board_portal" && c.target.id === boardId,
    );
    if (portal && portal.kind === "board_portal") {
      portal.target.title = title;
    }
    return Promise.resolve();
  }

  trashNote(cardId: string): Promise<string> {
    const i = this.snapshot.cards.findIndex((c) => c.id === cardId);
    if (i >= 0) this.snapshot.cards.splice(i, 1);
    return Promise.resolve("batch-" + cardId);
  }

  trashBoard(boardId: string): Promise<string> {
    const batchId = "batch-" + boardId;
    this.boards.delete(boardId);
    this.snapshot.cards = this.snapshot.cards.filter(
      (c) => c.boardId !== boardId && !(c.kind === "board_portal" && c.target.id === boardId),
    );
    return Promise.resolve(batchId);
  }

  restoreTrashBatch(batchId: string): Promise<void> {
    void batchId;
    return Promise.resolve();
  }

  importAsset(input: ImportAssetInput): Promise<AssetDto> {
    const asset: AssetDto = {
      id: input.id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      width: null,
      height: null,
      sizeBytes: 0,
      filePath: `${input.id}.bin`,
    };
    return Promise.resolve(asset);
  }

  resolveAssetPath(assetId: string): Promise<string> {
    return Promise.resolve(`/tmp/mock-assets/${assetId}.bin`);
  }

  createImageCard(input: CreateImageCardInput): Promise<void> {
    const card = {
      kind: "image" as const,
      id: input.id,
      boardId: input.boardId,
      frame: { ...input.frame },
      zIndex: input.zIndex,
      revision: 1,
      asset: {
        id: input.assetId,
        fileName: "",
        mimeType: "",
        width: null,
        height: null,
        sizeBytes: 0,
        filePath: `${input.assetId}.bin`,
      },
      captionJson: input.captionJson,
      captionPlainText: input.captionPlainText,
    };
    this.snapshot.cards.push(card);
    return Promise.resolve();
  }

  updateImageCaption(input: UpdateImageCaptionInput): Promise<void> {
    const card = this.snapshot.cards.find(
      (c) => c.kind === "image" && c.id === input.id,
    );
    if (!card || card.kind !== "image") {
      return Promise.reject(new Error(`image not found: ${input.id}`));
    }
    if (card.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }
    card.revision += 1;
    card.captionJson = input.captionJson;
    card.captionPlainText = input.captionPlainText;
    return Promise.resolve();
  }

  updateEmbedDescription(input: UpdateEmbedDescriptionInput): Promise<void> {
    const card = this.snapshot.cards.find(
      (c) => c.kind === "embed" && c.id === input.id,
    );
    if (!card || card.kind !== "embed") {
      return Promise.reject(new Error(`embed not found: ${input.id}`));
    }
    if (card.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }
    card.revision += 1;
    card.descriptionJson = input.descriptionJson;
    card.descriptionPlainText = input.descriptionPlainText;
    return Promise.resolve();
  }

  convertNoteToEmbed(input: ConvertNoteToEmbedInput): Promise<EmbedCardDto> {
    const i = this.snapshot.cards.findIndex(
      (c) => c.kind === "note" && c.id === input.id,
    );
    if (i < 0) {
      return Promise.reject(new Error(`note not found: ${input.id}`));
    }
    const note = this.snapshot.cards[i] as Extract<
      (typeof this.snapshot.cards)[number],
      { kind: "note" }
    >;
    if (note.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }
    const embed: EmbedCardDto = {
      kind: "embed",
      id: input.id,
      boardId: note.boardId,
      frame: { ...note.frame },
      zIndex: note.zIndex,
      revision: note.revision + 1,
      sourceUrl: input.sourceUrl,
      displayUrl: input.displayUrl,
      siteName: null,
      title: input.title,
      provider: null,
      descriptionJson: input.descriptionJson,
      descriptionPlainText: input.descriptionPlainText,
      descriptionOrigin: input.descriptionPlainText ? "user" : null,
      faviconAsset: null,
      previewAsset: null,
      previewOrigin: null,
      metadataStatus: "pending",
      metadataError: null,
    };
    this.snapshot.cards[i] = embed;
    return Promise.resolve(embed);
  }

  enrichEmbedMetadata(input: EnrichEmbedMetadataInput): Promise<EmbedCardDto> {
    const card = this.snapshot.cards.find(
      (candidate): candidate is EmbedCardDto => candidate.kind === "embed" && candidate.id === input.id,
    );
    if (!card) return Promise.reject(new Error(`embed not found: ${input.id}`));
    if (card.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }

    const host = new URL(card.sourceUrl).hostname.replace(/^www\./, "");
    card.revision += 1;
    card.siteName = host;
    card.title = `Preview for ${host}`;
    // A user-authored comment is authoritative; only fill a site description
    // when the field is empty (mirrors the Rust enrichment rule).
    if (!card.descriptionPlainText) {
      card.descriptionPlainText = `Link preview for ${host}`;
      card.descriptionOrigin = "site";
    }
    card.descriptionJson = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: card.descriptionPlainText }] }],
    };
    card.metadataStatus = "ready";
    card.metadataError = null;
    return Promise.resolve({ ...card });
  }

  trashSelection(input: TrashSelectionInput): Promise<string> {
    const ids = new Set(input.items.map((i) => i.id));
    for (const item of input.items) {
      if (item.kind === "board_portal") {
        this.boards.delete(item.id);
      }
    }
    this.snapshot.cards = this.snapshot.cards.filter((c) => !ids.has(c.id) && !(c.kind === "board_portal" && ids.has(c.target.id)));
    return Promise.resolve("batch");
  }

  listQuickBoards(): Promise<QuickBoardDto[]> {
    // Only return references to active (still-existing) boards.
    return Promise.resolve(
      this.quickBoards
        .filter((q) => this.boards.has(q.boardId))
        .map((q) => ({ ...q })),
    );
  }

  addQuickBoard(input: AddQuickBoardInput): Promise<void> {
    const board = this.boards.get(input.boardId);
    if (!board) return Promise.reject(new Error(`board not found: ${input.boardId}`));
    if (board.id === this.board.id) {
      // Home is never pinnable (mirrors RootBoardProtected).
      return Promise.reject(new Error("root board is protected"));
    }
    if (!this.quickBoards.some((q) => q.boardId === input.boardId)) {
      const colorToken = "terracotta";
      this.quickBoards.push({
        boardId: input.boardId,
        title: board.title,
        colorToken,
        symbol: null,
        sortOrder: this.quickBoards.length,
        coverAsset: null,
      });
    }
    return Promise.resolve();
  }

  removeQuickBoard(boardId: string): Promise<void> {
    this.quickBoards = this.quickBoards.filter((q) => q.boardId !== boardId);
    this.quickBoards.forEach((q, i) => {
      q.sortOrder = i;
    });
    return Promise.resolve();
  }

  reorderQuickBoards(input: ReorderQuickBoardsInput): Promise<void> {
    if (input.boardIds.length !== this.quickBoards.length) {
      return Promise.reject(new Error("reorder must include every pinned board exactly once"));
    }
    const byId = new Map(this.quickBoards.map((q) => [q.boardId, q]));
    const next: QuickBoardDto[] = [];
    for (const id of input.boardIds) {
      const q = byId.get(id);
      if (!q) return Promise.reject(new Error(`board not found: ${id}`));
      next.push({ ...q, sortOrder: next.length });
    }
    this.quickBoards = next;
    return Promise.resolve();
  }

  copyImageCards(input: CopyImageCardsInput): Promise<void> {
    void input;
    // Browser/tests have no pasteboard; succeed as a no-op (no-op parity with
    // the real command path, which only fails on missing assets/macOS).
    return Promise.resolve();
  }

  importClipboardImage(): Promise<AssetDto> {
    const id = `clip-${this.dataVersion++}`;
    return Promise.resolve({
      id,
      fileName: "clipboard.png",
      mimeType: "image/png",
      width: null,
      height: null,
      sizeBytes: 0,
      filePath: `${id}.png`,
    });
  }

  setBoardCover(input: SetBoardCoverInput): Promise<void> {
    const portal = this.snapshot.cards.find(
      (c): c is Extract<(typeof this.snapshot.cards)[number], { kind: "board_portal" }> =>
        c.kind === "board_portal" && c.target.id === input.boardId,
    );
    if (!portal) return Promise.reject(new Error(`board not found: ${input.boardId}`));
    portal.target.coverAsset = {
      id: input.assetId,
      fileName: "cover.png",
      mimeType: "image/png",
      width: null,
      height: null,
      sizeBytes: 0,
      filePath: `${input.assetId}.png`,
    };
    return Promise.resolve();
  }

  removeBoardCover(boardId: string): Promise<void> {
    const portal = this.snapshot.cards.find(
      (c): c is Extract<(typeof this.snapshot.cards)[number], { kind: "board_portal" }> =>
        c.kind === "board_portal" && c.target.id === boardId,
    );
    if (portal) portal.target.coverAsset = null;
    return Promise.resolve();
  }

  moveCardsToBoardUnsorted(input: MoveCardsToUnsortedInput): Promise<void> {
    for (const item of input.cards) {
      const card = this.snapshot.cards.find((c) => c.id === item.id);
      if (!card) return Promise.reject(new Error(`card not found: ${item.id}`));
      if (card.revision !== item.expectedRevision) {
        return Promise.reject(new Error(`stale revision for ${item.id}`));
      }
    }
    for (const item of input.cards) {
      const card = this.snapshot.cards.find((c) => c.id === item.id)!;
      card.revision += 1;
      card.boardId = input.targetBoardId;
      // Unsorted cards are hidden from the canvas; the rail shows them.
      (card as { unsorted?: boolean }).unsorted = true;
    }
    return Promise.resolve();
  }

  placeUnsortedCard(input: PlaceUnsortedCardInput): Promise<void> {
    const card = this.snapshot.cards.find((c) => c.id === input.id);
    if (!card) return Promise.reject(new Error(`card not found: ${input.id}`));
    if (card.revision !== input.expectedRevision) {
      return Promise.reject(new Error(`stale revision for ${input.id}`));
    }
    card.revision += 1;
    (card as { unsorted?: boolean }).unsorted = false;
    card.frame = { ...input.frame };
    return Promise.resolve();
  }

  private buildBreadcrumbs(boardId: string) {
    const crumbs: Array<{ id: string; title: string }> = [];
    let current = this.boards.get(boardId) ?? null;

    while (current) {
      crumbs.unshift({ id: current.id, title: current.title });
      current = current.parentBoardId ? this.boards.get(current.parentBoardId) ?? null : null;
    }

    return crumbs;
  }
}
