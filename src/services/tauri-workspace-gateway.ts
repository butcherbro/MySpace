import { invoke } from "@tauri-apps/api/core";
import type {
  BoardSnapshot,
  BoardSummary,
  CreateChildBoardInput,
  CreateNoteInput,
  MoveCardInput,
  MoveCardsInput,
  SaveViewportInput,
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

  saveViewport(input: SaveViewportInput): Promise<void> {
    return invoke<void>("save_viewport", { input });
  }

  createChildBoard(input: CreateChildBoardInput): Promise<void> {
    return invoke<void>("create_child_board", { input });
  }

  renameBoard(boardId: string, title: string): Promise<void> {
    return invoke<void>("rename_board", { boardId, title });
  }
}
