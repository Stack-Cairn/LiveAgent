import { Tooltip } from "@base-ui/react";
import {
  type MutableRefObject,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ComposerAttachmentCard } from "../../../components/chat/ComposerAttachmentCard";
import { getUploadedFileTypeIcon } from "../../../components/chat/fileTypeIcons";
import {
  MentionComposer,
  type MentionComposerHandle,
  type MentionComposerSkill,
} from "../../../components/chat/MentionComposer";
import { GitBranchSelector } from "../../../components/git/GitBranchSelector";
import {
  ChevronDown,
  ChevronUp,
  Clock3,
  Globe,
  GlobeOff,
  Lightbulb,
  LightbulbOff,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Play,
  Send,
  Sparkle,
  Square,
  SquarePen,
  Trash2,
} from "../../../components/icons";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { useLocale } from "../../../i18n";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type { GitClient } from "../../../lib/git/types";
import {
  type ChatRuntimeControls,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  type ReasoningLevel,
} from "../../../lib/settings";
import { cn } from "../../../lib/shared/utils";
import type { WorkspaceActivityClient } from "../../../lib/workspace-activity/types";
import { useUploadedImagePreview } from "../transcript/uploadedImagePreview";

const REASONING_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
  max: "settings.reasoning.max",
};

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && Object.hasOwn(REASONING_I18N_KEYS, value);
}

