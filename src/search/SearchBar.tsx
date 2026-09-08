import { useEffect, useMemo, useRef, useState } from "react";
import { BoardIdentityThumbnail } from "../boards/BoardIdentityThumbnail";
import { HighlightedText } from "../components/HighlightedText";
import type { SearchResultDto } from "../services/workspace-gateway";
import "./search-bar.css";

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: SearchResultDto[];
  loading: boolean;
  onSelect: (result: SearchResultDto) => void;
}

interface GroupEntry {
  result: SearchResultDto;
  flatIndex: number;
}

function boardTitle(result: SearchResultDto): string {
  const trail = result.boardTrail;
  return trail[trail.length - 1]?.title ?? "(board)";
}

function trailLabel(result: SearchResultDto): string {
  return result.boardTrail.map((crumb) => crumb.title).join(" / ");
}

function formatRelativeTime(millis: number): string {
  if (!millis) return "";
  const diff = Date.now() - millis;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч.`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн.`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} нед.`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес.`;
  const years = Math.floor(days / 365);
  return `${years} г.`;
}

/**
 * The always-visible search field in the top bar (right of breadcrumbs, left of
 * Undo/Redo). Results are grouped by board (cover/icon/acronym + path + count),
 * with matching substrings highlighted. The parent owns query, debounce, fetch,
 * and result activation.
 */
export function SearchBar({ query, onQueryChange, results, loading, onSelect }: SearchBarProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const clampIndex = (i: number) =>
    results.length === 0 ? 0 : Math.max(0, Math.min(i, results.length - 1));
  const index = clampIndex(activeIndex);

  const open = query.trim() !== "";

  // Clicking anywhere outside the search control closes it (clears the query),
  // so the panel does not linger until the user erases the field.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        onQueryChange("");
        setActiveIndex(0);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onQueryChange]);

  // Group results by board, preserving each result's flat index for keyboard
  // navigation and the active highlight.
  const groups = useMemo(() => {
    const map = new Map<string, GroupEntry[]>();
    results.forEach((result, flatIndex) => {
      const entries = map.get(result.boardId) ?? [];
      entries.push({ result, flatIndex });
      map.set(result.boardId, entries);
    });
    return Array.from(map.entries());
  }, [results]);

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
    <div className="search-bar" data-testid="search-bar" ref={rootRef}>
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
            <ul className="search-bar__groups" role="listbox" aria-label="Search results">
              {groups.map(([boardId, entries]) => {
                const first = entries[0].result;
                return (
                  <li key={boardId} className="search-bar__group">
                    <div className="search-bar__group-header">
                      <BoardIdentityThumbnail
                        title={boardTitle(first)}
                        colorToken={first.boardColorToken}
                        symbol={first.boardSymbol}
                        coverAsset={first.boardCoverAsset}
                        size="search"
                        decorative
                      />
                      <div className="search-bar__group-meta">
                        <span className="search-bar__group-title">{boardTitle(first)}</span>
                        <span className="search-bar__group-trail">{trailLabel(first)}</span>
                      </div>
                      <span className="search-bar__group-count">{entries.length}</span>
                    </div>
                    <ul className="search-bar__items">
                      {entries.map(({ result, flatIndex }) => (
                        <li
                          key={`${result.kind}:${result.entityId}`}
                          className={`search-bar__item${
                            flatIndex === index ? " search-bar__item--active" : ""
                          }`}
                          role="option"
                          aria-selected={flatIndex === index}
                          onMouseEnter={() => setActiveIndex(flatIndex)}
                          onClick={() => onSelect(result)}
                        >
                          <span className="search-bar__thumb">
                            {result.kind === "board" ? (
                              <BoardIdentityThumbnail
                                title={result.title}
                                colorToken={result.boardColorToken}
                                symbol={result.boardSymbol}
                                coverAsset={result.thumbnailAsset}
                                size="portal"
                                decorative
                              />
                            ) : result.thumbnailAsset ? (
                              <img
                                className="search-bar__thumb-img"
                                src={`myspace-asset://localhost/${result.thumbnailAsset.filePath}`}
                                alt=""
                              />
                            ) : (
                              <span className={`search-bar__kind search-bar__kind--${result.kind}`}>
                                {result.kind}
                              </span>
                            )}
                          </span>
                          <span className="search-bar__body">
                            <span className="search-bar__title">
                              <HighlightedText text={result.title || "(no title)"} query={query} />
                            </span>
                            {result.excerpt && (
                              <span className="search-bar__excerpt">
                                <HighlightedText text={result.excerpt} query={query} />
                              </span>
                            )}
                          </span>
                          <span className="search-bar__time">
                            {formatRelativeTime(result.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}