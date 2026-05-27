import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import iconSimpleUrl from "../../../src-tauri/icons/icon-simple.png";
import { ImagePreview, type ImagePreviewSlide } from "../../components/chat/ImagePreview";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  File,
  FileText,
  LoaderCircle,
  Pencil,
  Settings,
  X,
} from "../../components/icons";
import { LiveMarkdown, Markdown } from "../../components/Markdown";
import { ScrollArea } from "../../components/ui/scroll-area";
import { useLocale } from "../../i18n";
import type {
  HistoryMessageRef,
  RenderSummaryCard,
  RenderTimelineItem,
} from "../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../lib/chat/conversation/liveTranscriptStore";
import { getRoundText } from "../../lib/chat/messages/uiMessages";
import {
  formatUploadedFileSize,
  type PendingUploadedFile,
  parsePastedTextDisplayReferences,
} from "../../lib/chat/messages/uploadedFiles";
import { UserMessageContent } from "../../lib/chat/messages/userMessageContent";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../lib/chat/page/chatPageHelpers";
import { cn } from "../../lib/shared/utils";
import type { SectionId } from "../settings/types";
import { AssistantAvatar, AssistantBubble, CompactingText, VibingText } from "./AssistantBubble";
import { resolveNearestScrollViewport, resolveScrollViewport } from "./chatScrollViewport";

type UploadedImagePreviewResponse = {
  mimeType: string;
  data: string;
};

const uploadedImagePreviewCache = new Map<string, string>();
const uploadedImagePreviewRequests = new Map<string, Promise<string | null>>();
const UPLOADED_IMAGE_PREVIEW_CACHE_LIMIT = 64;

function getUploadedImagePreviewCacheKey(workspaceRoot: string, absolutePath: string) {
  return `${workspaceRoot}\n${absolutePath}`;
}

function readUploadedImagePreviewCache(cacheKey: string) {
  const cached = uploadedImagePreviewCache.get(cacheKey);
  if (cached === undefined) return undefined;
  uploadedImagePreviewCache.delete(cacheKey);
  uploadedImagePreviewCache.set(cacheKey, cached);
  return cached;
}

function writeUploadedImagePreviewCache(cacheKey: string, value: string) {
  uploadedImagePreviewCache.delete(cacheKey);
  uploadedImagePreviewCache.set(cacheKey, value);

  while (uploadedImagePreviewCache.size > UPLOADED_IMAGE_PREVIEW_CACHE_LIMIT) {
    const oldestKey = uploadedImagePreviewCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    uploadedImagePreviewCache.delete(oldestKey);
  }
}

async function loadUploadedImagePreview(params: { workspaceRoot: string; absolutePath: string }) {
  const { workspaceRoot, absolutePath } = params;
  const cacheKey = getUploadedImagePreviewCacheKey(workspaceRoot, absolutePath);
  const cached = readUploadedImagePreviewCache(cacheKey);
  if (cached !== undefined) return cached;

  const existing = uploadedImagePreviewRequests.get(cacheKey);
  if (existing) return existing;

  const request = invoke<UploadedImagePreviewResponse>("system_read_uploaded_image_preview", {
    workdir: workspaceRoot,
    absolute_path: absolutePath,
  })
    .then((result) => {
      const mimeType =
        typeof result.mimeType === "string" && result.mimeType.trim()
          ? result.mimeType
          : "application/octet-stream";
      const data = typeof result.data === "string" ? result.data.trim() : "";
      const next = data ? `data:${mimeType};base64,${data}` : null;
      if (next) {
        writeUploadedImagePreviewCache(cacheKey, next);
      }
      return next;
    })
    .catch(() => null)
    .finally(() => {
      uploadedImagePreviewRequests.delete(cacheKey);
    });

  uploadedImagePreviewRequests.set(cacheKey, request);
  return request;
}

