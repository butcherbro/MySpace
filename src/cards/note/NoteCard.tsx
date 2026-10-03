import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NoteEditor } from "../../editor/NoteEditor";
import { StaticDocument } from "../../editor/StaticDocument";
import { DamagedDocument } from "../../editor/DamagedDocument";
import { recoveredDocument, useCorruptRepair, type DocumentSave } from "../../editor/corrupt-document";
import { useDocumentDraft } from "../../editor/use-document-draft";
import { endDraftHandoff, takeDraftHandoffInput } from "../../editor/draft-handoff";
import type { NoteEditorCommands } from "../../editor/editor-commands";
import type { TextColorId } from "../../editor/text-color";
import type { NoteCardDto } from "../../services/workspace-gateway";
import type { ResizeOptions } from "../resize-options";
import { useInnerWheelScroll } from "../inner-scroll";
import { autoGrowHeight as autoGrowTarget, clampNoteSize, widthAfterPaste } from "./note-sizing";
import "./note-card.css";

interface NoteCardProps {
  note: NoteCardDto;
  /** Whether this note is the one currently being edited. */
  editing: boolean;
  /** Exit edit mode. */
  onDeactivate: () => void;
  /** Persist note content as an authoritative document. Rejects on failure. */
  onUpdate: DocumentSave;
  /** Finalize note editing (blur/Enter) and optionally convert into a Link Card. */
  onFinalize?: DocumentSave;
  /** Request a context menu (right-click) for this card. */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Persist a manual resize (width/height in CSS px), or an auto-grow (`auto`). */
  onResize: (id: string, width: number, height: number, options?: ResizeOptions) => void;
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

/** Content height change (px) below which the auto-grow does not react. */
const CONTENT_GROWTH_TOLERANCE_PX = 8;

/** How long a pointer-down may precede edit entry and still place the caret. */
const CARET_CLICK_WINDOW_MS = 1000;

/**
 * An editable note backed by an authoritative document. Editing is controlled
 * by the parent; the draft lifecycle (debounce/flush) lives in the shared
 * `useDocumentDraft` hook.
 *
 * P1.8: only the note being edited mounts a Tiptap editor. An idle note
 * renders its persisted document as static HTML (`StaticDocument`), so a board
 * of N notes costs one editor, not N. The draft hook stays mounted either way;
 * while idle it is clean, so its draft-flush registration has nothing to write.
 *
 * Memoised: `App` passes stable (ref-backed) callbacks, so an unrelated card's
 * update never re-renders this one.
 */
export const NoteCard = memo(function NoteCard({
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
  // P1.7: a corrupt note shows its recovered text and never autosaves until
  // the user starts a repair (see editor/corrupt-document.ts).
  const repair = useCorruptRepair({ corrupt: note.corrupt === true, onUpdate, onFinalize });
  const { draft, saving, error, handleChange, handleBlur, handleFinalize, replaceDraft } = useDocumentDraft({
    id: note.id,
    persistedDocument: note.documentJson,
    onUpdate: repair.onUpdate,
    onFinalize: repair.onFinalize,
    onSaved: onDeactivate,
    corrupt: repair.damaged,
    editing,
  });
  // The Repair click also reaches the canvas as a card click, which starts
  // editing, so the editor mounts on the recovered document.
  const startRepair = () => {
    repair.beginRepair();
    replaceDraft(recoveredDocument(note.plainText));
  };

  // The static view is swapped for an editor on the click that starts editing,
  // so remember where that click landed (see NoteEditor `initialCaretPoint`).
  const lastPointerDownRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // Заметка, появившаяся сразу в режиме правки (новая или копия конфликта, куда
  // перешёл набор), получает каретку в конце текста.
  const [caretPoint, setCaretPoint] = useState<{ x: number; y: number } | "end" | null>(editing ? "end" : null);
  const [wasEditing, setWasEditing] = useState(editing);
  if (editing !== wasEditing) {
    setWasEditing(editing);
    const down = lastPointerDownRef.current;
    setCaretPoint(
      editing && down && performance.now() - down.t <= CARET_CLICK_WINDOW_MS ? { x: down.x, y: down.y } : null,
    );
  }

  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);

  // Авторост высоты под содержимое (Milanote-стиль): пока карточка редактируется,
  // высота растёт вслед за контентом примерно до экрана, дальше текст прокручивается
  // внутри (см. ниже). `autoGrowHeight` —
  // локальный «горб» поверх persisted `note.frame.height`, растущий монотонно;
  // ручной resize (onResizeUp) сбрасывает его явно, чтобы не спорить с намеренным
  // уменьшением карточки пользователем.
  // Текст живёт во внутреннем `note-card__body`: он и прокручивается при правке,
  // а уголок resize и затухание остаются на месте, на самой карточке.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [autoGrowHeight, setAutoGrowHeight] = useState<number | null>(null);
  // Длинная вставка расширяет узкую заметку (см. `widthAfterPaste`): локально
  // сразу, чтобы авторост мерил высоту уже по новой ширине.
  const [autoWidth, setAutoWidth] = useState<number | null>(null);
  const growPendingRef = useRef<number | null>(null);
  const growTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appliedWidth = draftSize?.width ?? Math.max(note.frame.width, autoWidth ?? 0);
  const appliedHeight = draftSize?.height ?? Math.max(note.frame.height, autoGrowHeight ?? 0);

  function flushPendingGrow() {
    if (growTimer.current) {
      clearTimeout(growTimer.current);
      growTimer.current = null;
    }
    if (growPendingRef.current !== null) {
      onResize(note.id, appliedWidth, growPendingRef.current, { auto: true });
      growPendingRef.current = null;
    }
  }

  // Измеряем после каждого изменения контента, пока идёт редактирование: `scrollHeight`
  // тела карточки всегда отражает реальную высоту содержимого, даже когда `overflow`
  // клипует/скроллит его — так и ловим переполнение без синхронного layout-хака.
  // Реагируем только на изменения контента — не на смену высоты или ширины
  // карточки: ручной resize почти всегда чуть меняет и ширину, и авторост тут же
  // отращивал бы уменьшенную пользователем карточку обратно («пружина»). Ширину
  // от длинной вставки эффект видит вместе с самой вставкой (тот же `draft`).
  // Заметка с ревизией 1 ещё ни разу не менялась после создания (вставка текста
  // на пустой холст создаёт её 120px высотой и не в режиме правки) — её тоже
  // подгоняем под контент, один раз: запись роста поднимает ревизию.
  // Высота растёт примерно до экрана (`NOTE_AUTO_MAX_HEIGHT`), дальше текст
  // прокручивается внутри карточки; выше пользователь тянет уголком сам.
  const fitsContent = editing || note.revision === 1;
  // Растём только когда сам текст стал выше, чем при прошлом замере. Черновик
  // меняется и без правки (blur на уголке resize сохраняет и перечитывает
  // документ), и по одной смене черновика авторост отращивал только что
  // уменьшенную вручную карточку обратно.
  // Базу меряем и в покое: вход в правку (в т.ч. повторный — клик по уголку
  // снимает фокус и возвращает его) сам по себе карточку не растит. Допуск —
  // меньше строки: редактор и статичный вид расходятся на пару пикселей.
  const contentHeightRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const previous = contentHeightRef.current;
    contentHeightRef.current = el.scrollHeight;
    if (!fitsContent) return;
    if (previous !== null && el.scrollHeight <= previous + CONTENT_GROWTH_TOLERANCE_PX) return;
    const needed = autoGrowTarget(appliedHeight, el.scrollHeight - el.clientHeight);
    if (needed === null) return;
    setAutoGrowHeight((prev) => (prev === null || needed > prev ? needed : prev));
    growPendingRef.current = needed;
    if (growTimer.current) clearTimeout(growTimer.current);
    // Debounce как у автосохранения текста (250ms) — иначе каждая напечатанная
    // буква могла бы триггерить отдельную запись revision в БД.
    growTimer.current = setTimeout(() => {
      growTimer.current = null;
      onResize(note.id, appliedWidth, needed, { auto: true });
      growPendingRef.current = null;
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitsContent, draft]);

  // Текст, не влезший в карточку, прокручивается внутри только в режиме правки
  // (`useInnerWheelScroll`); в покое он обрезан с затуханием внизу, а колесо
  // всегда двигает канвас.
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setClipped(el.scrollHeight - el.clientHeight > 1);
  }, [editing, draft, note.documentJson, appliedWidth, appliedHeight]);

