import { prefersReducedMotion } from "@/lib/motion";

/**
 * `scrollIntoView` that honours `prefers-reduced-motion`.
 *
 * The global `scroll-behavior: auto !important` reduced-motion rule cannot win
 * against an explicit `behavior: "smooth"` argument, so the call site has to
 * degrade to an instant jump itself. Movement is dropped; the element still
 * ends up in view.
 */
export function scrollIntoViewRespectingMotion(
  element: Element | null | undefined,
  options: ScrollIntoViewOptions = { block: "nearest" },
): void {
  if (!element) return;
  element.scrollIntoView({
    ...options,
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}
