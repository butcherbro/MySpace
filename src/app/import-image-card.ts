import type { AssetDto, CreateImageCardInput, Frame } from "../services/workspace-gateway";

export interface ImageCardInputParams {
  cardId: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  /**
   * The asset DTO returned by `importAsset`/`importClipboardImage`. The
   * backend deduplicates imports by content hash, so this may be an existing
   * asset whose id differs from any id the frontend generated up front —
   * always build the card input from `asset.id`, never a locally generated id.
   */
  asset: AssetDto;
  captionJson: unknown;
}

/**
 * Builds the `createImageCard` input from a freshly imported asset. Pulled
 * out of `App.tsx` so the id-selection logic (use the returned asset's id,
 * not a locally generated one) can be unit tested directly.
 */
export function buildCreateImageCardInput(params: ImageCardInputParams): CreateImageCardInput {
  return {
    id: params.cardId,
    boardId: params.boardId,
    frame: params.frame,
    zIndex: params.zIndex,
    assetId: params.asset.id,
    captionJson: params.captionJson,
  };
}
