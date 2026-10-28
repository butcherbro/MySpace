import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteCard } from "./NoteCard";
import type { NoteCardDto } from "../../services/workspace-gateway";

// В отличие от NoteCard.test.tsx здесь настоящий Tiptap: ложная правка при
// открытии рождается внутри редактора (setEditable на монтировании), и мок
// NoteEditor её скрывает.

const note: NoteCardDto = {
  kind: "note",
  id: "note-1",
  boardId: "home",
  frame: { x: 0, y: 0, width: 240, height: 120 },
  zIndex: 0,
  revision: 1,
  groupId: null,
  documentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
  plainText: "hello",
  colorToken: "default",
};

afterEach(() => vi.useRealTimers());

describe("NoteCard with the real editor", () => {
  it("opening a note and typing nothing writes nothing", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <NoteCard
        note={note}
        editing
        onDeactivate={vi.fn()}
        onUpdate={onUpdate}
        onFinalize={onFinalize}
        onContextMenu={vi.fn()}
        onResize={vi.fn()}
      />,
    );

    // Дольше автосохранения (250 мс): грязный черновик успел бы уйти в onUpdate.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onUpdate).not.toHaveBeenCalled();
    expect(onFinalize).not.toHaveBeenCalled();
  });

  it("Enter in an opened, unchanged bare-link note reaches finalize", async () => {
    // Раньше это работало только через ложный update при монтировании (черновик
    // становился грязным); теперь Enter просит finalize принудительно.
    const urlDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "https://example.com" }] }],
    };
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <NoteCard
        note={{ ...note, documentJson: urlDoc, plainText: "https://example.com" }}
        editing
        onDeactivate={vi.fn()}
        onUpdate={onUpdate}
        onFinalize={onFinalize}
        onContextMenu={vi.fn()}
        onResize={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
    });

    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(onFinalize).toHaveBeenCalledWith("note-1", urlDoc, expect.anything());
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
