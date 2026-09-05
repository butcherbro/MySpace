import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImageCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";
import { ImageCard } from "./ImageCard";

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    void rej;
  });
  return { promise, resolve };
}

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
    captionPlainText: "Caption",
    ...overrides,
  };
}

describe("ImageCard", () => {
  it("renders a quiet no-caption state without the paper strip", () => {
    render(
      <ImageCard
        image={makeImage({ captionPlainText: "" })}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        onResize={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByTestId("image-card")).toHaveAttribute("data-has-caption", "false");
    expect(screen.getByTestId("image-card")).toHaveClass("image-card--no-caption");
    expect(screen.getByText("Add caption…")).toBeInTheDocument();
  });

  it("exposes the image semantic kind and caption state", () => {
    render(
      <ImageCard
        image={makeImage({ captionPlainText: "Caption" })}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        onResize={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByTestId("image-card")).toHaveAttribute("data-kind", "image");
    expect(screen.getByTestId("image-card")).toHaveAttribute("data-has-caption", "true");
    expect(screen.getByTestId("image-card")).toHaveClass("image-card--has-caption");
    expect(screen.getByText("Caption")).toBeInTheDocument();
  });

  it("marks editing and passes editable=true to the caption editor", () => {
    render(
      <ImageCard
        image={makeImage()}
        onUpdate={vi.fn().mockResolvedValue(undefined)}
        onResize={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText("Caption"));

    expect(screen.getByTestId("image-card")).toHaveAttribute("data-editing", "true");
    expect(screen.getByTestId("image-card")).toHaveClass("image-card--editing");
    expect(lastEditorProps()?.editable).toBe(true);
  });

  it("shows saving while the caption flush is in flight", async () => {
    const save = deferred<void>();
    render(
      <ImageCard
        image={makeImage()}
        onUpdate={vi.fn().mockReturnValue(save.promise)}
        onResize={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText("Caption"));
    act(() => lastEditorProps()?.onChange({ type: "doc", content: [{ type: "paragraph" }] }));
    await act(async () => {
      await lastEditorProps()?.onBlur?.();
    });

    expect(screen.getByTestId("image-card")).toHaveAttribute("data-saving", "true");
    expect(screen.getByTestId("image-card")).toHaveClass("image-card--saving");

    await act(async () => {
      save.resolve();
    });

    expect(screen.getByTestId("image-card")).toHaveAttribute("data-saving", "false");
  });

  it("marks errors when the caption save fails", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error("boom"));
    render(
      <ImageCard
        image={makeImage()}
        onUpdate={onUpdate}
        onResize={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText("Caption"));
    act(() => lastEditorProps()?.onChange({ type: "doc", content: [{ type: "paragraph" }] }));
    await act(async () => {
      await lastEditorProps()?.onBlur?.();
    });

    expect(screen.getByTestId("image-card")).toHaveAttribute("data-error", "true");
    expect(screen.getByTestId("image-card")).toHaveClass("image-card--error");
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
