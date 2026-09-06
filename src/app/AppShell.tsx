import type { ReactNode } from "react";
import "./app-shell.css";

interface AppShellProps {
  topBar: ReactNode;
  toolRail: ReactNode;
  children: ReactNode;
}

/** Fixed application chrome around the spatial workspace. */
export function AppShell({ topBar, toolRail, children }: AppShellProps) {
  return (
    <div className="app-shell" data-testid="app-shell" data-theme="system">
      <header className="app-shell__top-bar" data-testid="top-bar-region">
        {topBar}
      </header>
      <aside className="app-shell__tool-rail" data-testid="tool-rail-region">
        {toolRail}
      </aside>
      <main className="app-shell__canvas" data-testid="canvas-region">
        {children}
      </main>
    </div>
  );
}
