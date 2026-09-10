import type { ReactNode } from "react";
import "./app-shell.css";

interface AppShellProps {
  /** Content of the macOS title-bar row (breadcrumbs). */
  topBar: ReactNode;
  toolRail: ReactNode;
  rightRail?: ReactNode;
  rightRailCollapsed?: boolean;
  children: ReactNode;
}

/** Fixed application chrome around the spatial workspace. The Unsorted panel is
 *  an overlay drawer rendered by the caller over the canvas, not a grid column. */
export function AppShell({ topBar, toolRail, rightRail, rightRailCollapsed = false, children }: AppShellProps) {
  const className = [
    "app-shell",
    rightRail && "app-shell--with-right-rail",
    rightRail && rightRailCollapsed && "app-shell--right-rail-collapsed",
  ]
    .filter(Boolean)
    .join(" ");

  // Window dragging is done explicitly: WKWebView does not honor CSS
  // `-webkit-app-region`, and a wide `data-tauri-drag-region` header conflicts
  // with interactive chrome. Starting the drag ourselves on mouse-down keeps
  // buttons/inputs/search clickable while the rest of the bar moves the window.
  function onTitleBarMouseDown(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, a, select, [data-no-drag]")) return;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    event.preventDefault();
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow().startDragging();
    });
  }

  return (
    <div
      className={className}
      data-testid="app-shell"
      data-theme="system"
    >
      <header
        className="app-shell__title-bar"
        data-testid="title-bar-region"
        onMouseDown={onTitleBarMouseDown}
      >
        {/* Empty drag spacer under the macOS traffic lights. */}
        <div className="app-shell__titlebar-drag" data-testid="titlebar-drag-region" />
        <div className="app-shell__titlebar-content" data-testid="top-bar-region">
          {topBar}
        </div>
      </header>
      <aside className="app-shell__tool-rail" data-testid="tool-rail-region">
        {toolRail}
      </aside>
      <main className="app-shell__canvas" data-testid="canvas-region">
        {children}
      </main>
      {rightRail && (
        <aside
          className="app-shell__right-rail"
          data-testid="right-rail-region"
          data-collapsed={rightRailCollapsed ? "true" : "false"}
        >
          {rightRail}
        </aside>
      )}
    </div>
  );
}