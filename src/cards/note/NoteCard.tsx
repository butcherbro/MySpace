import { useLayoutEffect, useRef, useState } from "react";
import { NoteEditor } from "../../editor/NoteEditor";
import { useDocumentDraft } from "../../editor/use-document-draft";
import type { NoteEditorCommands } from "../../editor/editor-commands";
import type { TextColorId } from "../../editor/text-color";
import type { NoteCardDto } from "../../services/workspace-gateway";
import "./note-card.css";

interface NoteCardProps {
  note: NoteCardDto;
  /** Whether this note is the one currently being edited. */
  editing: boolean;
  /** Exit edit mode. */
  onDeactivate: () => void;
  /** Persist note content as an authoritative document. Rejects on failure. */
  onUpdate: (id: string, document: unknown) => Promise<void>;
  /** Finalize note editing (blur/Enter) and optionally convert into a Link Card. */
  onFinalize?: (id: string, document: unknown) => Promise<void>;
  /** Request a context menu (right-click) for this card. */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Persist a manual resize (width/height in CSS px). */
  onResize: (id: string, width: number, height: number) => void;
  /** Transient search phrase to highlight (UI-only; never persisted). */
  highlightQuery?: string;
  /** Called with the editing command surface (or null when leaving edit mode). */
  onCommandsReady?: (commands: NoteEditorCommands | null) => void;
  /** Called with the current bold-active state. */
  onBoldStateChange?: (active: boolean) => void;
  /** Called with the current italic-active state. */
  onItalicStateChange?: (active: boolean) => void;
  /** Called with the current strike-active state. */
  onStrikeStateChange?: (active: boolean) => void;
  /** Called with the current text color. */
  onTextColorChange?: (color: TextColorId) => void;
}

/**
 * An editable note backed by an authoritative document. Editing is controlled
 * by the parent; the draft lifecycle (debounce/flush) lives in the shared
 * `useDocumentDraft` hook.
 */
export function NoteCard({
  note,
  editing,
  onDeactivate,
  onUpdate,
  onFinalize,
  onContextMenu,
  onResize,
  highlightQuery = "",
  onCommandsReady,
  onBoldStateChange,
  onItalicStateChange,
  onStrikeStateChange,
  onTextColorChange,
}: NoteCardProps) {
  const { draft, saving, error, handleChange, handleBlur, handleFinalize } = useDocumentDraft({
    id: note.id,
    persistedDocument: note.documentJson,
    onUpdate,
    onFinalize,
    onSaved: onDeactivate,
  });

  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);

  // Авторост высоты под содержимое (Milanote-стиль): пока карточка редактируется,
  // высота растёт вслед за контентом — без верхнего предела (скролл внутри нужен
  // только как страховка после ручного уменьшения, см. ниже). `autoGrowHeight` —
  // локальный «горб» поверх persisted `note.frame.height`, растущий монотонно;
  // ручной resize (onResizeUp) сбрасывает его явно, чтобы не спорить с намеренным
  // уменьшением карточки пользователем.
  const cardRef = useRef<HTMLDivElement>(null);
  const [autoGrowHeight, setAutoGrowHeight] = useState<number | null>(null);
  const growPendingRef = useRef<number | null>(null);
  const growTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appliedWidth = draftSize?.width ?? note.frame.width;
  const appliedHeight = draftSize?.height ?? Math.max(note.frame.height, autoGrowHeight ?? 0);

  function flushPendingGrow() {
    if (growTimer.current) {
      clearTimeout(growTimer.current);
      growTimer.current = null;
    }
    if (growPendingRef.current !== null) {
      onResize(note.id, appliedWidth, growPendingRef.current);
      growPendingRef.current = null;
    }
  }

  // Измеряем после каждого изменения контента, пока идёт редактирование: `scrollHeight`
  // элемента всегда отражает реальную высоту содержимого, даже когда `overflow`
  // клипует/скроллит его — так и ловим переполнение без синхронного layout-хака.
  // Реагируем только на изменения контента (не на смену `note.frame.height`), иначе
  // эффект тут же отменял бы ручное уменьшение карточки пользователем.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = cardRef.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 0) return;
    const needed = Math.ceil(appliedHeight + overflow);
    setAutoGrowHeight((prev) => (prev === null || needed > prev ? needed : prev));
    growPendingRef.current = needed;
    if (growTimer.current) clearTimeout(growTimer.current);
    // Debounce как у автосохранения текста (250ms) — иначе каждая напечатанная
    // буква могла бы триггерить отдельную запись revision в БД.
    growTimer.current = setTimeout(() => {
      growTimer.current = null;
      onResize(note.id, appliedWidth, needed);
      growPendingRef.current = null;
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft, note.documentJson, appliedWidth]);

  // На unmount/при переключении заметки — не терять последний измеренный рост.
  useLayoutEffect(() => {
    return () => {
      if (growTimer.current) clearTimeout(growTimer.current);
    };
  }, []);

  function onResizePointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Ручной drag стартует с уже применённой (возможно, авторосшей) высоты и
    // отменяет любой отложенный автогрow-write, чтобы не гнаться следом.
    flushPendingGrow();
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      w: appliedWidth,
      h: appliedHeight,
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizeStart.current) return;
    const dx = e.clientX - resizeStart.current.x;
    const dy = e.clientY - resizeStart.current.y;
    const next = { width: Math.max(120, resizeStart.current.w + dx), height: Math.max(48, resizeStart.current.h + dy) };
    draftSizeRef.current = next;
    setDraftSize(next);
  }

  function onResizeUp() {
    resizeStart.current = null;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeUp);
    const final = draftSizeRef.current;
    if (final) {
      // Явный ручной resize побеждает автогrow: сбрасываем «горб», иначе
      // уменьшение карточки ниже высоты контента тут же откатилось бы назад.
      setAutoGrowHeight(null);
      onResize(note.id, final.width, final.height);
      draftSizeRef.current = null;
      setDraftSize(null);
    }
  }

  return (
    <div
      ref={cardRef}
      className={`note-card ${editing ? "note-card--editing" : ""}${
        note.colorToken && note.colorToken !== "default" ? ` note-card--${note.colorToken}` : ""
      }`}
      data-testid="note-card"
      data-kind="note"
      data-color={note.colorToken}
      data-editing={editing ? "true" : "false"}
      data-saving={saving ? "true" : "false"}
      data-error={error ? "true" : "false"}
      style={{ width: appliedWidth, height: appliedHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(note.id, e.clientX, e.clientY);
      }}
    >
      <NoteEditor
        document={editing ? draft : note.documentJson}
        editable={editing}
        onChange={handleChange}
        onBlur={() => {
          // Флашим отложенный автогrow-write вместе с флашем контента на blur —
          // иначе последний рост «в полёте» (debounce ещё не сработал) терялся бы.
          flushPendingGrow();
          handleBlur();
        }}
        onFinalize={() => {
          void handleFinalize();
        }}
        highlightQuery={highlightQuery}
        onCommandsReady={onCommandsReady}
        onBoldStateChange={onBoldStateChange}
        onItalicStateChange={onItalicStateChange}
        onStrikeStateChange={onStrikeStateChange}
        onTextColorChange={onTextColorChange}
      />
      {saving && <div className="note-card__status note-card__status--saving">Saving…</div>}
      {error && <div className="note-card__status note-card__status--error">{error}</div>}
      <div
        className="note-card__resize nodrag nopan"
        data-testid="note-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