function useUploadedImagePreview(absolutePath?: string, workspaceRoot?: string) {
  const normalizedPath = typeof absolutePath === "string" ? absolutePath.trim() : "";
  const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  const cacheKey =
    normalizedPath && normalizedWorkspaceRoot
      ? getUploadedImagePreviewCacheKey(normalizedWorkspaceRoot, normalizedPath)
      : "";
  const [imageSrc, setImageSrc] = useState<string | null | undefined>(() => {
    if (!cacheKey) return null;
    return readUploadedImagePreviewCache(cacheKey);
  });

  useEffect(() => {
    if (!cacheKey || !normalizedPath || !normalizedWorkspaceRoot) {
      setImageSrc(null);
      return;
    }

    const cached = readUploadedImagePreviewCache(cacheKey);
    if (cached !== undefined) {
      setImageSrc(cached);
      return;
    }

    let cancelled = false;
    setImageSrc(undefined);
    void loadUploadedImagePreview({
      workspaceRoot: normalizedWorkspaceRoot,
      absolutePath: normalizedPath,
    }).then((value) => {
      if (!cancelled) {
        setImageSrc(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, normalizedPath, normalizedWorkspaceRoot]);

  return {
    imageSrc: imageSrc ?? null,
    isLoading: Boolean(cacheKey) && imageSrc === undefined,
  };
}

function UserImageAttachmentCard({
  file,
  imageSrc,
  isLoading,
  compact,
  onRemove,
  removeLabel,
  previewLabel,
  closePreviewLabel,
}: {
  file: PendingUploadedFile;
  imageSrc: string | null;
  isLoading: boolean;
  compact: boolean;
  onRemove?: ((relativePath: string) => void) | undefined;
  removeLabel?: string;
  previewLabel: string;
  closePreviewLabel: string;
}) {
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

function UserFileAttachmentCard({
  file,
  onRemove,
  removeLabel,
  compact,
}: {
  file: PendingUploadedFile;
  onRemove?: ((relativePath: string) => void) | undefined;
  removeLabel?: string;
  compact: boolean;
}) {
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

function UserAttachmentCard({
  file,
  workspaceRoot,
  compactImageLayout,
  compactFileLayout,
  onRemove,
  removeLabel,
  previewLabel,
  closePreviewLabel,
}: {
  file: PendingUploadedFile;
  workspaceRoot?: string;
  compactImageLayout: boolean;
  compactFileLayout: boolean;
  onRemove?: ((relativePath: string) => void) | undefined;
  removeLabel?: string;
  previewLabel: string;
  closePreviewLabel: string;
}) {
  const shouldPreviewImage =
    file.kind === "image" && typeof file.absolutePath === "string" && file.absolutePath.trim();
  const { imageSrc, isLoading } = useUploadedImagePreview(
    shouldPreviewImage ? file.absolutePath : undefined,
    workspaceRoot,
  );

  if (shouldPreviewImage) {
    return (
      <UserImageAttachmentCard
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
    <UserFileAttachmentCard
      file={file}
      onRemove={onRemove}
      removeLabel={removeLabel}
      compact={compactFileLayout}
    />
  );
}

function UserAttachmentCards({
  files,
  workspaceRoot,
  onRemove,
}: {
  files: PendingUploadedFile[];
  workspaceRoot?: string;
  onRemove?: ((relativePath: string) => void) | undefined;
}) {
  const { t } = useLocale();
  if (files.length === 0) return null;
  const imageFiles = files.filter((file) => file.kind === "image");
  const otherFiles = files.filter((file) => file.kind !== "image");
  const compactImageLayout = imageFiles.length > 1;
  const compactFileLayout = otherFiles.length > 1;
  const removeLabel = onRemove ? t("chat.upload.removeFile") : undefined;
  const previewLabel = t("chat.upload.previewImage");
  const closePreviewLabel = t("chat.upload.closePreview");

  return (
    <div className="mb-2 flex flex-col gap-2">
      {imageFiles.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {imageFiles.map((file) => (
            <UserAttachmentCard
              key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
              file={file}
              workspaceRoot={workspaceRoot}
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
            <UserAttachmentCard
              key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
              file={file}
              workspaceRoot={workspaceRoot}
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

function HistorySwitchLoadingOverlay() {
  const { locale } = useLocale();
  const label = locale === "en-US" ? "Loading conversation..." : "正在加载对话...";

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-background/95 backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3.5 py-2 text-xs font-medium text-muted-foreground shadow-sm">
        <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}

type ChatTranscriptProps = {
  conversationId: string;
  workspaceRoot?: string;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
  hasModels: boolean;
  historyItems: RenderTimelineItem[];
  isHistorySwitching: boolean;
  isSending: boolean;
  isAgentMode: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  liveTranscriptStore: LiveTranscriptStore;
  isCompactionRunning: boolean;
  copiedMessageKey: string | null;
  setCopiedMessageKey: (key: string | null) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
  ) => void;
  onOpenSettings: (section?: SectionId) => void;
};

type TranscriptHistoryProps = Pick<
  ChatTranscriptProps,
  | "historyItems"
  | "conversationId"
  | "workspaceRoot"
  | "showUsage"
  | "usageContextWindow"
  | "copiedMessageKey"
  | "setCopiedMessageKey"
  | "onResendFromEdit"
> & {
  isSending: boolean;
  scrollViewport: HTMLDivElement | null;
};

type TranscriptLiveStateProps = Pick<
  ChatTranscriptProps,
  | "isSending"
  | "isAgentMode"
  | "showUsage"
  | "usageContextWindow"
  | "liveTranscriptStore"
  | "isCompactionRunning"
>;

const TRANSCRIPT_ROW_ESTIMATED_HEIGHT = 260;
const TRANSCRIPT_ROW_GAP = 24;
const TRANSCRIPT_ROW_OVERSCAN_COUNT = 5;

const SummaryCard = memo(function SummaryCard(props: { item: RenderSummaryCard }) {
  const { item } = props;
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const isEn = locale === "en-US";

  return (
    <div className="flex justify-center px-2">
      <div className="checkpoint-card w-full max-w-3xl overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/[0.72] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] backdrop-blur-xl dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)]">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
        >
          {/* Icon */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] dark:bg-white/[0.08]">
            <CheckCircle2 size={16} strokeWidth={1.8} className="text-muted-foreground" />
          </div>

          {/* Text content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-foreground/90">
                {isEn ? "Context Checkpoint" : "上下文检查点"}
              </span>
              <span className="inline-flex items-center rounded-md bg-black/[0.05] px-1.5 py-[1px] text-[11px] font-normal tabular-nums text-muted-foreground dark:bg-white/[0.08]">
                {item.coveredMessageCount} {isEn ? "msgs" : "条消息"}
              </span>
            </div>
            <div className="mt-[2px] text-[11px] text-muted-foreground/70">
              {item.generatedBy.providerId} · {item.generatedBy.model}
            </div>
          </div>

          {/* Expand/collapse chevron */}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 ${expanded ? "rotate-0" : "-rotate-90"}`}
          />
        </button>

        {/* Expandable content */}
        {expanded ? (
          <div className="checkpoint-expand border-t border-black/[0.05] px-3.5 py-3 dark:border-white/[0.06]">
            <Markdown content={item.content} className="font-openai-chat text-sm" />
          </div>
        ) : null}
      </div>
    </div>
  );
});

const EditableUserMessageBubble = memo(function EditableUserMessageBubble(props: {
  initialText: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  compactedClass: string;
  onCancel: () => void;
  onSubmit: (text: string, attachments: PendingUploadedFile[]) => void;
}) {
  const { initialText, attachments, workspaceRoot, compactedClass, onCancel, onSubmit } = props;
  const { t } = useLocale();
  const [draftText, setDraftText] = useState(initialText);
  const [draftAttachments, setDraftAttachments] = useState(attachments);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const viewport = resolveNearestScrollViewport(textarea);
    const scrollTopBeforeFocus = viewport?.scrollTop ?? null;
    const restoreViewportScroll = () => {
      if (viewport && scrollTopBeforeFocus !== null) {
        viewport.scrollTop = scrollTopBeforeFocus;
      }
    };

    textarea.focus({ preventScroll: true });
    const cursorPosition = textarea.value.length;
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    restoreViewportScroll();

    const rafId = requestAnimationFrame(restoreViewportScroll);
    return () => cancelAnimationFrame(rafId);
  }, []);

  useEffect(() => {
    setDraftAttachments(attachments);
  }, [attachments]);

  const canSubmit = draftText.trim().length > 0 || draftAttachments.length > 0;

  return (
    <div
      className={`w-full max-w-[min(85%,calc(50em+2.5rem))] rounded-2xl border border-border bg-[hsl(var(--chat-user-bg))] p-3 ${compactedClass}`}
    >
      <UserAttachmentCards
        files={draftAttachments}
        workspaceRoot={workspaceRoot}
        onRemove={(relativePath) => {
          setDraftAttachments((prev) => prev.filter((file) => file.relativePath !== relativePath));
        }}
      />
      <textarea
        ref={textareaRef}
        className="w-full resize-none rounded-lg bg-transparent p-2 font-openai-chat text-[14.5px] leading-relaxed text-[hsl(var(--chat-user-fg))] outline-none"
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        rows={Math.max(2, draftText.split("\n").length)}
        aria-label={t("chat.editMessage")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
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
          className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
          disabled={!canSubmit}
          onClick={() => {
            const newText = draftText.trim();
            if (!canSubmit) return;
            onSubmit(newText, draftAttachments);
          }}
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
});

const TranscriptHistory = memo(function TranscriptHistory(props: TranscriptHistoryProps) {
  const {
    conversationId,
    historyItems,
    scrollViewport,
    showUsage,
    usageContextWindow,
    copiedMessageKey,
    setCopiedMessageKey,
    onResendFromEdit,
    workspaceRoot,
    isSending,
  } = props;
  const { t } = useLocale();
  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(null);
  const copiedResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setEditingMessageKey(null);
  }, [conversationId]);

  useEffect(
    () => () => {
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
    },
    [],
  );

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

  const getTranscriptItemKey = useCallback(
    (index: number) => historyItems[index]?.key ?? index,
    [historyItems],
  );
  const transcriptVirtualizer = useVirtualizer({
    count: historyItems.length,
    getScrollElement: () => scrollViewport,
    estimateSize: () => TRANSCRIPT_ROW_ESTIMATED_HEIGHT,
    getItemKey: getTranscriptItemKey,
    gap: TRANSCRIPT_ROW_GAP,
    overscan: TRANSCRIPT_ROW_OVERSCAN_COUNT,
    enabled: scrollViewport !== null,
  });
  const virtualRows = transcriptVirtualizer.getVirtualItems();

  return (
    <div className="relative" style={{ height: transcriptVirtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const item = historyItems[virtualRow.index];
        if (!item) return null;

        if (item.kind === "summary") {
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <SummaryCard item={item} />
            </div>
          );
        }

        if (item.kind === "user") {
          const isEditing = editingMessageKey === item.key;
          const isCopied = copiedMessageKey === item.key;
          const compactedClass = item.isFromCompactedSegment ? "opacity-70" : "";
          const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(
            item.attachments,
            item.text,
          );
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="absolute left-0 right-0 top-0 flex justify-end"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {isEditing ? (
                <EditableUserMessageBubble
                  initialText={item.text}
                  attachments={item.attachments}
                  workspaceRoot={workspaceRoot}
                  compactedClass={compactedClass}
                  onCancel={() => setEditingMessageKey(null)}
                  onSubmit={(newText, nextAttachments) => {
                    setEditingMessageKey(null);
                    onResendFromEdit(item.messageRef, newText, nextAttachments);
                  }}
                />
              ) : (
                <div
                  className={`chat-user-bubble-wrap group relative ml-auto max-w-[min(85%,calc(50em+2rem))] ${compactedClass}`}
                >
                  <div className="chat-bubble-enter chat-user-bubble rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5 font-openai-chat text-[14.5px] leading-relaxed text-[hsl(var(--chat-user-fg))]">
                    <UserAttachmentCards files={visibleFiles} workspaceRoot={workspaceRoot} />
                    {item.text ? (
                      <UserMessageContent text={item.text} pastedTextFiles={pastedTextFiles} />
                    ) : null}
                  </div>
                  <div className="mt-1 flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                      title={t("chat.copy")}
                      onClick={() => {
                        navigator.clipboard.writeText(item.text);
                        setCopiedMessageKey(item.key);
                        if (copiedResetTimerRef.current !== null) {
                          window.clearTimeout(copiedResetTimerRef.current);
                        }
                        copiedResetTimerRef.current = window.setTimeout(() => {
                          copiedResetTimerRef.current = null;
                          setCopiedMessageKey(null);
                        }, 1500);
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
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                      title={t("chat.edit")}
                      disabled={isSending}
                      onClick={() => setEditingMessageKey(item.key)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        }

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={transcriptVirtualizer.measureElement}
            className={`absolute left-0 right-0 top-0 flex justify-start ${
              item.isFromCompactedSegment ? "opacity-70" : ""
            }`}
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {item.rounds.length > 0 ? (
              <AssistantBubble
                rounds={item.rounds}
                showUsage={showUsage}
                usageContextWindow={usageContextWindow}
              />
            ) : (
              <div className="flex w-full max-w-full items-start gap-3">
                <AssistantAvatar />
                <div className="min-w-0 flex-1 pt-0.5">
                  {getRoundText(item.rounds[item.rounds.length - 1] ?? { blocks: [] }).trim() ? (
                    <Markdown
                      content={getRoundText(item.rounds[item.rounds.length - 1] ?? { blocks: [] })}
                      className="font-openai-chat"
                    />
                  ) : null}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

const TranscriptLiveState = memo(function TranscriptLiveState(props: TranscriptLiveStateProps) {
  const {
    isSending,
    isAgentMode,
    showUsage,
    usageContextWindow,
    liveTranscriptStore,
    isCompactionRunning,
  } = props;
  const liveState = useSyncExternalStore(
    liveTranscriptStore.subscribe,
    liveTranscriptStore.getSnapshot,
    liveTranscriptStore.getSnapshot,
  );
  const { draftAssistantText, liveRounds, toolStatus } = liveState;
  const displayedToolStatus = normalizeLiveToolStatus(toolStatus);

  if (!isSending) {
    return null;
  }

  if (liveRounds.length > 0) {
    return (
      <div className="flex justify-start">
        <AssistantBubble
          rounds={liveRounds}
          showUsage={showUsage}
          usageContextWindow={usageContextWindow}
          isLive
          toolStatus={displayedToolStatus}
          toolStatusVariant={isCompactionRunning ? "compaction" : "default"}
        />
      </div>
    );
  }

  if (isAgentMode) {
    return (
      <div className="flex justify-start">
        <div className="flex w-full max-w-full items-start gap-3">
          <AssistantAvatar />
          <div className="min-w-0 flex-1 pt-1">
            {isCompactionRunning ? (
              <div className="flex items-center py-1">
                <CompactingText className="text-sm font-medium text-muted-foreground" />
              </div>
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
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="flex w-full max-w-full items-start gap-3">
        <AssistantAvatar />
        <div className="min-w-0 flex-1 pt-0.5">
          {draftAssistantText ? (
            <LiveMarkdown content={draftAssistantText} className="font-openai-chat" isAnimating />
          ) : isCompactionRunning ? (
            <div className="flex items-center py-1">
              <CompactingText className="text-sm font-medium text-muted-foreground" />
            </div>
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
    </div>
  );
});

export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  const {
    conversationId,
    workspaceRoot,
    scrollAreaRef,
    bottomRef,
    hasModels,
    historyItems,
    isHistorySwitching,
    isSending,
    isAgentMode,
    showUsage,
    usageContextWindow,
    liveTranscriptStore,
    isCompactionRunning,
    copiedMessageKey,
    setCopiedMessageKey,
    onResendFromEdit,
    onOpenSettings,
  } = props;
  const { t } = useLocale();
  const showNoModelsState = !hasModels;
  const showStartChatState = hasModels && historyItems.length === 0 && !isSending;
  const shouldReserveTranscriptBottomSpace = !(showNoModelsState || showStartChatState);
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const nextViewport = resolveScrollViewport(scrollAreaRef.current);
    setScrollViewport((current) => (current === nextViewport ? current : nextViewport));
  });

  return (
    <div className="relative min-h-0 flex-1">
      <ScrollArea ref={scrollAreaRef} className="h-full">
        <div className="mx-auto w-full max-w-[768px] px-5 py-4">
          {showNoModelsState ? (
            <div className="flex min-h-[calc(100vh-220px)] flex-col items-center justify-center">
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <div className="hero-glow-pulse h-[360px] w-[360px] rounded-full bg-[radial-gradient(closest-side,hsl(var(--foreground)/0.08),transparent_70%)] blur-3xl" />
              </div>

              <div className="relative flex flex-col items-center">
                <div className="hero-entrance hero-icon-float mb-5 flex h-24 w-24 items-center justify-center">
                  <img
                    src={iconSimpleUrl}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="h-[72px] w-[72px] select-none object-contain"
                  />
                </div>
                <h2 className="hero-entrance-delay-1 mb-2 bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-2xl font-semibold leading-tight tracking-tight text-transparent">
                  {t("chat.welcome")}
                </h2>
                <p className="hero-entrance-delay-2 mb-1 text-sm text-muted-foreground">
                  {t("chat.noModelSelected")}
                </p>
                <p className="hero-entrance-delay-2 mb-7 text-sm text-muted-foreground">
                  {t("chat.configureModel")}
                </p>
                <button
                  type="button"
                  onClick={() => onOpenSettings("providers")}
                  className="hero-entrance-delay-3 group inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/65 px-5 py-2 text-sm font-medium text-foreground/85 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-xl transition-all duration-200 hover:-translate-y-[1px] hover:bg-white/80 hover:text-foreground hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] active:translate-y-0 active:shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-foreground/90 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),0_8px_24px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-white/[0.1]"
                >
                  <Settings className="h-3.5 w-3.5 text-foreground/55 transition-colors group-hover:text-foreground/80" />
                  {t("chat.goToSettings")}
                </button>
              </div>
            </div>
          ) : showStartChatState ? (
            <div className="flex min-h-[calc(100vh-220px)] flex-col items-center justify-center">
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <div className="hero-glow-pulse h-[360px] w-[360px] rounded-full bg-[radial-gradient(closest-side,hsl(var(--foreground)/0.08),transparent_70%)] blur-3xl" />
              </div>

              <div className="relative flex flex-col items-center">
                <div className="hero-entrance hero-icon-float mb-5 flex h-24 w-24 items-center justify-center">
                  <img
                    src={iconSimpleUrl}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="h-[72px] w-[72px] select-none object-contain"
                  />
                </div>

                <h2 className="hero-entrance-delay-1 mb-2 bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-2xl font-semibold leading-tight tracking-tight text-transparent">
                  {t("chat.startChat")}
                </h2>

                <p className="hero-entrance-delay-2 max-w-[280px] text-center text-sm leading-relaxed text-muted-foreground">
                  {t("chat.startChatDesc")}
                </p>
              </div>
            </div>
          ) : null}

          <div className="space-y-6">
            <TranscriptHistory
              conversationId={conversationId}
              workspaceRoot={workspaceRoot}
              scrollViewport={scrollViewport}
              historyItems={historyItems}
              showUsage={showUsage}
              usageContextWindow={usageContextWindow}
              copiedMessageKey={copiedMessageKey}
              setCopiedMessageKey={setCopiedMessageKey}
              onResendFromEdit={onResendFromEdit}
              isSending={isSending}
            />

            <TranscriptLiveState
              isSending={isSending}
              isAgentMode={isAgentMode}
              showUsage={showUsage}
              usageContextWindow={usageContextWindow}
              liveTranscriptStore={liveTranscriptStore}
              isCompactionRunning={isCompactionRunning}
            />
          </div>

          <div ref={bottomRef} className={shouldReserveTranscriptBottomSpace ? "h-48" : "h-0"} />
        </div>
      </ScrollArea>
      {isHistorySwitching ? <HistorySwitchLoadingOverlay /> : null}
    </div>
  );
});
