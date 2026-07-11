interface ScrollToItemArgs {
  itemId: string;
  /** Pixels to leave between the target and the top of the viewport. */
  offset?: number;
  behavior?: ScrollBehavior;
}

/**
 * Smooth-scrolls the element marked with `data-item-id` into the viewport,
 * leaving `offset` pixels at the top (for the sticky header). Does nothing
 * if the target element cannot be found or is already visible below the header.
 */
export function scrollToItem({
  itemId,
  offset = 80,
  behavior = "smooth",
}: ScrollToItemArgs): void {
  if (typeof document === "undefined") return;

  const element = document.querySelector(
    `[data-item-id="${CSS.escape(itemId)}"]`
  );
  if (!element) return;

  const rect = element.getBoundingClientRect();
  const viewportTop = offset;
  const viewportBottom = window.innerHeight;

  // Already visible below the header — don't jump the viewport.
  if (rect.top >= viewportTop && rect.bottom <= viewportBottom) {
    return;
  }

  const targetY = rect.top + window.scrollY - offset;
  window.scrollTo({ top: targetY, behavior });
}
