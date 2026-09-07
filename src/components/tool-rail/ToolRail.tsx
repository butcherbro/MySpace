import { ToolButton } from "./ToolButton";
import "./tool-rail.css";

interface ToolRailProps {
  onNewNote: () => void;
  onNewLink: () => void;
  onNewBoard: () => void;
  onAddImage: () => void;
  trashBatchCount: number;
  onOpenTrash: () => void;
}

export function ToolRail({
  onNewNote,
  onNewLink,
  onNewBoard,
  onAddImage,
  trashBatchCount,
  onOpenTrash,
}: ToolRailProps) {
  return (
    <div className="tool-rail" role="toolbar" aria-label="Creation tools">
      <div className="tool-rail__group">
        <ToolButton icon="note" label="New note" visibleLabel="Note" onClick={onNewNote} />
        <ToolButton icon="link" label="New link" visibleLabel="Link" onClick={onNewLink} />
        <ToolButton icon="board" label="New board" visibleLabel="Board" onClick={onNewBoard} />
        <ToolButton icon="image" label="Add image" visibleLabel="Image" onClick={onAddImage} />
      </div>
      <div className="tool-rail__bottom">
        <ToolButton icon="trash" label="Open Trash" visibleLabel="Trash" onClick={onOpenTrash} />
        {trashBatchCount > 0 && (
          <span className="tool-rail__badge" data-testid="trash-badge" aria-hidden="true">
            {trashBatchCount}
          </span>
        )}
      </div>
    </div>
  );
}