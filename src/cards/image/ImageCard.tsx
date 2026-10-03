import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImageCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";
import { StaticDocument } from "../../editor/StaticDocument";
import { DamagedDocument } from "../../editor/DamagedDocument";
import { recoveredDocument, useCorruptRepair, type DocumentSave } from "../../editor/corrupt-document";
import { useDocumentDraft } from "../../editor/use-document-draft";
import { computeResizedImageFrameSize } from "./image-card-geometry";
import { useInnerWheelScroll } from "../inner-scroll";
import "./image-card.css";
import { assetUrl } from "../../services/asset-url";

interface ImageCardProps {
  image: ImageCardDto;
  /** Persist the caption as an authoritative document. Rejects on failure. */
  onUpdate: DocumentSave;
  /** Finalize a caption edit (blur); falls back to `onUpdate` when absent. */
  onFinalize?: DocumentSave;
  /** Persist a manual resize (width/height in CSS px). */
  onResize: (id: string, width: number, height: number) => void;
  /** Request a context menu (right-click). */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Transient search phrase to highlight (UI-only; never persisted). */
  highlightQuery?: string;
}

/**
 * An image card: a static image with an editable rich-text caption beneath it.
 * Double-clicking the image opens a fullscreen preview; double-clicking the
 * caption opens it for editing. The caption draft lifecycle is shared with notes
 * via `useDocumentDraft`.
 */
