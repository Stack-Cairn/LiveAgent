import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Pin } from "../../../components/icons";
import { useLocale } from "../../../i18n";
import {
  getFloorBookmarks,
  subscribeFloorBookmarks,
  toggleFloorBookmark,
} from "../../../lib/chat-floor-nav/floorBookmarks";
import {
  type FloorEntry,
  resolveNearestSampledRowKey,
  sampleFloorEntries,
} from "../../../lib/chat-floor-nav/floorModel";
import { cn } from "../../../lib/shared/utils";

/** 收起态短横线数量上限的绝对边界（实际数量随可用高度自适应）。 */
const MIN_COLLAPSED_MARKERS = 8;
const MAX_COLLAPSED_MARKERS = 40;
/** 单根短横线（2.5px）+ 间距（7px）的占位高度。 */
const MARKER_SLOT_PX = 9.5;
/** 鼠标移出后延迟收起，避免指针在轨道与面板间移动时闪烁。 */
const COLLAPSE_DELAY_MS = 160;

function useFloorBookmarks(conversationId: string): ReadonlySet<string> {
  const getSnapshot = useCallback(() => getFloorBookmarks(conversationId), [conversationId]);
  return useSyncExternalStore(subscribeFloorBookmarks, getSnapshot, getSnapshot);
}

