import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShellPlatform } from "../../app/platform";
import { ariaShortcut, formatShortcut, type ShortcutSpec } from "./menu-format";
import "./context-menu.css";

export interface ContextMenuAction {
  id: string;
  label: string;
  onSelect: () => void;
  /** Items of one section sit together; a divider separates sections. */
  section?: string;
  /** A shortcut the app's key handlers already run for this action. */
  shortcut?: ShortcutSpec;
  /** Destructive action, drawn in the danger colour. */
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
  /** Test id for the menu overlay (split card vs pane menus). */
  testId?: string;
  /** Muted line under the items (e.g. the card's created/modified dates). */
  footer?: string;
}

/** Gap kept between the menu and the window edge. */
const EDGE_MARGIN = 8;

/**
 * A type-aware context menu: the caller computes the relevant actions for the
 * hovered entity and passes them in; this component only renders the fixed
 * positioning, the sectioned action list, and the closing backdrop.
 */
export function ContextMenu({ x, y, actions, onClose, testId = "context-menu", footer }: ContextMenuProps) {
  const platform = useShellPlatform();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Esc закрывает меню — иначе единственный выход был клик мимо.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Меню у правого/нижнего края сдвигается внутрь окна до отрисовки,
  // чтобы не мигнуть обрезанным.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - width - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - height - EDGE_MARGIN)),
    });
  }, [x, y, actions.length, footer]);

  return (
    <>
      <div ref={menuRef} className="context-menu" style={position} data-testid={testId}>
        {actions.map((action, index) => (
          <Fragment key={action.id}>
            {index > 0 && actions[index - 1].section !== action.section && (
              <div className="context-menu__divider" role="separator" />
            )}
            <button
              type="button"
              className={action.danger ? "context-menu__item context-menu__item--danger" : "context-menu__item"}
              aria-keyshortcuts={action.shortcut && ariaShortcut(action.shortcut, platform)}
              onClick={() => {
                onClose();
                action.onSelect();
              }}
            >
              <span className="context-menu__label">{action.label}</span>
              {/* Подсказка не входит в доступное имя кнопки: тесты и скринридеры ищут пункт по названию. */}
              {action.shortcut && (
                <kbd className="context-menu__shortcut" aria-hidden="true">
                  {formatShortcut(action.shortcut, platform)}
                </kbd>
              )}
            </button>
          </Fragment>
        ))}
        {footer && (
          <>
            <div className="context-menu__divider" role="separator" />
            <p className="context-menu__footer" data-testid={`${testId}-footer`}>
              {footer}
            </p>
          </>
        )}
      </div>
      <div className="context-menu__backdrop" onClick={onClose} />
    </>
  );
}
