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
import { ImagePreview, type ImagePreviewSlide } from "@/components/chat/ImagePreview";
import { Markdown } from "@/components/Markdown";
import { useLocale } from "@/i18n/LocaleContext";
import { normalizeLiveToolStatus, VIBING_STATUS } from "@/lib/chat/chatPageHelpers";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import { getRoundText, getRoundToolTrace } from "@/lib/chat/uiMessages";
import {
  formatUploadedFileSize,
  type PendingUploadedFile,
  parsePastedTextDisplayReferences,
} from "@/lib/chat/uploadedFiles";
import {
  getUploadedImagePreviewCacheKey,
  loadUploadedImagePreview,
  readUploadedImagePreviewCache,
  type UploadedImagePreviewLoader,
} from "@/lib/chat/uploadedImagePreview";
import {
  buildGitHubCommitUrl,
  type CommitDetailsLoader,
  type CommitDisplayReference,
  UserMessageContent,
} from "@/lib/chat/userMessageContent";
import type { GitClient } from "@/lib/git/types";
import { cn } from "@/lib/shared/utils";
import { extractLiveRange } from "@/lib/transcript-virtual/liveRangeExtractor";
import { createLiveRowScrollAdjustPolicy } from "@/lib/transcript-virtual/liveScrollAdjustPolicy";
import { createTranscriptMeasurementsLru } from "@/lib/transcript-virtual/measurementsLru";
import {
  CHECKPOINT_ROW_ESTIMATE_PX,
  estimateAssistantRowHeight,
  estimateUserRowHeight,
  measureEstimateText,
} from "@/lib/transcript-virtual/rowEstimates";
import {
  AssistantAvatar,
  AssistantBubble,
  AssistantStatus,
  CompactingText,
  RetryDetailsBlock,
  VibingText,
} from "@/pages/chat/AssistantBubble";
import type { RetryAttemptRecord, TranscriptRow } from "../lib/chat/transcript/types";

import type { GatewayTranscriptRound } from "../lib/chatUi";
import type { SectionId } from "../pages/settings/types";
import { ChatEmptyState } from "./chat/ChatEmptyState";
import { getUploadedFileTypeIcon } from "./chat/fileTypeIcons";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  GitBranch,
  Loader2,
  Pencil,
  RefreshCw,
  X,
} from "./icons";
import { ConfirmActionPopover } from "./ui/confirm-action-popover";

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
  // Whether the scroll-follow engine is attached to the bottom; gates the
  // virtualizer's resize-compensation carve-out for live-row growth.
  isViewportFollowing?: () => boolean;
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
  onLoadFullHistory?: () => void;
  isAgentMode?: boolean;
  showUsage?: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
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

export type GatewayTranscriptNavHandle = {
  // Aligns the row to the viewport top and keeps re-aligning for a few
  // frames while dynamic measurements land (convergent, cancelled by user
  // scroll input).
  scrollToRowKey: (rowKey: string) => void;
};

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
    <div className="gateway-live-status-footer ml-9 pt-1">
      {isCompaction ? (
        <CompactingText />
      ) : status === VIBING_STATUS ? (
        <VibingText />
      ) : (
        <AssistantStatus>{status}</AssistantStatus>
      )}
    </div>
  );
}

