import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";

// Resize-compensation policy for the transcript virtualizer (virtual-core
// 3.17.x semantics).
//
// With `anchorTo: 'end'`, virtual-core handles the bottom-pinned case itself:
// while the viewport is virtually at the end, `resizeItem` compensates by the
// total-size delta and this predicate's verdict is ignored. This policy
// therefore only governs the detached reader.
//
// It replicates the upstream default and carves out exactly one case the
// default gets wrong: the live streaming row grown taller than the viewport.
// A reader scrolled up into that row has the row's start above the viewport
// top while the stream appends at the row's BOTTOM edge, below everything
// visible. The default would drag scrollTop down by the growth delta on
// every stream flush — the view creeps toward the bottom and the transcript
// is unreadable. Growth (delta > 0) of a live row that still extends past
// the viewport top never adjusts while the user is detached from the bottom.
// Everything else keeps the default:
// - rows entirely above the viewport compensate as before, where a first
//   measurement always compensates (the estimate→actual delta must land
//   regardless of scroll direction) and a re-measurement is skipped during
//   backward scroll (the upstream "items jump while scrolling up" fix);
// - while following, the compensation cooperates with the scroll-follow pin,
//   so it stays on;
// - live-row shrinks (delta < 0, e.g. a thinking block collapsing near the
//   row's top) keep compensating so content under the reader stays put.
export type LiveRowScrollAdjustPolicyArgs = {
  // Index of the first live (streaming) row in the virtualizer's item list,
  // -1 while idle. Read per call — the boundary moves between renders.
  getLiveStartIndex: () => number;
  // Whether the scroll-follow engine is attached to the bottom.
  isFollowing: () => boolean;
};

export function createLiveRowScrollAdjustPolicy<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(
  args: LiveRowScrollAdjustPolicyArgs,
): (
  item: VirtualItem,
  delta: number,
  instance: Virtualizer<TScrollElement, TItemElement>,
) => boolean {
  const { getLiveStartIndex, isFollowing } = args;
  return (item, delta, instance) => {
    // Un-echoed scroll writes accumulate in a private field until the next
    // scroll event; the upstream default folds them into the comparison, so
    // mirror that (fall back to 0 if the field ever disappears).
    const pendingAdjustments =
      (instance as unknown as { scrollAdjustments?: number }).scrollAdjustments ?? 0;
    const viewportTop = (instance.scrollOffset ?? 0) + pendingAdjustments;

    // Upstream default: only above-viewport resizes may shift scrollTop.
    if (item.start >= viewportTop) {
      return false;
    }
    // Upstream default: re-measurements are skipped during backward scroll;
    // first measurements always compensate.
    if (instance.itemSizeCache.has(item.key) && instance.scrollDirection === "backward") {
      return false;
    }

    // The carve-out. `item` carries the pre-resize measurement, so
    // `item.end > viewportTop` means the row straddles the viewport top and
    // its bottom-appended growth lands below the reading line.
    const liveStartIndex = getLiveStartIndex();
    if (
      liveStartIndex >= 0 &&
      item.index >= liveStartIndex &&
      delta > 0 &&
      item.end > viewportTop &&
      !isFollowing()
    ) {
      return false;
    }

    return true;
  };
}
