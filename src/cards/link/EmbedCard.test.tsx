import { fireEvent, render, screen } from "@testing-library/react";
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

describe("EmbedCard metadata states", () => {
  it("shows a quiet loading state while metadata is pending", () => {
    render(<EmbedCard embed={embed()} {...common} />);

    expect(screen.getByText("Loading preview…")).toBeInTheDocument();
  });

  it("offers an explicit retry when metadata loading failed", () => {
    const onRetryMetadata = vi.fn();
    render(
      <EmbedCard
        embed={embed({ metadataStatus: "failed", metadataError: "timeout" })}
        {...common}
        onRetryMetadata={onRetryMetadata}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(onRetryMetadata).toHaveBeenCalledWith("embed-1");
  });

  it("grows a ready preview to reveal all enriched content", () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(418);
    const onResize = vi.fn();

    render(
      <EmbedCard
        embed={embed({
          frame: { x: 0, y: 0, width: 320, height: 120 },
          metadataStatus: "ready",
          title: "Loaded title",
          descriptionPlainText: "Loaded description",
        })}
        {...common}
        onResize={onResize}
      />,
    );

    expect(onResize).toHaveBeenCalledWith("embed-1", 320, 418);
    scrollHeight.mockRestore();
  });

  it("does not shrink a card that is already taller than its content", () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(240);
    const onResize = vi.fn();

    render(
      <EmbedCard
        embed={embed({ metadataStatus: "ready", frame: { x: 0, y: 0, width: 320, height: 360 } })}
        {...common}
        onResize={onResize}
      />,
    );

    expect(onResize).not.toHaveBeenCalled();
    scrollHeight.mockRestore();
  });
});
