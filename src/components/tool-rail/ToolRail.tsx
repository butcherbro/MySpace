import { ToolButton } from "./ToolButton";
import "./tool-rail.css";

interface ToolRailProps {
  onNewNote: () => void;
  onNewLink: () => void;
  onNewBoard: () => void;
  onAddImage: () => void;
}

export function ToolRail({ onNewNote, onNewLink, onNewBoard, onAddImage }: ToolRailProps) {
  return (
    <div className="tool-rail" role="toolbar" aria-label="Creation tools">
      <ToolButton icon="note" label="New note" visibleLabel="Note" onClick={onNewNote} />
      <ToolButton icon="link" label="New link" visibleLabel="Link" onClick={onNewLink} />
      <ToolButton icon="board" label="New board" visibleLabel="Board" onClick={onNewBoard} />
      <ToolButton icon="image" label="Add image" visibleLabel="Image" onClick={onAddImage} />
    </div>
  );
}
