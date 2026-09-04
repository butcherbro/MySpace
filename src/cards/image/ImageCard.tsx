import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";
import "./image-card.css";

interface ImageCardProps {
  image: ImageCardDto;
  /** Persist the caption as an authoritative document. Rejects on failure. */
  onUpdate: (id: string, document: unknown) => Promise<void>;
  /** Request a context menu (right-click). */
  onContextMenu: (cardId: string, x: number, y: number) => void;
}

/**
 * An image card: a static image with an editable rich-text caption beneath it.
 * Double-clicking the caption opens it for editing (same NoteEditor/commit
 * pipeline as a note); single-click keeps the card draggable.
 */
export function ImageCard({ image, onUpdate, onContextMenu }: ImageCardProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<unknown>(image.captionJson);
  const draftRef = useRef<unknown>(image.captionJson);
  const dirtyRef = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const src = `myspace-asset://localhost/${image.asset.filePath}`;

  const commit = useCallback(
    async (doc: unknown) => {
      setSaving(true);
      setError(null);
      try {
        await onUpdate(image.id, doc);
        dirtyRef.current = false;
        setEditing(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [image.id, onUpdate],
  );

  const handleChange = useCallback(
    (doc: unknown) => {
      dirtyRef.current = true;
      draftRef.current = doc;
      setDraft(doc);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        onUpdate(image.id, doc).catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
        });
      }, 250);
    },
    [image.id, onUpdate],
  );

  const handleBlur = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (dirtyRef.current) {
      void commit(draftRef.current);
    } else {
      setEditing(false);
    }
  }, [commit]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  return (
    <div
      className="image-card"
      data-testid="image-card"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(image.id, e.clientX, e.clientY);
      }}
    >
      <div className="image-card__image">
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
          <div className="image-card__caption-display">{image.captionPlainText || "Add caption…"}</div>
        )}
      </div>
      {saving && <div className="image-card__status">Saving…</div>}
      {error && <div className="image-card__status image-card__status--error">{error}</div>}
    </div>
  );
}
