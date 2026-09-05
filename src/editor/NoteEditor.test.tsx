import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";

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
});