function shouldShowLiveStatusForRounds(rounds: GatewayTranscriptRound[]) {
  const activeRound = rounds[rounds.length - 1];
  if (!activeRound) {
    return true;
  }
  const visibleToolKeys = new Set(
    getRoundToolTrace(activeRound).map((item) => `${item.toolCall.id}\u0000${item.toolCall.name}`),
  );

  for (let index = activeRound.blocks.length - 1; index >= 0; index -= 1) {
    const block = activeRound.blocks[index];
    if (!block) {
      continue;
    }
    if (block.kind === "tool") {
      if (visibleToolKeys.has(`${block.item.toolCall.id}\u0000${block.item.toolCall.name}`)) {
        return true;
      }
      continue;
    }
    if (block.kind === "hostedSearch") {
      return false;
    }
    if (block.text.trim() === "") {
      continue;
    }
    return block.kind !== "text";
  }

  return true;
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
  const [expanded, setExpanded] = useState(false);
  const isExpanded = expanded;
  const messageCountLabel =
    item.coveredMessageCount > 0 ? `${item.coveredMessageCount} 条消息` : "已压缩";
  const headerContent = (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] dark:bg-white/[0.08]">
        <CheckCircle2 size={16} strokeWidth={1.8} className="text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[calc(13px*var(--zone-font-scale,1))] font-medium text-foreground/90">
            上下文检查点
          </span>
          <span className="inline-flex items-center rounded-md bg-black/[0.05] px-1.5 py-[1px] text-[calc(11px*var(--zone-font-scale,1))] font-normal tabular-nums text-muted-foreground dark:bg-white/[0.08]">
            {messageCountLabel}
          </span>
        </div>
        <div className="mt-[2px] text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/70">
          {item.generatedBy.providerId} · {item.generatedBy.model}
        </div>
      </div>

      <ChevronDown
        className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 ${isExpanded ? "rotate-0" : "-rotate-90"}`}
      />
    </>
  );

  return (
    <div className="checkpoint-row flex w-full max-w-full items-start gap-3">
      <div className="checkpoint-row-spacer mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
      <div className="checkpoint-row-body min-w-0 flex-1">
        <div className="checkpoint-card w-full overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/[0.85] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)]">
          <button
            type="button"
            aria-expanded={isExpanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
          >
            {headerContent}
          </button>

          {isExpanded ? (
            <div className="checkpoint-expand border-t border-black/[0.05] px-3.5 py-3 dark:border-white/[0.06]">
              <Markdown content={item.content} className="font-chat text-sm" readOnly={readOnly} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function useGatewayUploadedImagePreview(
  file?: PendingUploadedFile,
  workspaceRoot?: string,
  loader?: UploadedImagePreviewLoader,
) {
  const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  const absolutePath = typeof file?.absolutePath === "string" ? file.absolutePath.trim() : "";
  const cacheKey = file ? getUploadedImagePreviewCacheKey(normalizedWorkspaceRoot, file) : "";
  const [imageSrc, setImageSrc] = useState<string | null | undefined>(() => {
    if (!file || !normalizedWorkspaceRoot) return null;
    return readUploadedImagePreviewCache(normalizedWorkspaceRoot, file);
  });

  useEffect(() => {
    if (!file || !cacheKey || !normalizedWorkspaceRoot) {
      setImageSrc(null);
      return;
    }

    const cached = readUploadedImagePreviewCache(normalizedWorkspaceRoot, file);
    if (cached !== undefined) {
      setImageSrc(cached);
      return;
    }
    if (!absolutePath || !loader) {
      setImageSrc(null);
      return;
    }

    let cancelled = false;
    setImageSrc(undefined);
    void loadUploadedImagePreview({
      workspaceRoot: normalizedWorkspaceRoot,
      file,
      loader,
    }).then((value) => {
      if (!cancelled) {
        setImageSrc(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [absolutePath, cacheKey, file, loader, normalizedWorkspaceRoot]);

  return {
    imageSrc: imageSrc ?? null,
    isLoading: Boolean(cacheKey && absolutePath && loader) && imageSrc === undefined,
  };
}

function GatewayUserImageAttachmentCard(props: {
  file: PendingUploadedFile;
  imageSrc: string | null;
  isLoading: boolean;
  compact: boolean;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
  previewLabel: string;
  closePreviewLabel: string;
}) {
  const {
    file,
    imageSrc,
    isLoading,
    compact,
    onRemove,
    removeLabel,
    previewLabel,
    closePreviewLabel,
  } = props;
  const [previewOpen, setPreviewOpen] = useState(false);
  const labeledPreview = `${previewLabel}: ${file.fileName}`;
  const FallbackIcon = getUploadedFileTypeIcon(file);
  const previewSlides = useMemo<ImagePreviewSlide[]>(
    () =>
      imageSrc
        ? [
            {
              src: imageSrc,
              alt: file.fileName,
              title: file.fileName,
            },
          ]
        : [],
    [file.fileName, imageSrc],
  );
  return (
    <div
      title={file.relativePath}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-white/60 bg-white/75 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-[0_2px_8px_rgba(0,0,0,0.1)] dark:border-white/[0.12] dark:bg-white/[0.06]",
        compact ? "min-w-0 basis-[calc(33.333%-5.33px)] grow" : "w-full max-w-[280px]",
      )}
    >
      {onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(file.relativePath)}
          className="absolute top-1.5 right-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/30 text-white/90 opacity-0 backdrop-blur-sm transition-all hover:bg-black/45 group-hover:opacity-100"
          aria-label={removeLabel ?? file.fileName}
          title={removeLabel}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
      {imageSrc ? (
        <>
          <button
            type="button"
            className="block w-full cursor-zoom-in overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            aria-label={labeledPreview}
            title={labeledPreview}
            onClick={() => setPreviewOpen(true)}
          >
            <img
              src={imageSrc}
              alt={file.fileName}
              className={cn(
                "w-full bg-black/[0.02] transition-transform hover:scale-[1.01] dark:bg-white/5",
                compact ? "h-28 object-cover" : "max-h-56 object-contain",
              )}
            />
          </button>
          {previewOpen ? (
            <ImagePreview
              open={previewOpen}
              slides={previewSlides}
              closeLabel={closePreviewLabel}
              onClose={() => setPreviewOpen(false)}
            />
          ) : null}
        </>
      ) : (
        <div
          className={cn(
            "flex w-full items-center justify-center bg-black/[0.02] dark:bg-white/5",
            compact ? "h-28" : "h-36",
          )}
        >
          <div
            className={
              isLoading
                ? "h-16 w-16 animate-pulse rounded-xl bg-black/5 dark:bg-white/10"
                : "flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.03] dark:bg-white/10"
            }
          >
            {isLoading ? null : <FallbackIcon className="h-5 w-5" />}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-tight text-[hsl(var(--chat-user-fg)/0.85)]">
            {file.fileName}
          </div>
        </div>
        <span className="shrink-0 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums text-[hsl(var(--chat-user-fg)/0.4)]">
          {formatUploadedFileSize(file.sizeBytes)}
        </span>
      </div>
    </div>
  );
}

function GatewayUserFileAttachmentCard(props: {
  file: PendingUploadedFile;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
  compact: boolean;
}) {
  const { file, onRemove, removeLabel, compact } = props;
  const TypeIcon = getUploadedFileTypeIcon(file);
  return (
    <div
      title={file.relativePath}
      className={cn(
        "group relative flex items-center gap-2 rounded-xl border border-white/60 bg-white/75 px-2.5 py-2 text-left shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-[0_2px_8px_rgba(0,0,0,0.1)] dark:border-white/[0.12] dark:bg-white/[0.06]",
        compact ? "min-w-0 basis-[calc(33.333%-5.33px)] grow" : "w-full",
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-black/[0.03] to-black/[0.06] dark:from-white/[0.06] dark:to-white/[0.1]">
        <TypeIcon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-tight text-[hsl(var(--chat-user-fg)/0.85)]">
          {file.fileName}
        </div>
        <div className="mt-0.5 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums leading-tight text-[hsl(var(--chat-user-fg)/0.4)]">
          {formatUploadedFileSize(file.sizeBytes)}
        </div>
      </div>
      {onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(file.relativePath)}
          className="absolute top-1/2 right-1.5 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[hsl(var(--chat-user-fg)/0.3)] opacity-0 transition-all hover:bg-black/5 hover:text-[hsl(var(--chat-user-fg)/0.6)] group-hover:opacity-100 dark:hover:bg-white/10"
          aria-label={removeLabel ?? file.fileName}
          title={removeLabel}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function GatewayUserAttachmentCard(props: {
  file: PendingUploadedFile;
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  compactImageLayout: boolean;
  compactFileLayout: boolean;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
  previewLabel: string;
  closePreviewLabel: string;
}) {
  const {
    file,
    workspaceRoot,
    onLoadUploadedImagePreview,
    compactImageLayout,
    compactFileLayout,
    onRemove,
    removeLabel,
    previewLabel,
    closePreviewLabel,
  } = props;
  const shouldPreviewImage =
    file.kind === "image" && typeof workspaceRoot === "string" && workspaceRoot.trim();
  const { imageSrc, isLoading } = useGatewayUploadedImagePreview(
    shouldPreviewImage ? file : undefined,
    shouldPreviewImage ? workspaceRoot : undefined,
    onLoadUploadedImagePreview,
  );

  if (shouldPreviewImage) {
    return (
      <GatewayUserImageAttachmentCard
        file={file}
        imageSrc={imageSrc}
        isLoading={isLoading}
        compact={compactImageLayout}
        onRemove={onRemove}
        removeLabel={removeLabel}
        previewLabel={previewLabel}
        closePreviewLabel={closePreviewLabel}
      />
    );
  }

  return (
    <GatewayUserFileAttachmentCard
      file={file}
      onRemove={onRemove}
      removeLabel={removeLabel}
      compact={compactFileLayout}
    />
  );
}

function GatewayUserAttachmentCards(props: {
  files: PendingUploadedFile[];
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
}) {
  const { files, workspaceRoot, onLoadUploadedImagePreview, onRemove, removeLabel } = props;
  const { t } = useLocale();
  if (files.length === 0) return null;

  const imageFiles = files.filter((file) => file.kind === "image");
  const otherFiles = files.filter((file) => file.kind !== "image");
  const compactImageLayout = imageFiles.length > 1;
  const compactFileLayout = otherFiles.length > 1;
  const previewLabel = t("chat.upload.previewImage");
  const closePreviewLabel = t("chat.upload.closePreview");

  return (
    <div className="mb-2 flex flex-col gap-2">
      {imageFiles.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {imageFiles.map((file) => (
            <GatewayUserAttachmentCard
              key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
              file={file}
              workspaceRoot={workspaceRoot}
              onLoadUploadedImagePreview={onLoadUploadedImagePreview}
              compactImageLayout={compactImageLayout}
              compactFileLayout={false}
              onRemove={onRemove}
              removeLabel={removeLabel}
              previewLabel={previewLabel}
              closePreviewLabel={closePreviewLabel}
            />
          ))}
        </div>
      ) : null}
      {otherFiles.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {otherFiles.map((file) => (
            <GatewayUserAttachmentCard
              key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
              file={file}
              workspaceRoot={workspaceRoot}
              onLoadUploadedImagePreview={onLoadUploadedImagePreview}
              compactImageLayout={false}
              compactFileLayout={compactFileLayout}
              onRemove={onRemove}
              removeLabel={removeLabel}
              previewLabel={previewLabel}
              closePreviewLabel={closePreviewLabel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function splitUserAttachmentsForDisplay(files: PendingUploadedFile[], text: string) {
  const pastedTextReferences = parsePastedTextDisplayReferences(text);
  if (pastedTextReferences.length === 0 || files.length === 0) {
    return {
      visibleFiles: files,
      pastedTextFiles: [],
    };
  }

  const pastedTextPaths = new Set(pastedTextReferences.map((reference) => reference.relativePath));
  const pastedTextFiles: PendingUploadedFile[] = [];
  const visibleFiles: PendingUploadedFile[] = [];

  for (const file of files) {
    if (pastedTextPaths.has(file.relativePath)) {
      pastedTextFiles.push(file);
    } else {
      visibleFiles.push(file);
    }
  }

  return {
    visibleFiles,
    pastedTextFiles,
  };
}

function formatMessageTimestamp(timestamp: number | undefined, now = new Date()): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${monthDay} ${time}`;
  }
  return `${date.getFullYear()}-${monthDay} ${time}`;
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
      <GatewayUserAttachmentCards
        files={visibleFiles}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
      />
      {text ? (
        <UserMessageContent
          text={text}
          pastedTextFiles={pastedTextFiles}
          loadCommitDetails={loadCommitDetails}
        />
      ) : null}
    </div>
  );
}

