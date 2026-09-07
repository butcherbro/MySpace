import { useEffect, useReducer, useState } from "react";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { Icon } from "../components/icons/Icon";
import "./undo-redo-controls.css";

interface UndoRedoControlsProps {
  dispatcher: CommandDispatcher;
  onUndo: () => Promise<unknown> | unknown;
  onRedo: () => Promise<unknown> | unknown;
}

export function UndoRedoControls({ dispatcher, onUndo, onRedo }: UndoRedoControlsProps) {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const [pending, setPending] = useState(false);

  useEffect(() => dispatcher.subscribe(refresh), [dispatcher]);

  const undoLabel = dispatcher.undoLabel;
  const redoLabel = dispatcher.redoLabel;

  async function run(action: () => Promise<unknown> | unknown) {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="undo-redo-controls" aria-label="Workspace history">
      <button
        type="button"
        className="undo-redo-controls__button"
        aria-label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
        title={undoLabel ? `Undo ${undoLabel} (⌘Z)` : "Undo (⌘Z)"}
        disabled={pending || !dispatcher.canUndo()}
        onClick={() => void run(onUndo)}
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        className="undo-redo-controls__button"
        aria-label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
        title={redoLabel ? `Redo ${redoLabel} (⇧⌘Z)` : "Redo (⇧⌘Z)"}
        disabled={pending || !dispatcher.canRedo()}
        onClick={() => void run(onRedo)}
      >
        <Icon name="redo" />
      </button>
    </div>
  );
}
