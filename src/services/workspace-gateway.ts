// Type definitions for the workspace gateway. These mirror the Rust domain
// DTOs (camelCase) so the frontend never deals with snake_case or Tauri
// internals directly.

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardSummary {
  id: string;
  title: string;
  parentBoardId: string | null;
  revision: number;
  /** Visual identity: color/symbol fallback or a cover image. */
  colorToken: string;
  symbol: string | null;
  coverAsset: AssetDto | null;
}

export interface Breadcrumb {
  id: string;
  title: string;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
  revision: number;
}

/**
 * A Quick Board reference: a stable, ordered, workspace-scoped pointer to a
 * (non-Home) Board. Not a tab, portal, copy, or move.
 */
export interface QuickBoardDto {
  boardId: string;
  title: string;
  colorToken: string;
  symbol: string | null;
  sortOrder: number;
  /** Optional cover image, so a pinned chip mirrors the portal tile. */
  coverAsset: AssetDto | null;
}

export interface NoteCardDto {
  kind: "note";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  documentJson: unknown;
  plainText: string;
  /** Semantic background-color preset id (`default`, `yellow`, …). */
  colorToken: string;
}

export interface BoardPortalDto {
  kind: "board_portal";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  target: {
    id: string;
    boardRevision: number;
    title: string;
    colorToken: string;
    symbol: string | null;
    childBoardCount: number;
    childCardCount: number;
    /** Optional cover image replacing the color/symbol tile. */
    coverAsset: AssetDto | null;
  };
}

/** Metadata for a stored file asset (image / preview thumbnail). */
export interface AssetDto {
  id: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  filePath: string;
}

/** An image card: a static image plus an editable rich-text caption. */
export interface ImageCardDto {
  kind: "image";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  asset: AssetDto;
  captionJson: unknown;
  captionPlainText: string;
}

export type LinkMetadataStatus = "pending" | "ready" | "failed";

/**
 * The Link Card (link preview) surface. The user-facing "Link Card" is the
 * domain `embed` kind. Fields mirror docs/specs/link-card-and-clipboard.md.
 */
export interface EmbedCardDto {
  kind: "embed";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  sourceUrl: string;
  displayUrl: string;
  siteName: string | null;
  title: string;
  provider: string | null;
  descriptionJson: unknown;
  descriptionPlainText: string;
  /** `'user'` = author's comment (authoritative), `'site'` = fetched fallback, `null` = none. */
  descriptionOrigin: "user" | "site" | null;
  faviconAsset: AssetDto | null;
  previewAsset: AssetDto | null;
  previewOrigin: "fetched" | "custom" | null;
  metadataStatus: LinkMetadataStatus;
  metadataError: string | null;
}

export interface FilesystemAliasDto {
  kind: "filesystem_alias";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  targetKind: "folder" | "file";
  /** Last resolved display path only; bookmark bytes remain the authority in Rust. */
  pathHint: string;
  displayName: string;
}

/** A File Card: a text-like file copied into the managed asset store. */
export interface FileCardDto {
  kind: "file";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  asset: AssetDto;
  previewText: string;
}

export interface CreateFileCardInput {
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  sourcePath: string;
  mimeType: string;
  fileName: string;
}

export type FolderPreviewStatus = "ready" | "empty" | "missing" | "permission_lost" | "io_error";

export interface FolderEntryDto {
  name: string;
  kind: "folder" | "file";
  sizeBytes: number | null;
  childCount: number | null;
}

export interface FolderPreviewDto {
  status: FolderPreviewStatus;
  entries: FolderEntryDto[];
  hasMore: boolean;
  displayName: string;
  pathHint: string;
}

export type CardDto = NoteCardDto | BoardPortalDto | ImageCardDto | EmbedCardDto | FilesystemAliasDto | FileCardDto;

export interface BoardSnapshot {
  board: BoardSummary;
  breadcrumbs: Breadcrumb[];
  viewport: Viewport;
  cards: CardDto[];
  /** Cards in this board's Unsorted panel (not yet placed on the canvas). */
  unsortedCards: CardDto[];
}

export interface CreateNoteInput {
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  documentJson: unknown;
  plainText: string;
}

