import type { BoardTab } from "./board-tabs";
import "./board-tabs.css";

interface BoardTabsProps {
  tabs: BoardTab[];
  activeBoardId: string;
  onActivate: (boardId: string) => void;
  onClose: (boardId: string) => void;
}

/**
 * A browser-like strip of open-board tabs. Home is pinned leftmost and cannot be
 * closed. This is session-only navigation state; it renders inside the workspace
 * region (above breadcrumbs) and never mutates the `AppShell` chrome.
 */
export function BoardTabs({ tabs, activeBoardId, onActivate, onClose }: BoardTabsProps) {
  if (tabs.length <= 1) return null;

  return (
    <div
      className="board-tabs"
      data-testid="board-tabs"
      role="tablist"
      aria-label="Open boards"
    >
      {tabs.map((tab) => {
        const active = tab.boardId === activeBoardId;
        return (
          <div
            key={tab.boardId}
            className={"board-tabs__tab" + (active ? " board-tabs__tab--active" : "")}
            data-testid="board-tab"
            data-board-id={tab.boardId}
            data-active={active ? "true" : "false"}
            role="tab"
            aria-selected={active}
            onClick={() => onActivate(tab.boardId)}
          >
            <button
              type="button"
              className="board-tabs__label"
              onClick={() => onActivate(tab.boardId)}
            >
              {tab.title}
            </button>
            {tab.boardId !== "home" && (
              <button
                type="button"
                className="board-tabs__close"
                aria-label={`Close tab ${tab.title}`}
                title={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.boardId);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
