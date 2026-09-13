import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResultDto, WorkspaceGateway } from "../services/workspace-gateway";
import { useWorkspaceSearch } from "./use-workspace-search";

/**
 * Search controller: the top-bar query, its results, and what selecting a result
 * does to the board.
 *
 * The debounce and latest-request-wins live in `useWorkspaceSearch`; this hook
 * owns the parts that belong to the board — where a result takes you, which card
 * to focus once you are there, and the temporary on-board highlight. It was
 * extracted from `App.tsx` unchanged: same order (navigate, then focus, then
 * highlight), same reset of the query on selection, same banner on failure.
 */

export interface SearchControllerOptions {
  gateway: WorkspaceGateway;
  /** Opens a board; resolved before the result's card is focused. */
  navigateTo: (
    boardId: string,
    options: { pushHistory?: boolean; tabMode?: "open" | "sync" },
  ) => Promise<void>;
  /** Surfaces a failed search on the caller's error banner. */
  onError: (message: string) => void;
}

export interface SearchController {
  query: string;
  results: SearchResultDto[];
  loading: boolean;
  /** The query to highlight on the canvas after a result was opened. */
  highlightQuery: string;
  /** A card the canvas should center and select once, identified by token. */
  focusRequest: { cardId: string; token: number } | null;
  onQueryChange: (query: string) => void;
  onClear: () => void;
  onSelect: (result: SearchResultDto) => Promise<void>;
}

export function useSearchController(options: SearchControllerOptions): SearchController {
  const { gateway, navigateTo, onError } = options;
  const { query, results, loading, error, setQuery, clear } = useWorkspaceSearch(gateway);

  const [focusRequest, setFocusRequest] = useState<{ cardId: string; token: number } | null>(null);
  const focusTokenRef = useRef(0);
  const [highlightQuery, setHighlightQuery] = useState("");

  const onQueryChange = useCallback(
    (next: string) => {
      setQuery(next);
      // Any edit to the search phrase invalidates a previous on-board highlight.
      setHighlightQuery("");
    },
    [setQuery],
  );

  const onClear = useCallback(() => {
    clear();
  }, [clear]);

  // The controller owns the debounce and latest-request-wins; a failed search is
  // still surfaced on the canvas error banner, exactly as before.
  useEffect(() => {
    if (error !== null) onError(error);
  }, [error, onError]);

  // Open the result's board. A Board result navigates to itself; a Note/Link
  // result navigates to its containing board and focuses the card (center +
  // select) once it is rendered.
  const onSelect = useCallback(
    async (result: SearchResultDto) => {
      const phrase = query.trim();
      clear();
      const targetBoardId = result.kind === "board" ? result.entityId : result.boardId;
      await navigateTo(targetBoardId, { pushHistory: true, tabMode: "open" });
      if (result.kind !== "board") {
        setFocusRequest({ cardId: result.entityId, token: ++focusTokenRef.current });
      }
      setHighlightQuery(phrase);
    },
    [clear, navigateTo, query],
  );

  return {
    query,
    results,
    loading,
    highlightQuery,
    focusRequest,
    onQueryChange,
    onClear,
    onSelect,
  };
}
