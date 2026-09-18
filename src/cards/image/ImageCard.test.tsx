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

  describe("fullscreen preview", () => {
    // React Flow позиционирует карточки через CSS `transform` на узле-обёртке.
    // Любой предок с `transform` становится containing block для `position: fixed`
    // потомков (это в спеке CSS), поэтому просмотр раньше "прилипал" к позиции
    // миниатюры и уходил за край экрана вместо того, чтобы покрыть весь viewport.
    // Заворачиваем карточку в такой же трансформированный контейнер, чтобы тест
    // ловил регрессию, а не проходил случайно из-за отсутствия transform в jsdom.
    function renderInsideTransformedCanvasNode() {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-testid", "react-flow-node-stand-in");
      wrapper.style.transform = "translate(50px, 900px) scale(0.4)";
      wrapper.style.overflow = "hidden";
      document.body.appendChild(wrapper);

      render(
        <ImageCard
          image={makeImage()}
          onUpdate={vi.fn().mockResolvedValue(undefined)}
          onResize={vi.fn()}
          onContextMenu={vi.fn()}
        />,
        { container: wrapper },
      );

      return wrapper;
    }

    it("opens the preview on a double click of the image", () => {
      renderInsideTransformedCanvasNode();

      expect(screen.queryByTestId("image-preview")).not.toBeInTheDocument();
      fireEvent.doubleClick(screen.getByAltText("photo.png"));
      expect(screen.getByTestId("image-preview")).toBeInTheDocument();
    });

    it("renders the preview outside the transformed card ancestor (portal to document.body)", () => {
      const wrapper = renderInsideTransformedCanvasNode();
      fireEvent.doubleClick(screen.getByAltText("photo.png"));

      const preview = screen.getByTestId("image-preview");
      // Если бы просмотр остался вложенным узлом карточки, он бы читал
      // `position: fixed` относительно трансформированного `wrapper` (баг) —
      // и оказывался бы где-то возле миниатюры, а не по центру окна.
      expect(wrapper.contains(preview)).toBe(false);
      expect(document.body.contains(preview)).toBe(true);
    });

    it("closes the preview on click and on Escape", () => {
      renderInsideTransformedCanvasNode();
      fireEvent.doubleClick(screen.getByAltText("photo.png"));
      expect(screen.getByTestId("image-preview")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("image-preview"));
      expect(screen.queryByTestId("image-preview")).not.toBeInTheDocument();

      fireEvent.doubleClick(screen.getByAltText("photo.png"));
      expect(screen.getByTestId("image-preview")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByTestId("image-preview")).not.toBeInTheDocument();
    });
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
