import { useRef, useState } from "react";
import type { SearchResultDto } from "../services/workspace-gateway";
import "./search-bar.css";

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResultDto[];
  loading: boolean;
  onSelect: (result: SearchResultDto) => void;
}

function trailLabel(result: SearchResultDto): string {
  return result.boardTrail.map((crumb) => crumb.title).join(" / ");
}

/**
 * The always-visible search field in the top bar (right of breadcrumbs, left of
 * Undo/Redo). Typing shows a dropdown of results; the parent owns query,
 * debounce, and fetch. Owns focus, active-result state, and keyboard navigation.
 */
export function SearchBar({ query, onQueryChange, results, loading, onSelect }: SearchBarProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const clampIndex = (i: number) =>
    results.length === 0 ? 0 : Math.max(0, Math.min(i, results.length - 1));
  const index = clampIndex(activeIndex);

  const open = query.trim() !== "";

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onQueryChange("");
      setActiveIndex(0);
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

  return (
    <div className="search-bar" data-testid="search-bar">
      <input
        ref={inputRef}
        className="search-bar__input"
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search"
        aria-label="Search"
        role="searchbox"
      />
      {open && (
        <div className="search-bar__results" data-testid="search-results">
          {loading && <p className="search-bar__status">Searching…</p>}
          {!loading && results.length === 0 && <p className="search-bar__empty">No results</p>}
          {!loading && results.length > 0 && (
            <ul className="search-bar__list" role="listbox" aria-label="Search results">
              {results.map((result, resultIndex) => (
                <li
                  key={`${result.kind}:${result.entityId}`}
                  className={`search-bar__item${
                    resultIndex === index ? " search-bar__item--active" : ""
                  }`}
                  role="option"
                  aria-selected={resultIndex === index}
                  onMouseEnter={() => setActiveIndex(resultIndex)}
                  onClick={() => onSelect(result)}
                >
                  <span className={`search-bar__kind search-bar__kind--${result.kind}`}>
                    {result.kind}
                  </span>
                  <span className="search-bar__body">
                    <span className="search-bar__title">{result.title || "(no title)"}</span>
                    {result.excerpt && (
                      <span className="search-bar__excerpt">{result.excerpt}</span>
                    )}
                    <span className="search-bar__trail">{trailLabel(result)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}