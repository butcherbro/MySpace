// Регресс на баг №24: read-only подпись под картинкой раньше рендерилась из
// captionPlainText (HighlightedText), теряя marks после blur. Этот файл не
// мокает NoteEditor — рендерит настоящий Tiptap, чтобы проверить реальный DOM.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImageCardDto } from "../../services/workspace-gateway";
import { ImageCard } from "./ImageCard";

function makeImage(overrides: Partial<ImageCardDto> = {}): ImageCardDto {
  return {
    kind: "image",
    id: "image-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 320, height: 240 },
    zIndex: 0,
    revision: 1,
    asset: {
      id: "asset-1",
      fileName: "photo.png",
      mimeType: "image/png",
      width: 800,
      height: 600,
      sizeBytes: 12345,
      filePath: "assets/photo.png",
    },
    captionJson: { type: "doc", content: [{ type: "paragraph" }] },
    captionPlainText: "",
    ...overrides,
  };
}

describe("ImageCard caption formatting (real Tiptap, read-only)", () => {
  it("renders a bold mark as <strong> outside edit mode", () => {
    const captionJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Loud", marks: [{ type: "bold" }] }],
        },
      ],
    };

    render(
      <ImageCard
        image={makeImage({ captionPlainText: "Loud", captionJson })}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        onResize={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByTestId("image-card")).toHaveAttribute("data-editing", "false");
    const strong = screen.getByText("Loud");
    expect(strong.tagName).toBe("STRONG");
  });
});
