import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImageCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";
import { StaticDocument } from "../../editor/StaticDocument";
import { useDocumentDraft } from "../../editor/use-document-draft";
import { computeResizedImageFrameSize } from "./image-card-geometry";
import "./image-card.css";

interface ImageCardProps {
  image: ImageCardDto;
  /** Persist the caption as an authoritative document. Rejects on failure. */
  onUpdate: (id: string, document: unknown) => Promise<void>;
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
  onResize,
  onContextMenu,
  highlightQuery = "",
}: ImageCardProps) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const hasCaption = image.captionPlainText.trim().length > 0;

  const { draft, saving, error, handleChange, handleBlur } = useDocumentDraft({
    id: image.id,
    persistedDocument: image.captionJson,
    onUpdate,
    onSaved: () => setEditing(false),
  });

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
  const src = `myspace-asset://localhost/${image.asset.filePath}`;

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
          setEditing(true);
        }}
      >
        {editing ? (
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
