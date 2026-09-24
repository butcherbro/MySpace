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
  /**
   * P1.7: the stored document is not valid JSON. `documentJson` is then an
   * empty doc and `plainText` is the only recoverable content; the card shows
   * it read-only and a write must carry `acknowledgeCorrupt: true`. Always
   * sent by the backend; optional so older fixtures stay valid.
   */
  corrupt?: boolean;
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

/**
 * A board shortcut card (todo.md №17): an alias that points at a board
 * without owning it — deleting the shortcut never touches the target board,
 * and deleting the target board cascades to every shortcut pointing at it.
 * Identity is read live from the target board; `target` is `null` when the
 * target no longer exists or is itself trashed (a "broken" shortcut).
 */
export interface BoardShortcutDto {
  kind: "board_shortcut";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  targetBoardId: string;
  target: {
    id: string;
    boardRevision: number;
    title: string;
    colorToken: string;
    symbol: string | null;
    coverAsset: AssetDto | null;
  } | null;
}

export interface CreateBoardShortcutInput {
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  targetBoardId: string;
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
  /** Content hash used for dedup on import; absent on assets predating it. */
  sha256?: string | null;
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
  /**
   * P1.7: the stored caption is not valid JSON. `captionJson` is then an
   * empty doc and `captionPlainText` is the only recoverable content; the card shows
   * it read-only and a write must carry `acknowledgeCorrupt: true`. Always
   * sent by the backend; optional so older fixtures stay valid.
   */
  corrupt?: boolean;
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
  /**
   * P1.7: the stored description is not valid JSON. `descriptionJson` is then an
   * empty doc and `descriptionPlainText` is the only recoverable content; the card shows
   * it read-only and a write must carry `acknowledgeCorrupt: true`. Always
   * sent by the backend; optional so older fixtures stay valid.
   */
  corrupt?: boolean;
}

export interface FilesystemAliasDto {
  kind: "filesystem_alias";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  targetKind: "folder" | "file";
  /**
   * Display path only, as written by the origin device; bookmark bytes remain
   * the authority in Rust.
   */
  pathHint: string;
  displayName: string;
  /** The device that created the shortcut (ADR-0012). */
  originDeviceId: string;
  /** That device's name when this device knows it; `null` shows "another device". */
  originDeviceName: string | null;
  /**
   * True when this device holds a locator for the shortcut. `false`: the card
   * was created on another device; it renders dimmed, cannot open, and offers
   * "Point to a folder on this computer…".
   */
  local: boolean;
}

/** This installation's identity (ADR-0012). */
export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
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
  /** Generated thumbnail (PDF/office/HTML) when available. */
  previewAsset: AssetDto | null;
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

export type FolderPreviewStatus =
  | "ready"
  | "empty"
  | "missing"
  | "permission_lost"
  | "io_error"
  /** No locator on this device (ADR-0012); the filesystem is not touched. */
  | "foreign_device";

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

export type CardDto =
  | NoteCardDto
  | BoardPortalDto
  | ImageCardDto
  | EmbedCardDto
  | FilesystemAliasDto
  | FileCardDto
  | BoardShortcutDto;

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
}

