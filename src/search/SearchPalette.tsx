import { useEffect, useRef, useState } from "react";
import type { SearchResultDto } from "../services/workspace-gateway";
import "./search-palette.css";

interface SearchPaletteProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResultDto[];
  loading: boolean;
  onSelect: (result: SearchResultDto) => void;
  onClose: () => void;
}

function trailLabel(result: SearchResultDto): string {
  return result.boardTrail.map((crumb) => crumb.title).join(" / ");
}

/**
 * The V1 search palette. Controlled: the parent owns the query, debounce, and
 * fetch; this component owns input focus, result rendering, and keyboard
 * navigation (ArrowUp/ArrowDown/Enter/Escape).
 */
export function SearchPalette({
  query,
  onQueryChange,
  results,
  loading,
  onSelect,
  onClose,
}: SearchPaletteProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clamp the active index to the current result set; no reset effect needed.
  const clampIndex = (i: number) =>
    results.length === 0 ? 0 : Math.max(0, Math.min(i, results.length - 1));
  const index = clampIndex(activeIndex);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(clampIndex(activeIndex + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(clampIndex(activeIndex - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = results[index];
      if (result) onSelect(result);
    }
  }

  const showEmpty = !loading && query.trim() !== "" && results.length === 0;

  return (
    <div
      className="search-palette"
      role="dialog"
      aria-label="Search"
      data-testid="search-palette"
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        className="search-palette__input"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search boards, notes, and links"
        aria-label="Search"
      />
      <div className="search-palette__results">
        {loading && <p className="search-palette__status">Searching…</p>}
        {showEmpty && <p className="search-palette__empty">No results</p>}
        {!loading && results.length > 0 && (
          <ul className="search-palette__list" role="listbox" aria-label="Search results">
            {results.map((result, resultIndex) => (
              <li
                key={`${result.kind}:${result.entityId}`}
                className={`search-palette__item${
                  resultIndex === index ? " search-palette__item--active" : ""
                }`}
                role="option"
                aria-selected={resultIndex === index}
                onMouseEnter={() => setActiveIndex(resultIndex)}
                onClick={() => onSelect(result)}
              >
                <span className={`search-palette__kind search-palette__kind--${result.kind}`}>
                  {result.kind}
                </span>
                <span className="search-palette__body">
                  <span className="search-palette__title">{result.title || "(no title)"}</span>
                  {result.excerpt && (
                    <span className="search-palette__excerpt">{result.excerpt}</span>
                  )}
                  <span className="search-palette__trail">{trailLabel(result)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}