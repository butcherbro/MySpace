import { memo, useMemo } from "react";
import { StaticDocument } from "./StaticDocument";
import { recoveredDocument } from "./corrupt-document";
import "./damaged-document.css";

interface DamagedDocumentProps {
  /** What is damaged, for the banner: "note", "caption", "description". */
  label: string;
  /** The last stored plain text: the only recoverable content. */
  plainText: string;
  /** Start a repair: seed an editor with the recovered text. */
  onRepair: () => void;
  highlightQuery?: string;
}

/**
 * P1.7: the read-only state of a card whose stored document is corrupt. Shows
 * the recovered plain text through the static (no-editor) path and a Repair
 * action; nothing here can type into or save the card.
 */
export const DamagedDocument = memo(function DamagedDocument({
  label,
  plainText,
  onRepair,
  highlightQuery = "",
}: DamagedDocumentProps) {
  const document = useMemo(() => recoveredDocument(plainText), [plainText]);
  return (
    <div className="damaged-document" data-testid="damaged-document">
      <div className="damaged-document__banner" role="status">
        Damaged {label} — showing recovered text
      </div>
      <StaticDocument document={document} highlightQuery={highlightQuery} />
      <button
        type="button"
        className="damaged-document__repair nodrag nopan"
        data-testid="repair-document"
        onClick={onRepair}
      >
        Repair
      </button>
    </div>
  );
});
