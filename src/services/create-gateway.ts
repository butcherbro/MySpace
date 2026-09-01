import { MockWorkspaceGateway } from "./mock-workspace-gateway";
import { TauriWorkspaceGateway } from "./tauri-workspace-gateway";
import type { WorkspaceGateway } from "./workspace-gateway";

/**
 * Selects the appropriate gateway based on runtime environment.
 *
 * When running inside the Tauri WebView, `window.__TAURI_INTERNALS__` is
 * present and command invocation is available. Otherwise (e.g. a plain browser
 * or `vite dev` opened directly), fall back to an in-memory mock.
 */
export function createGateway(): WorkspaceGateway {
  const isTauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window;

  return isTauri ? new TauriWorkspaceGateway() : new MockWorkspaceGateway();
}
