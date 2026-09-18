import { invoke } from "@tauri-apps/api/core";
import type {
  AddQuickBoardInput,
  AssetDto,
  BoardShortcutDto,
  BoardSnapshot,
  BoardSummary,
  CardDto,
  ConvertNoteToEmbedInput,
  CopyImageCardsInput,
  CreateBoardShortcutInput,
  CreateChildBoardInput,
  DuplicateBoardInput,
  DuplicateBoardReceipt,
  CreateFileCardInput,
  CreateFolderAliasInput,
  CreateImageCardInput,
  CreateNoteInput,
  EmbedCardDto,
  EmptyTrashResult,
  EnrichEmbedMetadataInput,
  FileCardDto,
  ImportAssetInput,
  DropPathClassificationDto,
  PathClassificationDto,
  FilesystemAliasDto,
  FolderPreviewDto,
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
  TrashSelectionInput,
  TrashSummaryDto,
  UpdateEmbedDescriptionInput,
  UpdateImageCaptionInput,
  UpdateNoteInput,
  WorkspaceGateway,
} from "./workspace-gateway";

/**
 * Production gateway backed by Tauri commands. This is the only file that
 * imports the Tauri API; the rest of the frontend depends on the
 * `WorkspaceGateway` abstraction.
 */
export class TauriWorkspaceGateway implements WorkspaceGateway {
  getHomeBoard(): Promise<BoardSummary> {
    return invoke<BoardSummary>("get_home_board", {});
  }

  loadBoardSnapshot(boardId: string): Promise<BoardSnapshot> {
    return invoke<BoardSnapshot>("load_board_snapshot", { boardId });
  }

  readCard(cardId: string): Promise<CardDto> {
    return invoke<CardDto>("read_card", { cardId });
  }

  getDataVersion(): Promise<number> {
    return invoke<number>("get_data_version", {});
  }

  createNote(input: CreateNoteInput): Promise<void> {
    return invoke<void>("create_note", { input });
  }

  updateNote(input: UpdateNoteInput): Promise<void> {
    return invoke<void>("update_note", { input });
  }

  moveCard(input: MoveCardInput): Promise<void> {
    return invoke<void>("move_card", { input });
  }

  moveCards(input: MoveCardsInput): Promise<void> {
    return invoke<void>("move_cards", { input });
  }

  moveCardToBoard(input: MoveCardToBoardInput): Promise<void> {
    return invoke<void>("move_card_to_board", { input });
  }

  moveBoard(input: MoveBoardInput): Promise<void> {
    return invoke<void>("move_board", { input });
  }

  saveViewport(input: SaveViewportInput): Promise<void> {
    return invoke<void>("save_viewport", { input });
  }

  createChildBoard(input: CreateChildBoardInput): Promise<void> {
    return invoke<void>("create_child_board", { input });
  }

  duplicateBoard(input: DuplicateBoardInput): Promise<DuplicateBoardReceipt> {
    return invoke<DuplicateBoardReceipt>("duplicate_board", { input });
  }

  renameBoard(boardId: string, title: string): Promise<void> {
    return invoke<void>("rename_board", { boardId, title });
  }

  trashNote(cardId: string): Promise<string> {
    return invoke<string>("trash_note", { cardId });
  }

  trashBoard(boardId: string): Promise<string> {
    return invoke<string>("trash_board", { boardId });
  }

  restoreTrashBatch(batchId: string): Promise<void> {
    return invoke<void>("restore_trash_batch", { batchId });
  }

  importAsset(input: ImportAssetInput): Promise<AssetDto> {
    return invoke<AssetDto>("import_asset", { input });
  }

  resolveAssetPath(assetId: string): Promise<string> {
    return invoke<string>("resolve_asset_path", { assetId });
  }

  createImageCard(input: CreateImageCardInput): Promise<void> {
    return invoke<void>("create_image_card", { input });
  }

  createBoardShortcut(input: CreateBoardShortcutInput): Promise<BoardShortcutDto> {
    return invoke<BoardShortcutDto>("create_board_shortcut", { input });
  }

  async createFolderAlias(input: CreateFolderAliasInput): Promise<FilesystemAliasDto> {
    const alias = await invoke<Omit<FilesystemAliasDto, "kind">>("create_folder_alias", { input });
    return { ...alias, kind: "filesystem_alias" };
  }

  listFolderPreview(cardId: string, limit: number): Promise<FolderPreviewDto> {
    return invoke<FolderPreviewDto>("list_folder_preview", { cardId, limit });
  }

