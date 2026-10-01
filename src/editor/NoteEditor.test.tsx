import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";
import type { NoteEditorCommands } from "./editor-commands";

// Как буфер draft-handoff: набранное отдаётся один раз.
function handOnce(text: string): () => string {
  let left = text;
  return () => {
    const taken = left;
    left = "";
    return taken;
  };
}

const doc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

describe("NoteEditor", () => {
  it("renders the document text", () => {
    render(<NoteEditor document={doc} editable={false} onChange={vi.fn()} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("shows a document replaced from outside without reporting it as the user's change", () => {
    const onChange = vi.fn();
    const stored = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "stored" }] }] };
    const { rerender } = render(<NoteEditor document={doc} editable={true} onChange={onChange} />);

    // Mounting may report the initial document once; only the replacement matters here.
    onChange.mockClear();
    rerender(<NoteEditor document={stored} editable={true} onChange={onChange} />);

    expect(screen.getByText("stored")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("types the keystrokes handed to it at the end, Enter as a new paragraph and markup as text", () => {
    const onChange = vi.fn();
    const take = vi.fn(handOnce(" ab\n<b>c"));
    render(
      <NoteEditor
        document={doc}
        editable={true}
        onChange={onChange}
        initialCaretPoint="end"
        takeHandedInput={take}
      />,
    );

    // Однократность доказываем счётчиком вызовов, а не семантикой буфера.
    expect(take).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello ab" }] },
        { type: "paragraph", content: [{ type: "text", text: "<b>c" }] },
      ],
    });
  });

  it.each([
    ["without a click point", null],
    // В jsdom нет layout: posAtCoords бросает, поэтому проверяется ветка catch, а не null.
    ["when posAtCoords throws", { x: 5, y: 5 }],
  ])("opens a stored note with the caret at the end %s", (_, point) => {
    const onChange = vi.fn();
    // Документ в том же виде, что отдаёт getJSON(): setContent при монтировании
    // не срабатывает, и каретку в конец ставит только сам редактор.
    // Фокус синхронный (не в кадре Tiptap): набранное входит уже при монтировании.
    render(
      <NoteEditor
        document={doc}
        editable={true}
        onChange={onChange}
        initialCaretPoint={point}
        takeHandedInput={handOnce("!")}
      />,
    );

    expect(onChange).toHaveBeenLastCalledWith({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello!" }] }],
    });
  });

  it("reflects the editable flag after mount", () => {
    const { rerender } = render(
      <NoteEditor document={doc} editable={false} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");

    // Toggling `editable` after mount must update the underlying ProseMirror
    // (regression: useEditor only applies `editable` at creation time).
    rerender(<NoteEditor document={doc} editable={true} onChange={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true");
  });

  it("finalizes a single-url note on Enter instead of inserting a newline", () => {
    const onFinalize = vi.fn();
    const urlDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "https://example.com" }] }],
    };

    render(
      <NoteEditor
        document={urlDoc}
        editable={true}
        onChange={vi.fn()}
        onFinalize={onFinalize}
      />,
    );

    const editor = screen.getByRole("textbox");
    const prevented = !fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });

    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it("does not finalize mixed content on Enter", () => {
    const onFinalize = vi.fn();
    const mixedDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Read https://example.com" }] }],
    };

    render(
      <NoteEditor
        document={mixedDoc}
        editable={true}
        onChange={vi.fn()}
        onFinalize={onFinalize}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
    expect(onFinalize).not.toHaveBeenCalled();
  });

  it("renders a transient highlight without firing onChange", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <NoteEditor document={doc} editable={false} onChange={onChange} highlightQuery="" />,
    );
    const initialCalls = onChange.mock.calls.length;

    rerender(
      <NoteEditor document={doc} editable={false} onChange={onChange} highlightQuery="hell" />,
    );

    const mark = container.querySelector(".search-highlight");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("hell");
    // The meta-only highlight transaction must not emit `update`/`onChange`.
    expect(onChange.mock.calls.length).toBe(initialCalls);
  });

  it("clears the transient highlight when the query becomes empty", () => {
    const { container, rerender } = render(
      <NoteEditor document={doc} editable={false} onChange={vi.fn()} highlightQuery="hell" />,
    );
    expect(container.querySelector(".search-highlight")).not.toBeNull();

    rerender(
      <NoteEditor document={doc} editable={false} onChange={vi.fn()} highlightQuery="" />,
    );
    expect(container.querySelector(".search-highlight")).toBeNull();
  });

  it("exposes a Tiptap-free command surface while editing and clears it on exit", () => {
    const box: { commands: NoteEditorCommands | null } = { commands: null };
    const { rerender } = render(
      <NoteEditor
        document={doc}
        editable={true}
        onChange={vi.fn()}
        onCommandsReady={(c) => {
          box.commands = c;
        }}
      />,
    );
    expect(box.commands).not.toBeNull();
    expect(typeof box.commands?.toggleBold).toBe("function");
    expect(typeof box.commands?.isBoldActive).toBe("function");
    expect(typeof box.commands?.toggleItalic).toBe("function");
    expect(typeof box.commands?.isItalicActive).toBe("function");
    expect(typeof box.commands?.toggleStrike).toBe("function");
    expect(typeof box.commands?.isStrikeActive).toBe("function");

    rerender(
      <NoteEditor document={doc} editable={false} onChange={vi.fn()} onCommandsReady={(c) => {
        box.commands = c;
      }} />,
    );
    expect(box.commands).toBeNull();
  });

  it("reports the active text color and accepts a setTextColor call", () => {
    const box: { commands: NoteEditorCommands | null } = { commands: null };
    render(
      <NoteEditor
        document={doc}
        editable={true}
        onChange={vi.fn()}
        onCommandsReady={(c) => {
          box.commands = c;
        }}
      />,
    );
    expect(box.commands?.getTextColor()).toBe("default");
    expect(() => box.commands?.setTextColor("blue")).not.toThrow();
  });

  it("applies italic on toggleItalic and reports the active state", () => {
    const box: { commands: NoteEditorCommands | null } = { commands: null };
    const onItalicStateChange = vi.fn();
    render(
      <NoteEditor
        document={doc}
        editable={true}
        onChange={vi.fn()}
        onCommandsReady={(c) => {
          box.commands = c;
        }}
        onItalicStateChange={onItalicStateChange}
      />,
    );

    // Стартовое состояние репортится сразу при монтировании (as-is для Bold).
    expect(onItalicStateChange).toHaveBeenCalledWith(false);
    expect(box.commands?.isItalicActive()).toBe(false);

    box.commands?.toggleItalic();

    expect(box.commands?.isItalicActive()).toBe(true);
  });

  it("applies strike on toggleStrike and reports the active state", () => {
    const box: { commands: NoteEditorCommands | null } = { commands: null };
    const onStrikeStateChange = vi.fn();
    render(
      <NoteEditor
        document={doc}
        editable={true}
        onChange={vi.fn()}
        onCommandsReady={(c) => {
          box.commands = c;
        }}
        onStrikeStateChange={onStrikeStateChange}
      />,
    );

    expect(onStrikeStateChange).toHaveBeenCalledWith(false);
    expect(box.commands?.isStrikeActive()).toBe(false);

    box.commands?.toggleStrike();

    expect(box.commands?.isStrikeActive()).toBe(true);
  });

  // todo.md №13: pasting formatted text (Telegram/browser) into an OPEN note
  // editor must keep bold/italic/paragraphs — ProseMirror's own paste handler
  // runs on the contenteditable natively; nothing in NoteEditor intercepts or
  // downgrades the clipboard to text/plain, so this exercises the real default.
  it("keeps bold/italic marks and paragraph structure when pasting text/html", () => {
    const onChange = vi.fn();
    render(
      <NoteEditor
        document={{ type: "doc", content: [{ type: "paragraph", content: [] }] }}
        editable={true}
        onChange={onChange}
      />,
    );

    const editor = screen.getByRole("textbox");
    const html = "<p>plain <b>bold</b> and <i>italic</i></p><p>second paragraph</p>";
    const clipboardData = {
      getData: (type: string) => (type === "text/html" ? html : "plain bold and italic\nsecond paragraph"),
      types: ["text/html", "text/plain"],
    };
    fireEvent.paste(editor, { clipboardData });

    expect(onChange).toHaveBeenCalled();
    const calls = onChange.mock.calls;
    const doc = calls[calls.length - 1]?.[0] as {
      content: { type: string; content?: { marks?: { type: string }[] }[] }[];
    };
    expect(doc.content.map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
    const marks = doc.content[0].content?.flatMap((n) => n.marks?.map((m) => m.type) ?? []) ?? [];
    expect(marks).toContain("bold");
    expect(marks).toContain("italic");
  });

  it("pastes plain text as-is when the clipboard has no text/html", () => {
    const onChange = vi.fn();
    render(
      <NoteEditor
        document={{ type: "doc", content: [{ type: "paragraph", content: [] }] }}
        editable={true}
        onChange={onChange}
      />,
    );

    const editor = screen.getByRole("textbox");
    const clipboardData = {
      getData: (type: string) => (type === "text/plain" ? "just plain text" : ""),
      types: ["text/plain"],
    };
    fireEvent.paste(editor, { clipboardData });

    expect(onChange).toHaveBeenCalled();
    const calls = onChange.mock.calls;
    const doc = calls[calls.length - 1]?.[0] as { content: { content?: { text?: string; marks?: unknown[] }[] }[] };
    expect(doc.content[0].content?.[0]?.text).toBe("just plain text");
    expect(doc.content[0].content?.[0]?.marks ?? []).toEqual([]);
  });
});
