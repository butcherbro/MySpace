import { ToolButton } from "./ToolButton";
import { TEXT_COLOR_OPTIONS, type TextColorId } from "../../editor/text-color";
import "./tool-rail.css";

export type ToolRailMode = "create" | "note";

interface ToolRailProps {
  mode: ToolRailMode;
  onNewNote: () => void;
  onNewLink: () => void;
  onNewBoard: () => void;
  onAddImage: () => void;
  trashBatchCount: number;
  onOpenTrash: () => void;
  /** Toggle bold on the active note's editor. */
  onBold: () => void;
  /** Whether bold is active at the active note's caret/selection. */
  boldActive: boolean;
  /** Return to the default creation tools. */
  onBackToCreate: () => void;
  /** The active text color (preset id). */
  textColor: TextColorId;
  /** Apply a text color (or default). */
  onTextColor: (color: TextColorId) => void;
}

/**
 * The fixed left rail. In `create` mode it shows the default creation tools; in
 * `note` mode (a single Note is selected/editing) it shows the active note's
 * formatting tools. The Trash entry stays pinned at the bottom in both modes.
 */
export function ToolRail({
  mode,
  onNewNote,
  onNewLink,
  onNewBoard,
  onAddImage,
  trashBatchCount,
  onOpenTrash,
  onBold,
  boldActive,
  onBackToCreate,
  textColor,
  onTextColor,
}: ToolRailProps) {
  return (
    <div className="tool-rail" role="toolbar" aria-label="Tools">
      {mode === "note" ? (
        <div className="tool-rail__group">
          <ToolButton
            icon="arrow-left"
            label="Back to tools"
            visibleLabel="Back"
            onClick={onBackToCreate}
          />
          <ToolButton
            icon="bold"
            label="Bold"
            visibleLabel="Bold"
            onClick={onBold}
            active={boldActive}
            onMouseDown={(event) => event.preventDefault()}
          />
          <div className="tool-rail__section" aria-label="Text color">
            <span className="tool-rail__section-label">Text</span>
            <div className="tool-rail__swatches">
              {TEXT_COLOR_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`color-swatch color-swatch--${option.id}${
                    textColor === option.id ? " color-swatch--active" : ""
                  }`}
                  title={option.label}
                  aria-label={option.label}
                  aria-pressed={textColor === option.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onTextColor(option.id)}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="tool-rail__group">
          <ToolButton icon="note" label="New note" visibleLabel="Note" onClick={onNewNote} />
          <ToolButton icon="link" label="New link" visibleLabel="Link" onClick={onNewLink} />
          <ToolButton icon="board" label="New board" visibleLabel="Board" onClick={onNewBoard} />
          <ToolButton icon="image" label="Add image" visibleLabel="Image" onClick={onAddImage} />
        </div>
      )}
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