const MIN_EDIT_BUBBLE_HEIGHT_PX = 72;

function resizeEditableTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }
  textarea.style.height = "0px";
  textarea.style.height = `${Math.max(textarea.scrollHeight, MIN_EDIT_BUBBLE_HEIGHT_PX)}px`;
}

const EditableUserMessageBubble = memo(function EditableUserMessageBubble(props: {
  initialText: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  onCancel: () => void;
  onSubmit: (text: string, attachments: PendingUploadedFile[]) => void;
}) {
  const {
    initialText,
    attachments,
    workspaceRoot,
    onLoadUploadedImagePreview,
    onCancel,
    onSubmit,
  } = props;
  const { t } = useLocale();
  const [draftText, setDraftText] = useState(initialText);
  const [draftAttachments, setDraftAttachments] = useState(attachments);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    resizeEditableTextarea(textarea);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  }, []);

  useEffect(() => {
    setDraftAttachments(attachments);
  }, [attachments]);

  useLayoutEffect(() => {
    resizeEditableTextarea(textareaRef.current);
  }, [draftText]);

  const canSubmit = draftText.trim().length > 0 || draftAttachments.length > 0;

  return (
    <div className="chat-user-bubble-editor w-full max-w-[min(85%,calc(50em+2.5rem))] rounded-2xl border border-border bg-[hsl(var(--chat-user-bg))] p-3">
      <GatewayUserAttachmentCards
        files={draftAttachments}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        onRemove={(relativePath) => {
          setDraftAttachments((current) =>
            current.filter((file) => file.relativePath !== relativePath),
          );
        }}
        removeLabel={t("settings.delete")}
      />
      <textarea
        ref={textareaRef}
        className="chat-user-bubble-editor-textarea w-full resize-none overflow-hidden rounded-lg bg-transparent p-2 font-chat text-[calc(14.5px*var(--zone-font-scale,1))] leading-relaxed text-[hsl(var(--chat-user-fg))] outline-none"
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        rows={1}
        aria-label={t("chat.editMessage")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
          onClick={onCancel}
        >
          {t("chat.cancel")}
        </button>
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) {
              return;
            }
            onSubmit(draftText.trim(), draftAttachments);
          }}
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
});

