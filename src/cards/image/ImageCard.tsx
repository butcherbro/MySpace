import { useEffect, useRef, useState } from "react";
import type { ImageCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";
import { useDocumentDraft } from "../../editor/use-document-draft";
import "./image-card.css";

interface ImageCardProps {
  image: ImageCardDto;
  /** Persist the caption as an authoritative document. Rejects on failure. */
  onUpdate: (id: string, document: unknown) => Promise<void>;
  /** Persist a manual resize (width/height in CSS px). */
  onResize: (id: string, width: number, height: number) => void;
  /** Request a context menu (right-click). */
  onContextMenu: (cardId: string, x: number, y: number) => void;
}

/**
 * An image card: a static image with an editable rich-text caption beneath it.
 * Double-clicking the image opens a fullscreen preview; double-clicking the
 * caption opens it for editing. The caption draft lifecycle is shared with notes
 * via `useDocumentDraft`.
 */
export function ImageCard({ image, onUpdate, onResize, onContextMenu }: ImageCardProps) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);

  const { draft, saving, error, handleChange, handleBlur } = useDocumentDraft({
    id: image.id,
    persistedDocument: image.captionJson,
    onUpdate,
    onSaved: () => setEditing(false),
  });

  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);

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
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizeStart.current) return;
    const dx = e.clientX - resizeStart.current.x;
    const dy = e.clientY - resizeStart.current.y;
    const next = {
      width: Math.max(120, resizeStart.current.w + dx),
      height: Math.max(48, resizeStart.current.h + dy),
    };
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
      className="image-card"
      data-testid="image-card"
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
        <img src={src} alt={image.asset.fileName} />
      </div>
      <div
        className="image-card__caption"
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
          />
        ) : (
          <div className="image-card__caption-display">
            {image.captionPlainText || "Add caption…"}
          </div>
        )}
      </div>
      {saving && <div className="image-card__status">Saving…</div>}
      {error && <div className="image-card__status image-card__status--error">{error}</div>}
      {preview && (
        <div
          className="image-card__preview"
          data-testid="image-preview"
          onClick={() => setPreview(false)}
        >
          <img src={src} alt={image.asset.fileName} />
        </div>
      )}
      <div
        className="image-card__resize nodrag nopan"
        data-testid="image-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
