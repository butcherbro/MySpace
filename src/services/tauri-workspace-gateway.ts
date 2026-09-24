import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DiscoveredDevice,
  PairingCode,
  PairWithInput,
  SyncPeerState,
  SyncState,
  AddQuickBoardInput,
  AssetDto,
  BackupSummary,
  BoardChangeSeq,
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
  CardReceipt,
  CardsReceipt,
  CreateNoteInput,
  DeviceIdentity,
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
  StartupFailure,
  TextReceipt,
  TrashSelectionInput,
  TrashSummaryDto,
  UpdateEmbedDescriptionInput,
  UpdateImageCaptionInput,
  UpdateNoteInput,
  ViewportReceipt,
  WorkspaceGateway,
} from "./workspace-gateway";

/**
 * Production gateway backed by Tauri commands. This is the only file that
 * imports the Tauri API; the rest of the frontend depends on the
 * `WorkspaceGateway` abstraction.
 */
export class TauriWorkspaceGateway implements WorkspaceGateway {
  getStartupFailure(): Promise<StartupFailure | null> {
    return invoke<StartupFailure | null>("get_startup_failure", {});
  }

  getHomeBoard(): Promise<BoardSummary> {
    return invoke<BoardSummary>("get_home_board", {});
  }

  loadBoardSnapshot(boardId: string): Promise<BoardSnapshot> {
    return invoke<BoardSnapshot>("load_board_snapshot", { boardId });
  }

  readCard(cardId: string): Promise<CardDto> {
    return invoke<CardDto>("read_card", { cardId });
  }

  getBoardChangeSeq(boardId: string): Promise<BoardChangeSeq> {
    return invoke<BoardChangeSeq>("get_board_change_seq", { boardId });
  }

  createNote(input: CreateNoteInput): Promise<CardReceipt> {
    return invoke<CardReceipt>("create_note", { input });
  }

  updateNote(input: UpdateNoteInput): Promise<TextReceipt> {
    return invoke<TextReceipt>("update_note", { input });
  }

  moveCard(input: MoveCardInput): Promise<CardReceipt> {
    return invoke<CardReceipt>("move_card", { input });
  }

  moveCards(input: MoveCardsInput): Promise<CardsReceipt> {
    return invoke<CardsReceipt>("move_cards", { input });
  }

  moveCardToBoard(input: MoveCardToBoardInput): Promise<CardReceipt> {
    return invoke<CardReceipt>("move_card_to_board", { input });
  }

  moveBoard(input: MoveBoardInput): Promise<void> {
    return invoke<void>("move_board", { input });
  }

  saveViewport(input: SaveViewportInput): Promise<ViewportReceipt> {
    return invoke<ViewportReceipt>("save_viewport", { input });
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

  async setFilesystemAliasLocalTarget(cardId: string, path: string): Promise<FilesystemAliasDto> {
    const alias = await invoke<Omit<FilesystemAliasDto, "kind">>(
      "set_filesystem_alias_local_target",
      { cardId, path },
    );
    return { ...alias, kind: "filesystem_alias" };
  }

  getDeviceIdentity(): Promise<DeviceIdentity> {
    return invoke<DeviceIdentity>("get_device_identity", {});
  }

  renameDevice(name: string): Promise<DeviceIdentity> {
    return invoke<DeviceIdentity>("rename_device", { name });
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

  updateImageCaption(input: UpdateImageCaptionInput): Promise<TextReceipt> {
    return invoke<TextReceipt>("update_image_caption", { input });
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

  updateEmbedDescription(input: UpdateEmbedDescriptionInput): Promise<TextReceipt> {
    return invoke<TextReceipt>("update_embed_description", { input });
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

  moveCardsToBoardUnsorted(input: MoveCardsToUnsortedInput): Promise<CardsReceipt> {
    return invoke<CardsReceipt>("move_cards_to_board_unsorted", { input });
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


  placeUnsortedCard(input: PlaceUnsortedCardInput): Promise<CardReceipt> {
    return invoke<CardReceipt>("place_unsorted_card", { input });
  }

  listBackups(): Promise<BackupSummary[]> {
    return invoke<BackupSummary[]>("list_backups", {});
  }

  requestRestore(dirName: string): Promise<never> {
    return invoke<never>("request_restore", { snapshot: dirName });
  }

  getSyncState(): Promise<SyncState> {
    return invoke<SyncState>("get_sync_state", {});
  }

  syncListPeers(): Promise<SyncPeerState[]> {
    return invoke<SyncPeerState[]>("sync_list_peers", {});
  }

  syncListDiscovered(): Promise<DiscoveredDevice[]> {
    return invoke<DiscoveredDevice[]>("sync_list_discovered", {});
  }

  syncBeginPairing(): Promise<PairingCode> {
    return invoke<PairingCode>("sync_begin_pairing", {});
  }

  syncCancelPairing(): Promise<void> {
    return invoke<void>("sync_cancel_pairing", {});
  }

  syncPairWith(input: PairWithInput): Promise<SyncPeerState> {
    return invoke<SyncPeerState>("sync_pair_with", { input });
  }

  syncUnpair(deviceId: string): Promise<void> {
    return invoke<void>("sync_unpair", { deviceId });
  }

  syncNow(): Promise<SyncState> {
    return invoke<SyncState>("sync_now", {});
  }

  onSyncState(handler: (state: SyncState) => void): Promise<() => void> {
    return listen<SyncState>("sync-state", (event) => handler(event.payload));
  }

  onSyncApplied(handler: (boardIds: string[]) => void): Promise<() => void> {
    return listen<string[]>("sync-applied", (event) => handler(event.payload));
  }
}
