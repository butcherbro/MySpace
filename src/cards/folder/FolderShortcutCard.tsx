import { memo, useEffect, useRef, useState } from "react";
import type { FilesystemAliasDto, FolderPreviewDto } from "../../services/workspace-gateway";
import "./folder-shortcut-card.css";

interface Props { alias: FilesystemAliasDto; loadPreview: (id: string) => Promise<FolderPreviewDto>; onOpenFinder: (id: string) => void; onResize: (id: string, width: number, height: number) => void; onContextMenu: (id: string, x: number, y: number) => void; /** ADR-0012: pick a folder here for a shortcut created on another device. */ onPointToLocalFolder: (id: string) => void; }

const messages: Record<string, string> = { empty: "This folder is empty.", missing: "Folder is unavailable.", permission_lost: "Permission to this folder was lost.", io_error: "Folder preview is unavailable.", foreign_device: "This folder is on another device." };
/** Badge text for a shortcut created on another device (ADR-0012). */
function originDeviceLabel(alias: FilesystemAliasDto): string { return `On ${alias.originDeviceName ?? "another device"}`; }
function rowLimit(height: number) { return Math.max(2, Math.floor((height - 150) / 42)); }
function detail(entry: FolderPreviewDto["entries"][number]) { if (entry.kind === "folder") return entry.childCount == null ? "Folder" : `${entry.childCount} items`; if (entry.sizeBytes == null) return "File"; return entry.sizeBytes < 1024 ? `${entry.sizeBytes} B` : `${Math.round(entry.sizeBytes / 1024)} KB`; }

export const FolderShortcutCard = memo(function FolderShortcutCard({ alias, loadPreview, onOpenFinder, onResize, onContextMenu, onPointToLocalFolder }: Props) {
  // A shortcut without a locator on this device (ADR-0012) never loads a
  // preview and never opens: it shows where it lives and offers a re-point.
  const foreign = !alias.local;
  const [preview, setPreview] = useState<FolderPreviewDto | null>(null);
  const [draft, setDraft] = useState<{ width: number; height: number } | null>(null);
  const draftRef = useRef<{ width: number; height: number } | null>(null);
  const start = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  useEffect(() => { if (foreign) { setPreview(null); return; } let live = true; void loadPreview(alias.id).then((value) => { if (live) setPreview(value); }).catch(() => { if (live) setPreview({ status: "io_error", entries: [], hasMore: false, displayName: alias.displayName, pathHint: alias.pathHint }); }); return () => { live = false; }; }, [foreign, alias.id, alias.displayName, alias.pathHint, loadPreview]);
  const size = draft ?? { width: alias.frame.width, height: alias.frame.height };
  const rows = preview?.entries.slice(0, rowLimit(size.height)) ?? [];
  const onMove = (event: PointerEvent) => { if (!start.current) return; const next = { width: Math.max(280, start.current.width + event.clientX - start.current.x), height: Math.max(180, start.current.height + event.clientY - start.current.y) }; draftRef.current = next; setDraft(next); };
  const onUp = () => { const final = draftRef.current; start.current = null; window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); if (final) { onResize(alias.id, final.width, final.height); draftRef.current = null; setDraft(null); } };
  const origin = originDeviceLabel(alias);
  return <article className={foreign ? "folder-shortcut-card folder-shortcut-card--foreign" : "folder-shortcut-card"} data-testid="folder-shortcut-card" data-foreign={foreign ? "true" : undefined} data-preview-status={foreign ? "foreign_device" : preview?.status ?? "loading"} style={{ width: size.width, height: size.height }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(alias.id, event.clientX, event.clientY); }}>
    <header className="folder-shortcut-card__header"><div><strong>{preview?.displayName ?? alias.displayName}</strong>{foreign ? <span className="folder-shortcut-card__origin" data-testid="folder-origin-badge" title={alias.pathHint}>{origin}</span> : <span title={preview?.pathHint ?? alias.pathHint}>{preview?.pathHint ?? alias.pathHint}</span>}</div><button className="folder-shortcut-card__finder nodrag nopan" type="button" aria-label={`Open ${alias.displayName} in Finder`} title={foreign ? `${origin}: ${alias.pathHint}` : undefined} disabled={foreign} onClick={(event) => { event.stopPropagation(); if (!foreign) onOpenFinder(alias.id); }}>↗</button></header>
    <section className="folder-shortcut-card__surface" data-testid="folder-surface">
      {foreign ? <div className="folder-shortcut-card__state folder-shortcut-card__state--foreign"><p>This folder is on {alias.originDeviceName ?? "another device"}.</p><button className="folder-shortcut-card__repoint nodrag nopan" type="button" onClick={(event) => { event.stopPropagation(); onPointToLocalFolder(alias.id); }}>Point to a folder on this computer…</button></div> : preview === null ? <div className="folder-shortcut-card__state" role="status">Loading folder…</div> : preview.status === "ready" ? <><div className="folder-shortcut-card__rows">{rows.map((entry) => <div className="folder-shortcut-card__row" data-testid="folder-preview-row" key={`${entry.kind}-${entry.name}`}><span className={`folder-shortcut-card__icon folder-shortcut-card__icon--${entry.kind}`} aria-hidden="true">{entry.kind === "folder" ? "" : entry.name.split(".").pop()?.slice(0, 3)}</span><span className="folder-shortcut-card__name" title={entry.name}>{entry.name}</span><small>{detail(entry)}</small></div>)}</div><footer>{preview.hasMore || preview.entries.length > rows.length ? `${Math.max(0, preview.entries.length - rows.length)} more items` : "Live folder"}</footer></> : <div className="folder-shortcut-card__state">{messages[preview.status]}</div>}
    </section>
    <div className="folder-shortcut-card__resize nodrag nopan" data-testid="folder-resize" onPointerDown={(event) => { event.stopPropagation(); start.current = { x: event.clientX, y: event.clientY, width: alias.frame.width, height: alias.frame.height }; event.currentTarget.setPointerCapture?.(event.pointerId); window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); }} />
  </article>;
});
