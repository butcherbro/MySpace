import { useRef, useState } from "react";
import type { BoardTab } from "./board-tabs";
import { BoardIdentityThumbnail } from "../boards/BoardIdentityThumbnail";
import "./board-tabs.css";

interface BoardTabsProps {
  homeBoardId: string;
  tabs: BoardTab[];
  activeBoardId: string;
  onActivate: (boardId: string) => void;
  onClose: (boardId: string) => void;
  /** Drag-to-reorder: moves `boardId` to `toIndex` in the tabs array. */
  onReorder?: (boardId: string, toIndex: number) => void;
}

/** Pixels of pointer movement before a tab press becomes a drag, not a click. */
const DRAG_THRESHOLD_PX = 4;

/**
 * A browser-like strip of open-board tabs. Home is pinned leftmost and cannot be
 * closed or dragged. This is session-only navigation state; it renders inside the
 * workspace region (above breadcrumbs) and never mutates the `AppShell` chrome.
 *
 * Tab drag-to-reorder uses plain pointer events (not native HTML5 DnD), kept
 * entirely separate from card-onto-tab dropping: that gesture is driven by
 * `use-cross-board-drag`'s own pointer session started on the *card*, which
 * hit-tests `[data-testid='board-tab']` on pointerup and never attaches
 * listeners here. A pointer session started on a tab only ever reorders tabs.
 */
export function BoardTabs({
  homeBoardId,
  tabs,
  activeBoardId,
  onActivate,
  onClose,
  onReorder,
}: BoardTabsProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (tabs.length <= 1) return null;

  /** The tab index the pointer is currently over, by comparing tab midpoints. */
  function indexAtClientX(clientX: number): number {
    const container = containerRef.current;
    const children = container
      ? Array.from(container.querySelectorAll<HTMLElement>("[data-testid='board-tab']"))
      : [];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return children.length;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>, boardId: string) {
    // Home is pinned: neither draggable nor a drop target.
    if (!onReorder || boardId === homeBoardId || event.button !== 0) return;
    const reorder = onReorder;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    function handleMove(moveEvent: PointerEvent) {
      if (!dragging) {
        const dx = Math.abs(moveEvent.clientX - startX);
        const dy = Math.abs(moveEvent.clientY - startY);
        if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
        dragging = true;
        setDraggedId(boardId);
      }
      setDropIndex(indexAtClientX(moveEvent.clientX));
    }

    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      if (dragging) {
        const finalIndex = indexAtClientX(upEvent.clientX);
        reorder(boardId, finalIndex);
      }
      setDraggedId(null);
      setDropIndex(null);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div
      className="board-tabs"
      data-testid="board-tabs"
      role="tablist"
      aria-label="Open boards"
      ref={containerRef}
    >
      {tabs.map((tab, index) => {
        const active = tab.boardId === activeBoardId;
        const dragging = draggedId === tab.boardId;
        const dropBefore = draggedId !== null && dropIndex === index && !dragging;
        const dropAfter =
          draggedId !== null && dropIndex === tabs.length && index === tabs.length - 1 && !dragging;
        return (
          <div
            key={tab.boardId}
            className={
              "board-tabs__tab" +
              (active ? " board-tabs__tab--active" : "") +
              (dragging ? " board-tabs__tab--dragging" : "") +
              (dropBefore ? " board-tabs__tab--drop-before" : "") +
              (dropAfter ? " board-tabs__tab--drop-after" : "")
            }
            data-testid="board-tab"
            data-board-id={tab.boardId}
            data-active={active ? "true" : "false"}
            onPointerDown={(event) => handlePointerDown(event, tab.boardId)}
          >
            <button
              type="button"
              className="board-tabs__label"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onActivate(tab.boardId)}
            >
              <BoardIdentityThumbnail
                title={tab.title}
                colorToken={tab.colorToken}
                symbol={tab.symbol}
                coverAsset={tab.coverAsset}
                size="navigation"
                decorative
              />
              <span className="board-tabs__title">{tab.title}</span>
            </button>
            {tab.boardId !== homeBoardId && (
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