  classifyDropPaths(paths: string[]): Promise<DropPathClassificationDto[]> {
    return invoke<DropPathClassificationDto[]>("classify_drop_paths", { paths });
  }

  classifyPath(path: string): Promise<PathClassificationDto> {
    return invoke<PathClassificationDto>("classify_path", { path });
  }

  openFolderInFinder(cardId: string): Promise<void> {
    return invoke<void>("open_folder_in_finder", { cardId });
  }

  async createFileCard(input: CreateFileCardInput): Promise<FileCardDto> {
    const card = await invoke<Omit<FileCardDto, "kind">>("create_file_card", { input });
    return { ...card, kind: "file" };
  }

  openFileCard(cardId: string): Promise<void> {
    return invoke<void>("open_file_card", { cardId });
  }

  revealFileCard(cardId: string): Promise<void> {
    return invoke<void>("reveal_file_card", { cardId });
  }

  updateImageCaption(input: UpdateImageCaptionInput): Promise<void> {
    return invoke<void>("update_image_caption", { input });
  }

  async convertNoteToEmbed(input: ConvertNoteToEmbedInput): Promise<EmbedCardDto> {
    // Команда Rust возвращает сам EmbedCardDto без enum-тега. На IPC-границе
    // восстанавливаем дискриминатор, иначе registry принимает карточку за portal.
    const embed = await invoke<Omit<EmbedCardDto, "kind">>("convert_note_to_embed", { input });
    return { ...embed, kind: "embed" };
  }

  async enrichEmbedMetadata(input: EnrichEmbedMetadataInput): Promise<EmbedCardDto> {
    const embed = await invoke<Omit<EmbedCardDto, "kind">>("enrich_embed_metadata", { input });
    return { ...embed, kind: "embed" };
  }

  updateEmbedDescription(input: UpdateEmbedDescriptionInput): Promise<void> {
    return invoke<void>("update_embed_description", { input });
  }

  trashSelection(input: TrashSelectionInput): Promise<string> {
    return invoke<string>("trash_selection", { input });
  }

  listTrash(): Promise<TrashSummaryDto> {
    return invoke<TrashSummaryDto>("list_trash", {});
  }

  emptyTrash(confirmation: string): Promise<EmptyTrashResult> {
    return invoke<EmptyTrashResult>("empty_trash", { confirmation });
  }

  searchWorkspace(query: string): Promise<SearchResultDto[]> {
    return invoke<SearchResultDto[]>("search_workspace", { query });
  }

  listQuickBoards(): Promise<QuickBoardDto[]> {
    return invoke<QuickBoardDto[]>("list_quick_boards", {});
  }

  addQuickBoard(input: AddQuickBoardInput): Promise<void> {
    return invoke<void>("add_quick_board", { input });
  }

  removeQuickBoard(boardId: string): Promise<void> {
    return invoke<void>("remove_quick_board", { boardId });
  }

  reorderQuickBoards(input: ReorderQuickBoardsInput): Promise<void> {
    return invoke<void>("reorder_quick_boards", { input });
  }

  copyImageCards(input: CopyImageCardsInput): Promise<void> {
    return invoke<void>("copy_image_cards", { cardIds: input.cardIds });
  }

  importClipboardImage(): Promise<AssetDto> {
    return invoke<AssetDto>("import_clipboard_image", {});
  }

  setBoardCover(input: SetBoardCoverInput): Promise<void> {
    return invoke<void>("set_board_cover", { boardId: input.boardId, assetId: input.assetId });
  }

  removeBoardCover(boardId: string): Promise<void> {
    return invoke<void>("remove_board_cover", { boardId });
  }

  setNoteColor(input: SetNoteColorInput): Promise<void> {
    return invoke<void>("set_note_color", { input });
  }

  moveCardsToBoardUnsorted(input: MoveCardsToUnsortedInput): Promise<void> {
    return invoke<void>("move_cards_to_board_unsorted", { input });
  }
  moveSelectionToBoard(
    input: import("./workspace-gateway").MoveSelectionToBoardInput,
  ): Promise<import("./workspace-gateway").MoveSelectionToBoardReceipt> {
    return invoke<import("./workspace-gateway").MoveSelectionToBoardReceipt>(
      "move_selection_to_board",
      { input },
    );
  }

  undoMoveSelection(
    receipt: import("./workspace-gateway").MoveSelectionToBoardReceipt,
  ): Promise<void> {
    return invoke<void>("undo_move_selection", { receipt });
  }


  placeUnsortedCard(input: PlaceUnsortedCardInput): Promise<void> {
    return invoke<void>("place_unsorted_card", { input });
  }
}
