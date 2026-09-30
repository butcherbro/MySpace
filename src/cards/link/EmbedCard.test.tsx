import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EmbedCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";
import { EmbedCard } from "./EmbedCard";

vi.mock("../../editor/NoteEditor", () => ({
  NoteEditor: vi.fn(
    (props: { document: unknown; editable: boolean; onChange: (doc: unknown) => void; onBlur?: () => void }) => (
      <textarea data-testid="mock-editor" onBlur={() => props.onBlur?.()} />
    ),
  ),
}));

type MockEditorProps = {
  document: unknown;
  editable: boolean;
  onChange: (doc: unknown) => void;
  onBlur?: () => void;
};

function lastEditorProps(): MockEditorProps | undefined {
  const mock = NoteEditor as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[mock.mock.calls.length - 1]?.[0] as MockEditorProps | undefined;
}

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

describe("EmbedCard metadata states", () => {
  it("exposes the link semantic kind and metadata state", () => {
    render(
      <EmbedCard
        embed={embed({ metadataStatus: "ready", previewAsset: { id: "preview-1", fileName: "preview.png", mimeType: "image/png", width: 100, height: 80, sizeBytes: 1, filePath: "previews/preview.png" } })}
        {...common}
      />,
    );

    expect(screen.getByTestId("link-card")).toHaveAttribute("data-kind", "link");
    expect(screen.getByTestId("link-card")).toHaveAttribute("data-metadata-status", "ready");
    expect(screen.getByTestId("link-card")).toHaveAttribute("data-has-preview", "true");
  });

  it("marks editing and passes editable=true to the description editor", () => {
    render(
      <EmbedCard
        embed={embed({ metadataStatus: "ready" })}
        {...common}
      />,
    );

    fireEvent.doubleClick(screen.getByText("Add notes…"));

    expect(screen.getByTestId("link-card")).toHaveAttribute("data-editing", "true");
    expect(lastEditorProps()?.editable).toBe(true);
  });

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

    expect(onResize).toHaveBeenCalledWith("embed-1", 320, 418, { auto: true });
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
