import type { ReactNode } from "react";
import "./app-shell.css";

/**
 * The minimal application shell. This is the outermost chrome that wraps the
 * spatial canvas. In V1 it is intentionally bare: a title bar area and a main
 * region that will host the current board's canvas.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell" data-testid="app-shell" data-theme="system">
      <header className="app-shell__header">
        <span className="app-shell__title">MySpace</span>
      </header>
      <main className="app-shell__body">{children}</main>
    </div>
  );
}
