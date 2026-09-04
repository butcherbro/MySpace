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

export interface NoteCardDto {
  kind: "note";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  revision: number;
  documentJson: unknown;
  plainText: string;
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
    title: string;
    colorToken: string;
    symbol: string | null;
    childBoardCount: number;
    childCardCount: number;
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

export type CardDto = NoteCardDto | BoardPortalDto | ImageCardDto;

export interface BoardSnapshot {
  board: BoardSummary;
  breadcrumbs: Breadcrumb[];
  viewport: Viewport;
  cards: CardDto[];
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

export interface UpdateImageCaptionInput {
  id: string;
  expectedRevision: number;
  captionJson: unknown;
  captionPlainText: string;
}

export interface TrashItemInput {
  id: string;
  kind: "note" | "image" | "embed" | "board_portal";
}

export interface TrashSelectionInput {
  items: TrashItemInput[];
}

/**
 * The gateway the UI talks to. Concrete implementations adapt Tauri commands
 * or an in-memory mock (for browser-mode tests).
 */
export interface WorkspaceGateway {
  getHomeBoard(): Promise<BoardSummary>;
  loadBoardSnapshot(boardId: string): Promise<BoardSnapshot>;
  createNote(input: CreateNoteInput): Promise<void>;
  updateNote(input: UpdateNoteInput): Promise<void>;
  moveCard(input: MoveCardInput): Promise<void>;
  moveCards(input: MoveCardsInput): Promise<void>;
  saveViewport(input: SaveViewportInput): Promise<void>;
  createChildBoard(input: CreateChildBoardInput): Promise<void>;
  renameBoard(boardId: string, title: string): Promise<void>;
  trashNote(cardId: string): Promise<string>;
  trashBoard(boardId: string): Promise<string>;
  restoreTrashBatch(batchId: string): Promise<void>;
  importAsset(input: ImportAssetInput): Promise<AssetDto>;
  createImageCard(input: CreateImageCardInput): Promise<void>;
  updateImageCaption(input: UpdateImageCaptionInput): Promise<void>;
  trashSelection(input: TrashSelectionInput): Promise<string>;
}
