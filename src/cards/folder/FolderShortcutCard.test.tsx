import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FilesystemAliasDto, FolderPreviewDto } from "../../services/workspace-gateway";
import { FolderShortcutCard } from "./FolderShortcutCard";

const alias = (overrides: Partial<FilesystemAliasDto> = {}): FilesystemAliasDto => ({ kind: "filesystem_alias", id: "folder-1", boardId: "home", frame: { x: 0, y: 0, width: 360, height: 300 }, zIndex: 0, revision: 1, targetKind: "folder", pathHint: "/Users/me/Video project", displayName: "Video project", originDeviceId: "this-mac", originDeviceName: "This Mac", local: true, ...overrides });
const ready: FolderPreviewDto = { status: "ready", entries: [{ name: "Footage", kind: "folder", sizeBytes: null, childCount: 6 }, { name: "an-extremely-long-file-name-that-must-truncate.mov", kind: "file", sizeBytes: 1024, childCount: null }, { name: "shots.csv", kind: "file", sizeBytes: 42, childCount: null }], hasMore: true, displayName: "Video project", pathHint: "/Users/me/Video project" };

describe("FolderShortcutCard", () => {
  it("renders one blue folder surface with direct preview rows and no nested paper card", async () => {
    render(<FolderShortcutCard alias={alias()} loadPreview={vi.fn().mockResolvedValue(ready)} onOpenFinder={vi.fn()} onResize={vi.fn()} onContextMenu={vi.fn()} onPointToLocalFolder={vi.fn()} />);
    await screen.findByText("Footage");
    expect(screen.getByTestId("folder-shortcut-card")).toHaveClass("folder-shortcut-card");
    expect(screen.getByTestId("folder-surface")).toContainElement(screen.getByText("Footage"));
    expect(screen.queryByTestId("folder-paper-card")).not.toBeInTheDocument();
  });

  it("truncates long names, exposes every status, and opens Finder", async () => {
    const open = vi.fn(); const load = vi.fn().mockResolvedValue(ready);
    const { rerender } = render(<FolderShortcutCard alias={alias()} loadPreview={load} onOpenFinder={open} onResize={vi.fn()} onContextMenu={vi.fn()} onPointToLocalFolder={vi.fn()} />);
    await screen.findByText("Footage");
    expect(screen.getByText(/extremely-long/)).toHaveClass("folder-shortcut-card__name");
    fireEvent.click(screen.getByRole("button", { name: "Open Video project in Finder" }));
    expect(open).toHaveBeenCalledWith("folder-1");
    for (const status of ["empty", "missing", "permission_lost", "io_error"] as const) {
      rerender(<FolderShortcutCard alias={alias({ id: status })} loadPreview={vi.fn().mockResolvedValue({ ...ready, status, entries: [] })} onOpenFinder={open} onResize={vi.fn()} onContextMenu={vi.fn()} onPointToLocalFolder={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId("folder-shortcut-card")).toHaveAttribute("data-preview-status", status));
    }
  });

  it("loads once, keeps at least two rows for a short card, and persists a 280x180 minimum resize", async () => {
    const load = vi.fn().mockResolvedValue(ready); const resize = vi.fn();
    render(<FolderShortcutCard alias={alias({ frame: { x: 0, y: 0, width: 300, height: 180 } })} loadPreview={load} onOpenFinder={vi.fn()} onResize={resize} onContextMenu={vi.fn()} onPointToLocalFolder={vi.fn()} />);
    await screen.findByText("Footage");
    expect(screen.getAllByTestId("folder-preview-row")).toHaveLength(2);
    const handle = screen.getByTestId("folder-resize");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 }); fireEvent.pointerMove(window, { clientX: -100, clientY: -100 }); fireEvent.pointerUp(window, { clientX: -100, clientY: -100 });
    expect(resize).toHaveBeenCalledWith("folder-1", 280, 180);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("renders a shortcut from another device dimmed, badged, unopenable and without a preview (ADR-0012)", () => {
    const load = vi.fn().mockResolvedValue(ready); const open = vi.fn(); const point = vi.fn();
    render(<FolderShortcutCard alias={alias({ local: false, originDeviceId: "studio-mac", originDeviceName: "Studio Mac" })} loadPreview={load} onOpenFinder={open} onResize={vi.fn()} onContextMenu={vi.fn()} onPointToLocalFolder={point} />);
    const card = screen.getByTestId("folder-shortcut-card");
    expect(card).toHaveAttribute("data-foreign", "true");
    expect(card).toHaveAttribute("data-preview-status", "foreign_device");
    const badge = screen.getByTestId("folder-origin-badge");
    expect(badge).toHaveTextContent("On Studio Mac");
    expect(badge).toHaveAttribute("title", "/Users/me/Video project");
    const openButton = screen.getByRole("button", { name: "Open Video project in Finder" });
    expect(openButton).toBeDisabled();
    fireEvent.click(openButton);
    expect(open).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Point to a folder on this computer…" }));
    expect(point).toHaveBeenCalledWith("folder-1");
  });

  it("names an unknown origin 'another device' and loads the preview once the shortcut turns local", async () => {
    const load = vi.fn().mockResolvedValue(ready);
    const foreign = alias({ local: false, originDeviceId: "unknown", originDeviceName: null });
    const { rerender } = render(<FolderShortcutCard alias={foreign} loadPreview={load} onOpenFinder={vi.fn()} onResize={vi.fn()} onContextMenu={vi.fn()} onPointToLocalFolder={vi.fn()} />);
    expect(screen.getByTestId("folder-origin-badge")).toHaveTextContent("On another device");
    rerender(<FolderShortcutCard alias={{ ...foreign, local: true }} loadPreview={load} onOpenFinder={vi.fn()} onResize={vi.fn()} onContextMenu={vi.fn()} onPointToLocalFolder={vi.fn()} />);
    await screen.findByText("Footage");
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("folder-shortcut-card")).not.toHaveAttribute("data-foreign");
    expect(screen.queryByTestId("folder-origin-badge")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Video project in Finder" })).toBeEnabled();
  });
});