function useGatewayCommitDetailsLoader(
  workspaceRoot?: string,
  gitClient?: GitClient | null,
  cacheResetKey?: string,
) {
  const commitDetailsCacheRef = useRef(new Map<string, CommitDisplayReference>());

  useEffect(() => {
    if (cacheResetKey !== undefined) {
      commitDetailsCacheRef.current.clear();
    }
  }, [cacheResetKey]);

  return useCallback<CommitDetailsLoader>(
    async (commit) => {
      const workdir = workspaceRoot?.trim() ?? "";
      const sha = commit.sha.trim();
      if (!gitClient || !workdir || !sha) return null;
      const cacheKey = `${workdir}\u0000${sha}`;
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
      <div className="chat-user-bubble-actions mt-1 flex items-center justify-end gap-1.5">
        {!readOnly ? (
          <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <button
              type="button"
              className="chat-user-bubble-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              title={t("chat.copy")}
              aria-label={t("chat.copy")}
              onClick={() => {
                void navigator.clipboard.writeText(row.text).then(() => {
                  setCopiedMessageId(row.key);
                  window.setTimeout(() => {
                    setCopiedMessageId((current) => (current === row.key ? null : current));
                  }, 1500);
                });
              }}
            >
              {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              className="chat-user-bubble-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={editTitle}
              aria-label={editTitle}
              disabled={editDisabled}
              onClick={() => {
                if (effectiveMessageRef) {
                  setEditingMessageId(row.key);
                }
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <span className="select-none text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
          {formatMessageTimestamp(row.timestamp)}
        </span>
      </div>
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
    <div className="assistant-bubble-shell flex w-full max-w-full items-start gap-3">
      <div className="assistant-bubble-avatar w-7 shrink-0" aria-hidden="true" />
      <div className="chat-assistant-actions flex min-w-0 flex-1 items-center justify-start gap-1.5">
        <span className="select-none text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
          {formatMessageTimestamp(row.timestamp)}
        </span>
        <div
          className={`flex gap-0.5 transition-opacity group-focus-within/assistant:opacity-100 group-hover/assistant:opacity-100 [@media(hover:none)]:opacity-100 ${isRowBranchPending ? "opacity-100" : "opacity-0"}`}
        >
          <button
            type="button"
            className="chat-assistant-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title={t("chat.copy")}
            aria-label={t("chat.copy")}
            disabled={!replyText}
            onClick={() => {
              void navigator.clipboard.writeText(replyText).then(() => {
                setCopiedMessageId(row.key);
                window.setTimeout(() => {
                  setCopiedMessageId((current) => (current === row.key ? null : current));
                }, 1500);
              });
            }}
          >
            {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <ConfirmActionPopover
            title={t("chat.retryConfirmTitle")}
            description={t("chat.retryConfirmDescription")}
            confirmLabel={t("chat.retry")}
            align="start"
            side="top"
            onConfirm={() => {
              if (!retryTarget || !retryMessageRef) return;
              onResendFromEdit?.(retryMessageRef, retryTarget.text, retryTarget.attachments);
            }}
          >
            {(open) => (
              <button
                type="button"
                className="chat-assistant-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={retryTitle}
                aria-label={retryTitle}
                disabled={retryDisabled}
                onClick={open}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
          </ConfirmActionPopover>
          <ConfirmActionPopover
            title={t("chat.branchConfirmTitle")}
            description={t("chat.branchConfirmDescription")}
            confirmLabel={t("chat.branch")}
            tone="default"
            align="start"
            side="top"
            onConfirm={() => {
              if (!retryMessageRef) return;
              onBranchConversation?.(retryMessageRef);
            }}
          >
            {(open) => (
              <button
                type="button"
                className={`chat-assistant-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed ${isRowBranchPending ? "" : "disabled:opacity-40"}`}
                title={branchTitle}
                aria-label={branchTitle}
                disabled={branchDisabled}
                onClick={open}
              >
                {isRowBranchPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitBranch className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </ConfirmActionPopover>
        </div>
      </div>
    </div>
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
  scrollViewport: HTMLDivElement | null;
  isViewportFollowing?: () => boolean;
  navRef?: MutableRefObject<GatewayTranscriptNavHandle | null>;
  onAnchorUserRowChange?: (rowKey: string | null) => void;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadFullHistory?: () => void;
  isStreaming: boolean;
  isAgentMode: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
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
    scrollViewport,
    isViewportFollowing,
    navRef,
    onAnchorUserRowChange,
    hasMoreHistory,
    isLoadingMoreHistory,
    onLoadFullHistory,
    isStreaming,
    isAgentMode,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    gitClient,
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
  const loadCommitDetails = useGatewayCommitDetailsLoader(
    workspaceRoot,
    gitClient,
    historyIdentityKey,
  );

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
    if (displayedToolStatusIsCompaction) {
      return true;
    }
    const lastRowKind = rows[rows.length - 1]?.kind;
    return !lastRowKind || lastRowKind === "user" || lastRowKind === "checkpoint";
  }, [displayedToolStatusIsCompaction, isStreaming, readOnly, rows]);

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
        ? transcriptMeasurementsLru.restore(conversationId, scrollViewport.clientWidth)
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
    // End-anchored: prepends (loading earlier history) keep the visible item
    // stable upstream via keyed anchoring, growth of the last row while the
    // viewport is virtually at the end compensates by the total-size delta,
    // and estimate→measure corrections keep the bottom pinned. The threshold
    // matches scrollFollowCore's BOTTOM_ATTACH_THRESHOLD_PX so both engines
    // agree on what "at the bottom" means. followOnAppend stays off: its
    // DOM-distance re-follow would conflict with the follow reducer's
    // "shrink clamps never re-attach" contract — appends while following are
    // already pinned by the reducer.
    anchorTo: "end",
    scrollEndThreshold: 8,
    initialMeasurementsCache,
    rangeExtractor: (range) => extractLiveRange(range, forceMountStartRef.current),
  });

  // TanStack exposes the resize-compensation predicate as an instance field,
  // not an option; reassigning per render keeps the closure's inputs current.
  // It only governs the detached reader — while virtually at the end, the
  // upstream end-anchor compensation takes priority over this predicate.
  transcriptVirtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    createLiveRowScrollAdjustPolicy({
      getLiveStartIndex: () => forceMountStartRef.current,
      isFollowing: () => isViewportFollowing?.() ?? false,
    });

  // 楼层跳转：scrollToIndex(align:"start") 后连续几帧重对齐——目标行远处的
  // 估高行在滚动后被真实测量，落点会漂移；对准同一 index 是收敛操作，不会
  // 震荡。收敛期间用户的滚轮/触摸/按键立即取消收敛；新跳转替换旧收敛。
  const virtualItemsRef = useRef(virtualItems);
  virtualItemsRef.current = virtualItems;
  const cancelJumpSettleRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (!navRef) return;
    const handle: GatewayTranscriptNavHandle = {
      scrollToRowKey: (rowKey) => {
        cancelJumpSettleRef.current();
        const alignToRow = () => {
          const index = virtualItemsRef.current.findIndex((item) => item.key === rowKey);
          if (index < 0) return false;
          transcriptVirtualizer.scrollToIndex(index, { align: "start" });
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
  }, [navRef, transcriptVirtualizer, scrollViewport]);

  // 楼层导航当前楼层：以「视口顶缘（+8px 容差）」所落在的用户消息为准——与
  // 跳转的 align:"start" 落位一致，跳转后高亮的必然是刚点的楼层；视口贴近
  // 内容底部时直接取最后一层（否则短对话拼满一屏时底部楼层永远无法成为当前
  // 层）。贴底判定用 scrollHeight（与 scrollTop/clientHeight 同一坐标系，
  // 含底部保留区），避免与 getTotalSize 的列表局部坐标错位。
  const lastAnchorRef = useRef<string | null>(null);
  const onAnchorUserRowChangeRef = useRef(onAnchorUserRowChange);
  onAnchorUserRowChangeRef.current = onAnchorUserRowChange;
  const reportAnchorRef = useRef(() => {});
  reportAnchorRef.current = () => {
    const callback = onAnchorUserRowChangeRef.current;
    if (!callback || !scrollViewport) return;
    const itemList = virtualItemsRef.current;
    let anchorKey: string | null = null;
    if (itemList.length > 0) {
      const scrollTop = scrollViewport.scrollTop;
      const viewportHeight = scrollViewport.clientHeight;
      const nearBottom = scrollTop + viewportHeight >= scrollViewport.scrollHeight - 32;
      let anchorIndex = -1;
      if (nearBottom) {
        anchorIndex = itemList.length - 1;
      } else {
        const anchorLine = scrollTop + 8;
        const items = transcriptVirtualizer.getVirtualItems();
        for (const item of items) {
          if (item.start > anchorLine) break;
          anchorIndex = item.index;
        }
        if (anchorIndex === -1) anchorIndex = items[0]?.index ?? -1;
      }
      for (let i = Math.min(anchorIndex, itemList.length - 1); i >= 0; i--) {
        const item = itemList[i];
        if (item?.kind === "row" && item.row.kind === "user") {
          anchorKey = item.row.key;
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

  // 行集合变化（消息追加、流式落定）后兜底重算一次；依赖 virtualItems 而不是
  // 每次渲染都跑，避免「上报 → 父级重渲染 → 再上报」的空转循环。
  useEffect(() => {
    virtualItemsRef.current = virtualItems;
    reportAnchorRef.current();
  }, [virtualItems]);

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
      scrollViewport.clientWidth,
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
                onClick={onLoadFullHistory}
                disabled={isLoadingMoreHistory || !onLoadFullHistory}
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
                  {displayedToolStatusIsCompaction ? (
                    <div className="flex items-center py-1">
                      <CompactingText />
                    </div>
                  ) : isAgentMode ? (
                    displayedToolStatus === VIBING_STATUS ? (
                      <div className="flex items-center py-1">
                        <VibingText />
                      </div>
                    ) : displayedToolStatus ? (
                      <div className="py-1">
                        <AssistantStatus>{displayedToolStatus}</AssistantStatus>
                      </div>
                    ) : (
                      <div className="py-1">
                        <VibingText />
                      </div>
                    )
                  ) : displayedToolStatus === VIBING_STATUS ? (
                    <div className="flex items-center py-1">
                      <VibingText />
                    </div>
                  ) : displayedToolStatus ? (
                    <div className="py-1">
                      <AssistantStatus>{displayedToolStatus}</AssistantStatus>
                    </div>
                  ) : (
                    <div className="py-1">
                      <VibingText />
                    </div>
                  )}
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
          const shouldShowLiveStatus =
            isLatestLiveStreaming &&
            Boolean(displayedToolStatus) &&
            !displayedToolStatusIsCompaction &&
            shouldShowLiveStatusForRounds(row.rounds);
          const liveStatusText = shouldShowLiveStatus ? (displayedToolStatus ?? "") : "";
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
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
                />
                {shouldShowLiveStatus ? <LiveStatusFooter status={liveStatusText} /> : null}
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
  isViewportFollowing,
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
  onLoadFullHistory,
  isAgentMode = true,
  showUsage = false,
  usageContextWindow,
  workspaceRoot,
  gitClient,
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
          scrollViewport={transcriptScrollViewport}
          isViewportFollowing={isViewportFollowing}
          navRef={navRef}
          onAnchorUserRowChange={onAnchorUserRowChange}
          hasMoreHistory={hasMoreHistory}
          isLoadingMoreHistory={isLoadingMoreHistory}
          onLoadFullHistory={onLoadFullHistory}
          isStreaming={isStreaming}
          isAgentMode={isAgentMode}
          showUsage={showUsage}
          usageContextWindow={usageContextWindow}
          workspaceRoot={workspaceRoot}
          gitClient={gitClient}
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
