// Command dispatcher: executes workspace commands with an undo/redo history.
//
// Rules (plan Section H):
// - Failed durable command never enters history.
// - Undo dispatches a new durable inverse mutation.
// - Redo is cleared after any new command.
// - Maximum 200 entries.
// - `record` adds an already-applied command under the same rules.
// - Undo/redo that fails with `CommandConflictError`, a backend
//   `stale_revision` (revisions only grow) or `not_found` (the card was removed
//   outside the history, e.g. by sync) drops that command from its stack, since
//   it can never succeed later, and rethrows; any other failure keeps it.

import type { WorkspaceGateway } from "../services/workspace-gateway";
import { CommandConflictError, type WorkspaceCommand } from "./workspace-command";

const HISTORY_LIMIT = 200;

function isPermanentFailure(err: unknown): boolean {
  return (
    err instanceof CommandConflictError ||
    (typeof err === "object" &&
      err !== null &&
      ["stale_revision", "not_found"].includes((err as { code?: unknown }).code as string))
  );
}

export class CommandDispatcher {
  private undoStack: WorkspaceCommand<unknown>[] = [];
  private redoStack: WorkspaceCommand<unknown>[] = [];
  private listeners = new Set<() => void>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private gateway: WorkspaceGateway) {}

  /**
   * Executes a command and records it for undo. If `execute` rejects, the
   * command is not recorded. Returns the result.
   */
  execute<T>(command: WorkspaceCommand<T>): Promise<T> {
    return this.enqueue(async () => {
      const result = await command.execute(this.gateway);
      this.pushUndo(command as WorkspaceCommand<unknown>);
      this.notify();
      return result;
    });
  }

  /**
   * Records a command whose effect is already applied (a text edit session or
   * a resize gesture that saved as it went) without calling `execute`. Same
   * merge/limit/redo-clearing rules as `execute`.
   */
  record(command: WorkspaceCommand<unknown>): Promise<void> {
    // Через ту же очередь: иначе запись посреди идущего undo легла бы на вершину
    // стека, и undo снял бы её вместо своей команды.
    return this.enqueue(async () => {
      this.pushUndo(command);
      this.notify();
    });
  }

  undo(): Promise<boolean> {
    return this.enqueue(async () => {
      const cmd = this.undoStack[this.undoStack.length - 1];
      if (!cmd) return false;
      await this.runOrDrop(() => cmd.undo(this.gateway), this.undoStack);
      this.undoStack.pop();
      this.redoStack.push(cmd);
      this.notify();
      return true;
    });
  }

  redo(): Promise<boolean> {
    return this.enqueue(async () => {
      const cmd = this.redoStack[this.redoStack.length - 1];
      if (!cmd) return false;
      await this.runOrDrop(() => cmd.execute(this.gateway), this.redoStack);
      this.redoStack.pop();
      this.undoStack.push(cmd);
      this.notify();
      return true;
    });
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Runs `op` for the command on top of `stack`; see the drop rule above. */
  private async runOrDrop(op: () => Promise<unknown>, stack: WorkspaceCommand<unknown>[]): Promise<void> {
    try {
      await op();
    } catch (err) {
      if (isPermanentFailure(err)) {
        stack.pop();
        this.notify();
      }
      throw err;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private pushUndo(cmd: WorkspaceCommand<unknown>): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last?.mergeWith) {
      const merged = last.mergeWith(cmd);
      if (merged) {
        this.undoStack[this.undoStack.length - 1] = merged;
      } else {
        this.undoStack.push(cmd);
      }
    } else {
      this.undoStack.push(cmd);
    }
    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack = []; // any new command clears redo
  }
}
