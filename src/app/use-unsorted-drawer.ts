import { useEffect, useRef, useState } from "react";

/**
 * Unsorted drawer: shows when unsorted cards exist; Close hides it until the
 * next blind drop grows the count again.
 *
 * Extracted from `App.tsx` (docs/plans/2026-09-26-app-tsx-split.md, step 14).
 */

export interface UnsortedDrawerDeps {
  unsortedCount: number;
}

export interface UnsortedDrawerController {
  unsortedOpen: boolean;
  setUnsortedOpen: (open: boolean) => void;
}

export function useUnsortedDrawer({ unsortedCount }: UnsortedDrawerDeps): UnsortedDrawerController {
  const [unsortedOpen, setUnsortedOpen] = useState(false);
  const prevUnsortedCountRef = useRef(unsortedCount);
  useEffect(() => {
    if (unsortedCount > prevUnsortedCountRef.current) {
      setUnsortedOpen(true);
    }
    prevUnsortedCountRef.current = unsortedCount;
  }, [unsortedCount]);

  return { unsortedOpen, setUnsortedOpen };
}
