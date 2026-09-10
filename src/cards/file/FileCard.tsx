import { useRef, useState } from "react";
import type { FileCardDto } from "../../services/workspace-gateway";
import "./file-card.css";

interface Props {
  file: FileCardDto;
  onOpen: (id: string) => void;
  onResize: (id: string, width: number, height: number) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "file";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileCard({ file, onOpen, onResize, onContextMenu }: Props) {
  const [draft, setDraft] = useState<{ width: number; height: number } | null>(null);
  const draftRef = useRef<{ width: number; height: number } | null>(null);
  const start = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const size = draft ?? { width: file.frame.width, height: file.frame.height };
  const ext = extOf(file.asset.fileName);

  const onMove = (event: PointerEvent) => {
    if (!start.current) return;
    const next = {
      width: Math.max(280, start.current.width + event.clientX - start.current.x),
      height: Math.max(180, start.current.height + event.clientY - start.current.y),
    };
    draftRef.current = next;
    setDraft(next);
  };
  const onUp = () => {
    const final = draftRef.current;
    start.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (final) {
      onResize(file.id, final.width, final.height);
      draftRef.current = null;
      setDraft(null);
    }
  };

  return (
    <article
      className="file-card"
      data-testid="file-card"
      data-ext={ext}
      style={{ width: size.width, height: size.height }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(file.id, e.clientX, e.clientY);
      }}
    >
      <header className="file-card__header">
        <span className="file-card__ext" aria-hidden="true">
          {ext}
        </span>
        <div className="file-card__meta">
          <strong title={file.asset.fileName}>{file.asset.fileName}</strong>
          <span>{formatSize(file.asset.sizeBytes)}</span>
        </div>
        <button
          type="button"
          className="file-card__open nodrag nopan"
          aria-label={`Open ${file.asset.fileName}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(file.id);
          }}
        >
          ↗
        </button>
      </header>
      <pre className="file-card__preview" data-testid="file-preview">
        {file.previewText || "(no preview)"}
      </pre>
      <div
        className="file-card__resize nodrag nopan"
        data-testid="file-resize"
        onPointerDown={(e) => {
          e.stopPropagation();
          start.current = {
            x: e.clientX,
            y: e.clientY,
            width: file.frame.width,
            height: file.frame.height,
          };
          e.currentTarget.setPointerCapture?.(e.pointerId);
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      />
    </article>
  );
}