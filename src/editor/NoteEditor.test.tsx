import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";
import type { NoteEditorCommands } from "./editor-commands";

const doc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

describe("NoteEditor", () => {
  it("renders the document text", () => {
    render(<NoteEditor document={doc} editable={false} onChange={vi.fn()} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
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

    rerender(
      <NoteEditor document={doc} editable={false} onChange={vi.fn()} onCommandsReady={(c) => {
        box.commands = c;
      }} />,
    );
    expect(box.commands).toBeNull();
  });
});
