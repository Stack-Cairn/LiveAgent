import {
  type ChatRuntimeControls,
  type ExecutionMode,
  isAgentExecutionMode,
  type ProviderId,
  type ReasoningLevel,
  type SelectedModel,
  type SttProviderId,
} from "@liveagent/app/lib/settings";
import { ComposerAttachmentCard } from "@liveagent/ui/components/chat/ComposerAttachmentCard";
import { ComposerModelControls } from "@liveagent/ui/components/chat/ComposerModelControls";
import { ContextUsageRing } from "@liveagent/ui/components/chat/ContextUsageRing";
import { getUploadedFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import {
  MentionComposer,
  type MentionComposerHandle,
  type MentionComposerSkill,
} from "@liveagent/ui/components/chat/MentionComposer";
import { GitBranchSelector } from "@liveagent/ui/components/git/GitBranchSelector";
import {
  ChevronDown,
  ChevronUp,
  Clock3,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  Paperclip,
  Play,
  Send,
  Square,
  SquarePen,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { LabelTooltip as RuntimeControlTooltip } from "@liveagent/ui/components/ui/label-tooltip";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { SttTransport } from "@liveagent/ui/lib/stt/types";
import type { WorkspaceActivityClient } from "@liveagent/ui/lib/workspace-activity/types";
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
  useSyncExternalStore,
} from "react";
import {
  getUploadedImagePreviewCacheKey,
  loadUploadedImagePreview,
  readUploadedImagePreviewCache,
  type UploadedImagePreviewLoader,
} from "../../lib/chat/uploadedImagePreview";
import type { PendingUploadedFile } from "../../lib/chat/uploadTypes";
import { useComposerStt } from "./useComposerStt";

function useComposerUploadedImagePreview(
  file: PendingUploadedFile,
  workdir: string,
  loader?: UploadedImagePreviewLoader,
) {
  const shouldPreviewImage =
    file.kind === "image" && typeof file.absolutePath === "string" && file.absolutePath.trim();
  const cacheKey = shouldPreviewImage ? getUploadedImagePreviewCacheKey(workdir, file) : "";
  const [imageSrc, setImageSrc] = useState<string | null | undefined>(() => {
    if (!cacheKey) return null;
    return readUploadedImagePreviewCache(workdir, file);
  });

  useEffect(() => {
    if (!cacheKey) {
      setImageSrc(null);
      return;
    }

    const cached = readUploadedImagePreviewCache(workdir, file);
    if (cached !== undefined) {
      setImageSrc(cached);
      return;
    }
    if (!loader) {
      setImageSrc(null);
      return;
    }

    let cancelled = false;
    setImageSrc(undefined);
    void loadUploadedImagePreview({ workspaceRoot: workdir, file, loader }).then((value) => {
      if (!cancelled) setImageSrc(value);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, file, loader, workdir]);

  return {
    imageSrc: imageSrc ?? null,
    isLoading: Boolean(cacheKey && loader) && imageSrc === undefined,
  };
}

function PendingComposerAttachment(props: {
  file: PendingUploadedFile;
  workdir: string;
  disabled: boolean;
  removeLabel: string;
  previewLabel: string;
  closePreviewLabel: string;
  imagePreviewLoader?: UploadedImagePreviewLoader;
  onRemove: (relativePath: string) => void;
}) {
  const {
    file,
    workdir,
    disabled,
    removeLabel,
    previewLabel,
    closePreviewLabel,
    imagePreviewLoader,
    onRemove,
  } = props;
  const { imageSrc, isLoading } = useComposerUploadedImagePreview(
    file,
    workdir,
    imagePreviewLoader,
  );
  const TypeIcon = getUploadedFileTypeIcon(file);

  return (
    <ComposerAttachmentCard
      file={file}
      workspaceRoot={workdir}
      fileName={file.fileName}
      pathTitle={file.relativePath}
      imageSrc={imageSrc}
      isImageLoading={isLoading}
      fallbackIcon={<TypeIcon className="h-4 w-4" />}
      disabled={disabled}
      removeLabel={removeLabel}
      previewLabel={previewLabel}
      closePreviewLabel={closePreviewLabel}
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

/** 用量环实时读数订阅源（getContextUsageTokens 必须对同一底层状态返回稳定值）。 */
export type ContextUsageTokensSource = {
  subscribe: (listener: () => void) => () => void;
  getContextUsageTokens: () => number | undefined;
};

const noopSubscribe = () => () => {};

// 环的实时读数在独立小组件里订阅：流式期间每帧的读数变化只重渲染这枚
// SVG 环，不触发 ChatComposerBar/整页回流。
function ComposerContextUsageRing(props: {
  source?: ContextUsageTokensSource;
  totalTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  onConfirm?: (() => void) | (() => Promise<unknown>);
}) {
  const { source, totalTokens, contextWindow, disabled, onConfirm } = props;
  const readStatic = useCallback(() => totalTokens, [totalTokens]);
  const liveTokens = useSyncExternalStore(
    source?.subscribe ?? noopSubscribe,
    source?.getContextUsageTokens ?? readStatic,
    source?.getContextUsageTokens ?? readStatic,
  );
  return (
    <ContextUsageRing
      totalTokens={source ? liveTokens : totalTokens}
      contextWindow={contextWindow}
      disabled={disabled}
      onConfirm={onConfirm}
    />
  );
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export type ChatComposerBarProps = {
  surface: "desktop" | "web";
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  sttProvider?: SttProviderId | null;
  sttProviderConfigured?: boolean;
  sttTransport?: SttTransport;
  /** STT 失败（麦克风不可用、连接超时等）上报给宿主以 toast 形式提示。 */
  onSttError?: (message: string) => void;
  /**
   * 只读视图（如轨迹页）挂起输入区：整体 display:none 但保持挂载，
   * 半打的草稿与队列状态在切回聊天页时原样恢复。
   */
  hidden?: boolean;
  inputPlaceholder: string;
  workdir: string;
  enabledSkills: MentionComposerSkill[];
  executionMode: ExecutionMode;
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: SharedModelOption<ProviderId>[];
  selectedValue?: string;
  chatRuntimeControls: ChatRuntimeControls;
  reasoningOptions: ReasoningLevel[];
  thinkingAlwaysOn: boolean;
  gitClient?: GitClient | null;
  gitWriteEnabled?: boolean;
  gitDisabledMessage?: string;
  /** 当前会话上下文占用 token；与 contextWindow 齐备时显示用量环。 */
  contextUsageTokens?: number;
  /**
   * 可选的用量环实时订阅源：流式期间读数每帧都在变，经此订阅只重渲染环
   * 本身而不回流整页（GUI 用；WebUI 传静态 contextUsageTokens 即可）。
   * 提供时优先于 contextUsageTokens。
   */
  contextUsageTokensSource?: ContextUsageTokensSource;
  contextWindow?: number;
  /** 用量环确认后触发手动压缩；缺省时环为纯展示。 */
  onManualCompactConfirm?: (() => void) | (() => Promise<unknown>);
  /** 压缩进行中/请求在途时禁点用量环。 */
  manualCompactBlocked?: boolean;
  workspaceActivityClient?: WorkspaceActivityClient | null;
  /** 创建 worktree 成功后，把后端返回的路径与仓库身份加入侧边栏。 */
  onOpenWorktree?: (worktree: { path: string; repositoryPath: string; branch: string }) => void;
  onWorktreeRemoved?: (worktree: { path: string; repositoryPath: string; branch: string }) => void;
  onSend: () => void;
  onStop: () => void;
  onPrepareChatRuntime?: () => void;
  onComposerBusyChange: (isBusy: boolean) => void;
  onSelectModel: (selection: SelectedModel) => void;
  onSelectExecutionMode: (mode: "text" | "tools") => void;
  onOpenSettings: (section?: "providers", providerId?: string) => void;
  onChatRuntimeControlsChange: (patch: Partial<ChatRuntimeControls>) => void;
  onPickReadableFiles: () => void;
  onPasteFiles: (files: File[]) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
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
  /** 当前会话任务进度（存在时渲染在审批栏和队列面板之上）。 */
  taskProgressBar?: ReactNode;
  /** 输入框上方的集中审批栏(待审批时由上层注入,渲染在队列面板之上)。 */
  approvalBar?: ReactNode;
  /** 文件拖入命中输入框时显示的局部反馈层。 */
  fileDropOverlay?: ReactNode;
};

export const ChatComposerBar = memo(function ChatComposerBar(props: ChatComposerBarProps) {
  const {
    surface,
    composerRef,
    isSending,
    isUploadingFiles,
    isInputDisabled,
    sttProvider = null,
    sttProviderConfigured,
    sttTransport,
    onSttError,
    hidden = false,
    inputPlaceholder,
    workdir,
    enabledSkills,
    executionMode,
    hasModels,
    currentModelLabel,
    modelOptions,
    selectedValue,
    chatRuntimeControls,
    reasoningOptions,
    thinkingAlwaysOn,
    gitClient,
    gitWriteEnabled = true,
    gitDisabledMessage,
    contextUsageTokens,
    contextUsageTokensSource,
    contextWindow,
    onManualCompactConfirm,
    manualCompactBlocked,
    workspaceActivityClient,
    onOpenWorktree,
    onWorktreeRemoved,
    onSend,
    onStop,
    onPrepareChatRuntime,
    onComposerBusyChange,
    onSelectModel,
    onSelectExecutionMode,
    onOpenSettings,
    onChatRuntimeControlsChange,
    onPickReadableFiles,
    onPasteFiles,
    onLoadUploadedImagePreview,
    loadHistoryPrompts,
    pendingUploadedFiles,
    onRemovePendingUpload,
    queuedTurns,
    onRunQueuedTurnNow,
    onMoveQueuedTurnUp,
    onEditQueuedTurn,
    onRemoveQueuedTurn,
    onHeightChange,
    taskProgressBar,
    approvalBar,
    fileDropOverlay,
  } = props;
  const { t } = useLocale();
  const [composerIsEmpty, setComposerIsEmpty] = useState(true);
  const stt = useComposerStt({
    composerRef,
    provider: sttProvider,
    providerConfigured: sttProviderConfigured,
    transport: sttTransport,
    disabled: isInputDisabled,
    onError: onSttError,
  });
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const isComposerExpandedRef = useRef(false);
  const glassCardRef = useRef<HTMLDivElement | null>(null);
  const attachmentListRef = useRef<HTMLDivElement | null>(null);
  const previousPendingUploadCountRef = useRef(0);
  /** 切换瞬间记录的卡片旧高度，供 FLIP 动画用；消费后立即置空。 */
  const expandFromHeightRef = useRef<number | null>(null);
  const expandAnimationRef = useRef<Animation | null>(null);
  const scheduleHeightMeasureRef = useRef<(() => void) | null>(null);
  const composerLayerRef = useRef<HTMLDivElement | null>(null);
  const queuePanelRef = useRef<HTMLDivElement | null>(null);
  const queueListRef = useRef<HTMLUListElement | null>(null);
  const queueScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const queueScrollbarDragRef = useRef<{
    pointerId: number;
    startScrollTop: number;
    startY: number;
  } | null>(null);
  const queueHadTurnsRef = useRef(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [queueScrollbar, setQueueScrollbar] = useState<QueueScrollbarState>(
    DEFAULT_QUEUE_SCROLLBAR_STATE,
  );
  const isAgentMode = isAgentExecutionMode(executionMode);
  const uploadDisabled =
    isInputDisabled || stt.active || isUploadingFiles || !isAgentMode || !workdir;
  const controlsDisabled = isInputDisabled || stt.active;
  const hasSendableDraft = !composerIsEmpty || pendingUploadedFiles.length > 0;
  const sendDisabled = isInputDisabled || stt.active || isUploadingFiles || !hasSendableDraft;
  const canQueueDraftWhileSending = isSending && !sendDisabled;
  const primaryActionTitle = canQueueDraftWhileSending
    ? t("chat.queue.addToQueue")
    : isSending
      ? t("chat.stopGeneration")
      : t("chat.sendMessage");
  const uploadTooltip = isUploadingFiles
    ? t("chat.upload.uploading")
    : !isAgentMode
      ? t("chat.upload.onlyInTools")
      : !workdir
        ? t("chat.upload.requireWorkdir")
        : t("chat.upload.button");
  const toggleQueueTooltip = queueCollapsed ? t("chat.queue.expand") : t("chat.queue.collapse");
  const toggleComposerExpandTooltip = isComposerExpanded
    ? t("chat.composer.collapse")
    : t("chat.composer.expand");

  const toggleQueueCollapsed = useCallback(() => {
    setQueueCollapsed((current) => !current);
  }, []);

  useLayoutEffect(() => {
    const previousCount = previousPendingUploadCountRef.current;
    previousPendingUploadCountRef.current = pendingUploadedFiles.length;
    if (pendingUploadedFiles.length <= previousCount) return;

    const attachmentList = attachmentListRef.current;
    if (attachmentList) attachmentList.scrollLeft = attachmentList.scrollWidth;
  }, [pendingUploadedFiles.length]);

  // ref 与 state 同步更新：高度上报的 RO 回调可能先于 effect 执行，
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
    const composerLayer = composerLayerRef.current;
    if (!composerLayer) return;

    if (surface === "desktop") {
      if (!onHeightChange) return;

      let animationFrame: number | null = null;
      const measure = () => {
        animationFrame = null;
        if (isComposerExpandedRef.current || expandAnimationRef.current) return;
        const composerLayerHeight = composerLayer.getBoundingClientRect().height;
        const queueHeight = queuePanelRef.current?.getBoundingClientRect().height ?? 0;
        onHeightChange(Math.ceil(Math.max(0, composerLayerHeight - queueHeight)));
      };
      const scheduleMeasure = () => {
        if (animationFrame !== null) return;
        animationFrame = window.requestAnimationFrame(measure);
      };
      scheduleHeightMeasureRef.current = scheduleMeasure;
      scheduleMeasure();

      const resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
      resizeObserver?.observe(composerLayer);
      window.addEventListener("resize", scheduleMeasure);

      return () => {
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        if (scheduleHeightMeasureRef.current === scheduleMeasure) {
          scheduleHeightMeasureRef.current = null;
        }
        resizeObserver?.disconnect();
        window.removeEventListener("resize", scheduleMeasure);
        onHeightChange(0);
      };
    }

    const chatFrame = composerLayer.closest(".gateway-chat-frame");
    if (!(chatFrame instanceof HTMLElement)) return;

    const updateComposerOverlayHeight = () => {
      // 展开态占满聊天区，保留最近一次常规高度，避免底部预留跟着跳动；
      // 展开/还原动画期间高度是中间值，同样不上报，动画结束后补测。
      if (isComposerExpandedRef.current || expandAnimationRef.current) return;
      const composerLayerHeight = composerLayer.getBoundingClientRect().height;
      const queueHeight = queuePanelRef.current?.getBoundingClientRect().height ?? 0;
      chatFrame.style.setProperty(
        "--gateway-chat-composer-overlay-height",
        `${Math.ceil(Math.max(0, composerLayerHeight - queueHeight))}px`,
      );
    };
    scheduleHeightMeasureRef.current = updateComposerOverlayHeight;

    updateComposerOverlayHeight();

    if (typeof ResizeObserver === "undefined") {
      return () => {
        scheduleHeightMeasureRef.current = null;
        chatFrame.style.removeProperty("--gateway-chat-composer-overlay-height");
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateComposerOverlayHeight();
    });
    resizeObserver.observe(composerLayer);

    return () => {
      scheduleHeightMeasureRef.current = null;
      resizeObserver.disconnect();
      chatFrame.style.removeProperty("--gateway-chat-composer-overlay-height");
    };
  }, [onHeightChange, surface]);

  return (
    <div
      ref={composerLayerRef}
      className={cn(
        surface === "desktop"
          ? "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4"
          : "gateway-composer-layer pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center",
        isComposerExpanded && (surface === "desktop" ? "top-14" : "top-0 pt-3"),
        hidden && "hidden",
      )}
    >
      {surface === "desktop" ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-background"
          style={{ height: "1rem" }}
        />
      ) : null}
      <div
        className={cn(
          surface === "desktop"
            ? "pointer-events-auto relative w-full max-w-[768px]"
            : "gateway-chat-column pointer-events-auto relative",
          // justify-end：展开动画途中卡片被钳在中间高度时保持贴底，向上生长。
          isComposerExpanded && "flex min-h-0 flex-col justify-end",
        )}
      >
        {taskProgressBar}
        {approvalBar}
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
                      {queuedTurns.map((item, index) => (
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
                      ))}
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
          data-file-upload-drop-zone=""
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
            "composer-glass-card relative flex flex-col overflow-hidden rounded-3xl border border-black/[0.055] bg-white/70 shadow-[0_12px_40px_-14px_rgba(15,23,42,0.22),0_2px_6px_-2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.74)] backdrop-blur-2xl backdrop-saturate-[165%] transition-[background-color,border-color,box-shadow] focus-within:border-black/[0.075] focus-within:bg-white/74 focus-within:shadow-[0_16px_46px_-14px_rgba(15,23,42,0.26),0_4px_12px_-4px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.78)] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_12px_40px_-14px_rgba(0,0,0,0.72),0_2px_6px_-2px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)] dark:focus-within:border-white/[0.15] dark:focus-within:bg-white/[0.08]",
            surface === "desktop" && "z-10",
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
            className="pointer-events-none absolute inset-0 rounded-3xl bg-gradient-to-b from-white/18 to-transparent opacity-70 dark:from-white/[0.04] dark:opacity-100"
          />

          {pendingUploadedFiles.length > 0 ? (
            <div
              ref={attachmentListRef}
              className="upload-file-list relative z-10 flex shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden pb-1 pl-4 pr-12 pt-2"
            >
              {pendingUploadedFiles.map((file) => (
                <PendingComposerAttachment
                  key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
                  file={file}
                  workdir={workdir}
                  disabled={controlsDisabled}
                  removeLabel={t("chat.upload.removeFile")}
                  previewLabel={t("chat.upload.previewImage")}
                  closePreviewLabel={t("chat.upload.closePreview")}
                  imagePreviewLoader={onLoadUploadedImagePreview}
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

          {/* 用量环位于卡片右侧控制列的垂直中心，保持在展开与发送按钮之间。 */}
          <div className="absolute right-3 top-1/2 z-20 -translate-y-1/2">
            <ComposerContextUsageRing
              source={contextUsageTokensSource}
              totalTokens={contextUsageTokens}
              contextWindow={contextWindow}
              disabled={controlsDisabled || isSending || manualCompactBlocked}
              onConfirm={onManualCompactConfirm}
            />
          </div>

          {/* 常驻 flex-1：动画把卡片钳在中间高度时由本区吸收伸缩，工具栏才能
              全程贴住卡片底边。min-h-0 只在展开态加——折叠态靠自动最小高度
              (= 编辑器钳制高) 撑起卡片的固有高度，加了会塌缩。

              pr-12 让出右侧控制列：展开/用量环/发送都是 right-3 + w-8，占据卡片
              右缘 44px 宽的竖直轨道。让位必须做在本容器上，**不能只给编辑器加
              pr-8**——padding 不改变滚动条位置（滚动条恒贴 border box 右缘），
              只挡文字不挡滚动条，溢出时那条 6px 轨会直接压在环与展开图标上。
              收窄编辑器 border box 才能把滚动条一并推到轨道左侧；48px = 44 轨道
              + 4px 间隙，文本可用宽度与原先 px-4 + 编辑器 pr-8 完全一致。 */}
          <div
            className={cn(
              "relative flex flex-1 pl-4 pr-12",
              pendingUploadedFiles.length > 0 ? "pt-1.5" : "pt-3.5",
              isComposerExpanded && "min-h-0",
            )}
            onFocusCapture={onPrepareChatRuntime}
          >
            <MentionComposer
              ref={composerRef}
              onSend={handleComposerSend}
              onEmptyChange={setComposerIsEmpty}
              onBusyChange={onComposerBusyChange}
              onPasteFiles={onPasteFiles}
              loadHistoryPrompts={loadHistoryPrompts}
              placeholder={inputPlaceholder}
              disabled={isInputDisabled || stt.active}
              workdir={workdir}
              enabledSkills={enabledSkills}
              className={cn(
                // 右让位由外层容器 pr-12 统一承担（见上），此处不再补 pr——
                // 编辑器自身的右内距只会把文字推开、留下滚动条压在控制列上。
                "px-0 py-0",
                isComposerExpanded &&
                  (surface === "desktop" ? "h-full max-h-none" : "h-full! max-h-none!"),
              )}
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

              {stt.available ? (
                <RuntimeControlTooltip label={stt.active ? "停止语音输入" : "开始语音输入"}>
                  <button
                    type="button"
                    disabled={isInputDisabled || stt.state === "stopping"}
                    onClick={stt.toggle}
                    aria-label={stt.active ? "停止语音输入" : "开始语音输入"}
                    aria-pressed={stt.active}
                    className={cn(
                      "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                      "disabled:pointer-events-none disabled:opacity-40",
                      stt.active
                        ? "bg-red-500/10 text-red-600"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {stt.state === "requesting-permission" ||
                    stt.state === "buffering" ||
                    stt.state === "stopping" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : stt.active ? (
                      <Square className="h-3.5 w-3.5 fill-current" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </button>
                </RuntimeControlTooltip>
              ) : null}

              <ComposerModelControls
                executionMode={executionMode}
                hasModels={hasModels}
                currentModelLabel={currentModelLabel}
                modelOptions={modelOptions}
                selectedValue={selectedValue}
                chatRuntimeControls={chatRuntimeControls}
                reasoningOptions={reasoningOptions}
                thinkingAlwaysOn={thinkingAlwaysOn}
                disabled={controlsDisabled}
                onSelectModel={onSelectModel}
                onSelectExecutionMode={onSelectExecutionMode}
                onOpenSettings={onOpenSettings}
                onChatRuntimeControlsChange={onChatRuntimeControlsChange}
              />

              <GitBranchSelector
                workdir={workdir}
                gitClient={gitClient}
                workspaceActivityClient={workspaceActivityClient}
                disabled={controlsDisabled}
                canWrite={gitWriteEnabled}
                disabledMessage={gitDisabledMessage}
                onOpenWorktree={onOpenWorktree}
                onWorktreeRemoved={onWorktreeRemoved}
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
          {fileDropOverlay}
        </div>
      </div>
    </div>
  );
});
