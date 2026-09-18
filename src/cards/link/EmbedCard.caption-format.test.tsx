// Регресс на баг №24: read-only описание embed-карточки раньше рендерилось из
// descriptionPlainText (HighlightedText), теряя marks после blur. Этот файл не
// мокает NoteEditor — рендерит настоящий Tiptap, чтобы проверить реальный DOM.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EmbedCardDto } from "../../services/workspace-gateway";
import { EmbedCard } from "./EmbedCard";

function embed(overrides: Partial<EmbedCardDto> = {}): EmbedCardDto {
  return {
    kind: "embed",
    id: "embed-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 320, height: 240 },
    zIndex: 0,
    revision: 2,
    sourceUrl: "https://example.com",
    displayUrl: "example.com",
    siteName: null,
    title: "https://example.com",
    provider: null,
    descriptionJson: { type: "doc", content: [{ type: "paragraph" }] },
    descriptionPlainText: "",
    descriptionOrigin: null,
    faviconAsset: null,
    previewAsset: null,
    previewOrigin: null,
    metadataStatus: "pending",
    metadataError: null,
    ...overrides,
  };
}

const common = {
  onUpdate: vi.fn().mockResolvedValue(undefined),
  onResize: vi.fn(),
  onContextMenu: vi.fn(),
  onRetryMetadata: vi.fn(),
};

describe("EmbedCard description formatting (real Tiptap, read-only)", () => {
  it("renders a bold mark as <strong> outside edit mode", () => {
    const descriptionJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Loud", marks: [{ type: "bold" }] }],
        },
      ],
    };

    render(
      <EmbedCard
        embed={embed({ descriptionPlainText: "Loud", descriptionJson, descriptionOrigin: "user" })}
        {...common}
      />,
    );

    expect(screen.getByTestId("link-card")).toHaveAttribute("data-editing", "false");
    const strong = screen.getByText("Loud");
    expect(strong.tagName).toBe("STRONG");
  });
});
