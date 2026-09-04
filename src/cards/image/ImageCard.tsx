import type { AssetDto } from "../../services/workspace-gateway";
import "./image-card.css";

interface ImageCardProps {
  asset: AssetDto;
  captionPlainText: string;
}

/**
 * An image card: a static image with a caption beneath it (caption editing
 * arrives in a later step). The image is served via the `myspace-asset`
 * protocol by its relative `filePath`.
 */
export function ImageCard({ asset, captionPlainText }: ImageCardProps) {
  const src = `myspace-asset://localhost/${asset.filePath}`;
  return (
    <div className="image-card" data-testid="image-card">
      <div className="image-card__image">
        <img src={src} alt={asset.fileName} />
      </div>
      {captionPlainText ? (
        <div className="image-card__caption">{captionPlainText}</div>
      ) : null}
    </div>
  );
}
