import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../services/error-message";
import type { SearchResultDto, WorkspaceGateway } from "../services/workspace-gateway";

export interface WorkspaceSearchController {
  query: string;
  results: SearchResultDto[];
  loading: boolean;
  error: string | null;
  setQuery: (query: string) => void;
  clear: () => void;
}

const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Latest-request-wins workspace search.
 *
 * Every accepted query takes a monotonically increasing token, and a response is
 * only applied while its token is still the newest one. Without that, a slow
 * response for "pro" can land after the response for "project" and replace the
 * newer results; it would also clear `loading` (and report a stale error) while
 * the newer request is still in flight. Clearing the query invalidates everything
 * pending and empties the results.
 */
export function useWorkspaceSearch(
  gateway: WorkspaceGateway,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): WorkspaceSearchController {
  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<SearchResultDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    // Any edit invalidates a request that is already in flight.
    tokenRef.current += 1;
    if (next.trim() === "") {
      setResults([]);
      setLoading(false);
      setError(null);
    }
  }, []);

  const clear = useCallback(() => {
    setQuery("");
  }, [setQuery]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") return;

    const token = tokenRef.current;
    const timer = setTimeout(() => {
      setLoading(true);
      void gateway
        .searchWorkspace(trimmed)
        .then((next) => {
          if (tokenRef.current !== token) return;
          setResults(next);
          setError(null);
        })
        .catch((failure) => {
          if (tokenRef.current !== token) return;
          setResults([]);
          setError(errorMessage(failure));
        })
        .finally(() => {
          if (tokenRef.current !== token) return;
          setLoading(false);
        });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, gateway, debounceMs]);

  return { query, results, loading, error, setQuery, clear };
}
