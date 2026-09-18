import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileCardDto } from "../../services/workspace-gateway";
import { FileCard } from "./FileCard";

function fileCard(overrides: Partial<FileCardDto> = {}): FileCardDto {
  return {
    kind: "file",
    id: "file-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 320, height: 240 },
    zIndex: 0,
    revision: 1,
    asset: {
      id: "asset-1",
      filePath: "asset-1.html",
      fileName: "report.html",
      mimeType: "text/html",
      width: null,
      height: null,
      sizeBytes: 2048,
    },
    previewText: "",
    previewAsset: null,
    ...overrides,
  } as unknown as FileCardDto;
}

const props = {
  onOpen: vi.fn(),
  onReveal: vi.fn(),
  onResize: vi.fn(),
  onContextMenu: vi.fn(),
};

describe("FileCard", () => {
  it("frames HTML previews in a fully sandboxed iframe over the asset protocol", () => {
    // The preview is untrusted content: a sandboxed, script-free iframe is the
    // only thing keeping a dropped HTML file away from the app's own origin and
    // from Tauri IPC. This is the guard for that boundary.
    render(<FileCard file={fileCard()} {...props} />);

    const frame = screen.getByTestId("file-preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("src", "myspace-asset://localhost/asset-1.html");
    expect(frame).toHaveAttribute("tabindex", "-1");
  });

  it("never frames a HTML preview from any other scheme", () => {
    render(<FileCard file={fileCard()} {...props} />);

    const src = screen.getByTestId("file-preview").getAttribute("src") ?? "";
    expect(src.startsWith("myspace-asset://")).toBe(true);
  });

  it("shows a text preview instead of a frame for plain-text files", () => {
    render(
      <FileCard
        file={fileCard({
          asset: {
            id: "asset-2",
            filePath: "asset-2.txt",
            fileName: "notes.txt",
            mimeType: "text/plain",
            width: null,
            height: null,
            sizeBytes: 10,
          },
          previewText: "hello from the file",
        } as unknown as Partial<FileCardDto>)}
        {...props}
      />,
    );

    const preview = screen.getByTestId("file-preview");
    expect(preview.tagName).toBe("PRE");
    expect(preview).toHaveTextContent("hello from the file");
    expect(screen.queryByTestId("file-preview")).not.toHaveAttribute("sandbox");
  });

  it("renders .md files as markdown through the same sandboxed iframe as HTML, not raw text", () => {
    // The backend renders markdown -> HTML on the fly behind myspace-asset://
    // (see src-tauri/src/lib.rs), so a table shows as a <table>, never as the
    // raw "| a | b |" source. This is what todo.md #21 asks for.
    render(
      <FileCard
        file={fileCard({
          asset: {
            id: "asset-4",
            filePath: "asset-4.md",
            fileName: "PIPELINE_MAP.md",
            mimeType: "text/markdown",
            width: null,
            height: null,
            sizeBytes: 10,
          },
          previewText: "| a | b |\n| --- | --- |\n| 1 | 2 |",
        } as unknown as Partial<FileCardDto>)}
        {...props}
      />,
    );

    const frame = screen.getByTestId("file-preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("src", "myspace-asset://localhost/asset-4.md");
    expect(screen.queryByText("| a | b |", { exact: false })).not.toBeInTheDocument();
  });

  it("uses the stored thumbnail asset when there is one", () => {
    const { container } = render(
      <FileCard
        file={fileCard({
          asset: {
            id: "asset-3",
            filePath: "asset-3.pdf",
            fileName: "deck.pdf",
            mimeType: "application/pdf",
            width: null,
            height: null,
            sizeBytes: 10,
          },
          previewAsset: {
            id: "thumb-1",
            filePath: "thumb-1.png",
            fileName: "thumb-1.png",
            mimeType: "image/png",
            width: 320,
            height: 240,
            sizeBytes: 20,
          },
        } as unknown as Partial<FileCardDto>)}
        {...props}
      />,
    );

    // A thumbnail is served over the same scheme the CSP allows for images.
    // `alt=""` makes it presentational, so it is queried by class, not by role.
    expect(container.querySelector("img.file-card__thumb")).toHaveAttribute(
      "src",
      "myspace-asset://localhost/thumb-1.png",
    );
  });
});
