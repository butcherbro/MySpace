import { describe, expect, it } from "vitest";
import {
  computeInitialImageFrameSize,
  computeResizedImageFrameSize,
  CAPTION_BASE_HEIGHT,
  DEFAULT_IMAGE_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
} from "./image-card-geometry";

describe("computeInitialImageFrameSize", () => {
  it("sizes the frame to the image's aspect ratio at the default width", () => {
    // Портретный скриншот 1080x1920 — раньше карточка обрезала его под 320x240.
    const { width, height } = computeInitialImageFrameSize(1080, 1920);
    expect(width).toBe(DEFAULT_IMAGE_WIDTH);
    const expectedImageArea = DEFAULT_IMAGE_WIDTH * (1920 / 1080);
    expect(height).toBe(Math.round(expectedImageArea + CAPTION_BASE_HEIGHT));
  });

  it("falls back to the legacy 320x240 default when natural size is unknown", () => {
    expect(computeInitialImageFrameSize(null, null)).toEqual({ width: 320, height: 240 });
    expect(computeInitialImageFrameSize(0, 0)).toEqual({ width: 320, height: 240 });
  });

  it("never produces a height below the DB minimum for extreme wide images", () => {
    const { height } = computeInitialImageFrameSize(4000, 10);
    expect(height).toBeGreaterThanOrEqual(MIN_CARD_HEIGHT);
  });
});

describe("computeResizedImageFrameSize", () => {
  it("keeps the image area locked to the aspect ratio as width changes", () => {
    const aspect = 1080 / 1920; // width / height
    const captionHeight = 40;
    const { width, height } = computeResizedImageFrameSize(540, aspect, captionHeight);
    expect(width).toBe(540);
    expect(height).toBe(Math.round(540 / aspect + captionHeight));
  });

  it("falls back to unconstrained square-ish sizing without a known aspect ratio", () => {
    const { width, height } = computeResizedImageFrameSize(500, null, 40);
    expect(width).toBe(500);
    expect(height).toBeGreaterThanOrEqual(MIN_CARD_HEIGHT);
  });

  it("clamps width to the DB minimum", () => {
    const { width } = computeResizedImageFrameSize(10, 1, 40);
    expect(width).toBe(MIN_CARD_WIDTH);
  });
});
