import type {
  AddQuickBoardInput,
  AssetDto,
  BoardSnapshot,
  BoardSummary,
  CardDto,
  ConvertNoteToEmbedInput,
  CopyImageCardsInput,
  CreateChildBoardInput,
  CreateFileCardInput,
  CreateFolderAliasInput,
  CreateImageCardInput,
  CreateNoteInput,
  EmbedCardDto,
  EmptyTrashResult,
  EnrichEmbedMetadataInput,
  DropPathClassificationDto,
  FileCardDto,
  FilesystemAliasDto,
  FolderPreviewDto,
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
  SearchResultDto,
  SetBoardCoverInput,
  SetNoteColorInput,
  TrashEntryDto,
  TrashSelectionInput,
  TrashSummaryDto,
  UpdateEmbedDescriptionInput,
  UpdateImageCaptionInput,
  UpdateNoteInput,
  WorkspaceGateway,
} from "./workspace-gateway";
import { denseBoardSnapshot } from "../test/dense-board-fixture";

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
  private trashBatches = new Map<
    string,
    { cards: CardDto[]; boards: BoardSummary[]; deletedAt: number }
  >();
  private trashSequence = 0;

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
    // Test-only folder-shortcut fixture: a single alias, no other cards.
    if (
      boardId === "home" &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("fixture") === "folder"
    ) {
      const alias: FilesystemAliasDto = {
        kind: "filesystem_alias",
        id: "folder-0",
        boardId: "home",
        frame: { x: 40, y: 40, width: 280, height: 180 },
        zIndex: 0,
        revision: 1,
        targetKind: "folder",
        pathHint: "/Users/me/Research",
        displayName: "Research",
      };
      this.snapshot.cards = [structuredClone(alias)];
      return Promise.resolve({
        board: this.board,
        breadcrumbs: [{ id: "home", title: "Home" }],
        viewport: { x: 0, y: 0, zoom: 1, revision: 1 },
        cards: [structuredClone(alias)],
        unsortedCards: [],
      });
    }
    // Test-only dense fixture activated by a query parameter.
    if (
      boardId === "home" &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("fixture") === "dense"
    ) {
      const snap = denseBoardSnapshot();
      // Keep the mock's in-memory cards in sync so readCard/update/trash work.
      this.snapshot.cards = structuredClone(snap.cards);
      return Promise.resolve(snap);
    }

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
      colorToken: "default",
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
    if (board.revision !== input.expectedBoardRevision) {
      return Promise.reject(
        new Error(
          `stale revision for board ${input.boardId}: expected ${input.expectedBoardRevision}, actual ${board.revision}`,
        ),
      );
    }
    const portal = this.snapshot.cards.find(
      (c) => c.kind === "board_portal" && c.target.id === input.boardId,
    );
    if (!portal || portal.kind !== "board_portal") {
      return Promise.reject(new Error(`portal not found for board: ${input.boardId}`));
    }
    if (portal.revision !== input.expectedPortalRevision) {
      return Promise.reject(
        new Error(
          `stale revision for portal ${portal.id}: expected ${input.expectedPortalRevision}, actual ${portal.revision}`,
        ),
      );
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
    return Promise.resolve(this.moveToTrash(new Set([cardId]), new Set()));
  }

  trashBoard(boardId: string): Promise<string> {
    return Promise.resolve(this.moveToTrash(new Set(), new Set([boardId])));
  }

  restoreTrashBatch(batchId: string): Promise<void> {
    const batch = this.trashBatches.get(batchId);
    if (!batch) return Promise.resolve();
    for (const board of batch.boards) this.boards.set(board.id, structuredClone(board));
    const activeCardIds = new Set(this.snapshot.cards.map((card) => card.id));
    this.snapshot.cards.push(
      ...structuredClone(batch.cards.filter((card) => !activeCardIds.has(card.id))),
    );
    this.trashBatches.delete(batchId);
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

  createFolderAlias(input: CreateFolderAliasInput): Promise<FilesystemAliasDto> {
    const pathParts = input.sourcePath.split("/").filter(Boolean);
    const displayName = pathParts[pathParts.length - 1] ?? input.sourcePath;
    const card: FilesystemAliasDto = {
      kind: "filesystem_alias",
      id: input.id,
      boardId: input.boardId,
      frame: { ...input.frame },
      zIndex: input.zIndex,
      revision: 1,
      targetKind: "folder",
      pathHint: input.sourcePath,
      displayName,
    };
    this.snapshot.cards.push(card);
    return Promise.resolve(structuredClone(card));
  }

  listFolderPreview(cardId: string, limit: number): Promise<FolderPreviewDto> {
    const card = this.snapshot.cards.find(
      (candidate): candidate is FilesystemAliasDto =>
        candidate.kind === "filesystem_alias" && candidate.id === cardId,
    );
    if (!card) return Promise.reject(new Error(`folder alias not found: ${cardId}`));

    const status = card.pathHint.endsWith("/empty")
      ? "empty"
      : card.pathHint.endsWith("/missing")
        ? "missing"
        : card.pathHint.endsWith("/permission-lost")
          ? "permission_lost"
          : card.pathHint.endsWith("/io-error")
            ? "io_error"
            : "ready";
    const entries = status === "ready"
      ? [
          { name: "Footage", kind: "folder" as const, sizeBytes: null, childCount: 6 },
          { name: "script-v3.md", kind: "file" as const, sizeBytes: 18_432, childCount: null },
          { name: "shots.csv", kind: "file" as const, sizeBytes: 43_008, childCount: null },
          { name: "intro.mov", kind: "file" as const, sizeBytes: 1_932_735_283, childCount: null },
        ].slice(0, Math.max(0, Math.min(limit, 50)))
      : [];
    return Promise.resolve({
      status,
      entries,
      hasMore: false,
      displayName: card.displayName,
      pathHint: card.pathHint,
    });
  }

  classifyDropPaths(paths: string[]): Promise<DropPathClassificationDto[]> {
    return Promise.resolve(paths.map((path) => {
      const pathParts = path.split("/").filter(Boolean);
      const fileName = pathParts[pathParts.length - 1] ?? path;
      const nameParts = fileName.split(".");
      const extension = fileName.includes(".") ? nameParts[nameParts.length - 1]?.toLowerCase() ?? "" : "";
      const imageMimeTypes: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        heic: "image/heic",
      };
      if (!extension) return { path, kind: "folder", fileName, mimeType: null };
      if (imageMimeTypes[extension]) {
        return { path, kind: "image", fileName, mimeType: imageMimeTypes[extension] };
      }
      return { path, kind: "unsupported", fileName, mimeType: null };
    }));
  }

  openFolderInFinder(cardId: string): Promise<void> {
    const card = this.snapshot.cards.find(
      (candidate) => candidate.kind === "filesystem_alias" && candidate.id === cardId,
    );
    return card ? Promise.resolve() : Promise.reject(new Error(`folder alias not found: ${cardId}`));
  }

  async createFileCard(input: CreateFileCardInput): Promise<FileCardDto> {
    const fileName = input.fileName.split("/").pop() ?? input.fileName;
    const card: FileCardDto = {
      kind: "file",
      id: input.id,
      boardId: input.boardId,
      frame: { ...input.frame },
      zIndex: input.zIndex,
      revision: 1,
      asset: {
        id: `asset-${input.id}`,
        fileName,
        mimeType: input.mimeType,
        width: null,
        height: null,
        sizeBytes: 0,
        filePath: `${input.id}.${fileName.split(".").pop() ?? "bin"}`,
      },
      previewText: "mock preview of " + fileName,
      previewAsset: null,
    };
    this.snapshot.cards.push(card);
    return Promise.resolve(structuredClone(card));
  }

  openFileCard(cardId: string): Promise<void> {
    const card = this.snapshot.cards.find(
      (candidate) => candidate.kind === "file" && candidate.id === cardId,
    );
    return card ? Promise.resolve() : Promise.reject(new Error(`file card not found: ${cardId}`));
  }

  revealFileCard(cardId: string): Promise<void> {
    const card = this.snapshot.cards.find(
      (candidate) => candidate.kind === "file" && candidate.id === cardId,
    );
    return card ? Promise.resolve() : Promise.reject(new Error(`file card not found: ${cardId}`));
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
    const cardIds = new Set(
      input.items.filter((item) => item.kind !== "board_portal").map((item) => item.id),
    );
    const boardIds = new Set(
      input.items.filter((item) => item.kind === "board_portal").map((item) => item.id),
    );
    return Promise.resolve(this.moveToTrash(cardIds, boardIds));
  }

  listTrash(): Promise<TrashSummaryDto> {
    const batches = [...this.trashBatches.entries()].map(([batchId, batch]) => {
      const boardIds = new Set(batch.boards.map((board) => board.id));

      const boardItems: TrashEntryDto[] = batch.boards
        .filter((board) => !board.parentBoardId || !boardIds.has(board.parentBoardId))
        .map((board) => ({
          id: board.id,
          kind: "board" as const,
          title: board.title,
          thumbnailAsset: board.coverAsset ?? null,
          colorToken: board.colorToken,
          symbol: board.symbol,
        }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

      const cardItems: TrashEntryDto[] = batch.cards
        .filter((card) => card.kind !== "board_portal" && !boardIds.has(card.boardId))
        .map((card) => ({
          id: card.id,
          kind: card.kind as TrashEntryDto["kind"],
          title: cardTitle(card),
          thumbnailAsset: cardThumbnail(card),
          colorToken: null,
          symbol: null,
        }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

      return {
        batchId,
        deletedAt: batch.deletedAt,
        items: [...boardItems, ...cardItems],
        boardCount: batch.boards.length,
        cardCount: batch.cards.length,
      };
    });

    batches.sort((a, b) => b.deletedAt - a.deletedAt || b.batchId.localeCompare(a.batchId));

    return Promise.resolve({
      batches,
      batchCount: batches.length,
      boardCount: batches.reduce((sum, batch) => sum + batch.boardCount, 0),
      cardCount: batches.reduce((sum, batch) => sum + batch.cardCount, 0),
    });
  }

  emptyTrash(confirmation: string): Promise<EmptyTrashResult> {
    if (confirmation !== "EMPTY") {
      return Promise.reject(new Error("type EMPTY to confirm"));
    }
    let boardCount = 0;
    let cardCount = 0;
    for (const batch of this.trashBatches.values()) {
      boardCount += batch.boards.length;
      cardCount += batch.cards.length;
    }
    this.trashBatches.clear();
    return Promise.resolve({ boardCount, cardCount, orphanAssetCount: 0 });
  }

  searchWorkspace(query: string): Promise<SearchResultDto[]> {
    const q = query.trim().toLowerCase();
    if (!q) return Promise.resolve([]);

    const identity = (boardId: string) => {
      const board = this.boards.get(boardId);
      return {
        boardColorToken: board?.colorToken ?? "ink",
        boardSymbol: board?.symbol ?? null,
        boardCoverAsset: board?.coverAsset ?? null,
      };
    };

    const hits: Array<{ rank: number; result: SearchResultDto }> = [];

    // Boards by title.
    for (const board of this.boards.values()) {
      if (board.title.toLowerCase().includes(q)) {
        hits.push({
          rank: 0,
          result: {
            entityId: board.id,
            kind: "board",
            title: board.title,
            excerpt: null,
            boardId: board.id,
            boardTrail: this.buildBreadcrumbs(board.id),
            ...identity(board.id),
            thumbnailAsset: board.coverAsset ?? null,
            createdAt: Date.now(),
          },
        });
      }
    }

    for (const card of this.snapshot.cards) {
      if (card.kind === "note" && card.plainText.toLowerCase().includes(q)) {
        hits.push({
          rank: 1,
          result: {
            entityId: card.id,
            kind: "note",
            title: card.plainText.trim(),
            excerpt: null,
            boardId: card.boardId,
            boardTrail: this.buildBreadcrumbs(card.boardId),
            ...identity(card.boardId),
            thumbnailAsset: null,
            createdAt: Date.now(),
          },
        });
      }
      if (card.kind === "image") {
        const captionMatch = card.captionPlainText.toLowerCase().includes(q);
        const fileMatch = card.asset.fileName.toLowerCase().includes(q);
        if (captionMatch || fileMatch) {
          hits.push({
            rank: 1,
            result: {
              entityId: card.id,
              kind: "image",
              title: card.captionPlainText.trim() || card.asset.fileName,
              excerpt: null,
              boardId: card.boardId,
              boardTrail: this.buildBreadcrumbs(card.boardId),
              ...identity(card.boardId),
              thumbnailAsset: card.asset,
              createdAt: Date.now(),
            },
          });
        }
      }
      if (card.kind === "embed") {
        const titleMatch = card.title.toLowerCase().includes(q);
        const urlMatch =
          card.sourceUrl.toLowerCase().includes(q) || card.displayUrl.toLowerCase().includes(q);
        const descMatch = card.descriptionPlainText.toLowerCase().includes(q);
        if (titleMatch || urlMatch || descMatch) {
          hits.push({
            rank: titleMatch || urlMatch ? 0 : 2,
            result: {
              entityId: card.id,
              kind: "link",
              title: card.title || card.sourceUrl,
              excerpt: titleMatch || urlMatch ? null : card.descriptionPlainText.trim(),
              boardId: card.boardId,
              boardTrail: this.buildBreadcrumbs(card.boardId),
              ...identity(card.boardId),
              thumbnailAsset: card.previewAsset ?? card.faviconAsset,
              createdAt: Date.now(),
            },
          });
        }
      }
      if (card.kind === "filesystem_alias") {
        const nameMatch = card.displayName.toLowerCase().includes(q);
        const pathMatch = card.pathHint.toLowerCase().includes(q);
        if (nameMatch || pathMatch) {
          hits.push({
            rank: nameMatch ? 0 : 1,
            result: {
              entityId: card.id,
              kind: "folder",
              title: card.displayName,
              excerpt: nameMatch ? null : card.pathHint,
              boardId: card.boardId,
              boardTrail: this.buildBreadcrumbs(card.boardId),
              ...identity(card.boardId),
              thumbnailAsset: null,
              createdAt: Date.now(),
            },
          });
        }
      }
      if (card.kind === "file") {
        const nameMatch = card.asset.fileName.toLowerCase().includes(q);
        if (nameMatch) {
          hits.push({
            rank: 1,
            result: {
              entityId: card.id,
              kind: "file",
              title: card.asset.fileName,
              excerpt: null,
              boardId: card.boardId,
              boardTrail: this.buildBreadcrumbs(card.boardId),
              ...identity(card.boardId),
              thumbnailAsset: null,
              createdAt: Date.now(),
            },
          });
        }
      }
    }

    hits.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.result.title.toLowerCase().localeCompare(b.result.title.toLowerCase()) ||
        a.result.entityId.localeCompare(b.result.entityId),
    );

    return Promise.resolve(hits.slice(0, 50).map((hit) => hit.result));
  }

  private moveToTrash(cardIds: Set<string>, boardIds: Set<string>): string {
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const board of this.boards.values()) {
        if (board.parentBoardId && boardIds.has(board.parentBoardId) && !boardIds.has(board.id)) {
          boardIds.add(board.id);
          foundDescendant = true;
        }
      }
    }

    const removedBoards = [...this.boards.values()].filter((board) => boardIds.has(board.id));
    const removedCards = this.snapshot.cards.filter(
      (card) =>
        cardIds.has(card.id) ||
        boardIds.has(card.boardId) ||
        (card.kind === "board_portal" && boardIds.has(card.target.id)),
    );
    for (const board of removedBoards) this.boards.delete(board.id);
    const removedCardIds = new Set(removedCards.map((card) => card.id));
    this.snapshot.cards = this.snapshot.cards.filter((card) => !removedCardIds.has(card.id));

    const batchId = `batch-${++this.trashSequence}`;
    this.trashBatches.set(batchId, {
      cards: structuredClone(removedCards),
      boards: structuredClone(removedBoards),
      deletedAt: Date.now(),
    });
    return batchId;
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

  setNoteColor(input: SetNoteColorInput): Promise<void> {
    const card = this.snapshot.cards.find(
      (c): c is Extract<(typeof this.snapshot.cards)[number], { kind: "note" }> =>
        c.kind === "note" && c.id === input.id,
    );
    if (!card) return Promise.reject(new Error(`note not found: ${input.id}`));
    card.colorToken = input.colorToken;
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
  // Atomic mixed-selection move (ADR-0007). The backend performs this in one
  // transaction; the mock validates every member before mutating anything, so the
  // browser mode and e2e observe the same all-or-nothing outcome.
  moveSelectionToBoard(
    input: import("./workspace-gateway").MoveSelectionToBoardInput,
  ): Promise<import("./workspace-gateway").MoveSelectionToBoardReceipt> {
    try {
      if (input.cards.length === 0 && input.boards.length === 0) {
        throw new Error("the selection is empty; nothing to move");
      }
      const ids = [...input.cards.map((c) => c.id), ...input.boards.map((b) => b.boardId)];
      if (new Set(ids).size !== ids.length) {
        throw new Error("duplicate selection id");
      }
      if (!this.boards.has(input.targetBoardId)) {
        throw new Error(`board not found: ${input.targetBoardId}`);
      }

      const cards = input.cards.map((item) => {
        const card = this.snapshot.cards.find((c) => c.id === item.id);
        if (!card) throw new Error(`card not found: ${item.id}`);
        if (card.kind === "board_portal") {
          throw new Error(`board portal ${item.id} must be moved as a board`);
        }
        if (card.revision !== item.expectedRevision) {
          throw new Error(`stale revision for ${item.id}`);
        }
        return card;
      });

      const boards = input.boards.map((item) => {
        const board = this.boards.get(item.boardId);
        if (!board) throw new Error(`board not found: ${item.boardId}`);
        if (board.id === input.targetBoardId) {
          throw new Error("the selection contains the destination board");
        }
        if (board.revision !== item.expectedBoardRevision) {
          throw new Error(`stale revision for board ${item.boardId}`);
        }
        const portal = this.snapshot.cards.find(
          (c) => c.kind === "board_portal" && c.target.id === item.boardId,
        );
        if (!portal || portal.kind !== "board_portal") {
          throw new Error(`portal not found for board: ${item.boardId}`);
        }
        if (portal.revision !== item.expectedPortalRevision) {
          throw new Error(`stale revision for portal ${portal.id}`);
        }
        return { board, portal };
      });

      const receiptCards = cards.map((card) => ({
        id: card.id,
        previousBoardId: card.boardId,
        previousUnsorted: Boolean((card as { unsorted?: boolean }).unsorted),
        previousFrame: { ...card.frame },
        beforeRevision: card.revision,
        afterRevision: card.revision + 1,
      }));

      const targetCards = this.snapshot.cards.filter((c) => c.boardId === input.targetBoardId);
      const bottom = targetCards.reduce((max, c) => Math.max(max, c.frame.y + c.frame.height), 0);
      let cursor = bottom <= 0 ? 40 : bottom + 24;
      const receiptBoards = boards.map(({ board, portal }) => {
        const frame = { x: 40, y: cursor, width: portal.frame.width, height: portal.frame.height };
        cursor += portal.frame.height + 24;
        return {
          boardId: board.id,
          portalCardId: portal.id,
          previousParentBoardId: board.parentBoardId ?? "",
          previousPortalFrame: { ...portal.frame },
          destinationPortalFrame: frame,
          beforeBoardRevision: board.revision,
          afterBoardRevision: board.revision + 1,
          beforePortalRevision: portal.revision,
          afterPortalRevision: portal.revision + 1,
        };
      });

      cards.forEach((card, index) => {
        card.revision = receiptCards[index].afterRevision;
        card.boardId = input.targetBoardId;
        (card as { unsorted?: boolean }).unsorted = true;
      });
      boards.forEach(({ board, portal }, index) => {
        const receipt = receiptBoards[index];
        board.parentBoardId = input.targetBoardId;
        board.revision = receipt.afterBoardRevision;
        portal.boardId = input.targetBoardId;
        portal.frame = { ...receipt.destinationPortalFrame };
        portal.revision = receipt.afterPortalRevision;
      });

      return Promise.resolve({
        operationId: `mock-move-${Date.now()}`,
        targetBoardId: input.targetBoardId,
        cards: receiptCards,
        boards: receiptBoards,
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  undoMoveSelection(
    receipt: import("./workspace-gateway").MoveSelectionToBoardReceipt,
  ): Promise<void> {
    try {
      for (const entry of receipt.cards) {
        const card = this.snapshot.cards.find((c) => c.id === entry.id);
        if (!card) throw new Error(`card not found: ${entry.id}`);
        if (card.revision !== entry.afterRevision) {
          throw new Error(`stale revision for ${entry.id}`);
        }
      }
      for (const entry of receipt.boards) {
        const board = this.boards.get(entry.boardId);
        const portal = this.snapshot.cards.find((c) => c.id === entry.portalCardId);
        if (!board || !portal) throw new Error(`board not found: ${entry.boardId}`);
        if (
          board.revision !== entry.afterBoardRevision ||
          portal.revision !== entry.afterPortalRevision
        ) {
          throw new Error(`stale revision for board ${entry.boardId}`);
        }
      }
      for (const entry of receipt.cards) {
        const card = this.snapshot.cards.find((c) => c.id === entry.id)!;
        card.boardId = entry.previousBoardId;
        (card as { unsorted?: boolean }).unsorted = entry.previousUnsorted;
        card.frame = { ...entry.previousFrame };
        card.revision = entry.afterRevision + 1;
      }
      for (const entry of receipt.boards) {
        const board = this.boards.get(entry.boardId)!;
        const portal = this.snapshot.cards.find((c) => c.id === entry.portalCardId)!;
        board.parentBoardId = entry.previousParentBoardId;
        board.revision = entry.afterBoardRevision + 1;
        portal.boardId = entry.previousParentBoardId;
        portal.frame = { ...entry.previousPortalFrame };
        portal.revision = entry.afterPortalRevision + 1;
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
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

function cardTitle(card: CardDto): string {
  switch (card.kind) {
    case "note":
      return card.plainText || "";
    case "image":
      return card.captionPlainText || card.asset.fileName || "";
    case "embed":
      return card.title || card.sourceUrl || "";
    case "filesystem_alias":
      return card.displayName;
    case "file":
      return card.asset.fileName;
    default:
      return "";
  }
}

function cardThumbnail(card: CardDto): AssetDto | null {
  switch (card.kind) {
    case "image":
      return card.asset;
    case "embed":
      return card.previewAsset ?? card.faviconAsset;
    case "filesystem_alias":
      return null;
    case "file":
      return null;
    default:
      return null;
  }
}
