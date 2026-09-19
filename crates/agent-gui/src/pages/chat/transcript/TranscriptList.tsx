import { ContextCheckpointCard } from "@liveagent/ui/components/chat/ContextCheckpointCard";
import { normalizeLiveToolStatus } from "@liveagent/ui/lib/chat/assistantStatus";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { useCommitDetailsLoader } from "@liveagent/ui/lib/chat/useCommitDetailsLoader";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import { createLiveRowScrollAdjustPolicy } from "@liveagent/ui/lib/transcript-virtual/liveScrollAdjustPolicy";
import {
  buildTranscriptLayoutKey,
  createTranscriptMeasurementsLru,
} from "@liveagent/ui/lib/transcript-virtual/measurementsLru";
import {
  type TranscriptNavigationHandle,
  useTranscriptNavigation,
} from "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation";
import { type Range, useVirtualizer } from "@tanstack/react-virtual";
import {
  type MutableRefObject,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  HistoryMessageRef,
  RenderSummaryCard,
  RenderTimelineItem,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import {
  getPendingToolApprovalsSnapshot,
  subscribeToolApprovalsForConversation,
} from "../../../lib/tools/toolApproval";
import { AssistantActivityRow } from "./AssistantActivityRow";
import { AssistantRenderUnit } from "./AssistantRenderUnit";
import {
  initialTranscriptLayout,
  readTranscriptScrollPosition,
  saveTranscriptScrollPosition,
} from "./initialTranscriptLayout";
import { extractRenderUnitRange } from "./renderUnitRangeExtractor";
import { createReplyHoverStore } from "./replyHoverStore";
import { ReplyHoverProvider } from "./rowInteraction";
import { createTranscriptRowModel } from "./rowModel";
import { UserMessageRow } from "./UserMessageRow";

const TRANSCRIPT_MEASUREMENT_LAYOUT_VERSION = "assistant-activity-v2";

function buildVersionedTranscriptLayoutKey(viewportWidth: number, contentWidth: number) {
  const layoutKey = buildTranscriptLayoutKey(viewportWidth, contentWidth);
  return layoutKey ? `${layoutKey}:${TRANSCRIPT_MEASUREMENT_LAYOUT_VERSION}` : "";
}

function assistantReplyKeyFromEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return (
    target.closest<HTMLElement>("[data-assistant-reply-key]")?.dataset.assistantReplyKey ?? null
  );
}

// Measured row heights survive conversation switches: saved on unmount,
// restored (width-gated) on the next open so the switch lays out with exact
// heights instead of estimates. Persisted so revisited conversations skip
// the estimate→measure correction churn across app restarts too.
const transcriptMeasurementsLru = createTranscriptMeasurementsLru({
  persistNamespace: "gui-transcript",
});

const SummaryCard = memo(function SummaryCard(props: { item: RenderSummaryCard }) {
  const { item } = props;

  return (
    <div className="flex justify-center px-2">
      <ContextCheckpointCard
        content={item.content}
        coveredMessageCount={item.coveredMessageCount}
        generatedBy={item.generatedBy}
        className="max-w-3xl"
      />
    </div>
  );
});

export type TranscriptNavHandle = TranscriptNavigationHandle;

// Distance from the top of the loaded history (in settled scroll
// coordinates) under which the next earlier page is requested.
const LOAD_EARLIER_THRESHOLD_PX = 1600;

export type TranscriptListProps = {
  conversationId: string;
  historyItems: RenderTimelineItem[];
  hasMoreHistory: boolean;
  onLoadEarlierHistory: () => Promise<void>;
  isHistorySwitching: boolean;
  liveTranscriptStore: LiveTranscriptStore;
  scrollViewport: HTMLDivElement | null;
  layoutWidth: number;
  // Whether the scroll-follow engine is attached to the bottom; gates the
  // virtualizer's resize-compensation carve-out for live-row growth.
  isViewportFollowing?: () => boolean;
  viewportFollowing: boolean;
  onRestoreFollowing?: (following: boolean) => void;
  isSending: boolean;
  isCompactionRunning: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
  onOpenFileLink?: (link: ChatFileLink) => void;
  // 楼层导航：跳转句柄挂载点（与 followRef 同一模式），以及「视口顶部
  // 当前处于哪条用户消息行」变化时的上报回调。
  navRef?: MutableRefObject<TranscriptNavHandle | null>;
  saveReadingPositionRef?: MutableRefObject<(() => void) | null>;
  onAnchorUserRowChange?: (rowKey: string | null) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  // Fires once per mount, when the first layout has settled (scroll offset
  // and total size stable across frames after the initial scroll-to-end).
  // ChatTranscript keeps the transcript hidden behind the loading overlay
  // until then, so estimate→measure corrections never show as jumps.
  onFirstLayoutSettled?: () => void;
};

