import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_HIGHLIGHT_MS = 1400;

/**
 * Brief "saved" feedback for one row of a mutable list.
 *
 * Call `markSaved(id)` right after a successful mutation and add the
 * `row-saved` class only to the row whose id matches `highlightedId`. That
 * keeps the acknowledgement tied to the exact record instead of animating the
 * whole table.
 */
export function useRowHighlight(durationMs = DEFAULT_HIGHLIGHT_MS) {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const markSaved = useCallback(
    (id: string) => {
      clearTimer();
      setHighlightedId(id);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setHighlightedId(null);
      }, durationMs);
    },
    [clearTimer, durationMs],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const isHighlighted = useCallback(
    (id: string) => highlightedId === id,
    [highlightedId],
  );

  return { highlightedId, markSaved, isHighlighted };
}
