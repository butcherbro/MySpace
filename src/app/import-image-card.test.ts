import { describe, expect, it } from "vitest";
import type { AssetDto } from "../services/workspace-gateway";
import { buildCreateImageCardInput } from "./import-image-card";

describe("buildCreateImageCardInput", () => {
  it("uses the asset's own id, not any locally generated id", () => {
    // The backend deduplicates imports by content hash: `importAsset` can
    // return an EXISTING asset whose id differs from the id the frontend
    // generated before the call. Using the locally generated id here would
    // point `createImageCard` at a row that doesn't exist and fail the
    // foreign key check.
    const asset: AssetDto = {
      id: "existing-asset-42",
      fileName: "photo.png",
      mimeType: "image/png",
      width: 100,
      height: 80,
      sizeBytes: 1234,
      filePath: "existing-asset-42.png",
      sha256: "deadbeef",
    };

    const input = buildCreateImageCardInput({
      cardId: "card-1",
      boardId: "board-1",
      frame: { x: 0, y: 0, width: 100, height: 80 },
      zIndex: 0,
      asset,
      captionJson: null,
    });

    expect(input.assetId).toBe("existing-asset-42");
    expect(input.assetId).not.toBe("locally-generated-id");
    expect(input).toEqual({
      id: "card-1",
      boardId: "board-1",
      frame: { x: 0, y: 0, width: 100, height: 80 },
      zIndex: 0,
      assetId: "existing-asset-42",
      captionJson: null,
    });
  });
});
