import { memo, useEffect, useRef, useState } from "react";
import type { GroupCardDto } from "../../services/workspace-gateway";
import { GROUP_TITLE_MAX_CHARS, groupDisplayTitle } from "./group-title";
import { GROUP_MAX_HEIGHT, GROUP_MAX_WIDTH, GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH } from "./group-frame";
import "./group-card.css";

interface GroupCardProps {
  group: GroupCardDto;
  /** Идёт переименование: вместо плашки — поле ввода. */
  renaming: boolean;
  /** Войти в переименование (двойной клик по плашке). */
  onStartRename: (id: string) => void;
  /** Сохранить новое название. */
  onRename: (id: string, title: string) => void;
  /** Выйти из переименования (после сохранения или по Esc). */
  onDeactivate: () => void;
  /** Сохранить ручное изменение размера (CSS px). */
  onResize: (id: string, width: number, height: number) => void;
  onContextMenu: (cardId: string, x: number, y: number) => void;
}


const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Группа (ADR-0013): полупрозрачная рамка цвета пресета с плашкой названия в
 * левом верхнем углу, внутри рамки. Сама рамка — тело узла: клик выделяет группу, драг
 * двигает её вместе с карточками внутри (это делает холст). Размер меняется
 * угловой ручкой, как у картинки, и никогда не двигает карточки.
 */
export const GroupCard = memo(function GroupCard({
  group,
  renaming,
  onStartRename,
  onRename,
  onDeactivate,
  onResize,
  onContextMenu,
}: GroupCardProps) {
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);
  // Enter и потеря фокуса оба завершают правку; второе завершение не нужно.
  const finishedRef = useRef(false);
  // Слушатели окна текущего жеста: карточка может размонтироваться посреди
  // жеста (смена доски, перезагрузка снимка) — тогда их нужно снять.
  const resizeListenersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);

  const removeResizeListeners = () => {
    const listeners = resizeListenersRef.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    resizeListenersRef.current = null;
  };

  useEffect(() => removeResizeListeners, []);

  function onResizePointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    removeResizeListeners();
    resizeStart.current = { x: e.clientX, y: e.clientY, w: group.frame.width, h: group.frame.height };
    resizeListenersRef.current = { move: onResizeMove, up: onResizeUp };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp);
  }

  function onResizeMove(e: PointerEvent) {
    const start = resizeStart.current;
    if (!start) return;
    const next = {
      width: clamp(start.w + e.clientX - start.x, GROUP_MIN_WIDTH, GROUP_MAX_WIDTH),
      height: clamp(start.h + e.clientY - start.y, GROUP_MIN_HEIGHT, GROUP_MAX_HEIGHT),
    };
    draftSizeRef.current = next;
    setDraftSize(next);
  }

  function onResizeUp() {
    resizeStart.current = null;
    removeResizeListeners();
    const final = draftSizeRef.current;
    if (final) {
      onResize(group.id, final.width, final.height);
      draftSizeRef.current = null;
      setDraftSize(null);
    }
  }

  function finishRename(value: string | null) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (value !== null && value.trim() !== group.title) onRename(group.id, value.trim());
    onDeactivate();
  }

  return (
    <div
      className="group-card"
      data-testid="group-card"
      data-kind="group"
      data-color-token={group.colorToken}
      style={{ width: draftSize?.width ?? group.frame.width, height: draftSize?.height ?? group.frame.height }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(group.id, e.clientX, e.clientY);
      }}
    >
      {renaming ? (
        <input
          className="group-card__title group-card__title-input nodrag nopan"
          data-testid="group-title-input"
          aria-label="Group title"
          defaultValue={group.title}
          maxLength={GROUP_TITLE_MAX_CHARS}
          autoFocus
          onFocus={(e) => {
            finishedRef.current = false;
            e.currentTarget.select();
          }}
          onKeyDown={(e) => {
            // Клавиши поля не уходят холсту (Delete, Cmd+A, пробел).
            e.stopPropagation();
            if (e.key === "Enter") finishRename(e.currentTarget.value);
            else if (e.key === "Escape") finishRename(null);
          }}
          onBlur={(e) => finishRename(e.currentTarget.value)}
        />
      ) : (
        <div
          className="group-card__title"
          data-testid="group-title"
          data-untitled={group.title.trim() === "" ? "true" : undefined}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartRename(group.id);
          }}
        >
          {groupDisplayTitle(group.title)}
        </div>
      )}
      <div className="group-card__resize nodrag nopan" data-testid="group-resize" onPointerDown={onResizePointerDown} />
    </div>
  );
});
