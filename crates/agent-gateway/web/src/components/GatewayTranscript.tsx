import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, CheckCircle2, ChevronDown, Copy, File, FileText, Loader2, Pencil, Settings, X } from "./icons";
import {
  normalizeLiveToolStatus,
  VIBING_STATUS,
} from "@/lib/chat/chatPageHelpers";
import { getRoundToolTrace } from "@/lib/chat/uiMessages";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import {
  formatUploadedFileSize,
  parsePastedTextDisplayReferences,
  type PendingUploadedFile,
} from "@/lib/chat/uploadedFiles";
import {
  getUploadedImagePreviewCacheKey,
  loadUploadedImagePreview,
  readUploadedImagePreviewCache,
  type UploadedImagePreviewLoader,
} from "@/lib/chat/uploadedImagePreview";
import { Markdown } from "@/components/Markdown";
import { ImagePreview, type ImagePreviewSlide } from "@/components/chat/ImagePreview";
import { useLocale } from "@/i18n/LocaleContext";
import {
  buildGitHubCommitUrl,
  type CommitDetailsLoader,
  type CommitDisplayReference,
  UserMessageContent,
} from "@/lib/chat/userMessageContent";
import type { GitClient } from "@/lib/git/types";
import { cn } from "@/lib/shared/utils";
import {
  AssistantAvatar,
  AssistantBubble,
  CompactingText,
  VibingText,
} from "@/pages/chat/AssistantBubble";

import {
  buildTranscriptItems,
  type ChatEntry,
  type GatewayTranscriptItem,
  type GatewayTranscriptRound,
} from "../lib/chatUi";
import { omitEquivalentTailEntries } from "../lib/liveConversationCommit";
import type {
  LiveConversationStreamSnapshot,
  LiveConversationStreamStore,
} from "../lib/liveConversationStreamStore";
import type { SectionId } from "../pages/settings/types";

type GatewayTranscriptProps = {
  conversationId?: string;
  entries: ChatEntry[];
  liveStore?: LiveConversationStreamStore | null;
  hasLiveStream?: boolean;
  error?: string | null;
  toolStatus?: string | null;
  toolStatusIsCompaction?: boolean;
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
  readOnly?: boolean;
  redactToolContent?: boolean;
};

const EMPTY_LIVE_SNAPSHOT: LiveConversationStreamSnapshot = {
  revision: 0,
  entries: [],
  toolStatus: null,
  toolStatusIsCompaction: false,
};
const TRANSCRIPT_ROW_ESTIMATED_HEIGHT = 260;
const TRANSCRIPT_ROW_GAP = 18;
const TRANSCRIPT_ROW_OVERSCAN_COUNT = 5;

type GatewayTranscriptVirtualItem =
  | { key: string; kind: "loadRemoteHistory" }
  | { key: string; kind: "history"; item: GatewayTranscriptItem };

function resolveNearestScrollViewport(element: HTMLElement | null) {
  return element?.closest("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
}

function subscribeEmptyLiveStore() {
  return () => {};
}

function getEmptyLiveSnapshot() {
  return EMPTY_LIVE_SNAPSHOT;
}

function normalizeRoundsForRender(
  rounds: GatewayTranscriptRound[],
  isLive: boolean,
) {
  if (isLive) {
    return rounds;
  }
  return rounds.map((round) => ({
    ...round,
    runningToolCallIds: [],
    thinkingOpen: undefined,
  }));
}

function TypingDots() {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex gap-1">
        <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      </div>
    </div>
  );
}

