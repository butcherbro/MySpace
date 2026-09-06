import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardIdentityThumbnail } from "./BoardIdentityThumbnail";
import type { AssetDto } from "../services/workspace-gateway";

const cover: AssetDto = {
  id: "asset-1",
  fileName: "cover.png",
  mimeType: "image/png",
  width: null,
  height: null,
  sizeBytes: 0,
  filePath: "asset-1.png",
};

describe("BoardIdentityThumbnail", () => {
  it("renders the cover asset as an image with a useful alt in portal usage", () => {
    render(
      <BoardIdentityThumbnail
        title="Books"
        colorToken="terracotta"
        symbol={null}
        coverAsset={cover}
        size="portal"
      />,
    );
    const img = screen.getByRole("img", { name: "Books" });
    expect(img).toHaveAttribute("src", "myspace-asset://localhost/asset-1.png");
  });

  it("renders the cover as decorative when decorative is set", () => {
    const { container } = render(
      <BoardIdentityThumbnail
        title="Books"
        colorToken="terracotta"
        symbol={null}
        coverAsset={cover}
        size="navigation"
        decorative
      />,
    );
    const img = container.querySelector(".board-identity-thumbnail__cover");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the board color and symbol when there is no cover", () => {
    render(
      <BoardIdentityThumbnail
        title="Books"
        colorToken="moss"
        symbol="B"
        coverAsset={null}
        size="portal"
      />,
    );
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("falls back to the first grapheme of the title when there is no symbol", () => {
    render(
      <BoardIdentityThumbnail
        title="YouTube Services"
        colorToken="sky"
        symbol={null}
        coverAsset={null}
        size="navigation"
      />,
    );
    expect(screen.getByText("Y")).toBeInTheDocument();
  });
});