export interface UpdateNoteInput {
  id: string;
  expectedRevision: number;
  documentJson: unknown;
  plainText: string;
}

export interface MoveCardInput {
  id: string;
  expectedRevision: number;
  frame: Frame;
}

export interface SaveViewportInput {
  boardId: string;
  expectedRevision: number;
  x: number;
  y: number;
  zoom: number;
}

export interface MoveCardItemInput {
  id: string;
  expectedRevision: number;
  frame: Frame;
}

export interface MoveCardsInput {
  cards: MoveCardItemInput[];
}

export interface MoveCardToBoardInput {
  id: string;
  expectedRevision: number;
  targetBoardId: string;
  /** Optional destination frame; omit to land at the board origin. */
  frame?: Frame;
}

export interface MoveCardToUnsortedItem {
  id: string;
  expectedRevision: number;
}

export interface MoveCardsToUnsortedInput {
  targetBoardId: string;
  cards: MoveCardToUnsortedItem[];
}

export interface PlaceUnsortedCardInput {
  id: string;
  expectedRevision: number;
  frame: Frame;
}

export interface MoveBoardInput {
  boardId: string;
  expectedBoardRevision: number;
  expectedPortalRevision: number;
  targetParentBoardId: string;
  frame: Frame;
}

export interface CreateChildBoardInput {
  parentBoardId: string;
  boardId: string;
  portalCardId: string;
  frame: Frame;
  title: string;
}

export interface ImportAssetInput {
  id: string;
  sourcePath: string;
  fileName: string;
  mimeType: string;
}

export interface CreateImageCardInput {
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  assetId: string;
  captionJson: unknown;
  captionPlainText: string;
}

export interface CreateFolderAliasInput {
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  sourcePath: string;
}

export interface DropPathClassificationDto {
  path: string;
  kind: "folder" | "image" | "text_file" | "archive" | "unsupported";
  fileName: string;
  mimeType: string | null;
}

export interface UpdateImageCaptionInput {
  id: string;
  expectedRevision: number;
  captionJson: unknown;
  captionPlainText: string;
}

export interface TrashItemInput {
  id: string;
  kind: "note" | "image" | "embed" | "filesystem_alias" | "board_portal";
}

export interface ConvertNoteToEmbedInput {
  id: string;
  expectedRevision: number;
  sourceUrl: string;
  displayUrl: string;
  title: string;
  descriptionJson: unknown;
  descriptionPlainText: string;
}

export interface UpdateEmbedDescriptionInput {
  id: string;
  expectedRevision: number;
  descriptionJson: unknown;
  descriptionPlainText: string;
}

export interface EnrichEmbedMetadataInput {
  id: string;
  expectedRevision: number;
}

export interface TrashSelectionInput {
  items: TrashItemInput[];
}

/** A single representative top-level item in a Trash batch. */
export interface TrashEntryDto {
  id: string;
  kind: "note" | "image" | "embed" | "filesystem_alias" | "board";
  title: string;
  /** Thumbnail source: image/preview/cover asset when one exists. */
  thumbnailAsset: AssetDto | null;
  /** Board identity fallback (color/symbol) when there is no thumbnail. */
  colorToken: string | null;
  symbol: string | null;
}

/** One recoverable Trash batch: a single atomic delete operation. */
export interface TrashBatchDto {
  batchId: string;
  deletedAt: number;
  items: TrashEntryDto[];
  boardCount: number;
  cardCount: number;
}

/** The Trash read model, newest batch first. */
export interface TrashSummaryDto {
  batches: TrashBatchDto[];
  batchCount: number;
  boardCount: number;
  cardCount: number;
}

/** Result of permanently emptying the Trash. */
export interface EmptyTrashResult {
  boardCount: number;
  cardCount: number;
  orphanAssetCount: number;
}

