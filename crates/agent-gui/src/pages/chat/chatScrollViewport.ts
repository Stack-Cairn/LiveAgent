export const CHAT_SCROLL_VIEWPORT_SELECTOR =
  "[data-scroll-viewport], [data-radix-scroll-area-viewport]";

export function resolveScrollViewport(root: Element | null) {
  return root?.querySelector(CHAT_SCROLL_VIEWPORT_SELECTOR) as HTMLDivElement | null;
}

export function resolveNearestScrollViewport(element: Element | null) {
  return element?.closest(CHAT_SCROLL_VIEWPORT_SELECTOR) as HTMLDivElement | null;
}
