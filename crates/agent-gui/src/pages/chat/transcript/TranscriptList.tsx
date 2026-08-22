import { ContextCheckpointCard } from "@liveagent/ui/components/chat/ContextCheckpointCard";
import { normalizeLiveToolStatus } from "@liveagent/ui/lib/chat/assistantStatus";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { useCommitDetailsLoader } from "@liveagent/ui/lib/chat/useCommitDetailsLoader";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import { createEntranceRegistry } from "@liveagent/ui/lib/transcript-virtual/entranceOnce";
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
import { AssistantActivityRow } from "./AssistantActivityRow";
import { AssistantRenderUnit } from "./AssistantRenderUnit";
import { extractRenderUnitRange } from "./renderUnitRangeExtractor";
import { createTranscriptRowModel } from "./rowModel";
import { UserMessageRow } from "./UserMessageRow";

const TRANSCRIPT_MEASUREMENT_LAYOUT_VERSION = "assistant-activity-v2";

function buildVersionedTranscriptLayoutKey(viewportWidth: number, contentWidth: number) {
  const layoutKey = buildTranscriptLayoutKey(viewportWidth, contentWidth);
  return layoutKey ? `${layoutKey}:${TRANSCRIPT_MEASUREMENT_LAYOUT_VERSION}` : "";
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

export type TranscriptListProps = {
  conversationId: string;
  historyItems: RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  scrollViewport: HTMLDivElement | null;
  layoutWidth: number;
  // Whether the scroll-follow engine is attached to the bottom; gates the
  // virtualizer's resize-compensation carve-out for live-row growth.
  isViewportFollowing?: () => boolean;
  viewportFollowing: boolean;
  isSending: boolean;
  isAgentMode: boolean;
  isCompactionRunning: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
  onOpenFileLink?: (link: ChatFileLink) => void;
  // 楼层导航：跳转句柄挂载点（与 followRef 同一模式），以及「视口顶部
  // 当前处于哪条用户消息行」变化时的上报回调。
  navRef?: MutableRefObject<TranscriptNavHandle | null>;
  onAnchorUserRowChange?: (rowKey: string | null) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
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
    liveTranscriptStore,
    scrollViewport,
    layoutWidth,
    isViewportFollowing,
    viewportFollowing,
    isSending,
    isAgentMode,
    isCompactionRunning,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    gitClient,
    onOpenFileLink,
    navRef,
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

  // The component remounts per conversation (keyed by ChatTranscript), so
  // per-conversation state initializes once per mount — no reset effects.
  const [entranceRegistry] = useState(() => createEntranceRegistry());
  const [rowModel] = useState(() =>
    createTranscriptRowModel({
      onRowsBorn: (keys, isInitialBuild) => entranceRegistry.observeBirths(keys, isInitialBuild),
    }),
  );

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

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize: estimateRowSize,
    getItemKey: getRowKey,
    gap: 0,
    overscan: 0,
    enabled: scrollViewport !== null,
    initialMeasurementsCache,
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
    // WKWebView paints compositor scrolls ahead of the main thread; keep
    // roughly a half viewport of pre-rendered rows toward the scroll
    // direction so fast wheel ticks reveal content instead of blank space.
    directionalOverscanPx: 480,
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

  // First paint of a conversation lands at the bottom before the user sees
  // anything: scrollToEnd re-targets as dynamic measurements land, replacing
  // the old estimated-pin → measure → re-pin dance. The component remounts
  // per conversation (keyed by the parent), so this runs once per open.
  const scrollToEndOnceRef = useRef(false);
  useLayoutEffect(() => {
    if (scrollToEndOnceRef.current || scrollViewport === null || rows.length === 0) {
      return;
    }
    scrollToEndOnceRef.current = true;
    virtualizer.scrollToEnd();
  }, [scrollViewport, rows.length, virtualizer]);

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
    if (!hasRows || isSending) {
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
  }, [hasRows, isSending, onFirstLayoutSettled, scrollViewport, virtualizer]);

  // Snapshot measured heights for the next open of this conversation.
  const saveMeasurementsRef = useRef(() => {});
  saveMeasurementsRef.current = () => {
    if (!scrollViewport) return;
    transcriptMeasurementsLru.save(
      conversationId,
      buildVersionedTranscriptLayoutKey(scrollViewport.clientWidth, layoutWidth),
      virtualizer.takeSnapshot(),
    );
  };
  useEffect(() => () => saveMeasurementsRef.current(), []);

  return (
    <div ref={virtualizer.containerRef} className="relative">
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;

        let body: ReactNode;
        if (row.kind === "summary") {
          body = <SummaryCard item={row.item} />;
        } else if (row.kind === "user") {
          body = (
            <div className="flex justify-end">
              <UserMessageRow
                row={row}
                isEditing={editingMessageKey === row.key}
                animateEntrance={entranceRegistry.shouldAnimate(row.key)}
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
                isAgentMode={isAgentMode}
                isCompactionRunning={isCompactionRunning}
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
                isAgentMode={isAgentMode}
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
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 right-0 top-0"
          >
            {body}
            {row.gapAfter > 0 && virtualRow.index < rows.length - 1 ? (
              <div aria-hidden="true" style={{ height: row.gapAfter }} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
});
