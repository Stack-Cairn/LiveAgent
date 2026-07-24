import { useVirtualizer } from "@tanstack/react-virtual";
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

import { CheckCircle2, ChevronDown } from "../../../components/icons";
import { Markdown } from "../../../components/Markdown";
import { useLocale } from "../../../i18n";
import type {
  HistoryMessageRef,
  RenderSummaryCard,
  RenderTimelineItem,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import {
  buildGitHubCommitUrl,
  type CommitDetailsLoader,
  type CommitDisplayReference,
} from "../../../lib/chat/messages/userMessageContent";
import { normalizeLiveToolStatus } from "../../../lib/chat/page/chatPageHelpers";
import type { GitClient } from "../../../lib/git/types";
import { createEntranceRegistry } from "../../../lib/transcript-virtual/entranceOnce";
import { extractLiveRange } from "../../../lib/transcript-virtual/liveRangeExtractor";
import { createLiveRowScrollAdjustPolicy } from "../../../lib/transcript-virtual/liveScrollAdjustPolicy";
import { createTranscriptMeasurementsLru } from "../../../lib/transcript-virtual/measurementsLru";
import { AssistantRow } from "./AssistantRow";
import { createTranscriptRowModel } from "./rowModel";
import { UserMessageRow } from "./UserMessageRow";

const TRANSCRIPT_ROW_GAP = 24;
const TRANSCRIPT_ROW_OVERSCAN_COUNT = 5;

// Measured row heights survive conversation switches: saved on unmount,
// restored (width-gated) on the next open so the switch lays out with exact
// heights instead of estimates.
const transcriptMeasurementsLru = createTranscriptMeasurementsLru();

const SummaryCard = memo(function SummaryCard(props: { item: RenderSummaryCard }) {
  const { item } = props;
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const isEn = locale === "en-US";

  return (
    <div className="flex justify-center px-2">
      <div className="checkpoint-card w-full max-w-3xl overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/[0.85] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)]">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] dark:bg-white/[0.08]">
            <CheckCircle2 size={16} strokeWidth={1.8} className="text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[calc(13px*var(--zone-font-scale,1))] font-medium text-foreground/90">
                {isEn ? "Context Checkpoint" : "上下文检查点"}
              </span>
              <span className="inline-flex items-center rounded-md bg-black/[0.05] px-1.5 py-[1px] text-[calc(11px*var(--zone-font-scale,1))] font-normal tabular-nums text-muted-foreground dark:bg-white/[0.08]">
                {item.coveredMessageCount} {isEn ? "msgs" : "条消息"}
              </span>
            </div>
            <div className="mt-[2px] text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/70">
              {item.generatedBy.providerId} · {item.generatedBy.model}
            </div>
          </div>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 ${expanded ? "rotate-0" : "-rotate-90"}`}
          />
        </button>
        {expanded ? (
          <div className="checkpoint-expand border-t border-black/[0.05] px-3.5 py-3 dark:border-white/[0.06]">
            <Markdown content={item.content} className="font-chat text-sm" />
          </div>
        ) : null}
      </div>
    </div>
  );
});

export type TranscriptNavHandle = {
  /** 按行 key 跳转到对应消息（动态行高下会连帧重对准确保落位）。 */
  scrollToRowKey: (rowKey: string) => void;
};

export type TranscriptListProps = {
  conversationId: string;
  historyItems: RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  scrollViewport: HTMLDivElement | null;
  // Whether the scroll-follow engine is attached to the bottom; gates the
  // virtualizer's resize-compensation carve-out for live-row growth.
  isViewportFollowing?: () => boolean;
  isSending: boolean;
  isAgentMode: boolean;
  isCompactionRunning: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
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

// The whole transcript — committed history and the streaming reply — lives in
// one virtualized container with stable row keys, so a run settling into
// history is a pure data transition (no cross-container move, no remount).
// Rows at or after liveStartIndex are force-mounted; everything else
// virtualizes normally with per-row content-shaped height estimates.
export const TranscriptList = memo(function TranscriptList(props: TranscriptListProps) {
  const {
    conversationId,
    historyItems,
    liveTranscriptStore,
    scrollViewport,
    isViewportFollowing,
    isSending,
    isAgentMode,
    isCompactionRunning,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    gitClient,
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

  const { rows, liveStartIndex } = useMemo(
    () => rowModel.build(historyItems, { ...liveState, isSending }),
    [rowModel, historyItems, liveState, isSending],
  );

  const liveStartIndexRef = useRef(liveStartIndex);
  liveStartIndexRef.current = liveStartIndex;

  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(null);
  const commitDetailsCacheRef = useRef(new Map<string, CommitDisplayReference>());

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

  const loadCommitDetails = useCallback<CommitDetailsLoader>(
    async (commit) => {
      const workdir = workspaceRoot?.trim() ?? "";
      const sha = commit.sha.trim();
      if (!gitClient || !workdir || !sha) return null;
      const cacheKey = `${workdir}\n${sha}`;
      const cached = commitDetailsCacheRef.current.get(cacheKey);
      if (cached) return cached;
      const response = await gitClient.commitDetails(workdir, sha);
      const details = response.commit;
      const resolved: CommitDisplayReference = {
        sha: details.sha,
        shortSha: details.shortSha,
        subject: details.subject,
        body: details.body,
        authorName: details.authorName,
        authorEmail: details.authorEmail,
        authorDate: details.authorDate,
        fileCount: details.fileCount,
        filesChanged: details.filesChanged,
        insertions: details.insertions,
        deletions: details.deletions,
        stat: details.stat,
        remoteName: details.remoteName,
        remoteUrl: details.remoteUrl,
        githubUrl:
          commit.githubUrl ||
          buildGitHubCommitUrl(details.remoteUrl || response.state.remoteUrl, details.sha) ||
          undefined,
      };
      commitDetailsCacheRef.current.set(cacheKey, resolved);
      return resolved;
    },
    [gitClient, workspaceRoot],
  );

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
        ? transcriptMeasurementsLru.restore(conversationId, scrollViewport.clientWidth)
        : null) ?? [],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollViewport,
    estimateSize: (index) => rows[index]?.estimate ?? 260,
    getItemKey: (index) => rows[index]?.key ?? index,
    gap: TRANSCRIPT_ROW_GAP,
    overscan: TRANSCRIPT_ROW_OVERSCAN_COUNT,
    enabled: scrollViewport !== null,
    initialMeasurementsCache,
    // End-anchored: while the viewport sits within the threshold of the end,
    // growth of the last row (streaming) compensates by the total-size delta
    // upstream, and estimate→measure corrections keep the bottom pinned. The
    // threshold matches scrollFollowCore's BOTTOM_ATTACH_THRESHOLD_PX so both
    // engines agree on what "at the bottom" means. followOnAppend stays off:
    // its DOM-distance re-follow would conflict with the follow reducer's
    // "shrink clamps never re-attach" contract — appends while following are
    // already pinned by the reducer.
    anchorTo: "end",
    scrollEndThreshold: 8,
    rangeExtractor: (range) => extractLiveRange(range, liveStartIndexRef.current),
  });

  // TanStack exposes the resize-compensation predicate as an instance field,
  // not an option; reassigning per render keeps the closure's inputs current.
  // It only governs the detached reader — while virtually at the end, the
  // upstream end-anchor compensation takes priority over this predicate.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = createLiveRowScrollAdjustPolicy({
    getLiveStartIndex: () => liveStartIndexRef.current,
    isFollowing: () => isViewportFollowing?.() ?? false,
  });

  // 楼层导航跳转句柄：按行 key 定位 index 后 scrollToIndex。沿途行首次真实
  // 测量会不断修正总高度，连续若干帧重新对准，让滚动收敛在目标行顶部
  // （对准同一 index 是收敛操作，不会震荡）。收敛期间用户的滚轮/触摸/按键
  // 立即取消收敛；新跳转替换旧收敛；卸载时一并清理。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const cancelJumpSettleRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (!navRef) return;
    const handle: TranscriptNavHandle = {
      scrollToRowKey: (rowKey) => {
        cancelJumpSettleRef.current();
        const alignToRow = () => {
          const index = rowsRef.current.findIndex((row) => row.key === rowKey);
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

  // 楼层导航当前楼层：以「视口顶缘（+8px 容差）」所落在的用户消息为准——与
  // 跳转的 align:"start" 落位一致，跳转后高亮的必然是刚点的楼层；视口贴近
  // 内容底部时直接取最后一层（否则短对话拼满一屏时底部楼层永远无法成为当前
  // 层）。贴底判定用 scrollHeight（与 scrollTop/clientHeight 同一坐标系，
  // 含底部输入框保留区），避免与 getTotalSize 的列表局部坐标错位。
  const lastAnchorRef = useRef<string | null>(null);
  const onAnchorUserRowChangeRef = useRef(onAnchorUserRowChange);
  onAnchorUserRowChangeRef.current = onAnchorUserRowChange;
  const reportAnchorRef = useRef(() => {});
  reportAnchorRef.current = () => {
    const callback = onAnchorUserRowChangeRef.current;
    if (!callback || !scrollViewport) return;
    const rowList = rowsRef.current;
    let anchorKey: string | null = null;
    if (rowList.length > 0) {
      const scrollTop = scrollViewport.scrollTop;
      const viewportHeight = scrollViewport.clientHeight;
      const nearBottom = scrollTop + viewportHeight >= scrollViewport.scrollHeight - 32;
      let anchorIndex = -1;
      if (nearBottom) {
        anchorIndex = rowList.length - 1;
      } else {
        const anchorLine = scrollTop + 8;
        const items = virtualizer.getVirtualItems();
        for (const item of items) {
          if (item.start > anchorLine) break;
          anchorIndex = item.index;
        }
        if (anchorIndex === -1) anchorIndex = items[0]?.index ?? -1;
      }
      for (let i = Math.min(anchorIndex, rowList.length - 1); i >= 0; i--) {
        const row = rowList[i];
        if (row?.kind === "user") {
          anchorKey = row.key;
          break;
        }
      }
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

  // 行集合变化（消息追加、流式落定）后兜底重算一次；依赖 rows 而不是每次
  // 渲染都跑，避免「上报 → 父级重渲染 → 再上报」的空转循环。
  useEffect(() => {
    rowsRef.current = rows;
    reportAnchorRef.current();
  }, [rows]);

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
  // have converged — scroll offset and total size unchanged across two
  // frames — then reveals in one shot. Streaming conversations and empty
  // transcripts reveal immediately; a hard cap always reveals.
  const hasRows = rows.length > 0;
  const settledRef = useRef(false);
  const onFirstLayoutSettledRef = useRef(onFirstLayoutSettled);
  onFirstLayoutSettledRef.current = onFirstLayoutSettled;
  useLayoutEffect(() => {
    if (settledRef.current || scrollViewport === null) {
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
      if (stableFrames >= 2 || performance.now() - startedAt > 800) {
        settle();
        return;
      }
      frame = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frame);
  }, [hasRows, isSending, scrollViewport, virtualizer]);

  // Snapshot measured heights for the next open of this conversation.
  const saveMeasurementsRef = useRef(() => {});
  saveMeasurementsRef.current = () => {
    if (!scrollViewport) return;
    transcriptMeasurementsLru.save(
      conversationId,
      scrollViewport.clientWidth,
      virtualizer.takeSnapshot(),
    );
  };
  useEffect(() => () => saveMeasurementsRef.current(), []);

  return (
    <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
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
        } else {
          body = (
            <div className="flex justify-start">
              <AssistantRow
                row={row}
                showUsage={showUsage}
                usageContextWindow={usageContextWindow}
                isAgentMode={isAgentMode}
                isCompactionRunning={row.live ? isCompactionRunning : false}
                toolStatus={row.live ? displayedToolStatus : null}
                retryAttempts={row.live ? liveState.retryAttempts : undefined}
                onResendFromEdit={onResendFromEdit}
                onBranchConversation={onBranchConversation}
              />
            </div>
          );
        }

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 right-0 top-0"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
});
