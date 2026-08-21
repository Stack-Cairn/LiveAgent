import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from "react";

export type TranscriptNavigationHandle = {
  scrollToRowKey: (rowKey: string) => void;
};

type VirtualItemPosition = {
  index: number;
  start: number;
};

type TranscriptVirtualizerNavigation = {
  scrollToIndex: (index: number, options: { align: "start" }) => void;
  getVirtualItems: () => readonly VirtualItemPosition[];
};

type UseTranscriptNavigationOptions<TItem> = {
  items: readonly TItem[];
  getItemKey: (item: TItem) => string;
  getAnchorKey: (items: readonly TItem[], anchorIndex: number) => string | null;
  virtualizer: TranscriptVirtualizerNavigation;
  scrollViewport: HTMLDivElement | null;
  navRef?: MutableRefObject<TranscriptNavigationHandle | null>;
  onAnchorChange?: (rowKey: string | null) => void;
};

export function useTranscriptNavigation<TItem>(options: UseTranscriptNavigationOptions<TItem>) {
  const { items, getItemKey, getAnchorKey, virtualizer, scrollViewport, navRef, onAnchorChange } =
    options;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const getItemKeyRef = useRef(getItemKey);
  getItemKeyRef.current = getItemKey;
  const getAnchorKeyRef = useRef(getAnchorKey);
  getAnchorKeyRef.current = getAnchorKey;
  const cancelJumpSettleRef = useRef<() => void>(() => {});
  // A live row changes object identity on every content commit, but its list
  // position is structurally unchanged. Boundary keys catch append/prepend,
  // conversation replacement and live-row mount/unmount in O(1), without a
  // full key scan on every streamed token.
  const itemCount = items.length;
  const firstItemKey = itemCount > 0 ? getItemKey(items[0]) : null;
  const lastItemKey = itemCount > 0 ? getItemKey(items[itemCount - 1]) : null;
  const structureToken = JSON.stringify([itemCount, firstItemKey, lastItemKey]);
  const reportedStructureTokenRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!navRef) return;
    const handle: TranscriptNavigationHandle = {
      scrollToRowKey: (rowKey) => {
        cancelJumpSettleRef.current();
        const alignToRow = () => {
          const index = itemsRef.current.findIndex(
            (item) => getItemKeyRef.current(item) === rowKey,
          );
          if (index < 0) return false;
          virtualizer.scrollToIndex(index, { align: "start" });
          return true;
        };
        if (!alignToRow()) return;
        let rafId: number | null = null;
        const stopSettle = () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          scrollViewport?.removeEventListener("wheel", stopSettle);
          scrollViewport?.removeEventListener("touchstart", stopSettle);
          scrollViewport?.removeEventListener("keydown", stopSettle);
          if (cancelJumpSettleRef.current === stopSettle) {
            cancelJumpSettleRef.current = () => {};
          }
        };
        cancelJumpSettleRef.current = stopSettle;
        scrollViewport?.addEventListener("wheel", stopSettle, { passive: true });
        scrollViewport?.addEventListener("touchstart", stopSettle, { passive: true });
        scrollViewport?.addEventListener("keydown", stopSettle);
        let remainingFrames = 6;
        const settle = () => {
          rafId = null;
          if (!alignToRow()) {
            stopSettle();
            return;
          }
          remainingFrames -= 1;
          if (remainingFrames > 0) {
            rafId = requestAnimationFrame(settle);
          } else {
            stopSettle();
          }
        };
        rafId = requestAnimationFrame(settle);
      },
    };
    navRef.current = handle;
    return () => {
      cancelJumpSettleRef.current();
      if (navRef.current === handle) {
        navRef.current = null;
      }
    };
  }, [navRef, virtualizer, scrollViewport]);

  const lastAnchorRef = useRef<string | null>(null);
  const onAnchorChangeRef = useRef(onAnchorChange);
  onAnchorChangeRef.current = onAnchorChange;
  const reportAnchorRef = useRef(() => {});
  reportAnchorRef.current = () => {
    const callback = onAnchorChangeRef.current;
    if (!callback || !scrollViewport) return;
    const itemList = itemsRef.current;
    let anchorKey: string | null = null;
    if (itemList.length > 0) {
      const nearBottom =
        scrollViewport.scrollTop + scrollViewport.clientHeight >= scrollViewport.scrollHeight - 32;
      let anchorIndex = -1;
      if (nearBottom) {
        anchorIndex = itemList.length - 1;
      } else {
        const anchorLine = scrollViewport.scrollTop + 8;
        const virtualItems = virtualizer.getVirtualItems();
        for (const item of virtualItems) {
          if (item.start > anchorLine) break;
          anchorIndex = item.index;
        }
        if (anchorIndex === -1) anchorIndex = virtualItems[0]?.index ?? -1;
      }
      anchorKey = getAnchorKeyRef.current(itemList, Math.min(anchorIndex, itemList.length - 1));
    }
    if (anchorKey !== lastAnchorRef.current) {
      lastAnchorRef.current = anchorKey;
      callback(anchorKey);
    }
  };

  useEffect(() => {
    if (!scrollViewport) return;
    const handler = () => reportAnchorRef.current();
    handler();
    scrollViewport.addEventListener("scroll", handler, { passive: true });
    return () => scrollViewport.removeEventListener("scroll", handler);
  }, [scrollViewport]);

  useEffect(() => {
    if (reportedStructureTokenRef.current === structureToken) return;
    reportedStructureTokenRef.current = structureToken;
    reportAnchorRef.current();
  }, [structureToken]);
}