export function FloorNavRail(props: {
  conversationId: string;
  floors: FloorEntry[];
  activeRowKey: string | null;
  /** 底部输入框悬浮区高度：导航栏整体避开，不遮挡输入框。 */
  bottomReservePx?: number;
  onJump: (rowKey: string) => void;
}) {
  const { conversationId, floors, activeRowKey, bottomReservePx = 0, onJump } = props;
  const { locale } = useLocale();
  const isEn = locale === "en-US";
  const bookmarks = useFloorBookmarks(conversationId);
  const [expanded, setExpanded] = useState(false);
  const collapseTimerRef = useRef<number | null>(null);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  // 收起态标记数随聊天区可用高度自适应：矮视口（小窗口/高输入框）少放几根，
  // 保证最新楼层的标记不被裁掉。
  const [markerBudget, setMarkerBudget] = useState(MAX_COLLAPSED_MARKERS);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const budget = Math.floor((nav.clientHeight - 24) / MARKER_SLOT_PX);
      setMarkerBudget(Math.max(MIN_COLLAPSED_MARKERS, Math.min(MAX_COLLAPSED_MARKERS, budget)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  // 展开时把当前楼层滚到面板中间，楼层很多时不必从头找。
  useLayoutEffect(() => {
    if (!expanded) return;
    panelScrollRef.current
      ?.querySelector('[data-floor-active="true"]')
      ?.scrollIntoView({ block: "center" });
  }, [expanded]);

  const railLabel = isEn ? "Message navigation" : "楼层导航";
  const pinnedTitle = isEn ? "Pinned" : "收藏";
  const pinLabel = isEn ? "Pin" : "收藏";
  const unpinLabel = isEn ? "Unpin" : "取消收藏";

  const bookmarkedFloors = useMemo(
    () => floors.filter((floor) => bookmarks.has(floor.messageId)),
    [floors, bookmarks],
  );

  // 采样集合只由楼层与收藏决定（滚动不改变集合，整列不会随滚动抖动）；
  // 当前楼层未被采样时，高亮落到最近的已采样标记上。
  const collapsedMarkers = useMemo(() => {
    const mustKeep = new Set(bookmarkedFloors.map((floor) => floor.rowKey));
    return sampleFloorEntries(floors, markerBudget, mustKeep);
  }, [floors, bookmarkedFloors, markerBudget]);
  const activeMarkerKey = useMemo(
    () => resolveNearestSampledRowKey(floors, collapsedMarkers, activeRowKey),
    [floors, collapsedMarkers, activeRowKey],
  );

  const cancelCollapse = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const handleEnter = useCallback(() => {
    cancelCollapse();
    setExpanded(true);
  }, [cancelCollapse]);

  const handleLeave = useCallback(() => {
    cancelCollapse();
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      setExpanded(false);
    }, COLLAPSE_DELAY_MS);
  }, [cancelCollapse]);

  // 悬停展开是纯鼠标增强；不挂 onFocus——聚焦即展开会把刚聚焦的短横线按钮
  // 卸载掉（焦点静默掉到 body）。键盘用户直接 Tab 到短横线回车跳转。
  const hoverHandlers = {
    onMouseEnter: handleEnter,
    onMouseLeave: handleLeave,
  };

  if (floors.length < 2) return null;

  const renderPanelRow = (floor: FloorEntry, isPinnedCopy = false) => {
    const isActive = floor.rowKey === activeRowKey;
    const isBookmarked = bookmarks.has(floor.messageId);
    return (
      <div
        key={isPinnedCopy ? `pinned-${floor.rowKey}` : floor.rowKey}
        // 收藏区的副本不带定位锚点，展开自动居中永远对准主列表里的当前行。
        data-floor-active={(isActive && !isPinnedCopy) || undefined}
        className={cn(
          "group/floor flex items-center gap-1 rounded-lg pr-1 transition-colors",
          isActive ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
        )}
      >
        <button
          type="button"
          onClick={() => onJump(floor.rowKey)}
          className={cn(
            "min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[12px] leading-tight",
            isActive ? "font-medium text-foreground" : "text-muted-foreground",
          )}
          title={floor.preview}
        >
          {floor.preview}
        </button>
        <button
          type="button"
          aria-label={isBookmarked ? unpinLabel : pinLabel}
          title={isBookmarked ? unpinLabel : pinLabel}
          onClick={() => toggleFloorBookmark(conversationId, floor.messageId)}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all",
            isBookmarked
              ? "text-amber-500 hover:text-amber-600"
              : "text-muted-foreground/50 opacity-0 hover:text-foreground group-hover/floor:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Pin className={cn("h-3 w-3", isBookmarked && "fill-current")} />
        </button>
      </div>
    );
  };

  return (
    <nav
      ref={navRef}
      aria-label={railLabel}
      className="pointer-events-none absolute right-2 top-2 z-10 flex items-center"
      style={{ bottom: Math.ceil(bottomReservePx) + 8 }}
    >
      {expanded ? (
        <div
          className="floor-nav-panel pointer-events-auto flex max-h-[min(78%,560px)] w-60 flex-col overflow-hidden rounded-xl border border-border/50 bg-background/85 shadow-[0_12px_32px_-16px_rgba(15,23,42,0.28)] backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.06]"
          {...hoverHandlers}
        >
          <div ref={panelScrollRef} className="min-h-0 overflow-y-auto p-1.5">
            {bookmarkedFloors.length > 0 ? (
              <div className="mb-1.5 rounded-lg bg-amber-500/[0.07] p-1 ring-1 ring-amber-500/20">
                <div className="flex items-center gap-1.5 px-1.5 pb-1 pt-0.5 text-[10.5px] font-medium text-amber-600/90 dark:text-amber-400/90">
                  <Pin className="h-2.5 w-2.5 fill-current" />
                  {pinnedTitle}
                </div>
                {bookmarkedFloors.map((floor) => renderPanelRow(floor, true))}
              </div>
            ) : null}
            {floors.map((floor) => renderPanelRow(floor))}
          </div>
        </div>
      ) : (
        <div
          className="pointer-events-auto flex max-h-full flex-col items-end gap-[7px] overflow-hidden py-2 pl-3 pr-0.5"
          {...hoverHandlers}
        >
          {collapsedMarkers.map((floor) => {
            const isActive = floor.rowKey === activeMarkerKey;
            const isBookmarked = bookmarks.has(floor.messageId);
            return (
              <button
                key={floor.rowKey}
                type="button"
                aria-label={floor.preview}
                title={floor.preview}
                onClick={() => onJump(floor.rowKey)}
                className={cn(
                  "h-[2.5px] rounded-full transition-all duration-150",
                  isActive ? "w-[18px]" : "w-3 hover:w-[18px]",
                  isBookmarked
                    ? "bg-amber-500/90"
                    : isActive
                      ? "bg-foreground/75"
                      : "bg-foreground/[0.18] hover:bg-foreground/45",
                )}
              />
            );
          })}
        </div>
      )}
    </nav>
  );
}
