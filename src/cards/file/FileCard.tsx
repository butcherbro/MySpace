import { useRef, useState } from "react";
import type { FileCardDto } from "../../services/workspace-gateway";
import "./file-card.css";

interface Props {
  file: FileCardDto;
  onOpen: (id: string) => void;
  onReveal: (id: string) => void;
  onResize: (id: string, width: number, height: number) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "file";
}

const TEXT_EXTS = new Set(["txt", "md", "markdown", "json", "csv", "rtf", "log", "html", "htm"]);

// Brand-ish labels for office/archive types. The tile color matches the
// canonical document color (Word blue, Excel green, PowerPoint red, PDF red).
const OFFICE_LABELS: Record<string, string> = {
  doc: "Word",
  docx: "Word",
  xls: "Excel",
  xlsx: "Excel",
  ppt: "PowerPoint",
  pptx: "PowerPoint",
  pdf: "PDF",
  pages: "Pages",
  numbers: "Numbers",
  key: "Keynote",
  odt: "Writer",
  ods: "Calc",
  odp: "Impress",
};

// Canonical document colors (Word blue, Excel green, PowerPoint red, PDF red).
const OFFICE_COLORS: Record<string, string> = {
  Word: "#2b579a",
  Excel: "#217346",
  PowerPoint: "#d24726",
  PDF: "#d93025",
  Pages: "#f8a000",
  Numbers: "#f8a000",
  Keynote: "#f8a000",
  Writer: "#1a6f9c",
  Calc: "#1a6f9c",
  Impress: "#1a6f9c",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extColor(ext: string): string {
  switch (ext) {
    case "md":
    case "markdown":
      return "var(--text-blue)";
    case "csv":
      return "var(--text-green)";
    case "rtf":
      return "var(--text-orange)";
    case "log":
      return "var(--text-gray)";
    case "html":
    case "htm":
      return "#e44d26"; // HTML orange
    default:
      return ""; // txt/json stay neutral
  }
}

export function FileCard({ file, onOpen, onReveal, onResize, onContextMenu }: Props) {
  const [draft, setDraft] = useState<{ width: number; height: number } | null>(null);
  const draftRef = useRef<{ width: number; height: number } | null>(null);
  const start = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const size = draft ?? { width: file.frame.width, height: file.frame.height };
  const ext = extOf(file.asset.fileName);
  const isText = TEXT_EXTS.has(ext);
  const officeLabel = OFFICE_LABELS[ext];

  const onMove = (event: PointerEvent) => {
    if (!start.current) return;
    const next = {
      width: Math.max(140, start.current.width + event.clientX - start.current.x),
      height: Math.max(120, start.current.height + event.clientY - start.current.y),
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

  const actions = (
    <>
      <button
        type="button"
        className="file-card__open nodrag nopan"
        aria-label={`Open ${file.asset.fileName}`}
        title="Open in app"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(file.id);
        }}
      >
        ↗
      </button>
      <button
        type="button"
        className="file-card__open nodrag nopan"
        aria-label={`Reveal ${file.asset.fileName} in Finder`}
        title="Reveal in Finder"
        onClick={(e) => {
          e.stopPropagation();
          onReveal(file.id);
        }}
      >
        ⌘
      </button>
    </>
  );

  // Compact icon card for archives/office (no inline preview).
  if (!isText) {
    return (
      <article
        className="file-card file-card--icon"
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
          <span
            className="file-card__ext"
            aria-hidden="true"
            style={
              officeLabel
                ? { background: OFFICE_COLORS[officeLabel], color: "#fff" }
                : undefined
            }
          >
            {officeLabel ?? ext}
          </span>
          <div className="file-card__meta">
            <strong title={file.asset.fileName}>{file.asset.fileName}</strong>
            <span>{formatSize(file.asset.sizeBytes)}</span>
          </div>
          {actions}
        </header>
        <div className="file-card__placeholder" data-testid="file-preview">
          {file.previewAsset ? (
            <img
              className="file-card__thumb"
              src={`myspace-asset://localhost/${file.previewAsset.filePath}`}
              alt=""
              draggable={false}
            />
          ) : officeLabel ? (
            `${officeLabel} document`
          ) : (
            "Archive"
          )}
        </div>
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

  const isHtml = ext === "html" || ext === "htm";

  // Text card with readable preview + per-format tint. HTML is rendered as a
  // live (but inert) page inside the card, like a Finder thumbnail.
  return (
    <article
      className="file-card"
      data-testid="file-card"
      data-ext={ext}
      style={
        {
          width: size.width,
          height: size.height,
          "--file-tint": extColor(ext),
        } as React.CSSProperties
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(file.id, e.clientX, e.clientY);
      }}
    >
      <header className="file-card__header">
        <span className="file-card__ext" aria-hidden="true" style={extColor(ext) ? { background: `color-mix(in srgb, ${extColor(ext)} 16%, transparent)` } : undefined}>
          {ext}
        </span>
        <div className="file-card__meta">
          <strong title={file.asset.fileName}>{file.asset.fileName}</strong>
          <span>{formatSize(file.asset.sizeBytes)}</span>
        </div>
        {actions}
      </header>
      {isHtml ? (
        <iframe
          className="file-card__html"
          data-testid="file-preview"
          title={file.asset.fileName}
          srcDoc={file.previewText}
          sandbox=""
          tabIndex={-1}
        />
      ) : (
        <pre className="file-card__preview" data-testid="file-preview">
          {file.previewText || "(no preview)"}
        </pre>
      )}
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