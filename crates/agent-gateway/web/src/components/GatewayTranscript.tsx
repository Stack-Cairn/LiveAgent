import {
  AssistantAvatar,
  AssistantBubble,
  LiveAssistantStatus,
} from "@liveagent/ui/components/chat/AssistantBubble";
import { ChatEmptyState } from "@liveagent/ui/components/chat/ChatEmptyState";
import { ContextCheckpointCard } from "@liveagent/ui/components/chat/ContextCheckpointCard";
import { EditableUserMessageBubble } from "@liveagent/ui/components/chat/EditableUserMessageBubble";
import { RetryDetailsBlock } from "@liveagent/ui/components/chat/RetryDetailsBlock";
import {
  TranscriptAssistantMessageActions,
  TranscriptUserMessageActions,
} from "@liveagent/ui/components/chat/TranscriptMessageActions";
import { UserAttachmentCards } from "@liveagent/ui/components/chat/UserAttachmentCards";
import { Loader2 } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/LocaleContext";
import { normalizeLiveToolStatus, VIBING_STATUS } from "@liveagent/ui/lib/chat/assistantStatus";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import {
  type PendingUploadedFile,
  splitUserAttachmentsForDisplay,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import type { UploadedImagePreviewLoader } from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { useCommitDetailsLoader } from "@liveagent/ui/lib/chat/useCommitDetailsLoader";
import {
  type CommitDetailsLoader,
  UserMessageContent,
} from "@liveagent/ui/lib/chat/userMessageContent";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import { createLiveRowScrollAdjustPolicy } from "@liveagent/ui/lib/transcript-virtual/liveScrollAdjustPolicy";
import {
  buildTranscriptLayoutKey,
  createTranscriptMeasurementsLru,
} from "@liveagent/ui/lib/transcript-virtual/measurementsLru";
import {
  CHECKPOINT_ROW_ESTIMATE_PX,
  estimateAssistantRowHeight,
  estimateUserRowHeight,
  measureEstimateText,
} from "@liveagent/ui/lib/transcript-virtual/rowEstimates";
import {
  type TranscriptNavigationHandle,
  useTranscriptNavigation,
} from "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type Dispatch,
  type MutableRefObject,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import { getRoundText } from "@/lib/chat/uiMessages";
import { DEFAULT_CHAT_TRANSCRIPT_WIDTH } from "@/lib/settings";
import { extractLiveRange } from "@/lib/transcript-virtual/liveRangeExtractor";
import type { RetryAttemptRecord, TranscriptRow } from "../lib/chat/transcript/types";
import type { SectionId } from "../pages/settings/types";

type GatewayTranscriptProps = {
  conversationId?: string;
  // The whole transcript as one row list, rendered by one virtualizer. Rows
  // come from one store assembly, so a row can never render twice.
  rows: readonly TranscriptRow[];
  // Index of the first unfolded-turn row (-1 when everything is folded);
  // rows at or after it are force-mounted so a streaming reply never
  // unmounts mid-run.
  liveStartIndex?: number;
  // Key of the actively streaming turn (caret / live structural state).
  activeTurnKey?: string | null;
  contentWidth?: number;
  // Whether the scroll-follow engine is attached to the bottom; gates the
  // virtualizer's resize-compensation carve-out for live-row growth.
  isViewportFollowing?: () => boolean;
  viewportFollowing?: boolean;
  // Imperative jump handle for the floor navigation rail.
  navRef?: MutableRefObject<GatewayTranscriptNavHandle | null>;
  // Reports the user row at the viewport's top edge (the "current floor").
  onAnchorUserRowChange?: (rowKey: string | null) => void;
  error?: string | null;
  toolStatus?: string | null;
  toolStatusIsCompaction?: boolean;
  // Live run's stream-retry history; renders as an expandable details block
  // under the live status (mirrors the desktop app).
  retryAttempts?: readonly RetryAttemptRecord[];
  isStreaming?: boolean;
  isLoading?: boolean;
  loadingTitle?: string;
  hasModels?: boolean;
  onOpenSettings?: (section?: SectionId) => void;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadEarlierHistory?: () => void;
  showUsage?: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  // Anchor messageId of the branch request in flight; the matching row shows
  // a spinner and every branch button disables until it settles.
  branchPendingMessageId?: string | null;
  onSuggestionSelect?: (text: string) => void;
  suggestionsDisabled?: boolean;
  readOnly?: boolean;
  redactToolContent?: boolean;
};

// Stream-born rows keep Streamdown's streaming render mode forever — even
// after their turn folds — so the streaming→static mode flip (and its full
// re-parse) can never happen. History-born rows render static from the
// start.
function rowRenderMode(row: Extract<TranscriptRow, { kind: "assistant" }>) {
  return row.origin === "stream" ? ("streaming" as const) : ("static" as const);
}

export type GatewayTranscriptNavHandle = TranscriptNavigationHandle;

const TRANSCRIPT_ROW_ESTIMATED_HEIGHT = 260;
const TRANSCRIPT_ROW_GAP = 18;
const TRANSCRIPT_ROW_OVERSCAN_COUNT = 5;

// Measured row heights survive conversation switches: saved on unmount,
// restored (width-gated) on the next open so the switch lays out with exact
// heights instead of estimates.
const transcriptMeasurementsLru = createTranscriptMeasurementsLru();

type GatewayTranscriptVirtualItem =
  | { key: string; kind: "loadRemoteHistory" }
  | { key: string; kind: "row"; row: TranscriptRow }
  | { key: string; kind: "pendingBubble" };

function resolveNearestScrollViewport(element: HTMLElement | null) {
  return element?.closest("[data-scroll-viewport]") as HTMLDivElement | null;
}

function LiveStatusFooter(props: { status: string; isCompaction?: boolean }) {
  const { status, isCompaction = false } = props;
  return (
    <div className="gateway-live-status-footer ml-9 min-w-0 overflow-hidden pt-1">
      <LiveAssistantStatus status={status} isCompaction={isCompaction} className="w-full" />
    </div>
  );
}

function HistoryLoadingState(props: { title?: string }) {
  const title = props.title?.trim();
  return (
    <div className="gateway-transcript-shell">
      <div className="gateway-chat-column gateway-empty-state">
        <div className="flex min-h-[280px] w-full flex-col items-center justify-center px-4 text-center">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-background/80 shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
          <div className="max-w-[28rem] text-[calc(14px*var(--zone-font-scale,1))] font-medium text-foreground/90">
            正在加载会话历史
          </div>
          {title ? (
            <div className="mt-1 max-w-[28rem] truncate text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground">
              {title}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CheckpointCard(props: {
  item: Extract<TranscriptRow, { kind: "checkpoint" }>;
  readOnly?: boolean;
}) {
  const { item, readOnly = false } = props;

  return (
    <div className="checkpoint-row flex w-full max-w-full items-start gap-3">
      <div className="checkpoint-row-spacer mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
      <div className="checkpoint-row-body min-w-0 flex-1">
        <ContextCheckpointCard
          content={item.content}
          coveredMessageCount={item.coveredMessageCount}
          generatedBy={item.generatedBy}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}

function GatewayUserMessageBubbleBody(props: {
  text: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  loadCommitDetails?: CommitDetailsLoader;
}) {
  const { text, attachments, workspaceRoot, onLoadUploadedImagePreview, loadCommitDetails } = props;
  const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(attachments, text);

  return (
    <div className="chat-user-bubble ml-auto w-fit max-w-full rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5 font-chat text-[calc(14.5px*var(--zone-font-scale,1))] leading-relaxed text-[hsl(var(--chat-user-fg))]">
      <UserAttachmentCards
        files={visibleFiles}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        imagePreviewMode="imageKind"
      />
      {text ? (
        <UserMessageContent
          text={text}
          pastedTextFiles={pastedTextFiles}
          loadCommitDetails={loadCommitDetails}
          legacyInlineFileMentions
        />
      ) : null}
    </div>
  );
}

// Shared user-row body: the bubble plus hover actions (copy / edit), or the
// inline editor while this row is being edited. Both transcript regions
// render it; the per-row copied/editing state lives in the owning region so
// folds and conversation switches reset it there.
// Memoized with per-row `isCopied`/`isEditing` booleans (instead of the raw
// region-level ids) so copying or editing one row never re-renders the
// others, and streaming flushes bail on every settled user row.
const GatewayUserMessageRowBody = memo(function GatewayUserMessageRowBody(props: {
  row: Extract<TranscriptRow, { kind: "user" }>;
  isStreaming: boolean;
  readOnly?: boolean;
  isCopied: boolean;
  isEditing: boolean;
  setCopiedMessageId: Dispatch<SetStateAction<string | null>>;
  setEditingMessageId: Dispatch<SetStateAction<string | null>>;
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  loadCommitDetails?: CommitDetailsLoader;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
  ) => void;
}) {
  const {
    row,
    isStreaming,
    readOnly = false,
    isCopied,
    isEditing,
    setCopiedMessageId,
    setEditingMessageId,
    workspaceRoot,
    onLoadUploadedImagePreview,
    loadCommitDetails,
    onResendFromEdit,
  } = props;
  const { locale, t } = useLocale();
  const effectiveMessageRef = row.messageRef;
  const missingStableRef = !effectiveMessageRef;
  const editDisabled = readOnly || isStreaming || !onResendFromEdit || missingStableRef;
  const editTitle = missingStableRef
    ? locale === "en-US"
      ? "This older message cannot be edited because it has no stable message identifier."
      : "旧历史缺少稳定消息标识，无法编辑重发"
    : t("chat.edit");

  if (isEditing && effectiveMessageRef) {
    return (
      <EditableUserMessageBubble
        initialText={row.text}
        attachments={row.attachments}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        imagePreviewMode="imageKind"
        attachmentRemoveLabel={t("settings.delete")}
        className="chat-user-bubble-editor"
        textareaClassName="chat-user-bubble-editor-textarea overflow-hidden"
        textareaSizing="content"
        onCancel={() => setEditingMessageId(null)}
        onSubmit={(text, attachments) => {
          setEditingMessageId(null);
          onResendFromEdit?.(effectiveMessageRef, text, attachments);
        }}
      />
    );
  }

  return (
    <div className="chat-user-bubble-wrap group relative ml-auto max-w-[min(85%,calc(50em+2rem))]">
      <GatewayUserMessageBubbleBody
        text={row.text}
        attachments={row.attachments}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        loadCommitDetails={loadCommitDetails}
      />
      <TranscriptUserMessageActions
        timestamp={row.timestamp}
        copied={isCopied}
        onCopy={() => {
          void navigator.clipboard.writeText(row.text).then(() => {
            setCopiedMessageId(row.key);
            window.setTimeout(() => {
              setCopiedMessageId((current) => (current === row.key ? null : current));
            }, 1500);
          });
        }}
        editDisabled={editDisabled}
        editTitle={editTitle}
        onEdit={() => {
          if (effectiveMessageRef) setEditingMessageId(row.key);
        }}
        rewindTurnId={effectiveMessageRef?.messageId}
        readOnly={readOnly}
        alwaysShowActions
      />
    </div>
  );
});

// Maps each assistant row to the nearest preceding user row — the prompt a
// retry re-sends.
function buildRetryTargetMap(rows: readonly TranscriptRow[]) {
  const map = new Map<string, Extract<TranscriptRow, { kind: "user" }>>();
  let lastUser: Extract<TranscriptRow, { kind: "user" }> | null = null;
  for (const row of rows) {
    if (row.kind === "user") {
      lastUser = row;
    } else if (row.kind === "assistant" && lastUser) {
      map.set(row.key, lastUser);
    }
  }
  return map;
}

// Shared assistant-row hover actions (copy / retry). Retry re-sends the
// nearest preceding user prompt through the edit-resend pipeline: this reply
// and everything after it are discarded, same as editing that prompt
// unchanged. Both transcript regions render it below the bubble.
const GatewayAssistantMessageActions = memo(function GatewayAssistantMessageActions(props: {
  row: Extract<TranscriptRow, { kind: "assistant" }>;
  retryTarget: Extract<TranscriptRow, { kind: "user" }> | null;
  isStreaming: boolean;
  isCopied: boolean;
  setCopiedMessageId: Dispatch<SetStateAction<string | null>>;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  branchPendingMessageId?: string | null;
}) {
  const {
    row,
    retryTarget,
    isStreaming,
    isCopied,
    setCopiedMessageId,
    onResendFromEdit,
    onBranchConversation,
    branchPendingMessageId,
  } = props;
  const { locale, t } = useLocale();
  const replyText = row.rounds
    .map((round) => getRoundText(round).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  const retryMessageRef = retryTarget?.messageRef;
  const retryDisabled = isStreaming || !onResendFromEdit || !retryMessageRef;
  const retryTitle = retryMessageRef
    ? t("chat.retry")
    : locale === "en-US"
      ? "This reply cannot be retried because its prompt has no stable message identifier."
      : "旧历史缺少稳定消息标识，无法重试";
  const branchPending = branchPendingMessageId != null;
  const isRowBranchPending =
    branchPending && !!retryMessageRef && branchPendingMessageId === retryMessageRef.messageId;
  const branchDisabled = isStreaming || !onBranchConversation || !retryMessageRef || branchPending;
  const branchTitle = retryMessageRef ? t("chat.branch") : t("chat.branchUnavailable");

  return (
    <TranscriptAssistantMessageActions
      timestamp={row.timestamp}
      copied={isCopied}
      copyDisabled={!replyText}
      onCopy={() => {
        void navigator.clipboard.writeText(replyText).then(() => {
          setCopiedMessageId(row.key);
          window.setTimeout(() => {
            setCopiedMessageId((current) => (current === row.key ? null : current));
          }, 1500);
        });
      }}
      retryDisabled={retryDisabled}
      retryTitle={retryTitle}
      onRetry={() => {
        if (!retryTarget || !retryMessageRef) return;
        onResendFromEdit?.(retryMessageRef, retryTarget.text, retryTarget.attachments);
      }}
      branchDisabled={branchDisabled}
      branchTitle={branchTitle}
      branchPending={isRowBranchPending}
      onBranch={() => {
        if (retryMessageRef) onBranchConversation?.(retryMessageRef);
      }}
      withAvatarSpacer
      alwaysShowActions
    />
  );
});

const rowEstimateCache = new WeakMap<TranscriptRow, number>();

// Content-shaped height estimates: only ever used for rows the virtualizer
// has never measured (the measurement cache is keyed by row key and survives
// folding), but a shaped guess keeps scroll corrections small while reading
// unmeasured history.
function estimateRowHeight(row: TranscriptRow): number {
  const cached = rowEstimateCache.get(row);
  if (cached !== undefined) {
    return cached;
  }
  let estimate: number;
  if (row.kind === "user") {
    estimate = estimateUserRowHeight(row.text.length, row.attachments.length);
  } else if (row.kind === "assistant") {
    let proseChars = 0;
    let codeLines = 0;
    let codeFences = 0;
    let toolCount = 0;
    let thinkingCount = 0;
    for (const round of row.rounds) {
      for (const block of round.blocks) {
        if (block.kind === "text") {
          const measured = measureEstimateText(block.text);
          proseChars += measured.proseChars;
          codeLines += measured.codeLines;
          codeFences += measured.codeFences;
        } else if (block.kind === "thinking") {
          thinkingCount += 1;
        } else {
          toolCount += 1;
        }
      }
    }
    estimate = estimateAssistantRowHeight({
      proseChars,
      codeLines,
      codeFences,
      toolCount,
      thinkingCount,
    });
  } else if (row.kind === "checkpoint") {
    estimate = CHECKPOINT_ROW_ESTIMATE_PX;
  } else {
    estimate = 120;
  }
  rowEstimateCache.set(row, estimate);
  return estimate;
}

function estimateVirtualItemHeight(item: GatewayTranscriptVirtualItem): number {
  if (item.kind === "loadRemoteHistory") return 44;
  if (item.kind === "pendingBubble") return 56;
  return estimateRowHeight(item.row);
}

const GatewayTranscriptListRegion = memo(function GatewayTranscriptListRegion(props: {
  conversationId?: string;
  rows: readonly TranscriptRow[];
  liveStartIndex: number;
  activeTurnKey?: string | null;
  contentWidth: number;
  scrollViewport: HTMLDivElement | null;
  isViewportFollowing?: () => boolean;
  viewportFollowing: boolean;
  navRef?: MutableRefObject<GatewayTranscriptNavHandle | null>;
  onAnchorUserRowChange?: (rowKey: string | null) => void;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadEarlierHistory?: () => void;
  isStreaming: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  branchPendingMessageId?: string | null;
  toolStatus?: string | null;
  toolStatusIsCompaction: boolean;
  retryAttempts?: readonly RetryAttemptRecord[];
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const {
    conversationId,
    rows,
    liveStartIndex,
    activeTurnKey,
    contentWidth,
    scrollViewport,
    isViewportFollowing,
    viewportFollowing,
    navRef,
    onAnchorUserRowChange,
    hasMoreHistory,
    isLoadingMoreHistory,
    onLoadEarlierHistory,
    isStreaming,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    gitClient,
    onOpenFileLink,
    onLoadUploadedImagePreview,
    onResendFromEdit,
    onBranchConversation,
    branchPendingMessageId,
    toolStatus,
    toolStatusIsCompaction,
    retryAttempts,
    readOnly = false,
    redactToolContent = false,
  } = props;
  const { locale } = useLocale();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const historyIdentityKey = `${conversationId ?? ""}\n${rows[0]?.key ?? ""}`;
  const loadCommitDetails = useCommitDetailsLoader(workspaceRoot, gitClient, historyIdentityKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript identity changes intentionally cancel the current edit
  useEffect(() => {
    setEditingMessageId(null);
  }, [historyIdentityKey]);

  useEffect(() => {
    if (!editingMessageId) {
      return;
    }
    const hasEditingRow = rows.some((row) => row.kind === "user" && row.key === editingMessageId);
    if (!hasEditingRow) {
      setEditingMessageId(null);
    }
  }, [editingMessageId, rows]);

  const displayedToolStatus = useMemo(
    () => normalizeLiveToolStatus(toolStatus ?? null),
    [toolStatus],
  );
  const displayedToolStatusIsCompaction = toolStatusIsCompaction;

  // The live article: the streaming turn's trailing assistant row while a
  // run is active, else the trailing assistant row. It keeps its in-flight
  // structural state regardless of `isStreaming` (folding happens at the
  // next run_started); the caret tracks `isStreaming` separately so it hides
  // cleanly once the stream actually ends.
  const liveAssistantIndex = useMemo(() => {
    if (activeTurnKey) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row?.kind === "assistant" && row.turnKey === activeTurnKey) {
          return index;
        }
      }
      return -1;
    }
    return rows.length > 0 && rows[rows.length - 1]?.kind === "assistant" ? rows.length - 1 : -1;
  }, [activeTurnKey, rows]);

  // The pending bubble (typing dots / vibing / compacting) shows while busy
  // and the transcript has no assistant output for the active exchange yet.
  const shouldShowPendingLiveBubble = useMemo(() => {
    if (readOnly || !isStreaming) {
      return false;
    }
    if (liveAssistantIndex >= 0) {
      return false;
    }
    if (displayedToolStatusIsCompaction) {
      return true;
    }
    const lastRowKind = rows[rows.length - 1]?.kind;
    return !lastRowKind || lastRowKind === "user" || lastRowKind === "checkpoint";
  }, [displayedToolStatusIsCompaction, isStreaming, liveAssistantIndex, readOnly, rows]);

  // Row keys are unique by construction (the row builder's single canonical
  // pass) and feed both React reconciliation and the virtualizer's
  // measurement cache directly.
  const virtualItems = useMemo<GatewayTranscriptVirtualItem[]>(() => {
    const next: GatewayTranscriptVirtualItem[] = [];
    if (!readOnly && hasMoreHistory) {
      next.push({ key: "load-remote-history", kind: "loadRemoteHistory" });
    }
    for (const row of rows) {
      next.push({ key: row.key, kind: "row", row });
    }
    if (shouldShowPendingLiveBubble) {
      next.push({ key: "live-pending-bubble", kind: "pendingBubble" });
    }
    return next;
  }, [hasMoreHistory, rows, readOnly, shouldShowPendingLiveBubble]);

  const leadingOffset = !readOnly && hasMoreHistory ? 1 : 0;
  // Everything at or after the live boundary (including the pending bubble)
  // is force-mounted: a streaming reply must never unmount mid-run.
  const forceMountStart =
    liveStartIndex >= 0
      ? liveStartIndex + leadingOffset
      : shouldShowPendingLiveBubble
        ? virtualItems.length - 1
        : -1;
  const forceMountStartRef = useRef(forceMountStart);
  forceMountStartRef.current = forceMountStart;

  const retryTargetByAssistantKey = useMemo(() => buildRetryTargetMap(rows), [rows]);
  const getTranscriptItemKey = useCallback(
    // The index branch is unreachable (count === virtualItems.length); it
    // only satisfies the type.
    (index: number) => virtualItems[index]?.key ?? `virtual-${index}`,
    [virtualItems],
  );

  // Restored once per mount: at conversation-switch remounts the viewport is
  // already live, so a same-width snapshot skips straight to exact layout.
  const [initialMeasurementsCache] = useState(
    () =>
      (conversationId && scrollViewport
        ? transcriptMeasurementsLru.restore(
            conversationId,
            buildTranscriptLayoutKey(scrollViewport.clientWidth, contentWidth),
          )
        : null) ?? [],
  );

  const transcriptVirtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollViewport,
    estimateSize: (index) => {
      const item = virtualItems[index];
      return item ? estimateVirtualItemHeight(item) : TRANSCRIPT_ROW_ESTIMATED_HEIGHT;
    },
    getItemKey: getTranscriptItemKey,
    gap: TRANSCRIPT_ROW_GAP,
    overscan: TRANSCRIPT_ROW_OVERSCAN_COUNT,
    enabled: scrollViewport !== null,
    // End anchoring is enabled only for a detached reader so keyed prepends
    // preserve the visible row. While following, start anchoring disables the
    // virtualizer's bottom correction and leaves live growth to useScrollFollow.
    anchorTo: viewportFollowing ? "start" : "end",
    scrollEndThreshold: 8,
    initialMeasurementsCache,
    rangeExtractor: (range) => extractLiveRange(range, forceMountStartRef.current),
  });

  // TanStack exposes the resize-compensation predicate as an instance field,
  // not an option; reassigning per render keeps the closure's inputs current.
  // While following it rejects every virtualizer correction; while detached
  // it retains estimate/measurement anchoring for rows above the viewport.
  transcriptVirtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    createLiveRowScrollAdjustPolicy({
      getLiveStartIndex: () => forceMountStartRef.current,
      isFollowing: () => isViewportFollowing?.() ?? false,
    });

  // Every mounted row is already tracked by the virtualizer's ResizeObserver,
  // which updates its measured height as the centered transcript reflows.
  // Do not call measure() on width commits: it clears those fresh measurements
  // after the DOM has already resized, so estimate-based row positions can
  // overlap without another resize event to repopulate the cache.

  // 楼层跳转：scrollToIndex(align:"start") 后连续几帧重对齐——目标行远处的
  // 估高行在滚动后被真实测量，落点会漂移；对准同一 index 是收敛操作，不会
  // 震荡。收敛期间用户的滚轮/触摸/按键立即取消收敛；新跳转替换旧收敛。
  // 楼层导航当前楼层：以「视口顶缘（+8px 容差）」所落在的用户消息为准——与
  // 跳转的 align:"start" 落位一致，跳转后高亮的必然是刚点的楼层；视口贴近
  // 内容底部时直接取最后一层（否则短对话拼满一屏时底部楼层永远无法成为当前
  // 层）。贴底判定用 scrollHeight（与 scrollTop/clientHeight 同一坐标系，
  // 含底部保留区），避免与 getTotalSize 的列表局部坐标错位。
  useTranscriptNavigation({
    items: virtualItems,
    getItemKey: (item) => item.key,
    getAnchorKey: (itemList, anchorIndex) => {
      for (let index = anchorIndex; index >= 0; index -= 1) {
        const item = itemList[index];
        if (item?.kind === "row" && item.row.kind === "user") {
          return item.row.key;
        }
      }
      return null;
    },
    virtualizer: transcriptVirtualizer,
    scrollViewport,
    navRef,
    onAnchorChange: onAnchorUserRowChange,
  });

  // Infinite upward paging: scrolling within one viewport of the top requests
  // the previous page through the same handler as the "load earlier history"
  // button (which stays as the visible affordance and loading indicator).
  // Only scroll events trigger it — opening a conversation lands at the
  // bottom and never auto-fetches — and after a page lands the keyed
  // anchoring parks the viewport about a page below the top, so walking
  // further back keeps paging one request at a time: readers load exactly as
  // far as they scroll, servers transfer only the pages actually walked to,
  // and a failed fetch retries only on the next user scroll (no hammering).
  const autoLoadEarlierInFlightRef = useRef(false);
  const maybeAutoLoadEarlierRef = useRef(() => {});
  maybeAutoLoadEarlierRef.current = () => {
    if (
      readOnly ||
      isStreaming ||
      !hasMoreHistory ||
      !onLoadEarlierHistory ||
      isLoadingMoreHistory ||
      autoLoadEarlierInFlightRef.current ||
      !scrollViewport ||
      scrollViewport.scrollTop > scrollViewport.clientHeight
    ) {
      return;
    }
    autoLoadEarlierInFlightRef.current = true;
    onLoadEarlierHistory();
  };
  useEffect(() => {
    if (!scrollViewport || readOnly) return;
    const handler = () => maybeAutoLoadEarlierRef.current();
    scrollViewport.addEventListener("scroll", handler, { passive: true });
    return () => scrollViewport.removeEventListener("scroll", handler);
  }, [scrollViewport, readOnly]);
  useEffect(() => {
    // The latch guards the gap between firing and the loading flag landing;
    // it releases whenever a load cycle is not (or no longer) running.
    if (!isLoadingMoreHistory) {
      autoLoadEarlierInFlightRef.current = false;
    }
  }, [isLoadingMoreHistory]);

  // First paint of a conversation lands at the bottom before the user sees
  // anything: scrollToEnd re-targets as dynamic measurements land. The region
  // remounts per conversation (keyed by the parent), so this runs once per
  // open; read-only shared views keep their own initial position.
  const scrollToEndOnceRef = useRef(false);
  useLayoutEffect(() => {
    if (
      scrollToEndOnceRef.current ||
      readOnly ||
      scrollViewport === null ||
      virtualItems.length === 0
    ) {
      return;
    }
    scrollToEndOnceRef.current = true;
    transcriptVirtualizer.scrollToEnd();
  }, [readOnly, scrollViewport, virtualItems.length, transcriptVirtualizer]);

  // Snapshot measured heights for the next open of this conversation.
  const saveMeasurementsRef = useRef(() => {});
  saveMeasurementsRef.current = () => {
    if (!conversationId || !scrollViewport) return;
    transcriptMeasurementsLru.save(
      conversationId,
      buildTranscriptLayoutKey(scrollViewport.clientWidth, contentWidth),
      transcriptVirtualizer.takeSnapshot(),
    );
  };
  useEffect(() => () => saveMeasurementsRef.current(), []);

  const virtualRows = transcriptVirtualizer.getVirtualItems();

  return (
    <div className="relative" style={{ height: transcriptVirtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const virtualItem = virtualItems[virtualRow.index];
        if (!virtualItem) return null;

        if (virtualItem.kind === "loadRemoteHistory") {
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="absolute left-0 right-0 top-0 flex justify-center"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <button
                type="button"
                onClick={onLoadEarlierHistory}
                disabled={isLoadingMoreHistory || !onLoadEarlierHistory}
                className="rounded-full border border-border/60 bg-background/80 px-4 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoadingMoreHistory
                  ? locale === "en-US"
                    ? "Loading earlier history..."
                    : "正在加载更早历史..."
                  : locale === "en-US"
                    ? "Load earlier history"
                    : "加载更早历史"}
              </button>
            </div>
          );
        }

        if (virtualItem.kind === "pendingBubble") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="gateway-transcript-row absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <div className="flex w-full max-w-full items-start gap-3">
                <AssistantAvatar />
                <div className="min-w-0 flex-1 space-y-2 pt-1">
                  <div className="flex items-center py-1">
                    <LiveAssistantStatus
                      status={displayedToolStatus}
                      isCompaction={displayedToolStatusIsCompaction}
                    />
                  </div>
                  {retryAttempts && retryAttempts.length > 0 ? (
                    <RetryDetailsBlock attempts={retryAttempts} />
                  ) : null}
                </div>
              </div>
            </article>
          );
        }

        const row = virtualItem.row;
        if (row.kind === "user") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="gateway-transcript-row gateway-transcript-row-user absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <GatewayUserMessageRowBody
                row={row}
                isStreaming={isStreaming}
                readOnly={readOnly}
                isCopied={copiedMessageId === row.key}
                isEditing={editingMessageId === row.key}
                setCopiedMessageId={setCopiedMessageId}
                setEditingMessageId={setEditingMessageId}
                workspaceRoot={workspaceRoot}
                onLoadUploadedImagePreview={onLoadUploadedImagePreview}
                loadCommitDetails={loadCommitDetails}
                onResendFromEdit={onResendFromEdit}
              />
            </article>
          );
        }

        if (row.kind === "assistant") {
          const rowIndex = virtualRow.index - leadingOffset;
          const isLatestLiveAssistant = rowIndex === liveAssistantIndex;
          const isLatestLiveStreaming = isStreaming && isLatestLiveAssistant;
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-row-key={row.key}
              ref={transcriptVirtualizer.measureElement}
              className="gateway-transcript-row absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <div className="group/assistant min-w-0 w-full max-w-full space-y-1">
                <AssistantBubble
                  rounds={row.rounds}
                  showUsage={showUsage}
                  usageContextWindow={usageContextWindow}
                  isLive={isLatestLiveAssistant}
                  isStreaming={isLatestLiveStreaming}
                  renderMode={rowRenderMode(row)}
                  readOnly={readOnly}
                  redactToolContent={redactToolContent}
                  workdir={workspaceRoot}
                  onOpenFileLink={onOpenFileLink}
                />
                {isLatestLiveStreaming ? (
                  <LiveStatusFooter
                    status={displayedToolStatus ?? VIBING_STATUS}
                    isCompaction={displayedToolStatusIsCompaction}
                  />
                ) : null}
                {isLatestLiveStreaming &&
                !shouldShowPendingLiveBubble &&
                retryAttempts &&
                retryAttempts.length > 0 ? (
                  <div className="ml-9 pt-1">
                    <RetryDetailsBlock attempts={retryAttempts} />
                  </div>
                ) : null}
                {!readOnly && !isLatestLiveStreaming ? (
                  <GatewayAssistantMessageActions
                    row={row}
                    retryTarget={retryTargetByAssistantKey.get(row.key) ?? null}
                    isStreaming={isStreaming}
                    isCopied={copiedMessageId === row.key}
                    setCopiedMessageId={setCopiedMessageId}
                    onResendFromEdit={onResendFromEdit}
                    onBranchConversation={onBranchConversation}
                    branchPendingMessageId={branchPendingMessageId}
                  />
                ) : null}
              </div>
            </article>
          );
        }

        if (row.kind === "checkpoint") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="gateway-transcript-row gateway-transcript-row-checkpoint absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <CheckpointCard item={row} readOnly={readOnly} />
            </article>
          );
        }

        return (
          <article
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={transcriptVirtualizer.measureElement}
            className="gateway-transcript-row absolute left-0 right-0 top-0"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            <div className="gateway-bubble gateway-bubble-error">
              <div className="gateway-bubble-label">Error</div>
              <div className="gateway-bubble-content">
                <pre>{row.text}</pre>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
});

