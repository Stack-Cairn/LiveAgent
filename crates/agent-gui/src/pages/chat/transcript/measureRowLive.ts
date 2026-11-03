import { measureElement, type Virtualizer } from "@tanstack/react-virtual";

// The transcript's ResizeObserver flush runs one frame after the delivery it
// carries (useAnimationFrameWithResizeObserver). By then a height animation (a
// collapsing tool group) has written a newer size, and positioning rows from
// the delivered box paints the rows below one frame behind: a gap flashes open
// under the collapsing header. Read the row's live layout height instead
// (offsetHeight, like the observer's box, ignores ancestor transforms); without
// an entry (the ref-callback path) keep the cached size and skip the layout read.
export function measureRowLive(
  element: HTMLDivElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
) {
  if (!entry) return measureElement(element, entry, instance);
  return element.offsetHeight;
}
