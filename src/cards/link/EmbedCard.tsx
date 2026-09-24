import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { EmbedCardDto } from "../../services/workspace-gateway";
import { HighlightedText } from "../../components/HighlightedText";
import { NoteEditor } from "../../editor/NoteEditor";
import { StaticDocument } from "../../editor/StaticDocument";
import { DamagedDocument } from "../../editor/DamagedDocument";
import { recoveredDocument, useCorruptRepair, type DocumentSave } from "../../editor/corrupt-document";
import { useDocumentDraft } from "../../editor/use-document-draft";
import { openExternalUrl } from "../../services/url-opener";
import "./link-card.css";

interface EmbedCardProps {
  embed: EmbedCardDto;
  /** Persist the description body as an authoritative document. Rejects on failure. */
  onUpdate: DocumentSave;
  /** Persist a manual resize. */
  onResize: (id: string, width: number, height: number) => void;
  /** Request a context menu (right-click). */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Retry a failed metadata fetch without changing the source URL. */
  onRetryMetadata: (cardId: string) => void;
  /** Transient search phrase to highlight (UI-only; never persisted). */
  highlightQuery?: string;
}

/**
 * The Link Card (link preview) rendered from the domain `embed` kind. Slice A:
 * a clickable title (falls back to the URL until metadata loads), a muted
 * source line, and an editable rich-text description body. The preview image
 * and favicon render when present (Slice B populates them).
 */
export const EmbedCard = memo(function EmbedCard({
  embed,
  onUpdate,
  onResize,
  onContextMenu,
  onRetryMetadata,
  highlightQuery = "",
}: EmbedCardProps) {
  const [editing, setEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastAutoSizeRequest = useRef<string | null>(null);
  const previewAsset = embed.previewAsset;
  const hasPreview = previewAsset !== null;

  // P1.7: a corrupt description shows its recovered text and never
  // autosaves until the user starts a repair (see editor/corrupt-document.ts).
  const repair = useCorruptRepair({ corrupt: embed.corrupt === true, onUpdate });
  const { draft, saving, error, handleChange, handleBlur, replaceDraft } = useDocumentDraft({
    id: embed.id,
    persistedDocument: embed.descriptionJson,
    onUpdate: repair.onUpdate,
    onSaved: () => setEditing(false),
    corrupt: repair.damaged,
  });
  const startRepair = () => {
    repair.beginRepair();
    replaceDraft(recoveredDocument(embed.descriptionPlainText));
    setEditing(true);
  };

  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);

  const appliedWidth = draftSize?.width ?? embed.frame.width;
  const appliedHeight = draftSize?.height ?? embed.frame.height;
  const cardClassName = [
    "link-card",
    `link-card--${embed.metadataStatus}`,
    hasPreview ? "link-card--has-preview" : "",
    editing ? "link-card--editing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const fitEnrichedContent = useCallback(() => {
    if (embed.metadataStatus !== "ready" || draftSizeRef.current) return;

    const measuredHeight = Math.ceil(cardRef.current?.scrollHeight ?? 0);
    if (measuredHeight <= embed.frame.height + 1) return;

    const requestKey = `${embed.revision}:${embed.frame.width}:${measuredHeight}`;
    if (lastAutoSizeRequest.current === requestKey) return;
    lastAutoSizeRequest.current = requestKey;
    onResize(embed.id, embed.frame.width, measuredHeight);
  }, [embed.frame.height, embed.frame.width, embed.id, embed.metadataStatus, embed.revision, onResize]);

  useLayoutEffect(() => {
    fitEnrichedContent();
  }, [embed.descriptionPlainText, embed.previewAsset?.id, embed.title, fitEnrichedContent]);

  function onResizePointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      w: embed.frame.width,
      h: embed.frame.height,
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizeStart.current) return;
    const dx = e.clientX - resizeStart.current.x;
    const dy = e.clientY - resizeStart.current.y;
    const next = {
      width: Math.max(240, resizeStart.current.w + dx),
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
      onResize(embed.id, final.width, final.height);
      draftSizeRef.current = null;
      setDraftSize(null);
    }
  }

  return (
    <div
      ref={cardRef}
      className={cardClassName}
      data-testid="link-card"
      data-kind="link"
      data-metadata-status={embed.metadataStatus}
      data-has-preview={hasPreview ? "true" : "false"}
      data-editing={editing ? "true" : "false"}
      style={{ width: appliedWidth, height: appliedHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(embed.id, e.clientX, e.clientY);
      }}
    >
      {previewAsset && embed.metadataStatus !== "pending" && (
        <img
          className="link-card__preview"
          src={`myspace-asset://localhost/${previewAsset.filePath}`}
          alt={embed.title}
          onLoad={fitEnrichedContent}
        />
      )}

      <div className="link-card__body">
        {embed.metadataStatus === "pending" && (
          <div className="link-card__loading" role="status">Loading preview…</div>
        )}
        <div className="link-card__source">
          {embed.faviconAsset && (
            <img
              className="link-card__favicon"
              src={`myspace-asset://localhost/${embed.faviconAsset.filePath}`}
              alt=""
            />
          )}
          <span className="link-card__url" title={embed.sourceUrl}>
            <HighlightedText text={embed.displayUrl} query={highlightQuery} />
          </span>
        </div>

        <a
          className="link-card__title"
          href={embed.sourceUrl}
          onClick={(e) => {
            // Open in the OS browser, not inside the WebView, and do not let the
            // click bubble into React Flow (drag/edit).
            e.preventDefault();
            e.stopPropagation();
            void openExternalUrl(embed.sourceUrl);
          }}
        >
          <HighlightedText text={embed.title} query={highlightQuery} />
        </a>

        {embed.metadataStatus === "failed" && (
          <div className="link-card__unavailable">
            <span>Preview unavailable</span>
            <button
              type="button"
              className="link-card__retry nodrag nopan"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRetryMetadata(embed.id);
              }}
            >
              Retry preview
            </button>
          </div>
        )}

        <div
          className={
            "link-card__description" +
            (embed.descriptionOrigin === "user" && embed.descriptionPlainText.trim()
              ? " link-card__description--user-comment"
              : "")
          }
          data-testid="link-description"
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!repair.damaged) setEditing(true);
          }}
        >
          {repair.damaged ? (
            <DamagedDocument
              label="description"
              plainText={embed.descriptionPlainText}
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
          ) : embed.descriptionPlainText ? (
            // Read-only ветка раньше показывала plain text (без marks), потом —
            // read-only Tiptap. P1.8: статический HTML из того же документа и тех же
            // расширений (marks/списки сохраняются), без экземпляра редактора на
            // каждую неактивную карточку; редактор монтируется только в режиме правки.
            <StaticDocument document={embed.descriptionJson} highlightQuery={highlightQuery} />
          ) : (
            <div className="link-card__description-display">Add notes…</div>
          )}
        </div>
      </div>

      {saving && <div className="link-card__status">Saving…</div>}
      {error && <div className="link-card__status link-card__status--error">{error}</div>}

      <div
        className="link-card__resize nodrag nopan"
        data-testid="link-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
});