export function GatewayTranscript({
  conversationId,
  rows,
  liveStartIndex = -1,
  activeTurnKey = null,
  contentWidth = DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  isViewportFollowing,
  viewportFollowing = false,
  navRef,
  onAnchorUserRowChange,
  error,
  toolStatus,
  toolStatusIsCompaction = false,
  retryAttempts,
  isStreaming = false,
  isLoading = false,
  loadingTitle,
  hasModels = true,
  onOpenSettings,
  hasMoreHistory = false,
  isLoadingMoreHistory = false,
  onLoadEarlierHistory,
  showUsage = false,
  usageContextWindow,
  workspaceRoot,
  gitClient,
  onOpenFileLink,
  onLoadUploadedImagePreview,
  onResendFromEdit,
  onBranchConversation,
  branchPendingMessageId,
  onSuggestionSelect,
  suggestionsDisabled = false,
  readOnly = false,
  redactToolContent = false,
}: GatewayTranscriptProps) {
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const [transcriptScrollViewport, setTranscriptScrollViewport] = useState<HTMLDivElement | null>(
    null,
  );
  const rowCount = rows.length;
  const inlineErrorText = error?.trim() ?? "";
  const shouldShowInlineError = useMemo(() => {
    if (inlineErrorText.length === 0) {
      return false;
    }
    return !rows.some((row) => row.kind === "error" && row.text.trim() === inlineErrorText);
  }, [rows, inlineErrorText]);

  useLayoutEffect(() => {
    const nextViewport = resolveNearestScrollViewport(transcriptListRef.current);
    setTranscriptScrollViewport((current) => (current === nextViewport ? current : nextViewport));
  });

  if (rowCount === 0 && isLoading) {
    return <HistoryLoadingState title={loadingTitle} />;
  }

  if (rowCount === 0 && !isStreaming) {
    const showNoModelsState = !hasModels;
    return (
      <div className="gateway-transcript-shell">
        <div className="gateway-chat-column gateway-empty-state">
          {/* Keyed per conversation so the hero entrance replays when
              switching between empty conversations, not just on mount. */}
          <ChatEmptyState
            key={conversationId ?? "shared"}
            variant={showNoModelsState ? "no-models" : "start-chat"}
            onOpenSettings={onOpenSettings}
            onSuggestionSelect={readOnly ? undefined : onSuggestionSelect}
            suggestionsDisabled={suggestionsDisabled}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="gateway-transcript-shell">
      <div
        ref={transcriptListRef}
        className="gateway-chat-column gateway-transcript-list select-text"
      >
        {/* Keyed remount per conversation: per-conversation state (measured
            heights, scroll-to-end latch) initializes fresh, and row keys can
            never collide across conversations in the itemSizeCache. */}
        <GatewayTranscriptListRegion
          key={conversationId ?? "shared"}
          conversationId={conversationId}
          rows={rows}
          liveStartIndex={liveStartIndex}
          activeTurnKey={activeTurnKey}
          contentWidth={contentWidth}
          scrollViewport={transcriptScrollViewport}
          isViewportFollowing={isViewportFollowing}
          viewportFollowing={viewportFollowing}
          navRef={navRef}
          onAnchorUserRowChange={onAnchorUserRowChange}
          hasMoreHistory={hasMoreHistory}
          isLoadingMoreHistory={isLoadingMoreHistory}
          onLoadEarlierHistory={onLoadEarlierHistory}
          isStreaming={isStreaming}
          showUsage={showUsage}
          usageContextWindow={usageContextWindow}
          workspaceRoot={workspaceRoot}
          gitClient={gitClient}
          onOpenFileLink={onOpenFileLink}
          onLoadUploadedImagePreview={onLoadUploadedImagePreview}
          onResendFromEdit={onResendFromEdit}
          onBranchConversation={onBranchConversation}
          branchPendingMessageId={branchPendingMessageId}
          toolStatus={toolStatus}
          toolStatusIsCompaction={toolStatusIsCompaction}
          retryAttempts={retryAttempts}
          readOnly={readOnly}
          redactToolContent={redactToolContent}
        />
        {shouldShowInlineError ? (
          <div className="gateway-inline-error">{inlineErrorText}</div>
        ) : null}
      </div>
      <div className="gateway-transcript-bottom-spacer" />
    </div>
  );
}