// The whole transcript lives in one virtualized container. Assistant replies
// are block-level render units. The currently active reply is one stable outer
// activity row; static history keeps block-level virtualization.
export const TranscriptList = memo(function TranscriptList(props: TranscriptListProps) {
  const {
    conversationId,
    historyItems,
    hasMoreHistory,
    onLoadEarlierHistory,
    isHistorySwitching,
    liveTranscriptStore,
    scrollViewport,
    layoutWidth,
    isViewportFollowing,
    viewportFollowing,
    onRestoreFollowing,
    isSending,
    isCompactionRunning,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    gitClient,
    onOpenFileLink,
    navRef,
    saveReadingPositionRef,
    onAnchorUserRowChange,
    onResendFromEdit,
    onBranchConversation,
    onFirstLayoutSettled,
  } = props;

  const liveState = useSyncExternalStore(
    liveTranscriptStore.subscribe,
    liveTranscriptStore.getSnapshot,
    liveTranscriptStore.getSnapshot,
  );

  // 审批门在工具执行「之前」挂起，转录里看不出运行中的工具；活跃回合据此把
  // 进度指示冻结成静态（同一份 pending 表也驱动输入框上方的审批栏）。
  const subscribeApprovals = useCallback(
    (listener: () => void) => subscribeToolApprovalsForConversation(conversationId, listener),
    [conversationId],
  );
  const getApprovalsSnapshot = useCallback(
    () => getPendingToolApprovalsSnapshot(conversationId),
    [conversationId],
  );
  const hasPendingToolApproval =
    useSyncExternalStore(subscribeApprovals, getApprovalsSnapshot, getApprovalsSnapshot).length > 0;

  // The component remounts per conversation (keyed by ChatTranscript), so
  // per-conversation state initializes once per mount — no reset effects.
  const [rowModel] = useState(() => createTranscriptRowModel());

  // 手动压缩空闲态只置 isCompactionRunning、不置 isSending，仍要显示「正在
  // 压缩」live tail：把它并入可见性 gate（只影响 live tail 是否显示，不改动
  // 其他 isSending 语义）。
  const { rows, liveStartIndex } = useMemo(
    () => rowModel.build(historyItems, { ...liveState, isSending, isCompactionRunning }),
    [rowModel, historyItems, liveState, isSending, isCompactionRunning],
  );

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const liveStartIndexRef = useRef(liveStartIndex);
  liveStartIndexRef.current = liveStartIndex;
  const getScrollElement = useCallback(() => scrollViewport, [scrollViewport]);
  const estimateRowSize = useCallback((index: number) => {
    const rowList = rowsRef.current;
    const row = rowList[index];
    return row ? row.estimate + (index < rowList.length - 1 ? row.gapAfter : 0) : 260;
  }, []);
  const getRowKey = useCallback((index: number) => rowsRef.current[index]?.key ?? index, []);
  const getRenderCost = useCallback((index: number) => rowsRef.current[index]?.renderCost, []);
  const extractVirtualRange = useCallback(
    (range: Range) => extractRenderUnitRange(range, getRenderCost, liveStartIndexRef.current),
    [getRenderCost],
  );

  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(null);
  const [replyHoverStore] = useState(createReplyHoverStore);

  const handleTranscriptPointerOver = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      replyHoverStore.setHoveredReply(assistantReplyKeyFromEventTarget(event.target));
    },
    [replyHoverStore],
  );
  const handleTranscriptPointerLeave = useCallback(() => {
    replyHoverStore.setHoveredReply(null);
  }, [replyHoverStore]);

  useEffect(() => {
    if (!editingMessageKey) {
      return;
    }
    const hasEditingMessage = historyItems.some(
      (item) => item.kind === "user" && item.key === editingMessageKey,
    );
    if (!hasEditingMessage) {
      setEditingMessageKey(null);
    }
  }, [editingMessageKey, historyItems]);

  const loadCommitDetails = useCommitDetailsLoader(workspaceRoot, gitClient);

  const handleStartEdit = useCallback((key: string) => {
    setEditingMessageKey(key);
  }, []);
  const handleCancelEdit = useCallback(() => {
    setEditingMessageKey(null);
  }, []);

  const displayedToolStatus = normalizeLiveToolStatus(liveState.toolStatus);

  // Restored once per mount: at conversation-switch remounts the viewport is
  // already live, so a same-width snapshot skips straight to exact layout.
  const [initialMeasurementsCache] = useState(
    () =>
      (scrollViewport
        ? transcriptMeasurementsLru.restore(
            conversationId,
            buildVersionedTranscriptLayoutKey(scrollViewport.clientWidth, layoutWidth),
          )
        : null) ?? [],
  );

  const [savedScrollPosition] = useState(() => readTranscriptScrollPosition(conversationId));
  const initialLayout = useMemo(
    () =>
      initialTranscriptLayout(
        rows,
        initialMeasurementsCache,
        scrollViewport?.clientHeight ?? 0,
        savedScrollPosition,
      ),
    [rows, initialMeasurementsCache, scrollViewport, savedScrollPosition],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize: estimateRowSize,
    getItemKey: getRowKey,
    gap: 0,
    overscan: 0,
    enabled: scrollViewport !== null,
    initialMeasurementsCache,
    initialOffset: initialLayout.offset,
    initialRect: {
      width: scrollViewport?.clientWidth ?? 0,
      height: scrollViewport?.clientHeight ?? 0,
    },
    // Defer measurement-driven DOM writes out of WebKit's resize delivery.
    useAnimationFrameWithResizeObserver: true,
    // Pixel overscan covers the next paint; avoid synchronously rendering
    // Markdown inside every native scroll event.
    useFlushSync: false,
    directDomUpdates: true,
    directDomUpdatesMode: "transform",
    // End anchoring is enabled only for a detached reader so keyed prepends
    // preserve the visible row. While following, start anchoring disables the
    // virtualizer's bottom correction and leaves live growth to useScrollFollow.
    anchorTo: viewportFollowing ? "start" : "end",
    scrollEndThreshold: 8,
    // Above-viewport estimate corrections are absorbed into the layout
    // origin instead of written to scrollTop: on WKWebView the compositor
    // owns the viewport during a wheel gesture and can silently swallow
    // programmatic scrolls, leaving the virtualizer rendering a window the
    // viewport never reached (a blank band until the next scroll). The debt
    // settles with one verified write when scrolling is idle.
    scrollAnchoring: "origin",
    // Keep half a viewport behind and two ahead of native compositor scrolls.
    // Bound the pixel budget so tall windows do not mount unbounded Markdown.
    overscanPx: Math.min(800, Math.max(320, (scrollViewport?.clientHeight ?? 800) * 0.5)),
    directionalOverscanPx: Math.min(
      2400,
      Math.max(960, (scrollViewport?.clientHeight ?? 800) * 1.5),
    ),
    rangeExtractor: extractVirtualRange,
  });

  // TanStack exposes the resize-compensation predicate as an instance field,
  // not an option; reassigning per render keeps the closure's inputs current.
  // While following it rejects every virtualizer correction; while detached
  // it retains estimate/measurement anchoring for rows above the viewport.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = createLiveRowScrollAdjustPolicy({
    getLiveStartIndex: () => liveStartIndexRef.current,
    isFollowing: () => isViewportFollowing?.() ?? false,
  });

  // Prefetch near the loaded boundary once per approach. A prepend and its
  // measurement corrections are not another reading gesture.
  const loadingEarlierRef = useRef(false);
  const earlierArmedRef = useRef(true);
  const hardTopLatchedRef = useRef(false);
  const firstHistoryKey = historyItems[0]?.key;
  const lastRequestedBoundaryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollViewport || !hasMoreHistory || isHistorySwitching) return;
    let frame = 0;
    const loadAtTop = () => {
      const atHardTop = scrollViewport.scrollTop <= 1;
      if (!atHardTop) hardTopLatchedRef.current = false;
      const nearTop =
        (atHardTop && !hardTopLatchedRef.current) ||
        virtualizer.getSettledScrollOffset() <=
          Math.max(LOAD_EARLIER_THRESHOLD_PX, scrollViewport.clientHeight * 2);
      if (loadingEarlierRef.current) return;
      if (!nearTop) {
        earlierArmedRef.current = true;
        return;
      }
      if (!earlierArmedRef.current) return;
      if (!firstHistoryKey || lastRequestedBoundaryRef.current === firstHistoryKey) return;
      earlierArmedRef.current = false;
      if (atHardTop) hardTopLatchedRef.current = true;
      lastRequestedBoundaryRef.current = firstHistoryKey;
      loadingEarlierRef.current = true;
      void onLoadEarlierHistory()
        .catch(() => {
          lastRequestedBoundaryRef.current = null;
          hardTopLatchedRef.current = false;
        })
        .finally(() => {
          loadingEarlierRef.current = false;
        });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loadAtTop);
    };
    const requestFromGesture = () => {
      if (loadingEarlierRef.current) return;
      earlierArmedRef.current = true;
      schedule();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) requestFromGesture();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, [role=textbox]"))
      )
        return;
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        requestFromGesture();
      }
    };
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (touchY !== null && nextY !== null && nextY > touchY) requestFromGesture();
      touchY = nextY;
    };
    scrollViewport.addEventListener("scroll", schedule, { passive: true });
    scrollViewport.addEventListener("wheel", onWheel, { passive: true });
    scrollViewport.addEventListener("keydown", onKeyDown);
    scrollViewport.addEventListener("touchstart", onTouchStart, { passive: true });
    scrollViewport.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollViewport.removeEventListener("scroll", schedule);
      scrollViewport.removeEventListener("wheel", onWheel);
      scrollViewport.removeEventListener("keydown", onKeyDown);
      scrollViewport.removeEventListener("touchstart", onTouchStart);
      scrollViewport.removeEventListener("touchmove", onTouchMove);
    };
  }, [
    firstHistoryKey,
    hasMoreHistory,
    isHistorySwitching,
    onLoadEarlierHistory,
    scrollViewport,
    virtualizer,
  ]);

  // Every mounted row is already tracked by the virtualizer's ResizeObserver,
  // which updates its measured height as the centered transcript reflows.
  // Do not call virtualizer.measure() on width commits: it clears those fresh
  // measurements after the DOM has already resized, so no later resize event
  // may repopulate them and estimate-based row positions can overlap.

  // 楼层导航跳转句柄：按行 key 定位 index 后 scrollToIndex。沿途行首次真实
  // 测量会不断修正总高度，连续若干帧重新对准，让滚动收敛在目标行顶部
  // （对准同一 index 是收敛操作，不会震荡）。收敛期间用户的滚轮/触摸/按键
  // 立即取消收敛；新跳转替换旧收敛；卸载时一并清理。
  // 楼层导航当前楼层：以「视口顶缘（+8px 容差）」所落在的用户消息为准——与
  // 跳转的 align:"start" 落位一致，跳转后高亮的必然是刚点的楼层；视口贴近
  // 内容底部时直接取最后一层（否则短对话拼满一屏时底部楼层永远无法成为当前
  // 层）。贴底判定用 scrollHeight（与 scrollTop/clientHeight 同一坐标系，
  // 含底部输入框保留区），避免与 getTotalSize 的列表局部坐标错位。
  useTranscriptNavigation({
    items: rows,
    getItemKey: (row) => row.key,
    getAnchorKey: (rowList, anchorIndex) => rowList[anchorIndex]?.anchorUserKey ?? null,
    virtualizer,
    scrollViewport,
    navRef,
    onAnchorChange: onAnchorUserRowChange,
  });

  // Restore once before paint. Detached readers return to their message
  // anchor; new conversations and followers land at the latest message.
  const restoredScrollRef = useRef(false);
  useLayoutEffect(() => {
    if (restoredScrollRef.current || scrollViewport === null || rows.length === 0) {
      return;
    }
    restoredScrollRef.current = true;
    const follow = savedScrollPosition?.following ?? true;
    onRestoreFollowing?.(follow);
    if (follow) virtualizer.scrollToEnd();
    else virtualizer.scrollToOffset(initialLayout.offset);
  }, [
    scrollViewport,
    rows.length,
    virtualizer,
    savedScrollPosition,
    initialLayout.offset,
    onRestoreFollowing,
  ]);

  // Reconcile against the actual message element, not just estimated sizes:
  // Markdown/table measurements can change after the initial range mounts.
  useLayoutEffect(() => {
    if (
      !scrollViewport ||
      savedScrollPosition?.following !== false ||
      savedScrollPosition.anchorKey === undefined ||
      savedScrollPosition.anchorViewportTop === undefined
    )
      return;
    const { anchorKey, anchorViewportTop } = savedScrollPosition;
    let frame = 0;
    let cancelled = false;
    let stableFrames = 0;
    const started = performance.now();
    const cancel = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    const reconcile = () => {
      if (cancelled) return;
      const element = virtualizer.elementsCache.get(anchorKey);
      if (element) {
        const delta =
          element.getBoundingClientRect().top -
          scrollViewport.getBoundingClientRect().top -
          anchorViewportTop;
        if (Math.abs(delta) > 1) {
          virtualizer.scrollToOffset(scrollViewport.scrollTop + delta);
          stableFrames = 0;
        } else stableFrames++;
      }
      if (stableFrames < 2 && performance.now() - started < 240)
        frame = requestAnimationFrame(reconcile);
    };
    scrollViewport.addEventListener("wheel", cancel, { passive: true });
    scrollViewport.addEventListener("pointerdown", cancel);
    window.addEventListener("keydown", cancel);
    reconcile();
    return () => {
      cancel();
      scrollViewport.removeEventListener("wheel", cancel);
      scrollViewport.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, [scrollViewport, savedScrollPosition, virtualizer]);

  // First-layout settle watch: the transcript stays hidden (parent-gated)
  // until the initial scroll-to-end and its estimate→measure corrections
  // have converged — scroll offset and total size unchanged across one frame
  // — then reveals in one shot. The caller enables this only for large static
  // transcripts, and a short hard cap keeps startup responsive.
  const hasRows = rows.length > 0;
  const settledRef = useRef(false);
  const onFirstLayoutSettledRef = useRef(onFirstLayoutSettled);
  onFirstLayoutSettledRef.current = onFirstLayoutSettled;
  useLayoutEffect(() => {
    if (settledRef.current || scrollViewport === null || !onFirstLayoutSettled) {
      return;
    }
    const settle = () => {
      settledRef.current = true;
      onFirstLayoutSettledRef.current?.();
    };
    if (!hasRows || isSending || initialLayout.measuredViewport) {
      settle();
      return;
    }

    let stableFrames = 0;
    let previousTotalSize = -1;
    let previousScrollTop = -1;
    const startedAt = performance.now();
    let frame = requestAnimationFrame(function check() {
      const totalSize = virtualizer.getTotalSize();
      const scrollTop = scrollViewport.scrollTop;
      stableFrames =
        totalSize === previousTotalSize && scrollTop === previousScrollTop ? stableFrames + 1 : 0;
      previousTotalSize = totalSize;
      previousScrollTop = scrollTop;
      if (stableFrames >= 1 || performance.now() - startedAt > 240) {
        settle();
        return;
      }
      frame = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    hasRows,
    isSending,
    initialLayout.measuredViewport,
    onFirstLayoutSettled,
    scrollViewport,
    virtualizer,
  ]);

  // Capture while the virtualizer is alive: its own unmount cleanup clears
  // origin compensation before our cleanup runs, making a late read wrong.
  const readingPositionRef = useRef<ReturnType<typeof readTranscriptScrollPosition>>(undefined);
  const captureReadingPositionRef = useRef(() => {});
  const savedBeforeLeaveRef = useRef(false);
  useLayoutEffect(() => {
    if (!scrollViewport) return;
    const capture = () => {
      if (savedBeforeLeaveRef.current) return;
      const offset = virtualizer.getSettledScrollOffset();
      // Measurement starts include the origin shift; use DOM coordinates
      // for the anchor delta, and settled coordinates only for the fallback.
      const rawOffset = scrollViewport.scrollTop;
      const anchor = virtualizer.getVirtualItemForOffset(rawOffset);
      const anchorElement = anchor ? virtualizer.elementsCache.get(anchor.key) : undefined;
      readingPositionRef.current = {
        offset,
        following: isViewportFollowing?.() ?? viewportFollowing,
        anchorKey: anchor?.key,
        anchorOffset: anchor ? rawOffset - anchor.start : 0,
        anchorViewportTop: anchorElement
          ? anchorElement.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top
          : undefined,
      };
    };
    captureReadingPositionRef.current = capture;
    capture();
    scrollViewport.addEventListener("scroll", capture, { passive: true });
    return () => scrollViewport.removeEventListener("scroll", capture);
  }, [scrollViewport, virtualizer, isViewportFollowing, viewportFollowing]);

  // Snapshot measured heights for the next open of this conversation.
  const saveMeasurementsRef = useRef(() => {});
  saveMeasurementsRef.current = () => {
    if (!scrollViewport) return;
    if (readingPositionRef.current && !savedBeforeLeaveRef.current) {
      saveTranscriptScrollPosition(conversationId, readingPositionRef.current);
    }
    transcriptMeasurementsLru.save(
      conversationId,
      buildVersionedTranscriptLayoutKey(scrollViewport.clientWidth, layoutWidth),
      virtualizer.takeSnapshot(),
    );
  };
  useLayoutEffect(() => {
    if (!saveReadingPositionRef) return;
    saveReadingPositionRef.current = () => {
      savedBeforeLeaveRef.current = false;
      captureReadingPositionRef.current();
      saveMeasurementsRef.current();
      savedBeforeLeaveRef.current = true;
    };
    return () => {
      saveReadingPositionRef.current = null;
    };
  }, [saveReadingPositionRef]);
  // Save before the next conversation's layout effects move the shared viewport.
  useLayoutEffect(() => () => saveMeasurementsRef.current(), []);

  return (
    <ReplyHoverProvider value={replyHoverStore}>
      <div
        ref={virtualizer.containerRef}
        className="relative"
        onPointerOver={handleTranscriptPointerOver}
        onPointerLeave={handleTranscriptPointerLeave}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          const assistantReplyKey =
            row.kind === "assistant-unit" || row.kind === "assistant-activity"
              ? row.replyKey
              : null;

          let body: ReactNode;
          if (row.kind === "summary") {
            body = <SummaryCard item={row.item} />;
          } else if (row.kind === "user") {
            body = (
              <div className="flex justify-end">
                <UserMessageRow
                  row={row}
                  isEditing={editingMessageKey === row.key}
                  workspaceRoot={workspaceRoot}
                  loadCommitDetails={loadCommitDetails}
                  onStartEdit={handleStartEdit}
                  onCancelEdit={handleCancelEdit}
                  onResendFromEdit={onResendFromEdit}
                />
              </div>
            );
          } else if (row.kind === "assistant-activity") {
            body = (
              <div className="flex justify-start">
                <AssistantActivityRow
                  row={row}
                  showUsage={showUsage}
                  usageContextWindow={usageContextWindow}
                  isCompactionRunning={isCompactionRunning}
                  hasPendingToolApproval={hasPendingToolApproval}
                  toolStatus={displayedToolStatus}
                  retryAttempts={liveState.retryAttempts}
                  workdir={workspaceRoot}
                  onOpenFileLink={onOpenFileLink}
                  onResendFromEdit={onResendFromEdit}
                  onBranchConversation={onBranchConversation}
                />
              </div>
            );
          } else {
            body = (
              <div className="flex justify-start">
                <AssistantRenderUnit
                  row={row}
                  showUsage={showUsage}
                  usageContextWindow={usageContextWindow}
                  isCompactionRunning={row.mutable ? isCompactionRunning : false}
                  toolStatus={row.mutable ? displayedToolStatus : null}
                  retryAttempts={row.mutable ? liveState.retryAttempts : undefined}
                  workdir={workspaceRoot}
                  onOpenFileLink={onOpenFileLink}
                  onResendFromEdit={onResendFromEdit}
                  onBranchConversation={onBranchConversation}
                />
              </div>
            );
          }

          return (
            <div
              key={virtualRow.key}
              data-row-key={row.key}
              data-assistant-reply-key={assistantReplyKey ?? undefined}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0"
            >
              {body}
              {row.gapAfter > 0 && virtualRow.index < rows.length - 1 ? (
                <div aria-hidden="true" style={{ height: row.gapAfter }} />
              ) : null}
            </div>
          );
        })}
      </div>
    </ReplyHoverProvider>
  );
});
