import { render, screen } from "@testing-library/react";
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
});
