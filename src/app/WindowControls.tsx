import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./window-controls.css";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function withWindow(action: (win: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) {
  if (!inTauri()) return;
  void action(getCurrentWindow()).catch(() => {
    // A denied/failed window command must never crash the shell.
  });
}

/** Segoe-style 10px caption glyphs, 1px strokes aligned to the pixel grid. */
function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
      <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

/**
 * Minimize / maximize-restore / close for the undecorated Windows/Linux window.
 * Rendered at the right end of the top bar by `AppShell`; outside Tauri
 * (browser, e2e) the buttons render but do nothing.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      void win
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    };
    sync();
    void win
      .onResized(sync)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="window-controls" data-testid="window-controls" data-tauri-drag-region="false">
      <button
        type="button"
        className="window-controls__button"
        aria-label="Minimize"
        title="Minimize"
        data-testid="window-control-minimize"
        onClick={() => withWindow((win) => win.minimize())}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="window-controls__button"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        data-testid="window-control-maximize"
        data-maximized={maximized ? "true" : "false"}
        onClick={() => withWindow((win) => win.toggleMaximize())}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        className="window-controls__button window-controls__button--close"
        aria-label="Close"
        title="Close"
        data-testid="window-control-close"
        onClick={() => withWindow((win) => win.close())}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