function LiveStatusFooter(props: { status: string; isCompaction?: boolean }) {
  const { status, isCompaction = false } = props;
  return (
    <div className="gateway-live-status-footer ml-9 flex items-center gap-2 pt-1 text-[13px]">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      {isCompaction ? (
        <CompactingText className="font-medium text-muted-foreground" />
      ) : status === VIBING_STATUS ? (
        <VibingText className="font-medium text-muted-foreground" />
      ) : (
        <span className="font-medium text-muted-foreground">{status}</span>
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
    getRoundToolTrace(activeRound).map(
      (item) => `${item.toolCall.id}\u0000${item.toolCall.name}`,
    ),
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
          <div className="max-w-[28rem] text-[14px] font-medium text-foreground/90">
            正在加载会话历史
          </div>
          {title ? (
            <div className="mt-1 max-w-[28rem] truncate text-[12px] text-muted-foreground">
              {title}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CheckpointCard(props: {
  item: Extract<ReturnType<typeof buildTranscriptItems>[number], { kind: "checkpoint" }>;
  readOnly?: boolean;
}) {
  const { item, readOnly = false } = props;
  const [expanded, setExpanded] = useState(false);
  const isExpanded = expanded;
  const messageCountLabel = item.coveredMessageCount > 0 ? `${item.coveredMessageCount} 条消息` : "已压缩";
  const headerContent = (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] dark:bg-white/[0.08]">
        <CheckCircle2 size={16} strokeWidth={1.8} className="text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground/90">上下文检查点</span>
          <span className="inline-flex items-center rounded-md bg-black/[0.05] px-1.5 py-[1px] text-[11px] font-normal tabular-nums text-muted-foreground dark:bg-white/[0.08]">
            {messageCountLabel}
          </span>
        </div>
        <div className="mt-[2px] text-[11px] text-muted-foreground/70">
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
        <div className="checkpoint-card w-full overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/[0.72] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] backdrop-blur-xl dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)]">
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
              <Markdown content={item.content} className="font-openai-chat text-sm" readOnly={readOnly} />
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
  const relativePath = typeof file?.relativePath === "string" ? file.relativePath.trim() : "";
  const cacheKey = file
    ? getUploadedImagePreviewCacheKey(normalizedWorkspaceRoot, file)
    : "";
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
  }, [absolutePath, cacheKey, file, loader, normalizedWorkspaceRoot, relativePath]);

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
        "group relative overflow-hidden rounded-xl border border-white/60 bg-white/50 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-xl transition-shadow hover:shadow-[0_2px_8px_rgba(0,0,0,0.1)] dark:border-white/[0.12] dark:bg-white/[0.06]",
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
            {isLoading ? null : <File className="h-5 w-5 opacity-40" />}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium leading-tight text-[hsl(var(--chat-user-fg)/0.85)]">
            {file.fileName}
          </div>
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-[hsl(var(--chat-user-fg)/0.4)]">
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
  return (
    <div
      title={file.relativePath}
      className={cn(
        "group relative flex items-center gap-2 rounded-xl border border-white/60 bg-white/50 px-2.5 py-2 text-left shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-xl transition-shadow hover:shadow-[0_2px_8px_rgba(0,0,0,0.1)] dark:border-white/[0.12] dark:bg-white/[0.06]",
        compact ? "min-w-0 basis-[calc(33.333%-5.33px)] grow" : "w-full",
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-black/[0.03] to-black/[0.06] dark:from-white/[0.06] dark:to-white/[0.1]">
        <FileText className="h-4 w-4 text-[hsl(var(--chat-user-fg)/0.45)]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium leading-tight text-[hsl(var(--chat-user-fg)/0.85)]">
          {file.fileName}
        </div>
        <div className="mt-0.5 text-[10px] tabular-nums leading-tight text-[hsl(var(--chat-user-fg)/0.4)]">
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
    file.kind === "image" &&
    typeof workspaceRoot === "string" &&
    workspaceRoot.trim();
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

  const pastedTextPaths = new Set(
    pastedTextReferences.map((reference) => reference.relativePath),
  );
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

function GatewayUserMessageBubbleBody(props: {
  text: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  loadCommitDetails?: CommitDetailsLoader;
}) {
  const {
    text,
    attachments,
    workspaceRoot,
    onLoadUploadedImagePreview,
    loadCommitDetails,
  } = props;
  const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(
    attachments,
    text,
  );

  return (
    <div className="chat-bubble-enter chat-user-bubble rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5 font-openai-chat text-[14.5px] leading-relaxed text-[hsl(var(--chat-user-fg))]">
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
  const { initialText, attachments, workspaceRoot, onLoadUploadedImagePreview, onCancel, onSubmit } = props;
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
        className="chat-user-bubble-editor-textarea w-full resize-none overflow-hidden rounded-lg bg-transparent p-2 font-openai-chat text-[14.5px] leading-relaxed text-[hsl(var(--chat-user-fg))] outline-none"
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

const GatewayTranscriptHistory = memo(function GatewayTranscriptHistory(props: {
  conversationId?: string;
  items: GatewayTranscriptItem[];
  scrollViewport: HTMLDivElement | null;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadFullHistory?: () => void;
  isStreaming: boolean;
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
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const {
    conversationId,
    items,
    scrollViewport,
    hasMoreHistory,
    isLoadingMoreHistory,
    onLoadFullHistory,
    isStreaming,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    gitClient,
    onLoadUploadedImagePreview,
    onResendFromEdit,
    readOnly = false,
    redactToolContent = false,
  } = props;
  const { locale, t } = useLocale();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const historyIdentityKey = `${conversationId ?? ""}\n${items[0]?.id ?? ""}`;
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
    const hasEditingItem = items.some(
      (item) => item.kind === "user" && item.id === editingMessageId,
    );
    if (!hasEditingItem) {
      setEditingMessageId(null);
    }
  }, [editingMessageId, items]);

  const virtualItems = useMemo<GatewayTranscriptVirtualItem[]>(() => {
    const next: GatewayTranscriptVirtualItem[] = [];
    if (!readOnly && hasMoreHistory) {
      next.push({ key: "load-remote-history", kind: "loadRemoteHistory" });
    }
    for (const item of items) {
      next.push({ key: item.id, kind: "history", item });
    }
    return next;
  }, [hasMoreHistory, items, readOnly]);
  const getTranscriptItemKey = useCallback(
    (index: number) => virtualItems[index]?.key ?? index,
    [virtualItems],
  );
  const transcriptVirtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollViewport,
    estimateSize: () => TRANSCRIPT_ROW_ESTIMATED_HEIGHT,
    getItemKey: getTranscriptItemKey,
    gap: TRANSCRIPT_ROW_GAP,
    overscan: TRANSCRIPT_ROW_OVERSCAN_COUNT,
    enabled: scrollViewport !== null,
  });
  const virtualRows = transcriptVirtualizer.getVirtualItems();

  return (
    <div
      className="relative"
      style={{ height: transcriptVirtualizer.getTotalSize() }}
    >
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

        const item = virtualItem.item;
        if (item.kind === "user") {
          const isCopied = copiedMessageId === item.id;
          const isEditing = editingMessageId === item.id;
          const effectiveMessageRef = item.messageRef;
          const missingStableRef = !effectiveMessageRef;
          const editDisabled = readOnly || isStreaming || !onResendFromEdit || missingStableRef;
          const editTitle = missingStableRef
            ? locale === "en-US"
              ? "This older message cannot be edited because it has no stable message identifier."
              : "旧历史缺少稳定消息标识，无法编辑重发"
            : t("chat.edit");
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="gateway-transcript-row gateway-transcript-row-user absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {isEditing && effectiveMessageRef ? (
                <EditableUserMessageBubble
                  initialText={item.text}
                  attachments={item.attachments}
                  workspaceRoot={workspaceRoot}
                  onLoadUploadedImagePreview={onLoadUploadedImagePreview}
                  onCancel={() => setEditingMessageId(null)}
                  onSubmit={(text, attachments) => {
                    setEditingMessageId(null);
                    onResendFromEdit?.(effectiveMessageRef, text, attachments);
                  }}
                />
              ) : (
                <div className="chat-user-bubble-wrap group relative ml-auto max-w-[min(85%,calc(50em+2rem))]">
                  <GatewayUserMessageBubbleBody
                    text={item.text}
                    attachments={item.attachments}
                    workspaceRoot={workspaceRoot}
                    onLoadUploadedImagePreview={onLoadUploadedImagePreview}
                    loadCommitDetails={loadCommitDetails}
                  />
                  {!readOnly ? (
                    <div className="chat-user-bubble-actions mt-1 flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        className="chat-user-bubble-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        title={t("chat.copy")}
                        aria-label={t("chat.copy")}
                        onClick={() => {
                          void navigator.clipboard.writeText(item.text).then(() => {
                            setCopiedMessageId(item.id);
                            window.setTimeout(() => {
                              setCopiedMessageId((current) =>
                                current === item.id ? null : current,
                              );
                            }, 1500);
                          });
                        }}
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="chat-user-bubble-action rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title={editTitle}
                        aria-label={editTitle}
                        disabled={editDisabled}
                        onClick={() => {
                          if (effectiveMessageRef) {
                            setEditingMessageId(item.id);
                          }
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </article>
          );
        }

        if (item.kind === "assistant") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="gateway-transcript-row absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <div className="min-w-0 w-full max-w-full space-y-1">
                <AssistantBubble
                  rounds={normalizeRoundsForRender(item.rounds, false)}
                  showUsage={showUsage}
                  usageContextWindow={usageContextWindow}
                  isLive={false}
                  readOnly={readOnly}
                  redactToolContent={redactToolContent}
                />
              </div>
            </article>
          );
        }

        if (item.kind === "checkpoint") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="gateway-transcript-row gateway-transcript-row-checkpoint absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <CheckpointCard item={item} readOnly={readOnly} />
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
                <pre>{item.text}</pre>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
});

const GatewayTranscriptLiveState = memo(function GatewayTranscriptLiveState(props: {
  liveSnapshot: LiveConversationStreamSnapshot;
  lastHistoryKind?: GatewayTranscriptItem["kind"];
  isStreaming: boolean;
  isAgentMode: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  toolStatus?: string | null;
  toolStatusIsCompaction: boolean;
}) {
  const {
    liveSnapshot,
    lastHistoryKind,
    isStreaming,
    isAgentMode,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    gitClient,
    onLoadUploadedImagePreview,
    toolStatus,
    toolStatusIsCompaction,
  } = props;
  const loadCommitDetails = useGatewayCommitDetailsLoader(workspaceRoot, gitClient);
  const liveItems = useMemo(
    () => buildTranscriptItems(liveSnapshot.entries),
    [liveSnapshot.entries],
  );
  const activeLiveAssistantIndex = useMemo(() => {
    const lastItem = liveItems.at(-1);
    if (lastItem?.kind !== "assistant") {
      return -1;
    }
    return liveItems.length - 1;
  }, [liveItems]);
  const displayedToolStatus = useMemo(
    () => normalizeLiveToolStatus(liveSnapshot.toolStatus ?? toolStatus ?? null),
    [liveSnapshot.toolStatus, toolStatus],
  );
  const displayedToolStatusIsCompaction =
    liveSnapshot.toolStatus !== null
      ? liveSnapshot.toolStatusIsCompaction
      : toolStatusIsCompaction;
  const shouldShowPendingLiveBubble = useMemo(() => {
    if (!isStreaming) {
      return false;
    }
    if (displayedToolStatusIsCompaction) {
      return true;
    }
    const lastItemKind = liveItems.at(-1)?.kind ?? lastHistoryKind;
    return !lastItemKind || lastItemKind === "user" || lastItemKind === "checkpoint";
  }, [displayedToolStatusIsCompaction, isStreaming, lastHistoryKind, liveItems]);

  if (liveItems.length === 0 && !shouldShowPendingLiveBubble) {
    return null;
  }

  return (
    <>
      {liveItems.map((item, index) => {
        if (item.kind === "user") {
          return (
            <article key={item.id} className="gateway-transcript-row gateway-transcript-row-user">
              <div className="chat-user-bubble-wrap group relative ml-auto max-w-[min(85%,calc(50em+2rem))]">
                <GatewayUserMessageBubbleBody
                  text={item.text}
                  attachments={item.attachments}
                  workspaceRoot={workspaceRoot}
                  onLoadUploadedImagePreview={onLoadUploadedImagePreview}
                  loadCommitDetails={loadCommitDetails}
                />
              </div>
            </article>
          );
        }

        if (item.kind === "assistant") {
          // While the entry is still part of the live snapshot, render it in
          // its in-flight structural state regardless of `isStreaming`. The
          // snapshot is retained on purpose after `done` so the article stays
          // in place; gating `isLive` on `isStreaming` would otherwise
          // re-render the article in one frame (thinking collapses, markdown
          // switches to static mode, tool indicators clear) and produce a
          // visible flash. The caret tracks `isStreaming` separately so it
          // hides cleanly once the stream actually ends.
          const isLatestLiveAssistant = index === activeLiveAssistantIndex;
          const isLatestLiveStreaming = isStreaming && isLatestLiveAssistant;
          const shouldShowLiveStatus =
            isLatestLiveStreaming &&
            Boolean(displayedToolStatus) &&
            !displayedToolStatusIsCompaction &&
            shouldShowLiveStatusForRounds(item.rounds);
          const liveStatusText = shouldShowLiveStatus ? displayedToolStatus ?? "" : "";
          return (
            <article key={item.id} className="gateway-transcript-row">
              <div className="min-w-0 w-full max-w-full space-y-1">
                <AssistantBubble
                  rounds={normalizeRoundsForRender(item.rounds, isLatestLiveAssistant)}
                  showUsage={showUsage}
                  usageContextWindow={usageContextWindow}
                  isLive={isLatestLiveAssistant}
                  isStreaming={isLatestLiveStreaming}
                />
                {shouldShowLiveStatus ? (
                  <LiveStatusFooter status={liveStatusText} />
                ) : null}
              </div>
            </article>
          );
        }

        if (item.kind === "checkpoint") {
          return (
            <article key={item.id} className="gateway-transcript-row gateway-transcript-row-checkpoint">
              <CheckpointCard item={item} />
            </article>
          );
        }

        if (item.kind === "error") {
          return (
            <article key={item.id} className="gateway-transcript-row">
              <div className="gateway-bubble gateway-bubble-error">
                <div className="gateway-bubble-label">Error</div>
                <div className="gateway-bubble-content">
                  <pre>{item.text}</pre>
                </div>
              </div>
            </article>
          );
        }

        return null;
      })}
      {shouldShowPendingLiveBubble ? (
        <article className="gateway-transcript-row">
          <div className="flex w-full max-w-full items-start gap-3">
            <AssistantAvatar />
            <div className="min-w-0 flex-1 pt-1">
              {displayedToolStatusIsCompaction ? (
                <div className="flex items-center py-1">
                  <CompactingText className="text-sm font-medium text-muted-foreground" />
                </div>
              ) : isAgentMode ? (
                displayedToolStatus === VIBING_STATUS ? (
                  <div className="flex items-center py-1">
                    <VibingText className="text-sm font-medium text-muted-foreground" />
                  </div>
                ) : displayedToolStatus ? (
                  <div className="py-1 text-sm text-muted-foreground">{displayedToolStatus}</div>
                ) : (
                  <TypingDots />
                )
              ) : displayedToolStatus === VIBING_STATUS ? (
                <div className="flex items-center py-1">
                  <VibingText className="text-sm font-medium text-muted-foreground" />
                </div>
              ) : displayedToolStatus ? (
                <div className="py-1 text-sm text-muted-foreground">{displayedToolStatus}</div>
              ) : (
                <TypingDots />
              )}
            </div>
          </div>
        </article>
      ) : null}
    </>
  );
});

export function GatewayTranscript({
  conversationId,
  entries,
  liveStore,
  hasLiveStream = false,
  error,
  toolStatus,
  toolStatusIsCompaction = false,
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
  readOnly = false,
  redactToolContent = false,
}: GatewayTranscriptProps) {
  const { t } = useLocale();
  const liveSnapshot = useSyncExternalStore(
    liveStore?.subscribe ?? subscribeEmptyLiveStore,
    liveStore?.getSnapshot ?? getEmptyLiveSnapshot,
    liveStore?.getSnapshot ?? getEmptyLiveSnapshot,
  );
  const historyEntries = useMemo(
    () => omitEquivalentTailEntries(entries, liveSnapshot.entries),
    [entries, liveSnapshot.entries],
  );
  const historyItems = useMemo(() => buildTranscriptItems(historyEntries), [historyEntries]);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const [transcriptScrollViewport, setTranscriptScrollViewport] =
    useState<HTMLDivElement | null>(null);
  const hasLiveEntries = liveSnapshot.entries.length > 0;
  const lastHistoryKind = historyItems.at(-1)?.kind;
  const inlineErrorText = error?.trim() ?? "";
  const shouldShowInlineError = useMemo(
    () =>
      inlineErrorText.length > 0 &&
      !historyItems.some(
        (item) => item.kind === "error" && item.text.trim() === inlineErrorText,
      ),
    [historyItems, inlineErrorText],
  );

  useLayoutEffect(() => {
    const nextViewport = resolveNearestScrollViewport(transcriptListRef.current);
    setTranscriptScrollViewport((current) =>
      current === nextViewport ? current : nextViewport,
    );
  });

  if (historyItems.length === 0 && !hasLiveEntries && isLoading) {
    return <HistoryLoadingState title={loadingTitle} />;
  }

  if (historyItems.length === 0 && !hasLiveEntries && !isStreaming && !hasLiveStream) {
    const showNoModelsState = !hasModels;
    return (
      <div className="gateway-transcript-shell">
        <div className="gateway-chat-column gateway-empty-state">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
            <div className="hero-glow-pulse h-[360px] w-[360px] rounded-full bg-[radial-gradient(closest-side,hsl(var(--foreground)/0.08),transparent_70%)] blur-3xl" />
          </div>

          <div className="relative flex flex-col items-center">
            <div className="hero-entrance hero-icon-float mb-5 flex h-24 w-24 items-center justify-center">
              <img
                src="/icon-simple.png"
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-[72px] w-[72px] select-none object-contain"
              />
            </div>

            <h2
              className="hero-entrance-delay-1 bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-center text-2xl font-semibold leading-tight tracking-tight text-transparent"
              style={{ margin: `0 0 ${showNoModelsState ? 16 : 25}px` }}
            >
              {showNoModelsState ? t("chat.welcome") : t("chat.startChat")}
            </h2>

            {showNoModelsState ? (
              <>
                <p className="hero-entrance-delay-2 mb-1.5 text-center text-sm leading-relaxed text-muted-foreground">
                  {t("chat.noModelSelected")}
                </p>
                <p className="hero-entrance-delay-2 mb-8 text-center text-sm leading-relaxed text-muted-foreground">
                  {t("chat.configureModel")}
                </p>
                {onOpenSettings ? (
                  <button
                    type="button"
                    onClick={() => onOpenSettings("providers")}
                    className="hero-entrance-delay-3 group inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/65 px-5 py-2 text-sm font-medium text-foreground/85 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-xl transition-all duration-200 hover:-translate-y-[1px] hover:bg-white/80 hover:text-foreground hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] active:translate-y-0 active:shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-foreground/90 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),0_8px_24px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-white/[0.1]"
                  >
                    <Settings className="h-3.5 w-3.5 text-foreground/55 transition-colors group-hover:text-foreground/80" />
                    {t("chat.goToSettings")}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="hero-entrance-delay-2 max-w-[300px] text-center text-[13px] leading-relaxed text-muted-foreground/85">
                {t("chat.startChatDesc")}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gateway-transcript-shell">
      <div ref={transcriptListRef} className="gateway-chat-column gateway-transcript-list select-text">
        <GatewayTranscriptHistory
          conversationId={conversationId}
          items={historyItems}
          scrollViewport={transcriptScrollViewport}
          hasMoreHistory={hasMoreHistory}
          isLoadingMoreHistory={isLoadingMoreHistory}
          onLoadFullHistory={onLoadFullHistory}
          isStreaming={isStreaming}
          showUsage={showUsage}
          usageContextWindow={usageContextWindow}
          workspaceRoot={workspaceRoot}
          gitClient={gitClient}
          onLoadUploadedImagePreview={onLoadUploadedImagePreview}
          onResendFromEdit={onResendFromEdit}
          readOnly={readOnly}
          redactToolContent={redactToolContent}
        />
        {!readOnly ? (
          <GatewayTranscriptLiveState
            liveSnapshot={liveSnapshot}
            lastHistoryKind={lastHistoryKind}
            isStreaming={isStreaming}
            isAgentMode={isAgentMode}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            workspaceRoot={workspaceRoot}
            gitClient={gitClient}
            onLoadUploadedImagePreview={onLoadUploadedImagePreview}
            toolStatus={toolStatus}
            toolStatusIsCompaction={toolStatusIsCompaction}
          />
        ) : null}
        {shouldShowInlineError ? (
          <div className="gateway-inline-error">{inlineErrorText}</div>
        ) : null}
      </div>
      <div className="gateway-transcript-bottom-spacer" />
    </div>
  );
}
