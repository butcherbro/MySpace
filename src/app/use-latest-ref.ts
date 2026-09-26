import { useEffect, useRef, type RefObject } from "react";

/**
 * Ref that mirrors `value`, updated in an effect (not during render) so code
 * that runs outside React's render cycle (event handlers, queued async work)
 * always reads the latest value without causing a re-render.
 *
 * Extracted from `App.tsx` (docs/plans/2026-09-26-app-tsx-split.md, step 14).
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