  useInnerWheelScroll(bodyRef, editing);

  // Карточка ушла (смена доски) раньше, чем её редактор взял переданный набор:
  // клавиши больше не перехватываются, а набранное не теряется молча.
  useEffect(() => () => endDraftHandoff(note.id), [note.id]);

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
    const next = clampNoteSize(resizeStart.current.w + dx, resizeStart.current.h + dy);
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
      setAutoWidth(null);
      onResize(note.id, final.width, final.height);
      draftSizeRef.current = null;
      setDraftSize(null);
    }
  }

  return (
    <div
      className={`note-card ${editing ? "note-card--editing" : ""}${
        note.colorToken && note.colorToken !== "default" ? ` note-card--${note.colorToken}` : ""
      }`}
      data-testid="note-card"
      data-kind="note"
      data-color={note.colorToken}
      data-editing={editing ? "true" : "false"}
      data-saving={saving ? "true" : "false"}
      data-error={error ? "true" : "false"}
      data-corrupt={repair.damaged ? "true" : "false"}
      data-clipped={clipped ? "true" : "false"}
      style={{ width: appliedWidth, height: appliedHeight }}
      onPointerDown={(e) => {
        lastPointerDownRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(note.id, e.clientX, e.clientY);
      }}
    >
      <div ref={bodyRef} className="note-card__body" data-testid="note-card-body">
        {repair.damaged ? (
          <DamagedDocument
            label="note"
            plainText={note.plainText}
            onRepair={startRepair}
            highlightQuery={highlightQuery}
          />
        ) : editing ? (
          <NoteEditor
            document={draft}
            editable
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
            initialCaretPoint={caretPoint}
            takeHandedInput={() => takeDraftHandoffInput(note.id)}
            onPasteText={(text) => {
              const width = widthAfterPaste(appliedWidth, text);
              if (width === appliedWidth) return;
              setAutoWidth(width);
              // Ширину пишем сразу: авторост ниже запишет её же вместе с высотой,
              // но только если контент переполнит карточку.
              onResize(note.id, width, appliedHeight, { auto: true });
            }}
            onCommandsReady={onCommandsReady}
            onBoldStateChange={onBoldStateChange}
            onItalicStateChange={onItalicStateChange}
            onStrikeStateChange={onStrikeStateChange}
            onTextColorChange={onTextColorChange}
          />
        ) : (
          <StaticDocument document={note.documentJson} highlightQuery={highlightQuery} />
        )}
      </div>
      {clipped && !editing && <div className="note-card__fade" aria-hidden="true" />}
      {saving && <div className="note-card__status note-card__status--saving">Saving…</div>}
      {error && <div className="note-card__status note-card__status--error">{error}</div>}
      <div
        className="note-card__resize nodrag nopan"
        data-testid="note-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
});