function RuntimeControlTooltip(props: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={0}
        closeOnClick
        render={<span className="inline-flex shrink-0">{props.children}</span>}
      />
      <Tooltip.Portal>
        <Tooltip.Positioner
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={8}
          className="z-[9999]"
        >
          <Tooltip.Popup className="max-w-64 rounded-xl border border-border/60 bg-popover px-3 py-2 text-xs font-medium leading-4 text-popover-foreground shadow-lg outline-hidden data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95">
            {props.label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

let pendingComposerImagePreviewSequence = 0;
const pendingComposerImagePreviewKeys = new WeakMap<PendingUploadedFile, string>();

function getPendingComposerImagePreviewKey(file: PendingUploadedFile) {
  const cached = pendingComposerImagePreviewKeys.get(file);
  if (cached) return cached;
  pendingComposerImagePreviewSequence += 1;
  const next = String(pendingComposerImagePreviewSequence);
  pendingComposerImagePreviewKeys.set(file, next);
  return next;
}

function PendingComposerAttachment(props: {
  file: PendingUploadedFile;
  workdir: string;
  disabled: boolean;
  removeLabel: string;
  onRemove: (relativePath: string) => void;
}) {
  const { file, workdir, disabled, removeLabel, onRemove } = props;
  const shouldPreviewImage =
    file.kind === "image" && typeof file.absolutePath === "string" && file.absolutePath.trim();
  const { imageSrc, isLoading } = useUploadedImagePreview(
    shouldPreviewImage ? file.absolutePath : undefined,
    shouldPreviewImage ? workdir : undefined,
    shouldPreviewImage ? getPendingComposerImagePreviewKey(file) : undefined,
  );
  const TypeIcon = getUploadedFileTypeIcon(file);

  return (
    <ComposerAttachmentCard
      fileName={file.fileName}
      pathTitle={file.relativePath}
      imageSrc={imageSrc}
      isImageLoading={isLoading}
      fallbackIcon={<TypeIcon className="h-4 w-4" />}
      disabled={disabled}
      removeLabel={removeLabel}
      onRemove={() => onRemove(file.relativePath)}
    />
  );
}

export type ChatQueueTurnPreview = {
  id: string;
  previewText: string;
  fileCount: number;
};

type QueueScrollbarState = {
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
};

const QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT = 24;
const DEFAULT_QUEUE_SCROLLBAR_STATE: QueueScrollbarState = {
  visible: false,
  thumbHeight: QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT,
  thumbTop: 0,
};

const COMPOSER_EXPAND_ANIMATION_MS = 280;
const COMPOSER_EXPAND_EASING = "cubic-bezier(0.32, 0.72, 0.22, 1)";

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export const ChatComposerBar = memo(function ChatComposerBar(props: {
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  inputPlaceholder: string;
  workdir: string;
  enabledSkills: MentionComposerSkill[];
  isAgentMode: boolean;
  chatRuntimeControls: ChatRuntimeControls;
  reasoningOptions: ReasoningLevel[];
  thinkingAlwaysOn: boolean;
  gitClient?: GitClient | null;
  gitWriteEnabled?: boolean;
  gitDisabledMessage?: string;
  workspaceActivityClient?: WorkspaceActivityClient | null;
  onSend: () => void;
  onStop: () => void;
  onComposerBusyChange: (isBusy: boolean) => void;
  onChatRuntimeControlsChange: (patch: Partial<ChatRuntimeControls>) => void;
  onPickReadableFiles: () => void;
  onPasteFiles: (files: File[]) => void;
  /** Prompts previously sent in this conversation for ↑/↓ recall. */
  loadHistoryPrompts?: () => readonly string[];
  pendingUploadedFiles: PendingUploadedFile[];
  onRemovePendingUpload: (relativePath: string) => void;
  queuedTurns: ChatQueueTurnPreview[];
  onRunQueuedTurnNow: (id: string) => void;
  onMoveQueuedTurnUp: (id: string) => void;
  onEditQueuedTurn: (id: string) => void;
  onRemoveQueuedTurn: (id: string) => void;
  onHeightChange?: (height: number) => void;
}) {
  const {
    composerRef,
    isSending,
    isUploadingFiles,
    isInputDisabled,
    inputPlaceholder,
    workdir,
    enabledSkills,
    isAgentMode,
    chatRuntimeControls,
    reasoningOptions,
    thinkingAlwaysOn,
    gitClient,
    gitWriteEnabled = true,
    gitDisabledMessage,
    workspaceActivityClient,
    onSend,
    onStop,
    onComposerBusyChange,
    onChatRuntimeControlsChange,
    onPickReadableFiles,
    onPasteFiles,
    loadHistoryPrompts,
    pendingUploadedFiles,
    onRemovePendingUpload,
    queuedTurns,
    onRunQueuedTurnNow,
    onMoveQueuedTurnUp,
    onEditQueuedTurn,
    onRemoveQueuedTurn,
    onHeightChange,
  } = props;
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const queuePanelRef = useRef<HTMLDivElement | null>(null);
  const queueListRef = useRef<HTMLUListElement | null>(null);
  const queueScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const queueScrollbarDragRef = useRef<{
    pointerId: number;
    startScrollTop: number;
    startY: number;
  } | null>(null);
  const queueHadTurnsRef = useRef(false);
  const [composerIsEmpty, setComposerIsEmpty] = useState(true);
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const isComposerExpandedRef = useRef(false);
  const glassCardRef = useRef<HTMLDivElement | null>(null);
  /** 切换瞬间记录的卡片旧高度，供 FLIP 动画用；消费后立即置空。 */
  const expandFromHeightRef = useRef<number | null>(null);
  const expandAnimationRef = useRef<Animation | null>(null);
  const scheduleHeightMeasureRef = useRef<(() => void) | null>(null);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [queueScrollbar, setQueueScrollbar] = useState<QueueScrollbarState>(
    DEFAULT_QUEUE_SCROLLBAR_STATE,
  );
  const uploadDisabled = isInputDisabled || isUploadingFiles || !isAgentMode || !workdir;
  const controlsDisabled = isInputDisabled;
  const hasSendableDraft = !composerIsEmpty || pendingUploadedFiles.length > 0;
  const thinkingSupported = reasoningOptions.length > 0;
  const sendDisabled = isInputDisabled || isUploadingFiles || !hasSendableDraft;
  const canQueueDraftWhileSending = isSending && !sendDisabled;
  const primaryActionTitle = canQueueDraftWhileSending
    ? t("chat.queue.addToQueue")
    : isSending
      ? t("chat.stopGeneration")
      : t("chat.sendMessage");
  const selectedReasoning = reasoningOptions.includes(chatRuntimeControls.reasoning)
    ? chatRuntimeControls.reasoning
    : DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
  const uploadTooltip = isUploadingFiles
    ? t("chat.upload.uploading")
    : !isAgentMode
      ? t("chat.upload.onlyInTools")
      : !workdir
        ? t("chat.upload.requireWorkdir")
        : t("chat.upload.button");
  const thinkingTooltip = !thinkingSupported
    ? t("chat.runtime.thinkingUnavailable")
    : t("chat.runtime.thinkingTooltip");
  const webSearchTooltip = t("chat.runtime.webSearchTooltip");
  const toggleQueueTooltip = queueCollapsed ? t("chat.queue.expand") : t("chat.queue.collapse");
  const toggleComposerExpandTooltip = isComposerExpanded
    ? t("chat.composer.collapse")
    : t("chat.composer.expand");

  const toggleQueueCollapsed = useCallback(() => {
    setQueueCollapsed((current) => !current);
  }, []);

  // ref 与 state 同步更新：高度上报的 RO/rAF 回调可能先于 effect 执行，
  // 必须在布局变化前就能读到最新展开态。切换前记录卡片当前高度，
  // 布局翻转后由 FLIP effect 从旧高度平滑过渡到新高度。
  const setComposerExpanded = useCallback((next: boolean) => {
    if (next === isComposerExpandedRef.current) return;
    expandFromHeightRef.current = glassCardRef.current?.getBoundingClientRect().height ?? null;
    isComposerExpandedRef.current = next;
    setIsComposerExpanded(next);
  }, []);

  // FLIP：布局已按目标态落定，把卡片高度用 min/max 双钳制钉在动画值上，
  // 从旧高度平滑过渡到新高度。不能直接动 height——展开态卡片是 flex-1
  // (basis 0)，height 会被 flex 忽略；min/max 约束则两种布局都尊重。
  // biome-ignore lint/correctness/useExhaustiveDependencies(isComposerExpanded): 函数体不读它，但它正是"布局已翻转"的触发信号。
  useLayoutEffect(() => {
    const card = glassCardRef.current;
    const fromHeight = expandFromHeightRef.current;
    expandFromHeightRef.current = null;
    if (!card || fromHeight === null || typeof card.animate !== "function") return;
    if (prefersReducedMotion()) return;

    expandAnimationRef.current?.cancel();
    const toHeight = card.getBoundingClientRect().height;
    if (Math.abs(toHeight - fromHeight) < 1) return;

    const animation = card.animate(
      [
        { minHeight: `${fromHeight}px`, maxHeight: `${fromHeight}px` },
        { minHeight: `${toHeight}px`, maxHeight: `${toHeight}px` },
      ],
      { duration: COMPOSER_EXPAND_ANIMATION_MS, easing: COMPOSER_EXPAND_EASING },
    );
    expandAnimationRef.current = animation;
    const clear = () => {
      if (expandAnimationRef.current === animation) {
        expandAnimationRef.current = null;
      }
      // 还原方向的高度上报在动画期间被冻结，落定后补测一次。
      scheduleHeightMeasureRef.current?.();
    };
    animation.onfinish = clear;
    animation.oncancel = clear;
  }, [isComposerExpanded]);

  useEffect(() => () => expandAnimationRef.current?.cancel(), []);

  const toggleComposerExpanded = useCallback(() => {
    setComposerExpanded(!isComposerExpandedRef.current);
    composerRef.current?.focus();
  }, [composerRef, setComposerExpanded]);

  /** 发送（含排队）后退出全高编辑态，让路给回复内容。 */
  const handleComposerSend = useCallback(() => {
    setComposerExpanded(false);
    onSend();
  }, [onSend, setComposerExpanded]);

  const shouldShowQueueScrollbar = !queueCollapsed && queuedTurns.length > 2;

  const updateQueueScrollbar = useCallback(() => {
    const list = queueListRef.current;
    if (!list || !shouldShowQueueScrollbar) {
      setQueueScrollbar((current) => (current.visible ? DEFAULT_QUEUE_SCROLLBAR_STATE : current));
      return;
    }

    const { clientHeight, scrollHeight, scrollTop } = list;
    const trackHeight = Math.max(clientHeight, QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT);
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const thumbHeight =
      maxScrollTop <= 1
        ? trackHeight
        : Math.min(
            trackHeight,
            Math.max(
              QUEUE_SCROLLBAR_MIN_THUMB_HEIGHT,
              Math.round((clientHeight / scrollHeight) * trackHeight),
            ),
          );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxScrollTop <= 1 ? 0 : Math.round((scrollTop / maxScrollTop) * maxThumbTop);

    setQueueScrollbar((current) => {
      if (current.visible && current.thumbHeight === thumbHeight && current.thumbTop === thumbTop) {
        return current;
      }
      return { visible: true, thumbHeight, thumbTop };
    });
  }, [shouldShowQueueScrollbar]);

  const scrollQueueToThumbPosition = useCallback(
    (clientY: number) => {
      const list = queueListRef.current;
      const track = queueScrollbarTrackRef.current;
      if (!list || !track || !shouldShowQueueScrollbar) return;

      const rect = track.getBoundingClientRect();
      const maxThumbTop = Math.max(1, rect.height - queueScrollbar.thumbHeight);
      const nextThumbTop = Math.min(
        Math.max(clientY - rect.top - queueScrollbar.thumbHeight / 2, 0),
        maxThumbTop,
      );
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = (nextThumbTop / maxThumbTop) * maxScrollTop;
      updateQueueScrollbar();
    },
    [queueScrollbar.thumbHeight, shouldShowQueueScrollbar, updateQueueScrollbar],
  );

  const handleQueueScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!shouldShowQueueScrollbar || event.button !== 0) return;
      const list = queueListRef.current;
      const track = queueScrollbarTrackRef.current;
      if (!list || !track) return;

      event.preventDefault();
      const target = event.target as HTMLElement;
      if (!target.closest(".chat-queue-scrollbar-thumb")) {
        scrollQueueToThumbPosition(event.clientY);
      }

      queueScrollbarDragRef.current = {
        pointerId: event.pointerId,
        startScrollTop: list.scrollTop,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [shouldShowQueueScrollbar, scrollQueueToThumbPosition],
  );

  const handleQueueScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = queueScrollbarDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const list = queueListRef.current;
      const track = queueScrollbarTrackRef.current;
      if (!list || !track) return;

      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      const maxThumbTop = Math.max(1, track.clientHeight - queueScrollbar.thumbHeight);
      list.scrollTop =
        drag.startScrollTop + ((event.clientY - drag.startY) / maxThumbTop) * maxScrollTop;
      updateQueueScrollbar();
    },
    [queueScrollbar.thumbHeight, updateQueueScrollbar],
  );

  const handleQueueScrollbarPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = queueScrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    queueScrollbarDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  useEffect(() => {
    const hasQueuedTurns = queuedTurns.length > 0;
    if (hasQueuedTurns && !queueHadTurnsRef.current) {
      setQueueCollapsed(false);
    }
    queueHadTurnsRef.current = hasQueuedTurns;
  }, [queuedTurns.length]);

  useEffect(() => {
    const list = queueListRef.current;
    if (!list) {
      updateQueueScrollbar();
      return;
    }

    updateQueueScrollbar();
    list.addEventListener("scroll", updateQueueScrollbar, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateQueueScrollbar);
    resizeObserver?.observe(list);
    window.addEventListener("resize", updateQueueScrollbar);

    return () => {
      list.removeEventListener("scroll", updateQueueScrollbar);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateQueueScrollbar);
    };
  }, [updateQueueScrollbar]);

  useEffect(() => {
    const reasoningNeedsReset =
      !(reasoningOptions.length > 0 && reasoningOptions.includes(chatRuntimeControls.reasoning)) &&
      !(
        reasoningOptions.length === 0 &&
        chatRuntimeControls.reasoning === DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
      );
    const thinkingNeedsEnable = thinkingAlwaysOn && !chatRuntimeControls.thinkingEnabled;
    if (!reasoningNeedsReset && !thinkingNeedsEnable) {
      return;
    }
    onChatRuntimeControlsChange({
      ...(reasoningNeedsReset ? { reasoning: DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning } : {}),
      ...(thinkingNeedsEnable ? { thinkingEnabled: true } : {}),
    });
  }, [
    chatRuntimeControls.reasoning,
    chatRuntimeControls.thinkingEnabled,
    onChatRuntimeControlsChange,
    reasoningOptions,
    thinkingAlwaysOn,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onHeightChange) return;

    let animationFrame: number | null = null;
    const measure = () => {
      animationFrame = null;
      // 展开态占满聊天区，保留最近一次常规高度，避免底部预留跟着跳动；
      // 展开/还原动画期间高度是中间值，同样不上报，动画结束后补测。
      if (isComposerExpandedRef.current || expandAnimationRef.current) return;
      const rootHeight = root.getBoundingClientRect().height;
      const queueHeight = queuePanelRef.current?.getBoundingClientRect().height ?? 0;
      onHeightChange(Math.ceil(Math.max(0, rootHeight - queueHeight)));
    };
    const scheduleMeasure = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(measure);
    };
    scheduleHeightMeasureRef.current = scheduleMeasure;

    scheduleMeasure();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(root);
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (scheduleHeightMeasureRef.current === scheduleMeasure) {
        scheduleHeightMeasureRef.current = null;
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      onHeightChange(0);
    };
  }, [onHeightChange]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4",
        // 展开态从头部下沿一路铺到底部，把整个聊天区让给输入框。
        isComposerExpanded && "top-14",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto relative w-full max-w-[768px]",
          // justify-end：展开动画途中卡片被钳在中间高度时保持贴底，向上生长。
          isComposerExpanded && "flex min-h-0 flex-col justify-end",
        )}
      >
        {queuedTurns.length > 0 ? (
          <div
            ref={queuePanelRef}
            className="relative z-30 mx-auto mb-[-1px] w-[calc(100%-1.5rem)] max-w-[720px]"
          >
            <div
              aria-hidden={queueCollapsed}
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                queueCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="rounded-t-lg border border-b-0 border-black/[0.055] bg-white/70 px-1 pb-1 pt-2 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.24),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl backdrop-saturate-[165%] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_8px_24px_-18px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.08)]">
                  <div className="relative min-h-0">
                    <ul
                      ref={queueListRef}
                      data-scrollable={queuedTurns.length > 2 ? "true" : "false"}
                      className={cn(
                        "chat-queue-scroll flex min-w-0 flex-col gap-1 overflow-x-hidden",
                        queuedTurns.length > 2
                          ? "h-[76px] overflow-y-scroll pr-3"
                          : "max-h-[76px] overflow-y-hidden pr-1",
                      )}
                    >
                      {queuedTurns.map((item, index) => {
                        return (
                          <li
                            key={item.id}
                            className="relative grid h-9 min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-black/[0.035] bg-white/42 px-2 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.56)] backdrop-blur-xl backdrop-saturate-[150%] transition-[border-color,background-color] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                          >
                            <div className="flex shrink-0 items-center gap-0.5">
                              {index > 0 ? (
                                <button
                                  type="button"
                                  disabled={queueCollapsed}
                                  onClick={() => onMoveQueuedTurnUp(item.id)}
                                  aria-label={t("chat.queue.moveUp")}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                                >
                                  <ChevronUp className="h-3 w-3" />
                                </button>
                              ) : (
                                <span aria-hidden className="h-6 w-6" />
                              )}
                              <Clock3 className="h-3 w-3 shrink-0 text-muted-foreground/65" />
                            </div>
                            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                              <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-foreground/88">
                                {item.previewText || t("chat.queue.emptyMessage")}
                              </span>
                              {item.fileCount > 0 ? (
                                <span className="max-w-[4.5rem] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(9px*var(--zone-font-scale,1))] leading-4 text-muted-foreground">
                                  {t("chat.queue.fileCount").replace(
                                    "{count}",
                                    String(item.fileCount),
                                  )}
                                </span>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <RuntimeControlTooltip label={t("chat.queue.edit")}>
                                <button
                                  type="button"
                                  disabled={queueCollapsed}
                                  onClick={() => onEditQueuedTurn(item.id)}
                                  aria-label={t("chat.queue.edit")}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                >
                                  <SquarePen className="h-3 w-3" />
                                </button>
                              </RuntimeControlTooltip>
                              <RuntimeControlTooltip label={t("chat.queue.runNow")}>
                                <button
                                  type="button"
                                  disabled={queueCollapsed}
                                  onClick={() => onRunQueuedTurnNow(item.id)}
                                  aria-label={t("chat.queue.runNow")}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                >
                                  <Play className="h-3 w-3" />
                                </button>
                              </RuntimeControlTooltip>
                              <RuntimeControlTooltip label={t("chat.queue.delete")}>
                                <button
                                  type="button"
                                  disabled={queueCollapsed}
                                  onClick={() => onRemoveQueuedTurn(item.id)}
                                  aria-label={t("chat.queue.delete")}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </RuntimeControlTooltip>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {shouldShowQueueScrollbar ? (
                      <div
                        ref={queueScrollbarTrackRef}
                        aria-hidden
                        className="chat-queue-scrollbar"
                        onPointerCancel={handleQueueScrollbarPointerUp}
                        onPointerDown={handleQueueScrollbarPointerDown}
                        onPointerMove={handleQueueScrollbarPointerMove}
                        onPointerUp={handleQueueScrollbarPointerUp}
                      >
                        <div
                          className="chat-queue-scrollbar-thumb"
                          style={{
                            height: `${queueScrollbar.thumbHeight}px`,
                            transform: `translateY(${queueScrollbar.thumbTop}px)`,
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleQueueCollapsed}
              title={toggleQueueTooltip}
              aria-label={toggleQueueTooltip}
              aria-expanded={!queueCollapsed}
              className="absolute left-1/2 top-0 z-40 inline-flex h-[18px] -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-black/[0.07] bg-white/90 pl-1.5 pr-2 text-muted-foreground shadow-[0_2px_10px_-4px_rgba(15,23,42,0.45),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-xl backdrop-saturate-150 transition-[background-color,color,scale] hover:bg-white hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:border-white/[0.12] dark:bg-zinc-900/90 dark:shadow-[0_2px_10px_-4px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.10)] dark:hover:bg-zinc-900"
            >
              {queueCollapsed ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronUp className="h-3 w-3" />
              )}
              <span className="text-[calc(10px*var(--zone-font-scale,1))] font-medium leading-none tabular-nums">
                {queuedTurns.length}
              </span>
            </button>
          </div>
        ) : null}

        {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape 捕获仅在展开态生效，焦点始终在内部 textbox 上，包装层不参与 Tab 序。 */}
        <div
          ref={glassCardRef}
          onKeyDown={
            isComposerExpanded
              ? (event) => {
                  // mention 弹层消费 Escape 时会 preventDefault，此处让路。
                  if (event.key === "Escape" && !event.defaultPrevented) {
                    setComposerExpanded(false);
                  }
                }
              : undefined
          }
          className={cn(
            // 过渡只针对 focus-within 的配色/阴影；不能用 transition-all——
            // 展开态切换 flex-grow 时会被一并动画，导致卡片先跳顶再长满的闪动。
            // 常驻 flex-col：FLIP 动画把卡片钳在中间高度时，flex-1 的编辑器
            // 区吸收多余空间，工具栏才能始终贴住卡片底边。
            "composer-glass-card relative z-10 flex flex-col overflow-hidden rounded-[24px] border border-black/[0.055] bg-white/70 shadow-[0_12px_40px_-14px_rgba(15,23,42,0.22),0_2px_6px_-2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.74)] backdrop-blur-2xl backdrop-saturate-[165%] transition-[background-color,border-color,box-shadow] focus-within:border-black/[0.075] focus-within:bg-white/74 focus-within:shadow-[0_16px_46px_-14px_rgba(15,23,42,0.26),0_4px_12px_-4px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.78)] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_12px_40px_-14px_rgba(0,0,0,0.72),0_2px_6px_-2px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] dark:focus-within:border-white/[0.15] dark:focus-within:bg-white/[0.08]",
            isComposerExpanded && "min-h-0 flex-1",
          )}
        >
          {/* macOS material rim-light */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-5 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/85 to-transparent dark:via-white/15"
          />
          {/* subtle inner gloss gradient */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[24px] bg-gradient-to-b from-white/18 to-transparent opacity-70 dark:from-white/[0.04] dark:opacity-100"
          />

          {pendingUploadedFiles.length > 0 ? (
            <div className="upload-file-list relative z-10 flex shrink-0 gap-2 overflow-x-auto pb-1 pl-4 pr-12 pt-3.5">
              {pendingUploadedFiles.map((file) => (
                <PendingComposerAttachment
                  key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
                  file={file}
                  workdir={workdir}
                  disabled={isInputDisabled}
                  removeLabel={t("chat.upload.removeFile")}
                  onRemove={onRemovePendingUpload}
                />
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={toggleComposerExpanded}
            title={toggleComposerExpandTooltip}
            aria-label={toggleComposerExpandTooltip}
            aria-expanded={isComposerExpanded}
            className="absolute right-3 top-2 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground/70 outline-hidden transition-[background-color,color,scale] hover:bg-muted/60 hover:text-foreground active:scale-90 focus-visible:bg-muted/60"
          >
            {isComposerExpanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>

          {/* 常驻 flex-1：动画把卡片钳在中间高度时由本区吸收伸缩，工具栏才能
              全程贴住卡片底边。min-h-0 只在展开态加——折叠态靠自动最小高度
              (= 编辑器钳制高) 撑起卡片的固有高度，加了会塌缩。 */}
          <div
            className={cn(
              "relative flex flex-1 px-4",
              pendingUploadedFiles.length > 0 ? "pt-2" : "pt-3.5",
              isComposerExpanded && "min-h-0",
            )}
          >
            <MentionComposer
              ref={composerRef}
              onSend={handleComposerSend}
              onEmptyChange={setComposerIsEmpty}
              onBusyChange={onComposerBusyChange}
              onPasteFiles={onPasteFiles}
              loadHistoryPrompts={loadHistoryPrompts}
              placeholder={inputPlaceholder}
              disabled={isInputDisabled}
              workdir={workdir}
              enabledSkills={enabledSkills}
              className={cn("px-0 py-0 pr-8", isComposerExpanded && "h-full max-h-none")}
            />
          </div>

          <div className="relative flex items-center justify-between gap-2 px-3 pb-2 pt-1">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <RuntimeControlTooltip label={uploadTooltip}>
                <button
                  type="button"
                  disabled={uploadDisabled}
                  onClick={onPickReadableFiles}
                  aria-label={
                    isUploadingFiles
                      ? t("chat.upload.uploading")
                      : !isAgentMode
                        ? t("chat.upload.onlyInTools")
                        : !workdir
                          ? t("chat.upload.requireWorkdir")
                          : t("chat.upload.selectFiles")
                  }
                  className={cn(
                    "composer-toolbar-action relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                    "disabled:pointer-events-none disabled:opacity-40",
                    pendingUploadedFiles.length > 0
                      ? "text-sky-600 hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200"
                      : "text-muted-foreground hover:text-foreground dark:hover:text-white",
                  )}
                >
                  {isUploadingFiles ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Paperclip className="h-4 w-4" />
                  )}
                  {pendingUploadedFiles.length > 0 ? (
                    <span
                      aria-hidden
                      className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-sky-500 px-[3px] text-[calc(9px*var(--zone-font-scale,1))] font-semibold leading-none text-white shadow-[0_0_0_1.5px_rgba(255,255,255,0.95)] dark:bg-sky-400 dark:text-slate-900 dark:shadow-[0_0_0_1.5px_rgba(20,22,28,0.9)]"
                    >
                      {pendingUploadedFiles.length}
                    </span>
                  ) : null}
                </button>
              </RuntimeControlTooltip>

              <RuntimeControlTooltip label={webSearchTooltip}>
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() =>
                    onChatRuntimeControlsChange({
                      nativeWebSearchEnabled: !chatRuntimeControls.nativeWebSearchEnabled,
                    })
                  }
                  aria-label={
                    chatRuntimeControls.nativeWebSearchEnabled
                      ? t("chat.runtime.webSearchOn")
                      : t("chat.runtime.webSearchOff")
                  }
                  className={cn(
                    "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                    "disabled:pointer-events-none disabled:opacity-40",
                    chatRuntimeControls.nativeWebSearchEnabled
                      ? "text-emerald-600 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200"
                      : "text-muted-foreground hover:text-foreground dark:hover:text-white",
                  )}
                >
                  {chatRuntimeControls.nativeWebSearchEnabled ? (
                    <Globe className="h-4 w-4" />
                  ) : (
                    <GlobeOff className="h-4 w-4" />
                  )}
                </button>
              </RuntimeControlTooltip>

              <RuntimeControlTooltip label={thinkingTooltip}>
                <button
                  type="button"
                  disabled={controlsDisabled || !thinkingSupported || thinkingAlwaysOn}
                  onClick={() =>
                    onChatRuntimeControlsChange({
                      thinkingEnabled: !chatRuntimeControls.thinkingEnabled,
                    })
                  }
                  aria-label={
                    !thinkingSupported
                      ? t("chat.runtime.thinkingUnavailable")
                      : chatRuntimeControls.thinkingEnabled
                        ? t("chat.runtime.thinkingOn")
                        : t("chat.runtime.thinkingOff")
                  }
                  className={cn(
                    "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                    "disabled:pointer-events-none disabled:opacity-40",
                    chatRuntimeControls.thinkingEnabled && thinkingSupported
                      ? "text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                      : "text-muted-foreground hover:text-foreground dark:hover:text-white",
                  )}
                >
                  {chatRuntimeControls.thinkingEnabled && thinkingSupported ? (
                    <Lightbulb className="h-4 w-4" />
                  ) : (
                    <LightbulbOff className="h-4 w-4" />
                  )}
                </button>
              </RuntimeControlTooltip>

              {reasoningOptions.length > 0 ? (
                <div
                  aria-hidden={!chatRuntimeControls.thinkingEnabled}
                  className={cn(
                    "shrink-0 overflow-hidden transition-[max-width,margin-left,opacity] duration-200 ease-out",
                    chatRuntimeControls.thinkingEnabled
                      ? "ml-0 max-w-40 opacity-100"
                      : "pointer-events-none -ml-1 max-w-0 opacity-0",
                  )}
                >
                  <Select
                    value={selectedReasoning}
                    onValueChange={(value) =>
                      onChatRuntimeControlsChange({ reasoning: value as ReasoningLevel })
                    }
                    disabled={controlsDisabled || !chatRuntimeControls.thinkingEnabled}
                  >
                    <SelectTrigger
                      className="composer-reasoning-trigger group/reasoning h-8 w-auto shrink-0 gap-0.5 rounded-full border-0 bg-violet-50/55 pl-2 pr-1.5 text-xs font-medium text-foreground shadow-none outline-hidden transition-all duration-200 ease-out hover:bg-violet-50/80 disabled:opacity-45 dark:bg-violet-400/[0.07] dark:text-foreground dark:hover:bg-violet-400/[0.13] [&_svg:last-child]:h-3 [&_svg:last-child]:w-3 [&_svg:last-child]:opacity-50 [&_svg:last-child]:transition-transform [&_svg:last-child]:duration-200 [&[data-popup-open]_svg:last-child]:rotate-180"
                      aria-label={t("chat.runtime.reasoning")}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <Sparkle className="h-3.5 w-3.5 shrink-0 text-violet-500 transition-colors dark:text-violet-400" />
                        <SelectValue>
                          {(value) =>
                            t(
                              REASONING_I18N_KEYS[
                                isReasoningLevel(value) ? value : selectedReasoning
                              ],
                            )
                          }
                        </SelectValue>
                      </span>
                    </SelectTrigger>
                    <SelectContent className="sidebar-context-menu min-w-40 rounded-xl border-0">
                      {reasoningOptions.map((value) => (
                        <SelectItem
                          key={value}
                          value={value}
                          className={cn(
                            "mb-0.5 h-[30px] rounded-md py-0 text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 transition-none last:mb-0 data-[highlighted]:bg-foreground/[0.05] data-[highlighted]:text-foreground",
                            value === selectedReasoning &&
                              "bg-foreground/[0.07] data-[highlighted]:bg-foreground/[0.09]",
                          )}
                        >
                          {t(REASONING_I18N_KEYS[value])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <GitBranchSelector
                workdir={workdir}
                gitClient={gitClient}
                workspaceActivityClient={workspaceActivityClient}
                disabled={controlsDisabled}
                canWrite={gitWriteEnabled}
                disabledMessage={gitDisabledMessage}
              />
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                disabled={isSending ? false : sendDisabled}
                onClick={() => {
                  if (canQueueDraftWhileSending) {
                    handleComposerSend();
                    return;
                  }
                  if (isSending) {
                    onStop();
                    return;
                  }
                  if (sendDisabled) return;
                  handleComposerSend();
                }}
                size="sm"
                title={primaryActionTitle}
                aria-label={primaryActionTitle}
                style={
                  canQueueDraftWhileSending
                    ? {
                        backgroundColor: "hsl(160 84% 39%)",
                        backgroundImage: "none",
                        color: "white",
                      }
                    : isSending
                      ? {
                          backgroundColor: "hsl(var(--destructive))",
                          backgroundImage: "none",
                          color: "hsl(var(--destructive-foreground))",
                        }
                      : undefined
                }
                className={cn(
                  "h-8 w-8 shrink-0 rounded-full border-0 p-0 shadow-none transition-all",
                  canQueueDraftWhileSending
                    ? "hover:brightness-105 active:scale-95"
                    : isSending
                      ? "hover:opacity-90 active:scale-95"
                      : "disabled:opacity-100 [&:not(:disabled)]:bg-foreground [&:not(:disabled)]:text-background [&:not(:disabled)]:hover:bg-foreground/85 [&:not(:disabled)]:active:scale-95 disabled:bg-muted/60 disabled:text-muted-foreground",
                )}
              >
                {canQueueDraftWhileSending ? (
                  <Send className="h-4 w-4" />
                ) : isSending ? (
                  <Square className="h-3 w-3 fill-current" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