export interface UpdateNoteInput {
  id: string;
  expectedRevision: number;
  documentJson: unknown;
  /** P1.7: required (true) to overwrite a stored document that is corrupt. */
  acknowledgeCorrupt?: boolean;
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

/**
 * Duplicates a Board Portal's whole subtree recursively (todo.md №16). Only
 * the root board/portal ids are frontend-generated; the backend generates
 * every copied descendant's id inside its one transaction (ADR-0009) — the
 * frontend has no visibility into what a board contains before the copy runs.
 */
export interface DuplicateBoardInput {
  sourceBoardId: string;
  /** The board the new portal is placed on (may equal the source's own parent). */
  targetBoardId: string;
  newBoardId: string;
  newPortalCardId: string;
  frame: Frame;
}

export interface DuplicateBoardReceipt {
  newBoardId: string;
  portal: BoardPortalDto;
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
  kind: "folder" | "image" | "text_file" | "archive" | "office_file" | "unsupported";
  fileName: string;
  mimeType: string | null;
}

/** Existence check for one pasted clipboard path (todo.md №23). `~`
 *  expansion happens on the backend; `expandedPath` is the resolved path to
 *  use for the follow-up create call. */
export interface PathClassificationDto {
  kind: "folder" | "file" | "missing";
  expandedPath: string;
}

export interface UpdateImageCaptionInput {
  id: string;
  expectedRevision: number;
  captionJson: unknown;
  /** P1.7: required (true) to overwrite a stored document that is corrupt. */
  acknowledgeCorrupt?: boolean;
}

export interface TrashItemInput {
  id: string;
  kind: "note" | "image" | "embed" | "filesystem_alias" | "board_portal" | "file" | "board_shortcut";
}

export interface ConvertNoteToEmbedInput {
  id: string;
  expectedRevision: number;
  sourceUrl: string;
  displayUrl: string;
  title: string;
  descriptionJson: unknown;
}

export interface UpdateEmbedDescriptionInput {
  id: string;
  expectedRevision: number;
  descriptionJson: unknown;
  /** P1.7: required (true) to overwrite a stored document that is corrupt. */
  acknowledgeCorrupt?: boolean;
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

/** Receipt of a mutation that only bumps one card's revision. */
export interface CardReceipt {
  id: string;
  revision: number;
}

/** Receipt of a text mutation: the backend derives `plainText` from the JSON
 *  document, so the caller never computes or sends it itself. */
export interface TextReceipt {
  id: string;
  revision: number;
  plainText: string;
}

/** Receipt of a batch move: one `CardReceipt` per moved card. */
export interface CardsReceipt {
  cards: CardReceipt[];
}

/** Receipt of a viewport save. */
export interface ViewportReceipt {
  revision: number;
}

/**
 * What the external-change poll reads (P1.6), both on the writer connection:
 * `dataVersion` is SQLite's `PRAGMA data_version` (moves only when another
 * process commits), `changeSeq` is the board's trigger-maintained counter
 * (moves on any write touching what the board renders, own writes included).
 */
export interface BoardChangeSeq {
  dataVersion: number;
  changeSeq: number;
}

/**
 * The gateway the UI talks to. Concrete implementations adapt Tauri commands
 * or an in-memory mock (for browser-mode tests).
 */
export interface WorkspaceGateway {
  /**
   * P1.7: `null` normally; set when the workspace database could not be opened
   * at startup. The app then renders only the recovery dialog and calls no
   * other command except `listBackups` / `requestRestore`.
   */
  getStartupFailure(): Promise<StartupFailure | null>;
  getHomeBoard(): Promise<BoardSummary>;
  loadBoardSnapshot(boardId: string): Promise<BoardSnapshot>;
  readCard(cardId: string): Promise<CardDto>;
  getBoardChangeSeq(boardId: string): Promise<BoardChangeSeq>;
  createNote(input: CreateNoteInput): Promise<CardReceipt>;
  updateNote(input: UpdateNoteInput): Promise<TextReceipt>;
  moveCard(input: MoveCardInput): Promise<CardReceipt>;
  moveCards(input: MoveCardsInput): Promise<CardsReceipt>;
  moveCardToBoard(input: MoveCardToBoardInput): Promise<CardReceipt>;
  moveBoard(input: MoveBoardInput): Promise<void>;
  saveViewport(input: SaveViewportInput): Promise<ViewportReceipt>;
  createChildBoard(input: CreateChildBoardInput): Promise<void>;
  duplicateBoard(input: DuplicateBoardInput): Promise<DuplicateBoardReceipt>;
  renameBoard(boardId: string, title: string): Promise<void>;
  trashNote(cardId: string): Promise<string>;
  trashBoard(boardId: string): Promise<string>;
  restoreTrashBatch(batchId: string): Promise<void>;
  importAsset(input: ImportAssetInput): Promise<AssetDto>;
  resolveAssetPath(assetId: string): Promise<string>;
  createImageCard(input: CreateImageCardInput): Promise<void>;
  createBoardShortcut(input: CreateBoardShortcutInput): Promise<BoardShortcutDto>;
  createFolderAlias(input: CreateFolderAliasInput): Promise<FilesystemAliasDto>;
  listFolderPreview(cardId: string, limit: number): Promise<FolderPreviewDto>;
  classifyDropPaths(paths: string[]): Promise<DropPathClassificationDto[]>;
  classifyPath(path: string): Promise<PathClassificationDto>;
  openFolderInFinder(cardId: string): Promise<void>;
  /**
   * "Point to a folder on this computer…" (ADR-0012): stores this device's
   * locator for the shortcut and returns it with `local: true`. Device-local;
   * the origin device's locator and the path hint are untouched.
   */
  setFilesystemAliasLocalTarget(cardId: string, path: string): Promise<FilesystemAliasDto>;
  getDeviceIdentity(): Promise<DeviceIdentity>;
  renameDevice(name: string): Promise<DeviceIdentity>;
  createFileCard(input: CreateFileCardInput): Promise<FileCardDto>;
  openFileCard(cardId: string): Promise<void>;
  revealFileCard(cardId: string): Promise<void>;
  updateImageCaption(input: UpdateImageCaptionInput): Promise<TextReceipt>;
  convertNoteToEmbed(input: ConvertNoteToEmbedInput): Promise<EmbedCardDto>;
  enrichEmbedMetadata(input: EnrichEmbedMetadataInput): Promise<EmbedCardDto>;
  updateEmbedDescription(input: UpdateEmbedDescriptionInput): Promise<TextReceipt>;
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
  moveCardsToBoardUnsorted(input: MoveCardsToUnsortedInput): Promise<CardsReceipt>;
  /** One atomic call for a mixed selection of leaves and Board Portals (ADR-0007). */
  moveSelectionToBoard(input: MoveSelectionToBoardInput): Promise<MoveSelectionToBoardReceipt>;
  /** Reverses a mixed-selection move from the receipt that move returned. */
  undoMoveSelection(receipt: MoveSelectionToBoardReceipt): Promise<void>;
  placeUnsortedCard(input: PlaceUnsortedCardInput): Promise<CardReceipt>;
  /** Lists backup snapshots under `backups/`, newest first. */
  listBackups(): Promise<BackupSummary[]>;
  /**
   * Requests a restore from `dirName` (a `BackupSummary.dirName`). On success
   * the app restarts itself and the returned promise never resolves; a
   * rejection means the request itself was rejected (invalid name, snapshot
   * not found, or it failed validation) and nothing changed.
   */
  requestRestore(dirName: string): Promise<never>;
}

/** Why the app started in recovery mode (P1.7). No paths, no content. */
export interface StartupFailure {
  /** Stable error code (`db_open_failed`, `workspace_start_failed`). */
  code: string;
  /** User-facing text, prefixed with the code. */
  message: string;
}

/** One snapshot as shown in the "Restore from backup" dialog. */
export interface BackupSummary {
  /** Directory name under `backups/`; pass it back to `requestRestore`. */
  dirName: string;
  /** Unix seconds when the snapshot was taken. */
  createdAtSecs: number;
  /** Schema version recorded in the manifest (0 when unknown). */
  schemaVersion: number;
  /** Assets present in the snapshot. */
  assetCount: number;
  /** Apparent size of the snapshot, in bytes. */
  totalBytes: number;
  /** True when the snapshot passed validation and can be restored. */
  valid: boolean;
}

/**
 * Wire contract for the atomic mixed-selection move (ADR-0007). It mirrors the
 * Rust DTOs: the backend resolves the portal from `boardId` and picks the
 * destination slot itself, so the frontend sends neither a portal id nor a frame.
 */
export interface MoveSelectionCard {
  id: string;
  expectedRevision: number;
}

export interface MoveSelectionBoard {
  boardId: string;
  expectedBoardRevision: number;
  expectedPortalRevision: number;
}

/** Where the leaf cards land. Only `unsorted` exists today. */
export type SelectionLeafPlacement = "unsorted";

export interface MoveSelectionToBoardInput {
  /** Replay guard: the same key must return the original receipt. */
  idempotencyKey: string;
  targetBoardId: string;
  cards: MoveSelectionCard[];
  boards: MoveSelectionBoard[];
  leafPlacement: SelectionLeafPlacement;
}

/** One moved leaf, carrying everything the atomic undo needs to put it back. */
export interface MovedCardReceipt {
  id: string;
  previousBoardId: string;
  previousUnsorted: boolean;
  previousFrame: Frame;
  beforeRevision: number;
  afterRevision: number;
}

/** One reparented board, carrying both portal positions and both revisions. */
export interface MovedBoardReceipt {
  boardId: string;
  portalCardId: string;
  previousParentBoardId: string;
  previousPortalFrame: Frame;
  destinationPortalFrame: Frame;
  beforeBoardRevision: number;
  afterBoardRevision: number;
  beforePortalRevision: number;
  afterPortalRevision: number;
}

/** The receipt of one mixed-selection move; also the undo's input. */
export interface MoveSelectionToBoardReceipt {
  operationId: string;
  targetBoardId: string;
  cards: MovedCardReceipt[];
  boards: MovedBoardReceipt[];
}
