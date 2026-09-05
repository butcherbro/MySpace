// Normalizes any thrown value into a human-readable message for the error banner.
//
// Workspace commands reject with either a JavaScript `Error`, a bare string, or
// a Tauri/IPC-serialized `WorkspaceError` object shaped as `{ code, message }`
// (see `src-tauri/src/domain/errors.rs`, serde tag/content). Without this, a
// serialized rejection renders as the unhelpful `[object Object]`.
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;

  if (typeof err === "string") return err;

  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;

    if (typeof obj.message === "string") {
      // Prefer including the domain code when present for "constraint_violation".
      if (typeof obj.code === "string" && obj.code.length > 0) {
        return `${obj.code}: ${obj.message}`;
      }
      return obj.message;
    }

    if (typeof obj.code === "string") return obj.code;

    // Last resort: a structured value without a message field.
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  return String(err);
}
