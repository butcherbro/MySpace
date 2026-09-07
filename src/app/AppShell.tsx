import type { ReactNode } from "react";
import "./app-shell.css";

interface AppShellProps {
  /** Content of the macOS title-bar row (breadcrumbs). */
  topBar: ReactNode;
  toolRail: ReactNode;
  rightRail?: ReactNode;
  /** Optional separate Unsorted side panel (right of the Quick Boards rail). */
  unsortedRail?: ReactNode;
  children: ReactNode;
}

/** Fixed application chrome around the spatial workspace. */
export function AppShell({ topBar, toolRail, rightRail, unsortedRail, children }: AppShellProps) {
  const hasUnsorted = Boolean(unsortedRail);
  return (
    <div
      className={`app-shell${rightRail ? " app-shell--with-right-rail" : ""}${hasUnsorted ? " app-shell--with-unsorted" : ""}`}
      data-testid="app-shell"
      data-theme="system"
    >
      <header className="app-shell__title-bar" data-testid="title-bar-region">
        {/* Empty drag spacer under the macOS traffic lights. The attribute is on
            the spacer only, so breadcrumbs and their buttons never move the
            window. */}
        <div
          className="app-shell__titlebar-drag"
          data-testid="titlebar-drag-region"
          data-tauri-drag-region
        />
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
        <aside className="app-shell__right-rail" data-testid="right-rail-region">
          {rightRail}
        </aside>
      )}
      {hasUnsorted && (
        <aside className="app-shell__unsorted-rail" data-testid="unsorted-rail-region">
          {unsortedRail}
        </aside>
      )}
    </div>
  );
}
