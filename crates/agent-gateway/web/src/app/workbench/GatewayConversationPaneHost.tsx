// 会话 Pane 的统一宿主——复刻桌面端 RestorableConversationPaneHost:
// 每个 Pane 始终挂同一组件,焦点切换只换 primary/background 绑定,不拆宿主。
// 发送/停止/排队/上传/审批按本 Pane 的 conversationId 路由;选模型、编辑队列
// 项、由正文重发等页面级操作在背景 Pane 上先走 focusGuard。Primary 把自己的
// 输入框挂到页面 composerRef,卸载时把未发送草稿写回缓存。

import {
  type ChangedFilesActions,
  ChangedFilesActionsProvider,
} from "@liveagent/ui/components/chat/ChangedFilesCard";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { ToolApprovalBar } from "@liveagent/ui/components/chat/ToolApprovalBar";
import { ChevronDown, Loader2 } from "@liveagent/ui/components/IconSet";
import { TrajectoryView } from "@liveagent/ui/components/trajectory/TrajectoryView";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import { deriveContextUsageTokens } from "@liveagent/ui/lib/chat/contextUsage";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import { selectLatestTaskProgress } from "@liveagent/ui/lib/chat/taskProgress";
import {
  readToolApprovalDeadlineAt,
  readToolApprovalPending,
  readToolApprovalSummary,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";
import {
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { toTrajectoryMessages } from "@liveagent/ui/lib/trajectory/transcriptMessages";
import {
  ChatComposerBar,
  type ChatComposerBarProps,
  type ChatQueueTurnPreview,
  type ContextUsageTokensSource,
} from "@liveagent/ui/pages/chat/ChatComposerBar";
import { CHAT_TRANSCRIPT_WIDTH_CSS_VAR } from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import {
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { createGatewayTrajectoryHost } from "@/agent-ui-adapters/trajectory";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { trimLeadingHeadlessEntries } from "@/lib/chat/historyWindow";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { submitToolApprovalDecision } from "@/lib/chat/toolApprovalBridge";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";
import { toModelValue } from "@/lib/providers/llm";
import {
  type AppSettings,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  isThinkingAlwaysOnForModel,
  normalizeChatRuntimeControlsForProvider,
  type SelectedModel,
} from "@/lib/settings";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";
import type { SectionId } from "@/pages/settings/types";
import { ConversationStatsBarHost } from "../ConversationStatsBarHost";
import {
  HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
  HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES,
} from "../constants";
import { isLocalDraftConversationId } from "../gatewayLocalDraft";
import type { SendChatFn } from "../types";
import { resolveWorkbenchComposerInputDisabled } from "./composerInputState";

type ChatQueueSnapshotLike = Parameters<
  Parameters<GatewayWebSocketClient["subscribeChatQueue"]>[0]
>[0];

/**
 * 页面级共享上下文:所有背景会话 Pane 共用一份,在 GatewayAppView 渲染体内
 * 逐帧重建(未 memo 化——宿主经 contextRef 读取最新值,不依赖引用稳定;
 * 真正的稳定化需要先把上游 handler 链整体 useCallback 化,留待性能收敛)。
 * 函数字段一律按 conversationId 显式路由,不依赖"当前展示会话"。
 */
export type GatewayConversationPaneHostContext = {
  api: GatewayWebSocketClient;
  registry: TranscriptStoreRegistry;
  settings: AppSettings;
  hasModels: boolean;
  showUsage: boolean;
  /** 页面级输入禁用(历史加载/压缩中)——只作用于 primary Pane。 */
  isInputDisabled: boolean;
  /** 传输层禁用(离线/协议不兼容)——背景 Pane 也要挡住发送。 */
  transportInputDisabled: boolean;
  inputPlaceholder: string;
  modelOptions: ChatComposerBarProps["modelOptions"];
  enabledSkills: ChatComposerBarProps["enabledSkills"];
  mentionableConversations: ChatComposerBarProps["mentionableConversations"];
  searchMentionableConversations: ChatComposerBarProps["searchMentionableConversations"];
  mentionApps: ChatComposerBarProps["mentionApps"];
  contextDisplayMode: ChatComposerBarProps["contextDisplayMode"];
  commandSafetyMode: ChatComposerBarProps["commandSafetyMode"];
  onCommandSafetyModeChange: ChatComposerBarProps["onCommandSafetyModeChange"];
  sttProvider: ChatComposerBarProps["sttProvider"];
  sttProviderConfigured: boolean | undefined;
  sttTransport: ChatComposerBarProps["sttTransport"];
  onSttError: (message: string) => void;
  gitClient: ChatComposerBarProps["gitClient"];
  gitWriteEnabled: boolean;
  gitDisabledMessage: string | undefined;
  workspaceActivityClient: ChatComposerBarProps["workspaceActivityClient"];
  onOpenWorktree: ChatComposerBarProps["onOpenWorktree"];
  onWorktreeRemoved: ChatComposerBarProps["onWorktreeRemoved"];
  openSettings: (section?: SectionId, providerId?: string) => void;
  onOpenFileLink: Parameters<typeof GatewayTranscript>[0]["onOpenFileLink"];
  onLoadUploadedImagePreview: ChatComposerBarProps["onLoadUploadedImagePreview"];
  transcriptContentWidth: number;
  selectionForConversation: (conversationId: string) => SelectedModel | undefined;
  workdirForConversation: (conversationId: string) => string;
  isConversationBusy: (conversationId: string) => boolean;
  sendChat: SendChatFn;
  cancelChat: (conversationId: string) => Promise<void> | void;
  materializeComposerDraftForSend: (
    draft: MentionComposerDraft,
    files: PendingUploadedFile[],
    workdir: string,
    targetConversationId?: string,
  ) => Promise<{
    text: string;
    uploadedFiles: PendingUploadedFile[];
    referencedConversations: ConversationMentionReference[];
  }>;
  /** 在途导入归属的会话 id:上传禁用/动画只作用在目标会话的 Pane 上。 */
  uploadingConversationId: string | null;
  getPendingUploads: (conversationId: string) => PendingUploadedFile[];
  subscribePendingUploads: (listener: () => void) => () => void;
  updatePendingUploads: (
    conversationId: string,
    updater: (current: PendingUploadedFile[]) => PendingUploadedFile[],
  ) => PendingUploadedFile[];
  importFilesForConversation: (
    conversationId: string,
    workdir: string,
    files: File[],
  ) => Promise<void>;
  getCachedComposerDraft: (conversationId: string) => MentionComposerDraft | undefined;
  setCachedComposerDraft: (conversationId: string, draft: MentionComposerDraft) => void;
  notifyError: (message: string) => void;
  trajectoryHost: ReturnType<typeof createGatewayTrajectoryHost>;
};

export type GatewayConversationPrimarySurface = {
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  onSend: () => void;
  onStop: () => void;
  onSelectModel: ChatComposerBarProps["onSelectModel"];
  onSelectExecutionMode: ChatComposerBarProps["onSelectExecutionMode"];
  onChatRuntimeControlsChange: ChatComposerBarProps["onChatRuntimeControlsChange"];
  onPrepareChatRuntime: ChatComposerBarProps["onPrepareChatRuntime"];
  onComposerBusyChange: ChatComposerBarProps["onComposerBusyChange"];
  onPickReadableFiles: ChatComposerBarProps["onPickReadableFiles"];
  onPickWorkspaceFolder: ChatComposerBarProps["onPickWorkspaceFolder"];
  onPasteFiles: ChatComposerBarProps["onPasteFiles"];
  loadHistoryPrompts: ChatComposerBarProps["loadHistoryPrompts"];
  pendingUploadedFiles: PendingUploadedFile[];
  onRemovePendingUpload: ChatComposerBarProps["onRemovePendingUpload"];
  queuedTurns: ChatQueueTurnPreview[];
  onRunQueuedTurnNow: ChatComposerBarProps["onRunQueuedTurnNow"];
  onMoveQueuedTurnUp: ChatComposerBarProps["onMoveQueuedTurnUp"];
  onEditQueuedTurn: ChatComposerBarProps["onEditQueuedTurn"];
  onRemoveQueuedTurn: ChatComposerBarProps["onRemoveQueuedTurn"];
  onManualCompactConfirm: ChatComposerBarProps["onManualCompactConfirm"];
  manualCompactBlocked: boolean;
  approvalBar: ReactNode;
  taskProgressBar: ReactNode;
  statsBar: ReactNode;
  fileDropOverlay: ReactNode;
  transcriptExtras: ReactNode;
  stageRef?: MutableRefObject<HTMLElement | null>;
  setTranscriptScrollAreaRoot?: (node: HTMLDivElement | null) => void;
  setTranscriptViewport?: (node: HTMLDivElement | null) => void;
  isViewportFollowing?: () => boolean;
  viewportFollowing?: boolean;
  onJumpToBottom?: () => void;
  navRef?: Parameters<typeof GatewayTranscript>[0]["navRef"];
  onAnchorUserRowChange?: Parameters<typeof GatewayTranscript>[0]["onAnchorUserRowChange"];
  onResendFromEdit: Parameters<typeof GatewayTranscript>[0]["onResendFromEdit"];
  onBranchConversation: Parameters<typeof GatewayTranscript>[0]["onBranchConversation"];
  branchPendingMessageId: string | null;
  onSuggestionSelect: Parameters<typeof GatewayTranscript>[0]["onSuggestionSelect"];
  suggestionsDisabled: boolean;
  hasMoreHistory: boolean;
  isLoadingMoreHistory: boolean;
  onLoadEarlierHistory?: () => void;
  isLoading: boolean;
  loadingTitle?: string;
  transcriptError?: string | null;
  changedFilesActions: ChangedFilesActions;
  checkpoint: {
    client: CheckpointRewindClient;
    disabled: boolean;
    resolveAuthorizedRoots: () => string[] | Promise<string[]>;
    onRewound: (info: CheckpointRewoundInfo) => void;
  };
};

export type GatewayConversationPaneHostProps = {
  paneId: string;
  conversationId: string;
  context: GatewayConversationPaneHostContext;
  /** 本 Pane 是否承载页面当前会话(primary 绑定)。焦点切换不拆宿主。 */
  isPrimary: boolean;
  /** focusGuard 出口:页面级操作先聚焦本 Pane。 */
  onFocusPane: () => void;
  /** 页面 composerRef:primary Pane 把自己的输入框挂上去。 */
  pageComposerRef?: MutableRefObject<MentionComposerHandle | null>;
  primary?: GatewayConversationPrimarySurface;
  blockedMessage?: string | null;
  /** 本 Pane 独立的会话/轨迹视图（每个会话一份，后台 Pane 也能保持）。 */
  trajectoryActive?: boolean;
};

export function GatewayConversationPaneHost(props: GatewayConversationPaneHostProps) {
  const {
    paneId,
    conversationId,
    context,
    isPrimary,
    onFocusPane,
    pageComposerRef,
    primary,
    blockedMessage,
    trajectoryActive = false,
  } = props;
  const { api, registry } = context;
  // context 里的部分函数(sendChat 等)每次渲染都是新引用;凡按 conversationId
  // 维度运行的 effect 一律经 ref 读取,避免身份抖动触发误重置。
  const contextRef = useRef(context);
  contextRef.current = context;
  const { t } = useLocale();
  const isDraft = isLocalDraftConversationId(conversationId);
  const store = registry.get(conversationId);

  // ---- 数据层:独立流订阅 + 一次性尾窗水合 --------------------------------
  // Primary 的流由页面级 useConversationChat 占用同一 store;背景 Pane 自己订
  // 阅。isPrimary 翻转时 effect 重跑,保证「后订阅替换先订阅」后背景能把流接回。
  useEffect(() => {
    if (isDraft || isPrimary) return;
    return api.subscribeConversationStream(conversationId, {
      onSync: (result) => store.applySync(result),
      onEvent: (event) => store.applyEvent(event),
    });
  }, [api, conversationId, isDraft, isPrimary, store]);

  const [hydrated, setHydrated] = useState(isDraft);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const loadedMaxMessagesRef = useRef(HISTORY_DETAIL_INITIAL_MAX_MESSAGES);
  const historyConversationIdRef = useRef(conversationId);
  historyConversationIdRef.current = conversationId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity is the reset trigger; the effect intentionally does not read it.
  useEffect(() => {
    loadedMaxMessagesRef.current = HISTORY_DETAIL_INITIAL_MAX_MESSAGES;
    setHasMoreHistory(false);
  }, [conversationId]);
  useEffect(() => {
    if (isDraft || isPrimary) {
      setHydrated(true);
      return;
    }
    if (store.getSnapshot().rows.length > 0) {
      setHydrated(true);
      return;
    }
    let cancelled = false;
    setHydrated(false);
    void (async () => {
      try {
        const detail = await api.getHistory(conversationId, {
          maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
        });
        if (cancelled) return;
        const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (cancelled) return;
        const entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
        const mode = store.getSnapshot().rows.length > 0 ? "enrich" : "replace";
        store.applyHistorySnapshot(entries, { mode });
        setHasMoreHistory(detail.has_more === true);
      } catch {
        // 历史读取失败时退化为纯实时视图;聚焦后主视图会重新拉取。
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, conversationId, isDraft, isPrimary, store]);

  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  const handleLoadEarlierHistory = useCallback(() => {
    if (isDraft || loadingEarlierRef.current) return;
    const requestedConversationId = conversationId;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    const nextMax = loadedMaxMessagesRef.current + HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES;
    void (async () => {
      try {
        const detail = await api.getHistory(requestedConversationId, { maxMessages: nextMax });
        if (historyConversationIdRef.current !== requestedConversationId) return;
        const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (historyConversationIdRef.current !== requestedConversationId) return;
        const entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
        store.applyHistorySnapshot(entries, { mode: "enrich" });
        loadedMaxMessagesRef.current = nextMax;
        setHasMoreHistory(detail.has_more === true);
      } catch {
        // 拉取失败保持现状,按钮可重试。
      } finally {
        if (historyConversationIdRef.current === requestedConversationId) {
          loadingEarlierRef.current = false;
          setLoadingEarlier(false);
        }
      }
    })();
  }, [api, conversationId, isDraft, store]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity cancels the previous pane's loading indicator; the effect intentionally does not read it.
  useEffect(() => {
    loadingEarlierRef.current = false;
    setLoadingEarlier(false);
  }, [conversationId]);

  const subscribeTranscript = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getTranscript = useCallback(() => store.getSnapshot(), [store]);
  const transcript = useSyncExternalStore(subscribeTranscript, getTranscript, getTranscript);
  const paneTrajectoryMessages = useMemo(
    () => toTrajectoryMessages(transcript.rows),
    [transcript.rows],
  );
  const liveTrajectory = useSyncExternalStore(subscribeLiveTrajectory, () =>
    isDraft ? null : liveTrajectoryEvents(conversationId),
  );
  const trajectoryAuthoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(conversationId),
  );

  // ---- 每会话队列:订阅网关中继的队列快照,revision 单调递增去旧 ----------
  const [queuedTurns, setQueuedTurns] = useState<ChatQueueTurnPreview[]>([]);
  const queuedTurnsRef = useRef<ChatQueueTurnPreview[]>([]);
  const queueRevisionRef = useRef(0);
  const applyQueueSnapshot = useCallback(
    (snapshot: ChatQueueSnapshotLike | null | undefined) => {
      if (!snapshot || snapshot.conversationId !== conversationId) return;
      const revision = Number(snapshot.revision ?? 0);
      if (revision < queueRevisionRef.current) return;
      queueRevisionRef.current = revision;
      const items = snapshot.items.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      }));
      queuedTurnsRef.current = items;
      setQueuedTurns(items);
    },
    [conversationId],
  );
  useEffect(() => {
    if (isDraft) return;
    queueRevisionRef.current = 0;
    queuedTurnsRef.current = [];
    setQueuedTurns([]);
    let cancelled = false;
    const unsubscribe = api.subscribeChatQueue(applyQueueSnapshot);
    void api
      .chatQueueGet(conversationId)
      .then((response) => {
        if (!cancelled) applyQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, applyQueueSnapshot, conversationId, isDraft]);

  // 队列操作直接以本会话 id 走网关 RPC(等价桌面端按会话路由);编辑队列项
  // 需要页面级编辑会话,与桌面端一致先聚焦本 Pane。
  const handleRunQueuedTurnNow = useCallback(
    (id: string) => {
      void api
        .chatQueueRunNow(conversationId, id)
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );
  const handleMoveQueuedTurnUp = useCallback(
    (id: string) => {
      void api
        .chatQueueMove(conversationId, id, "up")
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );
  const handleRemoveQueuedTurn = useCallback(
    (id: string) => {
      void api
        .chatQueueRemove(conversationId, id)
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );

  // ---- 每会话待发附件:直接订阅页面级 per-conversation 存储 ----------------
  // 文档级 paste/drop 可以写入背景会话；订阅保证 chip 与发送读取同一份
  // 权威快照，不再依赖 Pane 自己动作后的手动镜像刷新。
  const pendingUploads = useSyncExternalStore(
    context.subscribePendingUploads,
    () => context.getPendingUploads(conversationId),
    () => context.getPendingUploads(conversationId),
  );

  // ---- 发送/停止:严格按本 Pane 的 conversationId 路由(桌面端口径) --------
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const sendInFlightRef = useRef(false);
  const workdir = context.workdirForConversation(conversationId);
  const workdirRef = useRef(workdir);
  workdirRef.current = workdir;
  const selection = context.selectionForConversation(conversationId);
  const selectedProvider = selection
    ? context.settings.customProviders.find((item) => item.id === selection.customProviderId)
    : undefined;
  const paneRuntimeControls = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(context.settings.chatRuntimeControls, {
        providerId: selectedProvider?.type,
        requestFormat: selectedProvider?.requestFormat,
        modelId: selection?.model,
      }),
    [
      context.settings.chatRuntimeControls,
      selectedProvider?.requestFormat,
      selectedProvider?.type,
      selection?.model,
    ],
  );
  const paneReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: selectedProvider?.type,
        requestFormat: selectedProvider?.requestFormat,
        modelId: selection?.model,
      }),
    [selectedProvider?.requestFormat, selectedProvider?.type, selection?.model],
  );
  const paneThinkingAlwaysOn = useMemo(
    () => isThinkingAlwaysOnForModel(selectedProvider?.type ?? "claude_code", selection?.model),
    [selectedProvider?.type, selection?.model],
  );

  // 提示词澄清执行器（桌面端背景 Pane 口径）：按本 Pane 会话解析供应商/模型，
  // 经 gateway 中继到桌面宿主跑一轮纯文本补全。Web 端无轻量 git 分支状态，
  // gitBranch 留空（spec 允许只喂 workdir）。runTurn 在 useClarifySession 内
  // 走 latest-ref，依赖变化只换身份不打断会话。
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    async (messages, _signal) => {
      if (!selection || !selectedProvider) {
        throw new Error("no active model selected");
      }
      const result = await context.api.clarifyPromptTurn({
        messages,
        providerId: selectedProvider.id,
        model: selection.model,
        requestFormat: selectedProvider.requestFormat ?? "",
        runtimeControls: paneRuntimeControls,
        workdir: workdirRef.current,
        gitBranch: "",
      });
      if (result.error_code) {
        throw new Error(result.error_message || result.error_code);
      }
      return result.final_text;
    },
    [context, selection, selectedProvider, paneRuntimeControls],
  );
  // 与桌面端口径一致：会话无 workdir 时不传空串，避免系统提示词带噪音。
  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (workdir ? { workdir } : undefined),
    [workdir],
  );

  const isRunning = transcript.activeRun !== null || context.isConversationBusy(conversationId);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;

  const handleSend = useCallback(() => {
    if (sendInFlightRef.current || context.transportInputDisabled) return;
    // 本会话的附件导入尚未落账时不得发送:此刻 getPendingUploads 读到的
    // 是空列表,消息会丢附件(与主 Pane 的上传中禁用同一边界)。
    if (context.uploadingConversationId === conversationId) return;
    const composer = composerRef.current;
    const draft = composer?.getDraft() ?? null;
    sendInFlightRef.current = true;
    void (async () => {
      try {
        const files = context.getPendingUploads(conversationId).slice();
        let text: string;
        let uploadedFiles: PendingUploadedFile[];
        let referencedConversations = draft?.conversationMentions ?? [];
        try {
          const materialized = draft
            ? await context.materializeComposerDraftForSend(
                draft,
                files,
                workdirRef.current,
                conversationId,
              )
            : { text: "", uploadedFiles: files, referencedConversations: [] };
          text = materialized.text;
          uploadedFiles = materialized.uploadedFiles;
          referencedConversations = materialized.referencedConversations;
        } catch (error) {
          context.notifyError(error instanceof Error ? error.message : "大段粘贴内容导入失败");
          return;
        }
        if (!text && uploadedFiles.length === 0) return;
        composerRef.current?.clear();
        context.updatePendingUploads(conversationId, () => []);
        // 忙时入队(与桌面端背景 Pane enqueue 一致):队列面板持有提示词,
        // 不做转录乐观回显;闲时直发。
        const busy = isRunningRef.current || queuedTurnsRef.current.length > 0;
        const restore = () => {
          context.updatePendingUploads(conversationId, (current) =>
            mergePendingUploadedFiles(current, uploadedFiles),
          );
          const currentComposer = composerRef.current;
          if (draft && currentComposer && !currentComposer.hasContent()) {
            currentComposer.setDraft(draft);
          }
        };
        try {
          const outcome = await context.sendChat(text, {
            conversationId,
            uploadedFiles,
            referencedConversations,
            runtimeControls: paneRuntimeControls,
            ...(busy ? { queuePolicy: "append" as const, optimisticEcho: false } : {}),
          });
          if (outcome?.kind === "failed") restore();
        } catch {
          restore();
        }
      } finally {
        sendInFlightRef.current = false;
      }
    })();
  }, [context, conversationId, paneRuntimeControls]);

  const handleStop = useCallback(() => {
    // 与桌面端/聚焦舞台一致:有排队回合先"停当前、跑下一条",否则纯停止。
    const nextQueuedTurn = queuedTurnsRef.current[0];
    if (nextQueuedTurn) {
      handleRunQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    void context.cancelChat(conversationId);
  }, [context, conversationId, handleRunQueuedTurnNow]);

  // ---- 草稿:挂载恢复缓存,卸载(聚焦切换/关 Pane)写回缓存(桌面端口径) --
  // hydrated 必须参与触发:背景 Pane 冷启动时先渲染加载占位,composer 尚未
  // 挂载,恢复会被无声跳过;水合完成后重跑一次才能把缓存草稿真正写进输入框。
  useLayoutEffect(() => {
    if (!hydrated) return;
    const composer = composerRef.current;
    const cached = contextRef.current.getCachedComposerDraft(conversationId);
    if (cached) {
      composer?.setDraft(cached);
    } else {
      composer?.clear();
    }
    return () => {
      // 只写回非空草稿:空输入框不得删除缓存里的草稿(聚焦舞台的恢复
      // 通路仍需要它),与桌面端 ConversationPaneHost 的卸载语义一致。
      const nextDraft = composerRef.current?.getDraft();
      if (!nextDraft || nextDraft.isEmpty || !nextDraft.text.trim()) return;
      contextRef.current.setCachedComposerDraft(conversationId, nextDraft);
    };
  }, [conversationId, hydrated]);

  useLayoutEffect(() => {
    if (!isPrimary || !pageComposerRef) return;
    // Assign on attach only. Nulling on detach is order-dependent: the
    // outgoing primary's cleanup can run after the incoming assign (or
    // assign null while this pane's composer is still mounting) and leave
    // Enter reading an empty page composer.
    if (composerRef.current) pageComposerRef.current = composerRef.current;
  });

  // ---- 转录滚动跟随:贴底自动跟进,用户上滚即释放,支持一键回底 ------------
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const detachScrollRef = useRef<(() => void) | null>(null);
  const setViewport = useCallback((element: HTMLDivElement | null) => {
    detachScrollRef.current?.();
    detachScrollRef.current = null;
    viewportRef.current = element;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    const handleScroll = () => {
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      followingRef.current = nearBottom;
      setFollowing(nearBottom);
    };
    element.addEventListener("scroll", handleScroll, { passive: true });
    detachScrollRef.current = () => element.removeEventListener("scroll", handleScroll);
  }, []);
  useEffect(() => () => detachScrollRef.current?.(), []);
  const rowCount = transcript.rows.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 行数/修订变化时按跟随态贴底,效果体不直接读取它们。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followingRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [rowCount, transcript.revision]);
  const jumpToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  }, []);
  const isViewportFollowing = useCallback(() => followingRef.current, []);

  // ---- 每会话模型/用量/进度/审批 -------------------------------------------
  const selectedValue = selection
    ? toModelValue(selection.customProviderId, selection.model)
    : undefined;
  const modelLabel = useMemo(() => {
    if (!selection) return t("chat.selectModel");
    return selectedProvider ? `${selectedProvider.name} / ${selection.model}` : selection.model;
  }, [selectedProvider, selection, t]);
  const contextWindow = useMemo(() => {
    if (!selection) return undefined;
    const provider = context.settings.customProviders.find(
      (item) => item.id === selection.customProviderId,
    );
    return provider ? findProviderModelConfig(provider, selection.model).contextWindow : undefined;
  }, [context.settings.customProviders, selection]);
  const contextUsageTokensSource = useMemo<ContextUsageTokensSource>(() => {
    let cache: { revision: number; value: number | undefined } | null = null;
    return {
      subscribe: store.subscribe,
      getContextUsageTokens: () => {
        const snapshot = store.getSnapshot();
        if (cache && cache.revision === snapshot.revision) return cache.value;
        const value = deriveContextUsageTokens(snapshot.rows);
        cache = { revision: snapshot.revision, value };
        return value;
      },
    };
  }, [store]);
  const taskProgressSnapshot = useMemo(
    () => selectLatestTaskProgress(transcript.rows),
    [transcript.rows],
  );
  const pendingToolApprovals = useMemo(() => {
    const result: {
      toolCallId: string;
      toolName: string;
      summary?: string;
      deadlineAt?: number;
    }[] = [];
    for (const row of transcript.rows) {
      if (row.kind !== "assistant") continue;
      for (const round of row.rounds) {
        for (const block of round.blocks) {
          if (block.kind !== "tool") continue;
          const { toolCall, toolResult } = block.item;
          if (toolResult || !readToolApprovalPending(toolCall.arguments)) continue;
          result.push({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            summary: readToolApprovalSummary(toolCall.arguments),
            deadlineAt: readToolApprovalDeadlineAt(toolCall.arguments) ?? undefined,
          });
        }
      }
    }
    return result;
  }, [transcript.rows]);
  // 审批决定显式携带本 Pane 的会话 id,绝不落到聚焦会话上。
  const approvalBar =
    pendingToolApprovals.length > 0 ? (
      <ToolApprovalBar
        pending={pendingToolApprovals}
        onDecide={(toolCallId, decision) =>
          submitToolApprovalDecision(toolCallId, decision, conversationId)
        }
        onDecideAll={async (decision) => {
          for (const item of pendingToolApprovals) {
            await submitToolApprovalDecision(item.toolCallId, decision, conversationId);
          }
        }}
      />
    ) : null;

  if (!hydrated && !isPrimary && rowCount === 0) {
    return (
      <div
        data-workbench-pane-id={paneId}
        data-workbench-surface="conversation"
        data-workbench-surface-id={`conversation:${conversationId}`}
        className="flex h-full min-h-0 w-full items-center justify-center"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const usePrimary = Boolean(isPrimary && primary);
  const transcriptFollowing = usePrimary ? (primary?.viewportFollowing ?? following) : following;
  const transcriptIsViewportFollowing =
    usePrimary && primary?.isViewportFollowing ? primary.isViewportFollowing : isViewportFollowing;
  const handleJumpToBottom =
    usePrimary && primary?.onJumpToBottom ? primary.onJumpToBottom : jumpToBottom;
  const transcriptTree = (
    <GatewayTranscript
      conversationId={conversationId}
      rows={transcript.rows}
      liveStartIndex={transcript.liveStartIndex}
      activeTurnKey={transcript.activeTurnKey}
      contentWidth={context.transcriptContentWidth}
      isViewportFollowing={transcriptIsViewportFollowing}
      viewportFollowing={transcriptFollowing}
      toolStatus={transcript.toolStatus}
      toolStatusIsCompaction={transcript.toolStatusIsCompaction}
      retryAttempts={transcript.retryAttempts}
      isStreaming={transcript.activeRun !== null}
      isLoading={usePrimary ? primary?.isLoading : false}
      loadingTitle={usePrimary ? primary?.loadingTitle : undefined}
      error={usePrimary ? (primary?.transcriptError ?? undefined) : undefined}
      hasModels={context.hasModels}
      onOpenSettings={context.openSettings}
      hasMoreHistory={usePrimary ? (primary?.hasMoreHistory ?? false) : hasMoreHistory}
      isLoadingMoreHistory={usePrimary ? (primary?.isLoadingMoreHistory ?? false) : loadingEarlier}
      onLoadEarlierHistory={
        usePrimary
          ? primary?.onLoadEarlierHistory
          : hasMoreHistory
            ? handleLoadEarlierHistory
            : undefined
      }
      showUsage={context.showUsage}
      usageContextWindow={contextWindow}
      workspaceRoot={workdir}
      onOpenFileLink={context.onOpenFileLink}
      gitClient={context.gitClient}
      onLoadUploadedImagePreview={context.onLoadUploadedImagePreview}
      navRef={usePrimary ? primary?.navRef : undefined}
      onAnchorUserRowChange={usePrimary ? primary?.onAnchorUserRowChange : undefined}
      onResendFromEdit={usePrimary ? primary?.onResendFromEdit : () => onFocusPane()}
      onBranchConversation={usePrimary ? primary?.onBranchConversation : undefined}
      branchPendingMessageId={
        usePrimary ? (primary?.branchPendingMessageId ?? undefined) : undefined
      }
      onSuggestionSelect={usePrimary ? primary?.onSuggestionSelect : () => onFocusPane()}
      suggestionsDisabled={usePrimary ? primary?.suggestionsDisabled : undefined}
    />
  );

  // 嵌套一层 .gateway-chat-frame:ChatComposerBar(surface="web")把输入框
  // 高度写到最近的 chat-frame CSS 变量上,这里让变量按 Pane 独立作用,多个
  // 输入框互不干扰;DOM 结构与桌面端 ConversationSurface 一致。
  return (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="conversation"
      data-workbench-surface-id={`conversation:${conversationId}`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {blockedMessage ? (
        <div
          data-workbench-pane-blocked=""
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400"
        >
          {blockedMessage}
        </div>
      ) : null}
      <div className="gateway-chat-frame relative flex h-full min-h-0 w-full flex-col overflow-hidden">
        <section
          ref={usePrimary ? primary?.stageRef : undefined}
          className="gateway-transcript-stage"
          style={
            {
              [CHAT_TRANSCRIPT_WIDTH_CSS_VAR]: `${context.transcriptContentWidth}px`,
            } as CSSProperties
          }
        >
          {trajectoryActive ? (
            <TrajectoryView
              conversationId={conversationId}
              host={context.trajectoryHost}
              messages={paneTrajectoryMessages}
              workdir={workdir}
              hasMoreMessages={usePrimary ? (primary?.hasMoreHistory ?? false) : hasMoreHistory}
              loadEarlierMessages={
                usePrimary
                  ? primary?.onLoadEarlierHistory
                  : hasMoreHistory
                    ? handleLoadEarlierHistory
                    : undefined
              }
              liveEvents={liveTrajectory ?? undefined}
              authoritativeRevision={trajectoryAuthoritativeRevision}
            />
          ) : (
            <div className="gateway-transcript-scroll-shell">
              <ScrollArea
                ref={usePrimary ? primary?.setTranscriptScrollAreaRoot : undefined}
                viewportRef={
                  usePrimary && primary?.setTranscriptViewport
                    ? primary.setTranscriptViewport
                    : setViewport
                }
                className="gateway-transcript-scroll"
              >
                {usePrimary && primary ? (
                  <ChangedFilesActionsProvider value={primary.changedFilesActions}>
                    <CheckpointRewindProvider
                      client={primary.checkpoint.client}
                      conversationId={conversationId}
                      disabled={primary.checkpoint.disabled}
                      resolveAuthorizedRoots={() =>
                        Promise.resolve(primary.checkpoint.resolveAuthorizedRoots())
                      }
                      onRewound={primary.checkpoint.onRewound}
                    >
                      {transcriptTree}
                    </CheckpointRewindProvider>
                  </ChangedFilesActionsProvider>
                ) : (
                  transcriptTree
                )}
              </ScrollArea>
              {usePrimary ? primary?.transcriptExtras : null}
              {!transcriptFollowing && rowCount > 0 ? (
                <button
                  type="button"
                  className="gateway-scroll-to-bottom"
                  onClick={handleJumpToBottom}
                  aria-label="滚动到底部"
                  title="滚动到底部"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          )}
          <ChatComposerBar
            surface="web"
            runClarifyTurn={runClarifyTurn}
            clarifyContext={clarifyContext}
            conversationId={conversationId}
            hidden={trajectoryActive}
            composerRef={composerRef}
            isSending={usePrimary ? (primary?.isSending ?? isRunning) : isRunning}
            isUploadingFiles={
              usePrimary
                ? (primary?.isUploadingFiles ?? false)
                : context.uploadingConversationId === conversationId
            }
            isInputDisabled={resolveWorkbenchComposerInputDisabled({
              isPrimary: usePrimary,
              primaryInputDisabled: primary?.isInputDisabled ?? context.isInputDisabled,
              transportInputDisabled: context.transportInputDisabled,
              conversationIsCompacting: transcript.toolStatusIsCompaction === true,
            })}
            sttSessionKey={conversationId}
            sttProvider={context.sttProvider}
            sttProviderConfigured={context.sttProviderConfigured}
            sttTransport={context.sttTransport}
            onSttError={context.onSttError}
            inputPlaceholder={context.inputPlaceholder}
            workdir={workdir}
            enabledSkills={context.enabledSkills}
            mentionableConversations={context.mentionableConversations}
            searchMentionableConversations={context.searchMentionableConversations}
            mentionApps={context.mentionApps}
            executionMode={context.settings.system.executionMode}
            hasModels={context.hasModels}
            currentModelLabel={modelLabel}
            modelOptions={context.modelOptions}
            selectedValue={selectedValue}
            chatRuntimeControls={paneRuntimeControls}
            commandSafetyMode={context.commandSafetyMode}
            onCommandSafetyModeChange={context.onCommandSafetyModeChange}
            reasoningOptions={paneReasoningOptions}
            thinkingAlwaysOn={paneThinkingAlwaysOn}
            contextUsageTokensSource={contextUsageTokensSource}
            contextWindow={contextWindow}
            contextDisplayMode={context.contextDisplayMode}
            onManualCompactConfirm={
              usePrimary && primary ? primary.onManualCompactConfirm : () => onFocusPane()
            }
            manualCompactBlocked={
              usePrimary
                ? (primary?.manualCompactBlocked ?? false)
                : transcript.toolStatusIsCompaction === true
            }
            gitClient={context.gitClient}
            gitWriteEnabled={context.gitWriteEnabled}
            gitDisabledMessage={context.gitDisabledMessage}
            workspaceActivityClient={context.workspaceActivityClient}
            onOpenWorktree={context.onOpenWorktree}
            onWorktreeRemoved={context.onWorktreeRemoved}
            onSend={usePrimary && primary ? primary.onSend : handleSend}
            onStop={usePrimary && primary ? primary.onStop : handleStop}
            onComposerBusyChange={
              usePrimary && primary ? primary.onComposerBusyChange : () => undefined
            }
            onSelectModel={usePrimary && primary ? primary.onSelectModel : () => onFocusPane()}
            onSelectExecutionMode={
              usePrimary && primary ? primary.onSelectExecutionMode : () => onFocusPane()
            }
            onOpenSettings={context.openSettings}
            onChatRuntimeControlsChange={
              usePrimary && primary ? primary.onChatRuntimeControlsChange : () => onFocusPane()
            }
            onPrepareChatRuntime={usePrimary && primary ? primary.onPrepareChatRuntime : undefined}
            onPickReadableFiles={
              usePrimary && primary ? primary.onPickReadableFiles : () => onFocusPane()
            }
            onPickWorkspaceFolder={
              usePrimary && primary ? primary.onPickWorkspaceFolder : () => onFocusPane()
            }
            onPasteFiles={
              usePrimary && primary
                ? primary.onPasteFiles
                : (files) => {
                    void context.importFilesForConversation(
                      conversationId,
                      workdirRef.current,
                      files,
                    );
                  }
            }
            onLoadUploadedImagePreview={context.onLoadUploadedImagePreview}
            loadHistoryPrompts={usePrimary && primary ? primary.loadHistoryPrompts : undefined}
            pendingUploadedFiles={
              usePrimary && primary ? primary.pendingUploadedFiles : pendingUploads
            }
            onRemovePendingUpload={
              usePrimary && primary
                ? primary.onRemovePendingUpload
                : (relativePath) => {
                    context.updatePendingUploads(conversationId, (current) =>
                      current.filter((file) => file.relativePath !== relativePath),
                    );
                  }
            }
            queuedTurns={usePrimary && primary ? primary.queuedTurns : queuedTurns}
            onRunQueuedTurnNow={
              usePrimary && primary ? primary.onRunQueuedTurnNow : handleRunQueuedTurnNow
            }
            onMoveQueuedTurnUp={
              usePrimary && primary ? primary.onMoveQueuedTurnUp : handleMoveQueuedTurnUp
            }
            onEditQueuedTurn={
              usePrimary && primary ? primary.onEditQueuedTurn : () => onFocusPane()
            }
            onRemoveQueuedTurn={
              usePrimary && primary ? primary.onRemoveQueuedTurn : handleRemoveQueuedTurn
            }
            taskProgressBar={
              usePrimary ? (
                primary?.taskProgressBar
              ) : (
                <TaskProgressBar
                  key={conversationId}
                  snapshot={taskProgressSnapshot}
                  isConversationRunning={isRunning}
                />
              )
            }
            approvalBar={usePrimary ? primary?.approvalBar : approvalBar}
            statsBar={
              usePrimary ? (
                primary?.statsBar
              ) : (
                <ConversationStatsBarHost
                  key={`stats-${conversationId}`}
                  conversationId={conversationId}
                  host={context.trajectoryHost}
                  enabled={!trajectoryActive}
                  contextUsageTokensSource={contextUsageTokensSource}
                  contextWindow={contextWindow}
                  onManualCompactConfirm={() => onFocusPane()}
                  manualCompactBlocked={transcript.toolStatusIsCompaction === true}
                />
              )
            }
            fileDropOverlay={usePrimary ? primary?.fileDropOverlay : null}
          />
        </section>
      </div>
    </div>
  );
}
