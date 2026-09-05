import { invoke } from "@tauri-apps/api/core";
import type {
  AssetDto,
  BoardSnapshot,
  BoardSummary,
  ConvertNoteToEmbedInput,
  CreateChildBoardInput,
  CreateImageCardInput,
  CreateNoteInput,
  EmbedCardDto,
  EnrichEmbedMetadataInput,
  ImportAssetInput,
  MoveCardInput,
  MoveCardsInput,
  MoveCardToBoardInput,
  SaveViewportInput,
  TrashSelectionInput,
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

  saveViewport(input: SaveViewportInput): Promise<void> {
    return invoke<void>("save_viewport", { input });
  }

  createChildBoard(input: CreateChildBoardInput): Promise<void> {
    return invoke<void>("create_child_board", { input });
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

  createImageCard(input: CreateImageCardInput): Promise<void> {
    return invoke<void>("create_image_card", { input });
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
}
