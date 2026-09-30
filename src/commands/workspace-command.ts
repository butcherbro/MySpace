// Workspace command contract (plan Section H).
//
// A command is a durable mutation plus its inverse. The dispatcher executes
// commands, records them for undo, and dispatches inverse mutations on undo.
// Commands never rely on frontend state alone: `undo` performs a real inverse
// gateway call.

import type { WorkspaceGateway } from "../services/workspace-gateway";

export interface WorkspaceCommand<TResult = void> {
  id: string;
  label: string;
  execute(gateway: WorkspaceGateway): Promise<TResult>;
  undo(gateway: WorkspaceGateway): Promise<void>;
  /** Coalesces consecutive gestures (e.g. back-to-back drags) into one entry. */
  mergeWith?(next: WorkspaceCommand<unknown>): WorkspaceCommand<unknown> | null;
}

/**
 * Thrown by `undo`/redo-`execute` when the target changed since the command
 * ran, so the inverse can no longer be applied safely. Nothing is written.
 */
export class CommandConflictError extends Error {
  constructor(label: string, action: "undo" | "redo") {
    super(`Can't ${action} "${label}": the card has changed since.`);
    this.name = "CommandConflictError";
  }
}