/** A single workspace search result. */
export interface SearchResultDto {
  entityId: string;
  kind: "board" | "note" | "link" | "image" | "folder" | "file";
  title: string;
  /** Bounded match-context snippet; `null` when the match is in the title. */
  excerpt: string | null;
  boardId: string;
  boardTrail: Array<{ id: string; title: string }>;
  /** The board's visual identity, for grouping results under a board. */
  boardColorToken: string;
  boardSymbol: string | null;
  boardCoverAsset: AssetDto | null;
  /** Thumbnail for the matched entity itself (image/link preview/board cover). */
  thumbnailAsset: AssetDto | null;
  /** Entity creation time (unix millis). */
  createdAt: number;
}

export interface AddQuickBoardInput {
  boardId: string;
}

export interface ReorderQuickBoardsInput {
  boardIds: string[];
}

export interface CopyImageCardsInput {
  cardIds: string[];
}

export interface SetBoardCoverInput {
  boardId: string;
  assetId: string;
}

export interface SetNoteColorInput {
  id: string;
  colorToken: string;
}

/**
 * The gateway the UI talks to. Concrete implementations adapt Tauri commands
 * or an in-memory mock (for browser-mode tests).
 */
export interface WorkspaceGateway {
  getHomeBoard(): Promise<BoardSummary>;
  loadBoardSnapshot(boardId: string): Promise<BoardSnapshot>;
  readCard(cardId: string): Promise<CardDto>;
  getDataVersion(): Promise<number>;
  createNote(input: CreateNoteInput): Promise<void>;
  updateNote(input: UpdateNoteInput): Promise<void>;
  moveCard(input: MoveCardInput): Promise<void>;
  moveCards(input: MoveCardsInput): Promise<void>;
  moveCardToBoard(input: MoveCardToBoardInput): Promise<void>;
  moveBoard(input: MoveBoardInput): Promise<void>;
  saveViewport(input: SaveViewportInput): Promise<void>;
  createChildBoard(input: CreateChildBoardInput): Promise<void>;
  renameBoard(boardId: string, title: string): Promise<void>;
  trashNote(cardId: string): Promise<string>;
  trashBoard(boardId: string): Promise<string>;
  restoreTrashBatch(batchId: string): Promise<void>;
  importAsset(input: ImportAssetInput): Promise<AssetDto>;
  resolveAssetPath(assetId: string): Promise<string>;
  createImageCard(input: CreateImageCardInput): Promise<void>;
  createFolderAlias(input: CreateFolderAliasInput): Promise<FilesystemAliasDto>;
  listFolderPreview(cardId: string, limit: number): Promise<FolderPreviewDto>;
  classifyDropPaths(paths: string[]): Promise<DropPathClassificationDto[]>;
  openFolderInFinder(cardId: string): Promise<void>;
  createFileCard(input: CreateFileCardInput): Promise<FileCardDto>;
  openFileCard(cardId: string): Promise<void>;
  updateImageCaption(input: UpdateImageCaptionInput): Promise<void>;
  convertNoteToEmbed(input: ConvertNoteToEmbedInput): Promise<EmbedCardDto>;
  enrichEmbedMetadata(input: EnrichEmbedMetadataInput): Promise<EmbedCardDto>;
  updateEmbedDescription(input: UpdateEmbedDescriptionInput): Promise<void>;
  trashSelection(input: TrashSelectionInput): Promise<string>;
  listTrash(): Promise<TrashSummaryDto>;
  emptyTrash(confirmation: string): Promise<EmptyTrashResult>;
  searchWorkspace(query: string): Promise<SearchResultDto[]>;
  listQuickBoards(): Promise<QuickBoardDto[]>;
  addQuickBoard(input: AddQuickBoardInput): Promise<void>;
  removeQuickBoard(boardId: string): Promise<void>;
  reorderQuickBoards(input: ReorderQuickBoardsInput): Promise<void>;
  copyImageCards(input: CopyImageCardsInput): Promise<void>;
  importClipboardImage(): Promise<AssetDto>;
  setBoardCover(input: SetBoardCoverInput): Promise<void>;
  removeBoardCover(boardId: string): Promise<void>;
  setNoteColor(input: SetNoteColorInput): Promise<void>;
  moveCardsToBoardUnsorted(input: MoveCardsToUnsortedInput): Promise<void>;
  placeUnsortedCard(input: PlaceUnsortedCardInput): Promise<void>;
}