export const ImageCard = memo(function ImageCard({
  image,
  onUpdate,
  onFinalize,
  onResize,
  onContextMenu,
  highlightQuery = "",
}: ImageCardProps) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const hasCaption = image.captionPlainText.trim().length > 0;

  // P1.7: a corrupt caption shows its recovered text and never autosaves
  // until the user starts a repair (see editor/corrupt-document.ts).
  const repair = useCorruptRepair({ corrupt: image.corrupt === true, onUpdate, onFinalize });
  const { draft, saving, error, handleChange, handleBlur, replaceDraft } = useDocumentDraft({
    id: image.id,
    persistedDocument: image.captionJson,
    onUpdate: repair.onUpdate,
    onFinalize: repair.onFinalize,
    onSaved: () => setEditing(false),
    corrupt: repair.damaged,
  });
  const startRepair = () => {
    repair.beginRepair();
    replaceDraft(recoveredDocument(image.captionPlainText));
    setEditing(true);
  };

  const cardClassName = [
    "image-card",
    hasCaption ? "image-card--has-caption" : "image-card--no-caption",
    editing ? "image-card--editing" : "",
    saving ? "image-card--saving" : "",
    error ? "image-card--error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const resizeStart = useRef<{ x: number; y: number; w: number; h: number; captionHeight: number } | null>(
    null,
  );
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);
  // Natural aspect ratio (width/height) картинки — известна только после
  // загрузки <img> в браузере (backend её не хранит). Пока null — resize
  // остаётся свободным (старое поведение), чтобы не блокировать интеракцию.
  const imageAspectRatio = useRef<number | null>(null);
  const captionRef = useRef<HTMLDivElement | null>(null);

  const appliedWidth = draftSize?.width ?? image.frame.width;
  const appliedHeight = draftSize?.height ?? image.frame.height;

  // Подпись занимает не больше половины карточки, чтобы длинный текст не
  // выдавливал картинку. Что не влезло, в покое обрезано с затуханием, а при
  // правке прокручивается внутри (колесо — тексту, у края снова канвасу).
  const [captionClipped, setCaptionClipped] = useState(false);
  useLayoutEffect(() => {
    const el = captionRef.current;
    if (!el) return;
    setCaptionClipped(el.scrollHeight - el.clientHeight > 1);
  }, [editing, draft, image.captionJson, appliedWidth, appliedHeight]);
  useInnerWheelScroll(captionRef, editing);
  const src = assetUrl(image.asset.filePath);

  // Close the preview on Escape.
  useEffect(() => {
    if (!preview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPreview(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  function onResizePointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      w: image.frame.width,
      h: image.frame.height,
      // Измеряем подпись сейчас, а не по CAPTION_BASE_HEIGHT — она может быть
      // многострочной, и высота image area должна остаться честной.
      captionHeight: captionRef.current?.getBoundingClientRect().height ?? 0,
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizeStart.current) return;
    const dx = e.clientX - resizeStart.current.x;
    const dy = e.clientY - resizeStart.current.y;
    const aspect = imageAspectRatio.current;
    let next: { width: number; height: number };
    if (aspect) {
      // Aspect-lock: ширина ведёт (drag по диагонали), высота image area
      // считается по пропорциям картинки + фактическая высота подписи.
      next = computeResizedImageFrameSize(
        resizeStart.current.w + dx,
        aspect,
        resizeStart.current.captionHeight,
      );
    } else {
      // Пропорции ещё не известны (картинка не догрузилась) — старое
      // свободное поведение, чтобы resize не блокировался.
      next = {
        width: Math.max(120, resizeStart.current.w + dx),
        height: Math.max(48, resizeStart.current.h + dy),
      };
    }
    draftSizeRef.current = next;
    setDraftSize(next);
  }

  function onResizeUp() {
    resizeStart.current = null;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeUp);
    const final = draftSizeRef.current;
    if (final) {
      onResize(image.id, final.width, final.height);
      draftSizeRef.current = null;
      setDraftSize(null);
    }
  }

  return (
    <div
      className={cardClassName}
      data-testid="image-card"
      data-kind="image"
      data-has-caption={hasCaption ? "true" : "false"}
      data-editing={editing ? "true" : "false"}
      data-saving={saving ? "true" : "false"}
      data-error={error ? "true" : "false"}
      data-preview-open={preview ? "true" : "false"}
      style={{ width: appliedWidth, height: appliedHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(image.id, e.clientX, e.clientY);
      }}
    >
      <div
        className="image-card__image"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setPreview(true);
        }}
      >
        <img
          src={src}
          alt={image.asset.fileName}
          onLoad={(e) => {
            const el = e.currentTarget;
            imageAspectRatio.current =
              el.naturalWidth > 0 && el.naturalHeight > 0 ? el.naturalWidth / el.naturalHeight : null;
          }}
        />
      </div>
      <div
        ref={captionRef}
        className="image-card__caption"
        data-testid="image-caption"
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!repair.damaged) setEditing(true);
        }}
      >
        {repair.damaged ? (
          <DamagedDocument
            label="caption"
            plainText={image.captionPlainText}
            onRepair={startRepair}
            highlightQuery={highlightQuery}
          />
        ) : editing ? (
          <NoteEditor
            document={draft}
            editable
            onChange={handleChange}
            onBlur={handleBlur}
            highlightQuery={highlightQuery}
          />
        ) : hasCaption ? (
          // Read-only ветка раньше показывала plain text (без marks), потом —
          // read-only Tiptap. P1.8: статический HTML из того же документа и тех же
          // расширений (marks/списки сохраняются), без экземпляра редактора на
          // каждую неактивную карточку; редактор монтируется только в режиме правки.
          <StaticDocument document={image.captionJson} highlightQuery={highlightQuery} />
        ) : (
          <div className="image-card__caption-display">Add caption…</div>
        )}
        {captionClipped && !editing && <div className="image-card__caption-fade" aria-hidden="true" />}
      </div>
      {saving && <div className="image-card__status">Saving…</div>}
      {error && <div className="image-card__status image-card__status--error">{error}</div>}
      {preview &&
        // Портал в document.body: React Flow позиционирует карточки через
        // CSS `transform`, а трансформированный предок становится containing
        // block для `position: fixed` — без портала просмотр раскрывался бы
        // от позиции миниатюры и мог уезжать за край окна. Через портал
        // `fixed` считается от настоящего viewport окна, независимо от того,
        // где на доске стоит миниатюра и какой сейчас зум канваса.
        createPortal(
          <div
            className="image-card__preview"
            data-testid="image-preview"
            onClick={() => setPreview(false)}
          >
            <img src={src} alt={image.asset.fileName} />
          </div>,
          document.body,
        )}
      <div
        className="image-card__resize nodrag nopan"
        data-testid="image-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
});
