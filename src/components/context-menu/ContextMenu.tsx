import "./context-menu.css";

export interface ContextMenuAction {
  id: string;
  label: string;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
  /** Test id for the menu overlay (split card vs pane menus). */
  testId?: string;
}

/**
 * A type-aware context menu: the caller computes the relevant actions for the
 * hovered entity and passes them in; this component only renders the fixed
 * positioning, the action list, and the closing backdrop.
 */
export function ContextMenu({ x, y, actions, onClose, testId = "context-menu" }: ContextMenuProps) {
  return (
    <>
      <div className="context-menu" style={{ left: x, top: y }} data-testid={testId}>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="context-menu__item"
            onClick={() => {
              onClose();
              action.onSelect();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div className="context-menu__backdrop" onClick={onClose} />
    </>
  );
}