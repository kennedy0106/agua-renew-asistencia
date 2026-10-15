// Shared motion decisions. Keeping the reduced-motion check in one place lets
// every hand-rolled transition opt into the gentle variant without duplicating
// the media-query string (and stays safe in tests where `matchMedia` may not
// exist).

/** Duration a popover keeps its node mounted for an exit transition. */
export const POPOVER_EXIT_MS = 150;

/** Shorter exit for users who asked for reduced motion (opacity only). */
export const POPOVER_EXIT_REDUCED_MS = 120;

/**
 * True when the user asked for reduced motion. Guarded so non-DOM and test
 * environments (jsdom without a `matchMedia` shim) never throw.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
