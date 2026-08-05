import {
  useCallback,
  useEffect,
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
/**
 * 触屏端收起态上限单独收紧：手机视口高而窄，高度自适应会直接摸到桌面上限，
 * 超长会话下整列标记撑满全屏高度、视觉噪音大；压成短列后配合 nav 的垂直
 * 居中布局只占屏幕中段一小截。楼层再多也只是采样更稀，首尾仍然保留。
 */
const MAX_COLLAPSED_MARKERS_TOUCH = 12;
/** 单根短横线（2.5px）+ 间距（7px）的占位高度。 */
const MARKER_SLOT_PX = 9.5;
/** 鼠标移出后延迟收起，避免指针在轨道与面板间移动时闪烁。 */
const COLLAPSE_DELAY_MS = 160;
/** 触屏端：滚动停止后导航栏保持可见的时长，随后淡出避免遮挡内容。 */
const TOUCH_SCROLL_REVEAL_MS = 1400;

function useFloorBookmarks(conversationId: string): ReadonlySet<string> {
  const getSnapshot = useCallback(() => getFloorBookmarks(conversationId), [conversationId]);
  return useSyncExternalStore(subscribeFloorBookmarks, getSnapshot, getSnapshot);
}

export function FloorNavRail(props: {
  conversationId: string;
  floors: FloorEntry[];
  activeRowKey: string | null;
  /**
   * 导航栏底缘的 CSS 偏移（避开底部输入框悬浮区）。桌面端传计算好的像素值
   * （如 "196px"），WebUI 传 CSS 变量表达式（如 "calc(var(--x) + 12px)"）。
   */
  bottomOffset?: string;
  /**
   * 转写滚动视口。触屏端用于「滚动时显现、静止后淡出」——不传则触屏端也
   * 常显（桌面端 hover 交互不依赖此元素）。
   */
  scrollViewport?: HTMLElement | null;
  onJump: (rowKey: string) => void;
}) {
  const {
    conversationId,
    floors,
    activeRowKey,
    bottomOffset = "8px",
    scrollViewport = null,
    onJump,
  } = props;
  const { locale } = useLocale();
  const isEn = locale === "en-US";
  const bookmarks = useFloorBookmarks(conversationId);
  const [expanded, setExpanded] = useState(false);
  const collapseTimerRef = useRef<number | null>(null);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  // nav 元素走 callback ref → state（与 ChatTranscript 绑定 scrollViewport 同一
  // 模式）：楼层 <2 时 rail 渲染为 null，nav 在组件已挂载后才出现/消失，一次性
  // 挂载 effect 会错过它——按元素身份重跑，观察器才始终挂在活着的节点上。
  const [navEl, setNavEl] = useState<HTMLElement | null>(null);

  // 触屏（无 hover）环境：展开/收起改由点按驱动，跳转后主动收起面板。
  const isCoarsePointer = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none), (pointer: coarse)").matches,
    [],
  );

  // 触屏端滚动显隐：平时整体隐藏不遮内容，滚动中显现、静止一段时间后淡出。
  // 面板展开期间不淡出（用户正在交互）；隐藏态关闭指针事件，透传给转写区。
  const [touchRevealed, setTouchRevealed] = useState(false);
  const revealTimerRef = useRef<number | null>(null);
  const expandedRef = useRef(false);
  useEffect(() => {
    if (!isCoarsePointer || !scrollViewport) return;
    const handleScroll = () => {
      setTouchRevealed(true);
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
      }
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = null;
        // 面板展开中不淡出；面板收起时（handleLeave/外点）会重新走到这里。
        if (!expandedRef.current) setTouchRevealed(false);
      }, TOUCH_SCROLL_REVEAL_MS);
    };
    scrollViewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollViewport.removeEventListener("scroll", handleScroll);
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, [isCoarsePointer, scrollViewport]);

  // 收起态标记数随聊天区可用高度自适应：矮视口（小窗口/高输入框）少放几根，
  // 保证最新楼层的标记不被裁掉。触屏端上限另行收紧（见常量注释）。
  const maxMarkers = isCoarsePointer ? MAX_COLLAPSED_MARKERS_TOUCH : MAX_COLLAPSED_MARKERS;
  const [markerBudget, setMarkerBudget] = useState(maxMarkers);
  useLayoutEffect(() => {
    if (!navEl || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const budget = Math.floor((navEl.clientHeight - 24) / MARKER_SLOT_PX);
      setMarkerBudget(Math.max(MIN_COLLAPSED_MARKERS, Math.min(maxMarkers, budget)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(navEl);
    return () => observer.disconnect();
  }, [navEl, maxMarkers]);

  // 展开时把当前楼层滚到面板中间，楼层很多时不必从头找。
  useLayoutEffect(() => {
    if (!expanded) return;
    panelScrollRef.current
      ?.querySelector('[data-floor-active="true"]')
      ?.scrollIntoView({ block: "center" });
  }, [expanded]);

  // 触屏自动隐藏仅在提供了滚动视口时启用。
  const touchAutoHide = isCoarsePointer && scrollViewport !== null;

  // 面板展开期间强制可见并挂起淡出计时；收起后重新计时淡出。
  useEffect(() => {
    expandedRef.current = expanded;
    if (!touchAutoHide) return;
    if (expanded) {
      setTouchRevealed(true);
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      return;
    }
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      setTouchRevealed(false);
    }, TOUCH_SCROLL_REVEAL_MS);
    return () => {
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, [expanded, touchAutoHide]);

  const railVisible = !touchAutoHide || touchRevealed;

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

  // 触屏没有 mouseleave：面板展开期间点按导航栏以外任意位置立即收起。桌面端
  // 该监听与 mouseleave 收起并存，行为不冲突。
  useEffect(() => {
    if (!expanded || !navEl) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && navEl.contains(event.target)) return;
      cancelCollapse();
      setExpanded(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [expanded, navEl, cancelCollapse]);

  const handleJump = useCallback(
    (rowKey: string) => {
      onJump(rowKey);
      // 触屏跳转后面板不会因指针移出而收起，这里主动收；桌面保持展开便于连跳。
      if (isCoarsePointer) {
        cancelCollapse();
        setExpanded(false);
      }
    },
    [onJump, isCoarsePointer, cancelCollapse],
  );

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
          onClick={() => handleJump(floor.rowKey)}
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
            // 触屏没有 hover 显隐，收藏按钮常显。
            isCoarsePointer && "opacity-100",
          )}
        >
          <Pin className={cn("h-3 w-3", isBookmarked && "fill-current")} />
        </button>
      </div>
    );
  };

  return (
    <nav
      ref={setNavEl}
      aria-label={railLabel}
      aria-hidden={!railVisible || undefined}
      className={cn(
        "pointer-events-none absolute right-4 top-2 z-10 flex items-center transition-opacity duration-200",
        railVisible ? "opacity-100" : "opacity-0",
      )}
      style={{ bottom: bottomOffset }}
    >
      {expanded ? (
        <div
          className={cn(
            "floor-nav-panel flex max-h-[min(78%,560px)] w-60 max-w-[calc(100vw-2rem)] touch-manipulation flex-col overflow-hidden rounded-xl border border-border/50 bg-background/85 shadow-[0_12px_32px_-16px_rgba(15,23,42,0.28)] backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.06]",
            // 隐藏态不吃指针事件：触摸透传给转写区，不会点到看不见的控件。
            railVisible ? "pointer-events-auto" : "pointer-events-none",
          )}
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
          className={cn(
            "flex max-h-full touch-manipulation flex-col items-end gap-[7px] overflow-hidden py-2 pl-3 pr-0.5",
            railVisible ? "pointer-events-auto" : "pointer-events-none",
          )}
          {...hoverHandlers}
          // 触屏收起态：2.5px 的短横线没法精确点按，整列点按一律先展开面板，
          // 跳转都发生在面板行上。preventDefault 掐掉后续合成 mouse/click，
          // 避免展开瞬间面板行吃到同一次点按误触跳转。
          onTouchEnd={
            isCoarsePointer
              ? (event) => {
                  event.preventDefault();
                  handleEnter();
                }
              : undefined
          }
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
                onClick={() => handleJump(floor.rowKey)}
                className={cn(
                  // after 伪元素把命中区扩到整条槽位高度，覆盖标记间 7px 间隙。
                  "relative h-[2.5px] rounded-full transition-all duration-150 after:absolute after:-inset-x-2 after:-inset-y-1 after:content-['']",
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
