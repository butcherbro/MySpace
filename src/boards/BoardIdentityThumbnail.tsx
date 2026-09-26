import type { CSSProperties } from "react";
import type { AssetDto } from "../services/workspace-gateway";
import "./board-identity-thumbnail.css";
import { assetUrl } from "../services/asset-url";

interface BoardIdentityThumbnailProps {
  title: string;
  colorToken: string;
  symbol: string | null;
  coverAsset: AssetDto | null;
  size: "portal" | "navigation" | "search";
  /** Decorative (aria-hidden) in tab/bookmark usage; the adjacent title names it. */
  decorative?: boolean;
}

// Maps a color token to its palette color (plan Visual Interface Contract).
const COLOR_VARS: Record<string, string> = {
  terracotta: "#c77b55",
  moss: "#899b71",
  sky: "#72a9c7",
  sand: "#c3a66d",
  ink: "#657482",
};

/** First grapheme, spanning surrogate pairs so emoji don't split. */
function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "·";
  return Array.from(trimmed)[0] ?? "·";
}

/**
 * The single replaceable visual identity of a Board: a cover image, or the
 * Board color + symbol fallback. Tabs, Quick Boards, and the portal tile all
 * use this so identity rendering is never duplicated.
 */
export function BoardIdentityThumbnail({
  title,
  colorToken,
  symbol,
  coverAsset,
  size,
  decorative = false,
}: BoardIdentityThumbnailProps) {
  const color = COLOR_VARS[colorToken] ?? COLOR_VARS.ink;
  const glyph = symbol ?? firstGrapheme(title);

  if (coverAsset) {
    return (
      <span
        className={`board-identity-thumbnail board-identity-thumbnail--${size}`}
        aria-hidden={decorative ? "true" : undefined}
      >
        <img
          className="board-identity-thumbnail__cover"
          src={assetUrl(coverAsset.filePath)}
          alt={decorative ? "" : title}
          aria-hidden={decorative ? "true" : undefined}
          draggable={false}
        />
      </span>
    );
  }

  return (
    <span
      className={`board-identity-thumbnail board-identity-thumbnail--${size}`}
      style={{ "--board-accent": color } as CSSProperties}
      aria-hidden={decorative ? "true" : undefined}
    >
      <span className="board-identity-thumbnail__symbol">{glyph}</span>
    </span>
  );
}