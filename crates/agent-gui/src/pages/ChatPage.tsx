import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { AppWorkbenchChrome } from "@liveagent/ui/application/AppWorkbenchChrome";
import { useApplicationViewState } from "@liveagent/ui/application/useApplicationViewState";
import { ConversationViewTabs } from "@liveagent/ui/components/chat/ConversationViewTabs";
import type { RunClarifyTurn } from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { HistoryShareModal } from "@liveagent/ui/components/chat/HistoryShareModal";
import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import { NotifyToast } from "@liveagent/ui/components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import { WorkspaceCloneModal } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import { WorkspaceProjectSettingsModal } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { ProjectToolsPanelToggle } from "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle";
import { RightDockPanel } from "@liveagent/ui/components/project-tools/RightDockPanel";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { PaneChrome } from "@liveagent/ui/components/workbench/PaneChrome";
import { UnsupportedPaneSurface } from "@liveagent/ui/components/workbench/surfaces/UnsupportedPaneSurface";
import {
  WORKBENCH_CANVAS_DIVIDER_SIZE,
  WorkbenchCanvas,
} from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import { WorkbenchEmptyState } from "@liveagent/ui/components/workbench/WorkbenchEmptyState";
import { useWorkspaceOverlays } from "@liveagent/ui/components/workspace-editor/useWorkspaceOverlays";
import { WorkspaceOverlayHost } from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import { useLocale } from "@liveagent/ui/i18n/index";
import { getAutomationState, useAutomation } from "@liveagent/ui/lib/automation/index";
import { formatCheckpointRewoundNotification } from "@liveagent/ui/lib/chat/checkpointRewind";
import { useChangedFilesActions } from "@liveagent/ui/lib/chat/useChangedFilesActions";
import { useChatFileLinkNavigation } from "@liveagent/ui/lib/chat/useChatFileLinkNavigation";
import {
  useComposerActions,
  useComposerSkillSelection,
  useInsertCodeReviewSkill,
} from "@liveagent/ui/lib/chat/useComposerActions";
import { useMentionApps } from "@liveagent/ui/lib/chat/useMentionApps";
import { setPreferredMonacoNlsLocale } from "@liveagent/ui/lib/monacoNls";
import { useRightDockSettings } from "@liveagent/ui/lib/projectTools/useRightDockSettings";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "@liveagent/ui/lib/sidebar/openController";
import { conversationMatchesScope } from "@liveagent/ui/lib/sidebar/scope";
import {
  selectConversations,
  selectRunningConversationIds,
} from "@liveagent/ui/lib/sidebar/selectors";
import { createSidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { buildSkillsSystemPrompt, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { useChatSkills } from "@liveagent/ui/lib/skills/useChatSkills";
import { terminalSessionBelongsToProject } from "@liveagent/ui/lib/terminal/sessionStore";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";
import {
  toTrajectoryLiveAssistantMessage,
  toTrajectoryMessages,
} from "@liveagent/ui/lib/trajectory/transcriptMessages";
import { useConversationViewState } from "@liveagent/ui/lib/trajectory/useConversationViewState";
import type { LocalTunnelClient } from "@liveagent/ui/lib/tunnels/constants";
import {
  findAdjacentPaneId,
  findParentSplitId,
  hitTestWorkbenchDrop,
  type WorkbenchCommandError,
  type WorkbenchDropTarget,
  type WorkbenchGeometry,
} from "@liveagent/ui/lib/workbench/index";
import {
  type ConversationWorkbenchSurface,
  type PaneRecord,
  type ProjectRef,
  surfaceIdentityKey,
  surfaceProjectRef,
} from "@liveagent/ui/lib/workbench/types";
import { listen } from "@tauri-apps/api/event";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { loadComposerUploadedImagePreview } from "../agent-ui-adapters/composerImagePreview";
import { createTauriTrajectoryHost } from "../agent-ui-adapters/trajectory";
import { WorkspaceCloneTaskOverlayAdapter } from "../agent-ui-adapters/workspaceCloneTasks";
import { desktopWorkspaceProjectRootClient } from "../agent-ui-adapters/workspaceProjectRoots";
import { PaneLoadingSkeleton } from "../components/app/PaneLoadingSkeleton";
import { MacOsTitleBarToggle } from "../components/MacOsTitleBarSpacer";
import type { CompactionStatus } from "../lib/chat/compaction/types";
import {
  buildRequestContext,
  type ConversationViewState,
  createConversationStateFromContext,
  type RenderTimelineItem,
} from "../lib/chat/conversation/conversationState";
import type { ChatHistorySummary } from "../lib/chat/history/chatHistory";
import { memoryExtraction } from "../lib/chat/memory/extractionController";
import { memoryTurnInjection } from "../lib/chat/memory/injectionController";
import {
  buildFallbackConversationTitle,
  createConversationIdentity,
  createPendingHistoryItem,
  getFirstUserMessageText,
} from "../lib/chat/page/chatPageHelpers";
import { skillMentionInjection } from "../lib/chat/skills/mentionInjection";
import { tauriGitClient } from "../lib/git/tauriGitClient";
import { buildMemoryOverviewSection } from "../lib/memory/prompts/injection";
import { createProviderRuntimeConfig, toModelValue } from "../lib/providers/llm";
import {
  findProviderModelConfig,
  isAgentDevMode,
  isAgentExecutionMode,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
  resolveEffectivePromptSettings,
  resolveEffectiveTheme,
  resolveWorkspaceResources,
  updateExecutionModeFromChatSelection,
  updateSystem,
  updateWorkspaceResourceSettings,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "../lib/settings";
import { tauriSftpClient } from "../lib/sftp/tauriSftpClient";
import { createGuiSidebarBackend } from "../lib/sidebar/guiSidebarBackend";
import { desktopSttTransport } from "../lib/stt/desktopSttTransport";
import { createSubagentStoreManager } from "../lib/subagents";
import { tauriTerminalClient } from "../lib/terminal/tauriTerminalClient";
import { cancelPendingAskUserQuestionsForConversation } from "../lib/tools/askUserQuestionTools";
import {
  answerPlanDecision,
  cancelPendingPlanDecisionsForConversation,
  getPendingPlanForConversation,
  isPlanApprovalMessage,
  registerPlanDecisionHandlers,
} from "../lib/tools/planModeTools";
import { cancelPendingToolApprovalsForConversation } from "../lib/tools/toolApproval";
import { clearMcpToolActivation } from "../lib/tools/toolSearchTools";
import { buildTrayMenuModel, syncTrayMenu } from "../lib/tray/trayMenu";
import { useTrayPrefs } from "../lib/tray/trayPrefs";
import { createTauriTunnelClient } from "../lib/tunnels/tauriTunnelClient";
import { tauriWorkspaceActivityClient } from "../lib/workspace-activity/tauriWorkspaceActivityClient";
import type { ChatPageProps } from "./chat/chatPageTypes";
import { useComposerHistoryPrompts } from "./chat/composer/useComposerHistoryPrompts";
import type {
  ConversationControllerActions,
  ConversationSurfaceController,
} from "./chat/conversations/conversationControllerTypes";
import { createConversationSurfaceController } from "./chat/conversations/createConversationSurfaceController";
import { useConversationHydrationPhase } from "./chat/conversations/useConversationHydrationPhase";
import { useConversationPaneHostBridge } from "./chat/conversations/useConversationPaneHostBridge";
import { useConversationRuntimeEntrySnapshot } from "./chat/conversations/useConversationRuntimeEntrySnapshot";
import type {
  EnsureGatewayBridgeConversationReadyOptions,
  SendChatAction,
} from "./chat/gateway/gatewayBridgeTypes";
import { useGatewayBridgeListeners } from "./chat/gateway/useGatewayBridgeListeners";
import { useGatewayBridgeReadiness } from "./chat/gateway/useGatewayBridgeReadiness";
import { useGatewayRunMirrorCoordinator } from "./chat/gateway/useGatewayRunMirrorCoordinator";
import { useGatewayStatus } from "./chat/gateway/useGatewayStatus";
import { useBranchConversation } from "./chat/history/useBranchConversation";
import { useConversationHistoryActions } from "./chat/history/useConversationHistoryActions";
import { useSharedHistory } from "./chat/history/useSharedHistory";
import { useChatPageRuntimeStore } from "./chat/hooks/useChatPageRuntimeStore";
import {
  createContextUsageTokensSource,
  useContextUsageTokensSource,
} from "./chat/hooks/useContextUsageTokensSource";
import { useEditResend } from "./chat/hooks/useEditResend";
import { useLiveTranscriptController } from "./chat/hooks/useLiveTranscriptController";
import { useNotifyToasts } from "./chat/hooks/useNotifyToasts";
import { MAX_UPLOAD_FILES, usePendingUploads } from "./chat/hooks/usePendingUploads";
import { useTauriFileDrop } from "./chat/hooks/useTauriFileDrop";
import { useUploadZoneDrop } from "./chat/hooks/useUploadZoneDrop";
import {
  getQueuedConversationIds,
  removeQueuedChatTurnsForConversation,
} from "./chat/queue/chatTurnQueue";
import { useChatTurnQueue } from "./chat/queue/useChatTurnQueue";
import { createChatRuntimeHost } from "./chat/runtime/ChatRuntimeHost";
import {
  pruneIdleConversationRuntimeCaches,
  syncMovedConversationRuntimeWorkdir,
} from "./chat/runtime/chatPageRuntime";
import { createGuiClarifyRunner } from "./chat/runtime/clarifyRunner";
import {
  resolveActiveModelSelection,
  resolveEffectiveChatModelSelection,
} from "./chat/runtime/modelSelection";
import { useChatModelSelection } from "./chat/runtime/useChatModelSelection";
import {
  type ManualCompactionRequest,
  type ManualCompactionResult,
  useManualCompaction,
} from "./chat/runtime/useManualCompaction";
import { useProjectToolTextGenerationClient } from "./chat/runtime/useProjectToolTextGenerationClient";
import { useSendChatTurn } from "./chat/runtime/useSendChatTurn";
import { ChatSidebarContainer } from "./chat/sidebar/ChatSidebarContainer";
import {
  type ConversationPaneBinding,
  ConversationPaneHostEnvironmentProvider,
  type ConversationPaneRegistration,
  createConversationPaneHostEnvironment,
} from "./chat/surfaces/ConversationPaneHostEnvironment";
import { ConversationTrajectorySurface } from "./chat/surfaces/ConversationTrajectorySurface";
import { TerminalPaneHost } from "./chat/surfaces/TerminalPaneHost";
import { resolveWorkbenchPaneProject } from "./chat/workbench/paneProjectContext";
import { sessionWorkbench } from "./chat/workbench/sessionWorkbench";
import { commitTerminalDrop } from "./chat/workbench/terminalDropCommit";
import {
  createTerminalSurfaceId,
  findTerminalPaneForSession,
  terminalAppExitGuard,
  terminalPaneAutoLaunch,
  terminalPaneBindings,
  terminalPaneLease,
} from "./chat/workbench/terminalPaneRuntime";
import { useWindowWorkbench } from "./chat/workbench/useWindowWorkbench";
import {
  canSplitRectAtEdge,
  useWorkbenchDragSession,
  type WorkbenchDropCommit,
} from "./chat/workbench/useWorkbenchDragSession";
import { useProjectTerminals } from "./chat/workspace/useProjectTerminals";
import { useWorkspaceProjectRemoval } from "./chat/workspace/useWorkspaceProjectRemoval";
import { useWorkspaceProjects } from "./chat/workspace/useWorkspaceProjects";

const ConversationPaneHost = lazy(async () => ({
  default: (await import("./chat/surfaces/ConversationPaneHost")).ConversationPaneHost,
}));
const RestorableConversationPaneHost = lazy(async () => ({
  default: (await import("./chat/surfaces/ConversationPaneHost")).RestorableConversationPaneHost,
}));

export function ChatPage(props: ChatPageProps) {
  const {
    settings,
    setSettings,
    sttProviderOverride,
    getMcpSettings,
    getToolPolicies,
    context,
    setContext,
    onOpenSettings,
    onToggleTheme,
    appUpdate,
    onRunningConversationCountChange,
  } = props;
  // Monaco reads NLS globals while the lazy editor module imports monaco-editor.
  setPreferredMonacoNlsLocale(settings.locale);
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const { t, locale } = useLocale();
  const initialConversationRef = useRef(createConversationIdentity());
  const initialConversationStateRef = useRef(createConversationStateFromContext(context));

  const [conversationState, setConversationState] = useState<ConversationViewState>(
    () => initialConversationStateRef.current,
  );
  const [compactionStatus, setCompactionStatus] = useState<CompactionStatus>({ phase: "idle" });
  const [isSending, setIsSending] = useState(false);
  const [isImportingPastedText, setIsImportingPastedText] = useState(false);
  const isImportingPastedTextRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hookWarning, setHookWarning] = useState<string | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string>(
    () => initialConversationRef.current.conversationId,
  );
  // sessionId / createdAt / selectedModel 不再是页面级镜像 state:它们由
  // registry entry 派生(见 useChatPageRuntimeStore 调用后的
  // useConversationRuntimeEntrySnapshot),registry 是唯一写入方。
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conversationOpenState, setConversationOpenState] = useState<ConversationOpenState>({
    conversationId: "",
    phase: "idle",
    showOverlay: false,
    errorCode: null,
  });
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();

  const isAgentMode = isAgentExecutionMode(settings.system.executionMode);
  const isAgentDevExecutionMode = isAgentDevMode(settings.system.executionMode);
  const workdir = settings.system.workdir.trim();
  const activeAgentPrompt = useMemo(() => {
    return resolveEffectivePromptSettings(settings, "").globalPrompt;
  }, [settings]);
  // The sidebar store owns all sidebar domain state (conversation list,
  // workdirs, running set); ChatPage only issues imperative calls and keeps a
  // few narrow selector subscriptions.
  const sidebarStore = useMemo(() => createSidebarStore(createGuiSidebarBackend()), []);
  const startNewConversationActionRef = useRef<(options?: { workdir?: string }) => void>(
    () => undefined,
  );
  const prepareComposerForConversationChangeActionRef = useRef<() => void>(() => undefined);
  const {
    activeView,
    setActiveView,
    projectSettingsProject,
    setProjectSettingsProject,
    rightDockOpen,
    setRightDockOpen,
  } = useApplicationViewState<WorkspaceProject>();
  const {
    workspaceProjects,
    setActiveWorkspaceProjectId,
    missingWorkspaceProjectPathKeys,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    sidebarScope,
    historyScopeKey,
    activateWorkspaceProject,
    handleSelectWorkspaceProject,
    handleNewConversationForProject,
    handleBrowseWorkspaceProjectInFileTree,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    handleBrowseWorkspaceProjectInSystemFileManager,
    handleOpenCreateWorkspaceProject,
    workspaceCreateModalOpen,
    setWorkspaceCreateModalOpen,
    handleOpenWorkspaceFolder,
    handleDropWorkspaceFolders,
    handleCloneWorkspaceProject,
    handleOpenClonedWorkspace,
    handleOpenWorktree,
    workspaceProjectGroups,
    handleCreateWorkspaceGroup,
    handleRenameWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleMoveWorkspaceProjectToGroup,
    handleToggleWorkspaceGroupCollapsed,
    handleLoadWorkspaceRemoteBranches,
    commitWorkspaceProjectRename,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
  } = useWorkspaceProjects({
    settings,
    setSettings,
    sidebarStore,
    isAgentMode,
    workdir,
    t,
    setErrorMessage,
    setActiveView,
    setRightDockOpen,
    startNewConversationActionRef,
    prepareComposerForConversationChangeActionRef,
  });
  useEffect(() => {
    sidebarStore.start();
    return () => {
      sidebarStore.stop();
    };
  }, [sidebarStore]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { remoteRuntimeStatus, setRemoteRuntimeStatus } = useGatewayStatus({
    remote: settings.remote,
  });
  const tauriTunnelClient = useMemo<LocalTunnelClient>(() => createTauriTunnelClient(), []);

  // The only page-level subscription to the sidebar list: ChatPage's own
  // render needs (draft detection, pending-item effect, workspace root).
  const historyItems = useSidebarSelector(sidebarStore, selectConversations);
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (s) => s.byId);
  const {
    canShareHistory,
    shareConversation,
    shareStatus,
    shareLoading,
    shareUpdating,
    shareError,
    sharedManagerOpen,
    setSharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerLoadingIds,
    sharedManagerUpdatingIds,
    sharedManagerErrors,
    sharedManagerGatewayUrlLoading,
    sharedManagerShareOrigin,
    sharedManagerShareOriginPort,
    sharedHistoryItems,
    removeSharedHistoryItems,
    handleLoadSharedHistoryStatus,
    handleOpenShareModal,
    handleCloseShareModal,
    handleToggleHistoryShare,
    handleSetShareRedactToolContent,
    handleRefreshSharedHistoryStatuses,
    handleOpenSharedHistoryManager,
    handleDisableSharedHistory,
    handleSetSharedHistoryRedactToolContent,
  } = useSharedHistory({
    remoteSettings: settings.remote,
    remoteRuntimeStatus,
    setRemoteRuntimeStatus,
    sidebarStore,
    setErrorMessage,
  });

  const { availableSkills, skillsRootDir, refreshSkills } = useChatSkills({
    skillsEnabled: settings.skills.enabled && isAgentMode,
    selectedSkillNames: settings.skills.selected,
    setSettings,
  });

  const transcriptItems = useMemo<RenderTimelineItem[]>(
    () => conversationState.transcript.items,
    [conversationState],
  );
  const loadComposerHistoryPrompts = useComposerHistoryPrompts(transcriptItems);
  const {
    activeConversationView,
    setActiveConversationView,
    viewForConversation,
    setConversationView,
  } = useConversationViewState(currentConversationId);
  const currentRequestContext = useMemo(
    () => buildRequestContext(conversationState),
    [conversationState],
  );
  const chatRuntimeHost = useMemo(() => createChatRuntimeHost(), []);

  const {
    hostRef: conversationPaneHostRef,
    composerRef,
    scrollFollowRef,
  } = useConversationPaneHostBridge();
  const composerBusyRef = useRef(false);
  const conversationLoadSequenceRef = useRef(0);
  const subagentStoresRef = useRef(createSubagentStoreManager());
  const previousSubagentRuntimeConversationRef = useRef(currentConversationId);
  const subagentWarmupSignatureRef = useRef("");
  const titleJobRef = useRef<{
    conversationId: string;
    promise: Promise<string | null>;
  } | null>(null);
  const previousHistoryIdsRef = useRef<Set<string>>(new Set());
  const previousHistoryScopeKeyRef = useRef(historyScopeKey);
  const currentConversationHistoryUpdatedAtRef = useRef<number | null>(null);
  const locallySyncedHistoryUpdatedAtRef = useRef(new Map<string, number>());
  const gatewayBridgeHistorySummaryRef = useRef(new Map<string, ChatHistorySummary>());
  const openInitialActionRef = useRef<(id: string) => Promise<"cache-hit" | "painted">>(
    async () => "painted",
  );
  const hydrateConversationActionRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const loadEarlierHistoryActionRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const cleanupDeletedConversationActionRef = useRef<(id: string) => void>(() => undefined);
  const openController = useMemo(
    () =>
      createConversationOpenController({
        openInitial: (conversationId) => openInitialActionRef.current(conversationId),
        onStateChange: setConversationOpenState,
      }),
    [],
  );
  const sendActionRef = useRef<SendChatAction>(async () => false);
  // WebUI 经 chat_queue compact_now 中继的手动压缩入口(useChatTurnQueue 消费)。
  const manualCompactActionRef = useRef<
    (request?: ManualCompactionRequest) => Promise<ManualCompactionResult>
  >(async () => ({ status: "skipped" }));
  const ensureGatewayBridgeConversationReadyRef = useRef<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >(async (id) => id.trim());
  const stopSendingActionRef = useRef<() => void>(() => undefined);
  const stopConversationActionRef = useRef<(conversationId: string) => void>(() => undefined);
  const {
    liveTranscriptStore,
    getConversationLiveTranscriptStore,
    getCompactionController,
    deleteConversationArtifacts,
    clearAbortSnapshot,
    captureAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    settleLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
  } = useLiveTranscriptController({
    currentConversationId,
  });
  // Persisted transcript rows provide stable historical content; the synthetic live assistant
  // supplies current streaming text/thinking/tool payloads until the final history write lands.
  const trajectoryPersistedMessages = useMemo(
    () => toTrajectoryMessages(transcriptItems),
    [transcriptItems],
  );
  const trajectoryLiveTranscriptSnapshot = useSyncExternalStore(
    (listener) => liveTranscriptStore.subscribe(listener),
    () => liveTranscriptStore.getSnapshot(),
  );
  const trajectoryLiveAssistantMessage = useMemo(
    () =>
      toTrajectoryLiveAssistantMessage(
        trajectoryLiveTranscriptSnapshot,
        `trajectory-live-${currentConversationId}`,
      ),
    [currentConversationId, trajectoryLiveTranscriptSnapshot],
  );
  const trajectoryMessages = useMemo(
    () =>
      trajectoryLiveAssistantMessage === undefined
        ? trajectoryPersistedMessages
        : [...trajectoryPersistedMessages, trajectoryLiveAssistantMessage],
    [trajectoryLiveAssistantMessage, trajectoryPersistedMessages],
  );
  const isDraftConversation = !historyItems.some((item) => item.id === currentConversationId);
  const hasConversationReply =
    !isDraftConversation && trajectoryMessages.some((message) => message.role === "assistant");
  const renderedConversationView = hasConversationReply ? activeConversationView : "conversation";
  const {
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
  } = useGatewayRunMirrorCoordinator();

  // 用量环读数：运行中直读 TokenLedger（消息落定即更新，不逐帧估算流式
  // 文本，优先级与理由见 useContextUsageTokensSource 内注释）；账本无读数
  // 或空闲时用与 WebUI 同源的 deriveContextUsageTokens 倒扫历史项（运行中
  // 补上 live 尾部）。经订阅源直达环组件，读数变化只重渲染环本身而不回流
  // ChatPage。
  const contextUsageRingRunning = isSending || compactionStatus.phase === "running";
  const contextUsageTokensSource = useContextUsageTokensSource({
    isRunning: contextUsageRingRunning,
    conversationId: currentConversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  });
  const {
    currentConversationIdRef,
    conversationRuntimeRegistry,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    isConversationRunning,
    setConversationAbortController,
    getConversationAbortController,
    requestConversationStop,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    setConversationRunningState,
    setConversationStopHandler,
    clearConversationStopHandler,
    requestActiveConversationStop,
    setConversationSendingState,
  } = useChatPageRuntimeStore({
    initialConversation: initialConversationRef.current,
    initialConversationState: initialConversationStateRef.current,
    currentConversationId,
    conversationState,
    compactionStatus,
    isSending,
    errorMessage,
    hookWarning,
    setConversationState,
    setCompactionStatus,
    setIsSending,
    setErrorMessage,
    setHookWarning,
    setRunningConversationIds,
  });
  // Registry-derived "current conversation" metadata: the runtime entry is
  // the single writer target, so these follow per-conversation updates (model
  // selection, gateway installs) without a mirrored page-level slot.
  const currentConversationRuntimeEntrySnapshot = useConversationRuntimeEntrySnapshot(
    conversationRuntimeRegistry,
    currentConversationId,
  );
  const currentConversationSessionId =
    currentConversationRuntimeEntrySnapshot?.sessionId ?? currentConversationId;
  const currentConversationCreatedAt =
    currentConversationRuntimeEntrySnapshot?.createdAt ?? initialConversationRef.current.createdAt;
  const currentConversationSelectedModel = currentConversationRuntimeEntrySnapshot?.selectedModel;
  // Reactive read of the *current* conversation's hydration phase. Hydration
  // itself is bucketed per conversation in the registry (two panes hydrating
  // at once never clobber each other); this is only the page-level view.
  const currentConversationHydrationPhase = useConversationHydrationPhase(
    conversationRuntimeRegistry.hydration,
    currentConversationId,
  );
  const handleLoadEarlierHistory = useCallback(
    () => loadEarlierHistoryActionRef.current(currentConversationIdRef.current),
    [currentConversationIdRef],
  );

  const {
    modelOptions,
    activeSelectedModel,
    selectedValue,
    hasModels,
    currentModelLabel,
    currentModelContextWindow,
    handleSelectModel,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    chatRuntimeControlsForCurrentProvider,
    handleChatRuntimeControlsChange,
  } = useChatModelSelection({
    settings,
    setSettings,
    t,
    sidebarStore,
    sidebarConversationsById,
    currentConversationId,
    currentConversationSelectedModel,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    updateConversationRuntimeEntry,
  });

  const projectToolTextGenerationClient = useProjectToolTextGenerationClient({
    settings,
    conversationRuntimeCacheRef,
    currentConversationIdRef,
    currentConversationSessionId,
  });

  function cancelConversationLoad() {
    conversationLoadSequenceRef.current += 1;
    // The sequence bump invalidated every in-flight load, so no bucket may
    // stay "hydrating". Failure marks stay: they describe a conversation that
    // truly failed and are cleared per-id by that conversation's retry.
    conversationRuntimeRegistry.hydration.clearAllHydrating();
  }

  const currentConversationPersistedCwd =
    historyItems.find((item) => item.id === currentConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationRuntimeCacheRef.current.get(currentConversationId)?.workdir?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (isAgentMode ? activeWorkspaceProjectPath || workdir : "");
  const activeWorkspaceResources = useMemo(
    () => resolveWorkspaceResources(settings, displayedConversationWorkdir),
    [displayedConversationWorkdir, settings],
  );
  const skillsEnabled = activeWorkspaceResources.skillsEnabled && isAgentMode;
  const selectedSkillNames = useMemo(
    () => (skillsEnabled ? activeWorkspaceResources.skillNames : []),
    [activeWorkspaceResources.skillNames, skillsEnabled],
  );
  const { enabledComposerSkills, codeReviewSkill } = useComposerSkillSelection(
    availableSkills,
    selectedSkillNames,
    skillsEnabled,
  );
  const mentionApps = useMentionApps(activeWorkspaceResources.mcpServers, isAgentMode);
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  const {
    terminalSessions,
    setTerminalSessions,
    terminalSessionsLoaded,
    handleRightDockSessionsChange,
    verifyTerminalSessionAlive,
  } = useProjectTerminals({
    terminalProjectPathKey,
    requestConfirmDialog,
    t,
    setErrorMessage,
  });
  // 被工作台 Pane 租用的会话从 Right Dock 的终端 tab 中隐藏(终端任一时刻只
  // 出现在一个宿主里);Pane 关闭(Detach)释放租约后自动回归 dock。SSH overlay
  // 的 shell tab 仍用该集合做视口占位互斥。
  const leasedTerminalSessionIds = useSyncExternalStore(
    terminalPaneLease.subscribe,
    terminalPaneLease.leasedSessionIds,
  );
  const leasedDockSessionIds = useMemo(
    () => (leasedTerminalSessionIds.length > 0 ? new Set(leasedTerminalSessionIds) : undefined),
    [leasedTerminalSessionIds],
  );
  // 顶栏 dock 折叠按钮的计数徽标:只数还留在 dock 里的会话。拖入画板的
  // 终端已在画板可见,徽标再计入会与 dock 内 tab 数对不上。
  const projectTerminalSessions = useMemo(
    () =>
      terminalProjectPathKey
        ? terminalSessions.filter(
            (session) =>
              terminalSessionBelongsToProject(session, terminalProjectPathKey) &&
              !leasedDockSessionIds?.has(session.id),
          )
        : [],
    [leasedDockSessionIds, terminalProjectPathKey, terminalSessions],
  );
  const terminalSessionsRef = useRef(terminalSessions);
  terminalSessionsRef.current = terminalSessions;
  const {
    rightDockProjectState,
    rightDockFileTreeState,
    rightDockFileTreeOpen,
    associatedSshHostIds,
    handleChatTranscriptWidthChange,
    handleRightDockWidthChange,
    handleRightDockProjectStateChange,
    handleRightDockFileTreeStateChange,
    handleSshProjectHostIdsChange,
  } = useRightDockSettings({ settings, setSettings, terminalProjectPathKey });
  const terminalDisabledMessage = !isAgentMode
    ? "Project tools require Agent project mode."
    : !terminalProjectPath
      ? "Select a project to use project tools."
      : undefined;
  const tunnelEnabled = settings.remote.enableWebTunnels === true;
  const tunnelDisabledMessage = !settings.remote.enableWebTunnels
    ? t("projectTools.tunnelWebDisabled")
    : undefined;
  const {
    isSuggestionTyping,
    handleRightDockInsertFileMention,
    handleRightDockInsertCommitMention,
    handleRightDockInsertGitFileMention,
    handleInsertCodeMention,
    handleEmptyStateSuggestion,
  } = useComposerActions(composerRef);
  const handleRightDockInsertCodeReviewSkill = useInsertCodeReviewSkill({
    composerRef,
    codeReviewSkill,
    setSettings,
  });
  const workspaceOverlays = useWorkspaceOverlays({
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
  });
  const {
    handleOpenWorkspaceFile,
    handleOpenSshTerminal,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
  } = workspaceOverlays;
  const {
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleChangedFileReveal,
    changedFilesActions,
  } = useChangedFilesActions({
    terminalProjectPathKey,
    setRightDockOpen,
    setSettings,
    onOpenFile: handleOpenWorkspaceFile,
  });
  // Local runner running-state → sidebar store: diff transitions so sidebar
  // dots (and running workdir keys) include local runs immediately; remote
  // runs arrive through the store's own event subscription.
  const previousSidebarRunningPatchIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const previous = previousSidebarRunningPatchIdsRef.current;
    previousSidebarRunningPatchIdsRef.current = runningConversationIds;
    for (const conversationId of runningConversationIds) {
      if (!previous.has(conversationId)) {
        sidebarStore.applyRunningPatch({
          conversationId,
          running: true,
          workdir: conversationRuntimeCacheRef.current.get(conversationId)?.workdir,
        });
      }
    }
    for (const conversationId of previous) {
      if (!runningConversationIds.has(conversationId)) {
        sidebarStore.applyRunningPatch({ conversationId, running: false });
      }
    }
  }, [conversationRuntimeCacheRef, runningConversationIds, sidebarStore]);

  const { notifyItems, addNotify, dismissNotify } = useNotifyToasts({
    errorMessage,
    hookWarning,
    compactionStatus,
  });

  const notifyChatFileLinkError = useCallback(
    (message: string) => addNotify("error", message),
    [addNotify],
  );
  // 语音输入失败（麦克风不可用等）以 toast 提示，不占用输入框区域。
  const handleSttError = useCallback((message: string) => addNotify("error", message), [addNotify]);
  const handleOpenChatFileLink = useChatFileLinkNavigation({
    conversationId: currentConversationId,
    conversationWorkdir: displayedConversationWorkdir,
    terminalProjectPathKey,
    notifyError: notifyChatFileLinkError,
    onRevealInFileTree: handleChangedFileReveal,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
  });
  const trajectoryHost = useMemo(
    () => createTauriTrajectoryHost(handleOpenChatFileLink),
    [handleOpenChatFileLink],
  );

  const {
    isUploadingFiles,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    pickReadableFiles,
    importReadableFilePaths,
    importReadableFiles,
    removePendingUpload,
  } = usePendingUploads({
    isAgentMode,
    workdir: displayedConversationWorkdir,
    conversationId: currentConversationId,
    uploadStore: conversationRuntimeRegistry.uploads,
    currentConversationIdRef,
    composerRef,
    setErrorMessage,
    addNotify,
  });
  function resetVisibleTransientState(targetConversationId = currentConversationIdRef.current) {
    if (currentConversationIdRef.current !== targetConversationId) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(targetConversationId, []);
    setErrorMessage(null);
    setHookWarning(null);
    scrollFollowRef.current?.stickToBottom();
  }

  const composerDraftCacheRef = useRef(conversationRuntimeRegistry.drafts);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The optional conversation defaults to the latest id stored in the stable ref.
  const cacheActiveComposerDraft = useCallback(
    (conversationId = currentConversationIdRef.current) => {
      const key = conversationId.trim();
      const draft = composerRef.current?.getDraft();
      if (!key || !draft || draft.isEmpty || !draft.text.trim()) {
        conversationRuntimeRegistry.drafts.delete(key);
        return;
      }
      conversationRuntimeRegistry.drafts.set(key, draft);
    },
    [composerRef, conversationRuntimeRegistry],
  );
  const prepareComposerForConversationChange = useCallback(() => {
    cacheActiveComposerDraft();
  }, [cacheActiveComposerDraft]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The optional conversation defaults to the latest id stored in the stable ref.
  const clearCachedComposerDraft = useCallback(
    (conversationId = currentConversationIdRef.current) => {
      conversationRuntimeRegistry.drafts.delete(conversationId);
    },
    [conversationRuntimeRegistry],
  );
  const deleteCachedComposerDraftState = clearCachedComposerDraft;

  prepareComposerForConversationChangeActionRef.current = prepareComposerForConversationChange;

  const {
    queuedChatTurnsRef,
    queuedChatTurnEditSlotRef,
    setQueuedChatTurnsState,
    publishChatQueueSnapshots,
    collectChatQueueSnapshotConversationIds,
    stopSending,
    stopConversation,
    enqueueCurrentComposerTurn,
    enqueueComposerTurnForConversation,
    requestQueuedChatTurnProcessing,
    runQueuedTurnNow,
    moveQueuedTurnUp,
    editQueuedTurn,
    removeQueuedTurn,
    shouldQueueGatewayChatRequest,
    enqueueGatewayChatRequest,
  } = useChatTurnQueue({
    settings,
    currentConversationId,
    queueStore: conversationRuntimeRegistry.queue,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    isConversationRunning,
    runningConversationIds,
    getConversationAbortController,
    setConversationAbortController,
    setConversationSendingState,
    requestConversationStop,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    requestActiveConversationStop,
    getConversationLiveTranscriptStore,
    captureAbortSnapshot,
    updateToolStatus,
    composerRef,
    pendingUploadedFiles,
    setPendingUploadsForConversation,
    clearCachedComposerDraft,
    displayedConversationWorkdir,
    sendActionRef,
    manualCompactActionRef,
  });
  stopConversationActionRef.current = stopConversation;

  // 对话式计划审批(对齐 Codex):计划提交即终止规划 run,用户以消息或按钮
  // 回应。批准 = 关 plan 开关 + 暂存执行续轮;退回 = 反馈暂存为普通用户消息。
  // 两者都走"暂存 → run 消失后冲刷"路径:send 在会话恰在发送/加载时会拒绝
  // (返回 false),直发会静默丢消息——冲刷按结果重新暂存,直到真正发出。
  // 卡片按钮、输入框批准短语、WebUI plan_decision 三个入口共用这两条路径。
  const pendingPlanContinuationsRef = useRef(new Map<string, string>());
  const pendingPlanFeedbackRef = useRef(new Map<string, string>());
  const planDecisionSendsInFlightRef = useRef(new Set<string>());
  const planDecisionRetryCountsRef = useRef(new Map<string, number>());
  // handleSend 点击时采样(该回调刻意不依赖 settings):短语批准只在 plan 开关
  // 仍开着时生效,防止被弃置的陈旧待决计划之后被一句"好的/ok"意外复活。
  const planModeEnabledRef = useRef(false);
  planModeEnabledRef.current = settings.chatRuntimeControls.planModeEnabled === true;
  const [planContinuationVersion, setPlanContinuationVersion] = useState(0);
  useEffect(() => {
    registerPlanDecisionHandlers({
      onApprove: ({ conversationId }) => {
        setSettings((prev) =>
          prev.chatRuntimeControls.planModeEnabled
            ? {
                ...prev,
                chatRuntimeControls: { ...prev.chatRuntimeControls, planModeEnabled: false },
              }
            : prev,
        );
        pendingPlanContinuationsRef.current.set(conversationId, t("chat.planMode.executePrompt"));
        planDecisionRetryCountsRef.current.delete(conversationId);
        setPlanContinuationVersion((version) => version + 1);
      },
      onReject: ({ conversationId, feedback }) => {
        pendingPlanFeedbackRef.current.set(conversationId, feedback);
        planDecisionRetryCountsRef.current.delete(conversationId);
        setPlanContinuationVersion((version) => version + 1);
      },
    });
    return () => registerPlanDecisionHandlers(null);
  }, [setSettings, t]);
  // 冲刷暂存的计划应答消息(规划 run 已"提交即终止",但打断/排队等场景下会话
  // 可能仍在发送):
  // - 退回反馈:会话空闲即发(模型留在 plan mode 修订);
  // - 执行续轮:还需 plan 开关已关(settings 已 flush,避免续轮又被"只能收紧"
  //   合并锁回只读)。
  // send 返回 false / 抛错时重新暂存;运行集变化(run 结束)是主要重试信号,
  // 另排一次短延迟兜底 bump(覆盖 hydrating 等与运行集无关的拒绝)。兜底限次:
  // 永久性失败(会话加载失败等)不得退化成秒级重试死循环——超限后消息仍留在
  // 暂存 map,由下一次运行集变化或新应答触发再试。in-flight 集防并发重复发送。
  // biome-ignore lint/correctness/useExhaustiveDependencies: planContinuationVersion 是刻意的重跑触发器(应答写入 ref 后 bump)
  useEffect(() => {
    const scheduleFlushRetry = (conversationId: string) => {
      const attempts = planDecisionRetryCountsRef.current.get(conversationId) ?? 0;
      if (attempts >= 5) return;
      planDecisionRetryCountsRef.current.set(conversationId, attempts + 1);
      window.setTimeout(() => setPlanContinuationVersion((version) => version + 1), 1_000);
    };
    const flushPlanSends = (
      store: Map<string, string>,
      buildOverrides: (conversationId: string, text: string) => Parameters<SendChatAction>[0],
    ) => {
      for (const [conversationId, text] of store) {
        if (runningConversationIds.has(conversationId)) continue;
        if (planDecisionSendsInFlightRef.current.has(conversationId)) continue;
        planDecisionSendsInFlightRef.current.add(conversationId);
        store.delete(conversationId);
        void sendActionRef
          .current(buildOverrides(conversationId, text))
          .then((accepted) => {
            // 竞态失败(会话恰在发送/加载)时重新暂存并排一次兜底重试;期间若
            // 有更新的同会话应答入了 map,保留新值。
            if (accepted) {
              planDecisionRetryCountsRef.current.delete(conversationId);
            } else if (!store.has(conversationId)) {
              store.set(conversationId, text);
              scheduleFlushRetry(conversationId);
            }
          })
          .catch((error) => {
            console.warn("plan decision message send failed", error);
            if (!store.has(conversationId)) {
              store.set(conversationId, text);
              scheduleFlushRetry(conversationId);
            }
          })
          .finally(() => {
            planDecisionSendsInFlightRef.current.delete(conversationId);
          });
      }
    };
    flushPlanSends(pendingPlanFeedbackRef.current, (conversationId, feedback) => ({
      conversationIdOverride: conversationId,
      textOverride: feedback,
      preserveComposerOnStart: true,
    }));
    if (settings.chatRuntimeControls.planModeEnabled) return;
    flushPlanSends(pendingPlanContinuationsRef.current, (conversationId, prompt) => ({
      conversationIdOverride: conversationId,
      textOverride: prompt,
      preserveComposerOnStart: true,
      runtimeControlsOverride: {
        ...settings.chatRuntimeControls,
        planModeEnabled: false,
      },
    }));
  }, [planContinuationVersion, runningConversationIds, settings.chatRuntimeControls]);

  // Queue snapshots publish on queue mutation only; after a gateway
  // reconnect (new session) the gateway's in-memory queue view is empty, so
  // republish the current queue for every conversation that has one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection identity intentionally drives the republish
  useEffect(() => {
    if (!canShareHistory) {
      return;
    }
    publishChatQueueSnapshots(
      collectChatQueueSnapshotConversationIds(queuedChatTurnsRef.current, [
        currentConversationIdRef.current,
      ]),
    );
  }, [canShareHistory, remoteRuntimeStatus.connectedSince, remoteRuntimeStatus.sessionId]);

  const deleteConversationLocalCaches = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      if (!key) return;
      deleteCachedComposerDraftState(key);
      locallySyncedHistoryUpdatedAtRef.current.delete(key);
      gatewayBridgeHistorySummaryRef.current.delete(key);
      setPendingUploadsForConversation(key, []);
      memoryExtraction.dispose(key);
      memoryTurnInjection.dispose(key);
      skillMentionInjection.dispose(key);
      deleteConversationArtifacts(key);
      setQueuedChatTurnsState((current) => removeQueuedChatTurnsForConversation(current, key));
    },
    [
      deleteCachedComposerDraftState,
      deleteConversationArtifacts,
      setPendingUploadsForConversation,
      setQueuedChatTurnsState,
    ],
  );

  // 会话瞬态交互的统一 prune 清理:本页与 useConversationHistoryActions 两条
  // prune 路径共用,保证生命周期裁决一致。计划审批刻意不在此列——待决计划的
  // 设计就是跨 run 存活(规划 run 提交即终止),空闲运行时缓存被逐出不等于会话
  // 销毁,回到会话后卡片必须仍可批准;真正删除会话时才连批准态一起清(见
  // handleConversationDeleted)。MCP 激活集清了只损失一次重新检索,可清。
  const cancelConversationTransientInteractions = useCallback((conversationId: string) => {
    cancelPendingAskUserQuestionsForConversation(conversationId);
    cancelPendingToolApprovalsForConversation(conversationId);
    clearMcpToolActivation(conversationId);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Queue and runtime maps are mutable registries intentionally sampled at prune time through refs.
  const pruneIdleConversationCaches = useCallback(
    (extraKeepIds: Iterable<string> = []) => {
      const queuedConversationIds = getQueuedConversationIds(queuedChatTurnsRef.current);
      pruneIdleConversationRuntimeCaches({
        runtimeCache: conversationRuntimeCacheRef.current,
        persistenceCursors: conversationPersistenceCursorRef.current,
        keepConversationIds: [
          currentConversationIdRef.current,
          ...extraKeepIds,
          ...queuedConversationIds,
        ],
        isConversationRunning,
        onPruneConversation: (conversationId) => {
          deleteConversationLocalCaches(conversationId);
          subagentStoresRef.current.dispose(conversationId);
          cancelConversationTransientInteractions(conversationId);
        },
      });
    },
    [
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      deleteConversationLocalCaches,
      isConversationRunning,
      conversationPersistenceCursorRef,
      cancelConversationTransientInteractions,
    ],
  );

  const markLocalHistorySnapshotSynced = useCallback(
    (conversationId: string, updatedAt: number) => {
      const key = conversationId.trim();
      if (!key) {
        return;
      }
      if (updatedAt < 0) {
        locallySyncedHistoryUpdatedAtRef.current.delete(key);
        if (currentConversationIdRef.current === key) {
          const currentItem = sidebarStore.peek(key);
          currentConversationHistoryUpdatedAtRef.current =
            currentItem && !currentItem.isPending ? currentItem.updatedAt : null;
        }
        return;
      }
      const previous = locallySyncedHistoryUpdatedAtRef.current.get(key);
      if (previous === undefined || previous === Number.MAX_SAFE_INTEGER || updatedAt > previous) {
        locallySyncedHistoryUpdatedAtRef.current.set(key, updatedAt);
      }
      if (currentConversationIdRef.current === key) {
        const currentSyncedAt = currentConversationHistoryUpdatedAtRef.current ?? 0;
        currentConversationHistoryUpdatedAtRef.current =
          currentSyncedAt === Number.MAX_SAFE_INTEGER || updatedAt === Number.MAX_SAFE_INTEGER
            ? updatedAt
            : Math.max(currentSyncedAt, updatedAt);
      }
    },
    [currentConversationIdRef, sidebarStore],
  );

  const {
    startNewConversation,
    openInitial: openConversationInitial,
    hydrateInBackground: hydrateConversationInBackground,
    loadEarlier: loadEarlierConversationHistory,
    replaceConversationAtMessage,
    cleanupDeletedConversation,
    persistConversation,
  } = useConversationHistoryActions({
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    markLocalHistorySnapshotSynced,
    isConversationRunning,
    conversationLoadSequenceRef,
    sidebarStore,
    titleJobRef,
    t,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    cancelConversationLoad,
    resetVisibleTransientState,
    deleteConversationArtifacts: deleteConversationLocalCaches,
    disposeSubagentsForConversation: (conversationId) => {
      subagentStoresRef.current.dispose(conversationId);
    },
    cancelConversationTransientInteractions,
    cancelPlanDecisionsForConversation: (conversationId) => {
      pendingPlanContinuationsRef.current.delete(conversationId);
      pendingPlanFeedbackRef.current.delete(conversationId);
      planDecisionRetryCountsRef.current.delete(conversationId);
      cancelPendingPlanDecisionsForConversation(conversationId);
    },
    getDefaultNewConversationWorkdir: () =>
      isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    resolveConversationSelectedModel: (json) =>
      normalizeSelectedModelForProviders(parseSelectedModelJson(json), settings.customProviders),
    setCurrentConversationId,
    setErrorMessage,
    hydration: conversationRuntimeRegistry.hydration,
  });

  startNewConversationActionRef.current = startNewConversation;
  openInitialActionRef.current = openConversationInitial;
  hydrateConversationActionRef.current = hydrateConversationInBackground;
  loadEarlierHistoryActionRef.current = loadEarlierConversationHistory;
  cleanupDeletedConversationActionRef.current = cleanupDeletedConversation;

  const {
    handleRemoveWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  } = useWorkspaceProjectRemoval({
    settings,
    setSettings,
    t,
    requestConfirmDialog,
    setErrorMessage,
    sidebarStore,
    workspaceProjects,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activateWorkspaceProject,
    setActiveWorkspaceProjectId,
    terminalProjectPathKey,
    setTerminalSessions,
    setRightDockOpen,
    displayedConversationWorkdir,
    startNewConversationActionRef,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Runtime and persistence registries are intentionally sampled through refs when the visible workspace inputs change.
  useEffect(() => {
    const nextWorkdir = activeWorkspaceProjectPath.trim();
    if (!isAgentMode || !nextWorkdir) {
      return;
    }
    const conversationId = currentConversationIdRef.current.trim();
    if (!conversationId || isSending || isConversationRunning(conversationId)) {
      return;
    }
    if (conversationState.meta.totalMessageCount > 0 || pendingUploadedFiles.length > 0) {
      return;
    }
    if (conversationPersistenceCursorRef.current.has(conversationId)) {
      return;
    }
    const historyItem = sidebarStore.peek(conversationId);
    if (historyItem && !historyItem.isPending) {
      return;
    }
    const currentWorkdir =
      conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
    if (currentWorkdir === nextWorkdir) {
      return;
    }
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      workdir: nextWorkdir,
    }));
  }, [
    activeWorkspaceProjectPath,
    conversationState.meta.totalMessageCount,
    isAgentMode,
    isConversationRunning,
    isSending,
    pendingUploadedFiles.length,
    sidebarStore,
    updateConversationRuntimeEntry,
  ]);

  const handleConversationCwdChanged = useCallback(
    (conversationId: string, cwd: string) => {
      syncMovedConversationRuntimeWorkdir({
        conversationId,
        cwd,
        runtimeCache: conversationRuntimeCacheRef.current,
        isConversationRunning,
        updateConversationRuntimeEntry,
      });
    },
    [conversationRuntimeCacheRef, isConversationRunning, updateConversationRuntimeEntry],
  );

  useEffect(() => {
    const previous = previousSubagentRuntimeConversationRef.current;
    if (previous && previous !== currentConversationId) {
      subagentStoresRef.current.dispose(previous);
    }
    previousSubagentRuntimeConversationRef.current = currentConversationId;

    const currentHistoryItem = historyItems.find(
      (item) => item.id === currentConversationId && !item.isPending,
    );
    if (!currentConversationId || !currentHistoryItem) return;

    const agentSignature = settings.agents
      .map((template) => `${template.id}:${template.name}:${template.prompt.length}`)
      .join("|");
    const warmupSignature = `${currentConversationId}:${currentHistoryItem.updatedAt}:${agentSignature}`;
    if (subagentWarmupSignatureRef.current === warmupSignature) return;
    subagentWarmupSignatureRef.current = warmupSignature;
    subagentStoresRef.current.warmup(currentConversationId);
  }, [currentConversationId, historyItems, settings.agents]);

  useEffect(
    () => () => {
      subagentStoresRef.current.disposeAll();
    },
    [],
  );

  const { ensureGatewayBridgeConversationReady } = useGatewayBridgeReadiness({
    settings,
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    syncVisibleConversationRuntime,
    isConversationRunning,
    sidebarStore,
    gatewayBridgeHistorySummaryRef,
    hydration: conversationRuntimeRegistry.hydration,
  });

  ensureGatewayBridgeConversationReadyRef.current = ensureGatewayBridgeConversationReady;

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
    // Per-conversation pending uploads are restored inside usePendingUploads
    // when its conversationId param changes.
  }, [currentConversationId, currentConversationIdRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The runtime cache is a mutable registry sampled when the visible conversation summary inputs change.
  useEffect(() => {
    const currentItem = historyItems.find((item) => item.id === currentConversationId);
    if (currentItem) {
      return;
    }

    if (!currentConversationId || (!isSending && !isConversationRunning(currentConversationId))) {
      return;
    }

    const runtimeEntry = conversationRuntimeCacheRef.current.get(currentConversationId);
    const currentState = runtimeEntry?.state ?? conversationState;
    const fallbackTitle = buildFallbackConversationTitle(
      getFirstUserMessageText(buildRequestContext(currentState)),
    );
    const providerId =
      activeSelectedModel?.customProviderId ??
      sidebarStore.peek(currentConversationId)?.providerId ??
      "pending";
    const model =
      activeSelectedModel?.model ?? sidebarStore.peek(currentConversationId)?.model ?? "pending";

    const pendingConversationTitle = t("chat.pendingTitle");
    const pendingItem = createPendingHistoryItem({
      conversationId: currentConversationId,
      title:
        fallbackTitle && fallbackTitle !== pendingConversationTitle
          ? fallbackTitle
          : pendingConversationTitle,
      providerId,
      model,
      sessionId: currentConversationSessionId,
      cwd: displayedConversationWorkdir || undefined,
      createdAt: currentConversationCreatedAt,
      updatedAt: Date.now(),
    });
    // 会话不属于当前工作区作用域时（例如流式进行中切换了工作区），不往
    // 侧栏强插 pending 行：它本就不该出现在新工作区的列表里，反复重插
    // 会与作用域过滤互相打架，形成无限更新循环导致页面崩溃。
    if (!conversationMatchesScope(pendingItem, sidebarScope)) {
      return;
    }
    sidebarStore.upsertLocal(pendingItem);
  }, [
    conversationState,
    currentConversationCreatedAt,
    currentConversationId,
    currentConversationSessionId,
    historyItems,
    isConversationRunning,
    isSending,
    activeSelectedModel,
    displayedConversationWorkdir,
    sidebarScope,
    sidebarStore,
    t,
  ]);

  useEffect(() => {
    const currentItem = sidebarStore.peek(currentConversationId);
    currentConversationHistoryUpdatedAtRef.current =
      currentItem && !currentItem.isPending ? currentItem.updatedAt : null;
  }, [currentConversationId, sidebarStore]);

  useEffect(() => {
    const previousIds = previousHistoryIdsRef.current;
    const nextIds = new Set(historyItems.map((item) => item.id));
    if (previousHistoryScopeKeyRef.current !== historyScopeKey) {
      previousHistoryIdsRef.current = nextIds;
      previousHistoryScopeKeyRef.current = historyScopeKey;
      return;
    }
    const currentConversationWasPersisted = previousIds.has(currentConversationId);
    const currentConversationExists = nextIds.has(currentConversationId);

    if (
      currentConversationId &&
      currentConversationWasPersisted &&
      !currentConversationExists &&
      !isSending
    ) {
      startNewConversationActionRef.current();
    }

    previousHistoryIdsRef.current = nextIds;
  }, [currentConversationId, historyItems, historyScopeKey, isSending]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Composer content is sampled through its ref; the effect is driven by persisted snapshot changes and run state.
  useEffect(() => {
    const currentItem = historyItems.find((item) => item.id === currentConversationId);
    if (!currentItem || currentItem.isPending) {
      return;
    }

    const lastSyncedUpdatedAt = currentConversationHistoryUpdatedAtRef.current;
    const isFirstPersistedSnapshot = lastSyncedUpdatedAt === null;
    if (!isFirstPersistedSnapshot && currentItem.updatedAt <= lastSyncedUpdatedAt) {
      return;
    }

    if (
      isSending ||
      isConversationRunning(currentConversationId) ||
      currentConversationHydrationPhase !== null ||
      composerBusyRef.current ||
      pendingUploadedFiles.length > 0
    ) {
      return;
    }

    if (composerRef.current?.hasContent()) {
      return;
    }

    currentConversationHistoryUpdatedAtRef.current = currentItem.updatedAt;
    openController.open(currentConversationId);
  }, [
    currentConversationId,
    currentConversationHydrationPhase,
    historyItems,
    isConversationRunning,
    isSending,
    openController,
    pendingUploadedFiles,
  ]);

  useEffect(() => {
    setContext(currentRequestContext);
  }, [currentRequestContext, setContext]);

  useGatewayBridgeListeners({
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    ensureGatewayBridgeConversationReadyRef,
    sendActionRef,
    queueGatewayBridgeEventForRequest,
    shouldQueueGatewayChatRequest,
    enqueueGatewayChatRequest,
    isConversationRunning,
    getConversationAbortController,
    requestConversationStop,
    requestActiveConversationStop,
    consumeConversationStop,
  });

  const { send } = useSendChatTurn({
    settings,
    workspaceProjects,
    setSettings,
    getMcpSettings,
    getToolPolicies,
    t,
    setErrorMessage,
    sidebarStore,
    titleJobRef,
    chatRuntimeHost,
    subagentStoresRef,
    scrollFollowRef,
    composerRef,
    composerDraftCacheRef,
    clearCachedComposerDraft,
    resetVisibleTransientState,
    isImportingPastedTextRef,
    setIsImportingPastedText,
    hydration: conversationRuntimeRegistry.hydration,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    updateConversationRuntimeEntry,
    setConversationAbortController,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    setConversationStopHandler,
    clearConversationStopHandler,
    setConversationSendingState,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    getConversationLiveTranscriptStore,
    getCompactionController,
    clearAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    settleLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
    gatewayBridgeHistorySummaryRef,
    availableSkills,
    skillsRootDir,
    refreshSkills,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    persistConversation,
    replaceConversationAtMessage,
    pruneIdleConversationCaches,
    requestQueuedChatTurnProcessing,
  });

  sendActionRef.current = send;
  stopSendingActionRef.current = stopSending;

  // 手动压缩的同源提示词构建：当前会话据其工作区解析 skills/memory 提示词，
  // 与发送链路的 buildPreparedContext 同源（activeAgentPrompt 单独直传）。手动
  // 压缩无触发消息，skills 的 explicit 提及为空。跨会话中继的后台会话在此层拿
  // 不到工作区上下文，返回空提示词（当前会话必须同源，后台保持现状）。
  const resolveManualCompactionPromptInputs = useCallback(
    async (input: { isCurrentConversation: boolean; workdir?: string }) => {
      if (!input.isCurrentConversation) {
        return { activeAgentPrompt, skillsPrompt: "", memoryPrompt: "" };
      }
      const promptWorkdir = input.workdir?.trim() ?? "";
      const effectivePrompt = resolveEffectivePromptSettings(settings, promptWorkdir).prompt;
      const resources = resolveWorkspaceResources(settings, promptWorkdir);
      let skillsPrompt = "";
      if (resources.skillsEnabled && isAgentMode && resources.skillNames.length > 0) {
        const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
        const selectedSkills = resources.skillNames
          .map((name) => byName.get(name))
          .filter((skill): skill is SkillSummary => Boolean(skill));
        if (selectedSkills.length > 0) {
          skillsPrompt = buildSkillsSystemPrompt({
            rootDir: skillsRootDir,
            selected: selectedSkills,
          });
        }
      }
      let memoryPrompt = "";
      if (promptWorkdir) {
        try {
          memoryPrompt = await buildMemoryOverviewSection(promptWorkdir);
        } catch (error) {
          console.warn("Failed to build manual compaction memory prompt", error);
          memoryPrompt = "";
        }
      }
      return { activeAgentPrompt: effectivePrompt, skillsPrompt, memoryPrompt };
    },
    [activeAgentPrompt, availableSkills, isAgentMode, settings, skillsRootDir],
  );

  const handleManualCompact = useManualCompaction({
    settings,
    t,
    currentConversationIdRef,
    isConversationRunning,
    setConversationRunningState,
    setConversationAbortController,
    setConversationStopHandler,
    clearConversationStopHandler,
    consumeConversationStop,
    buildRuntimeEntryFromVisibleState,
    conversationRuntimeCacheRef,
    ensureConversationReady: ensureGatewayBridgeConversationReady,
    getCompactionController,
    getConversationLiveTranscriptStore,
    updateConversationRuntimeEntry,
    resetLiveTranscript,
    updateToolStatus,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
    persistConversation,
    setErrorMessage,
    resolveManualCompactionPromptInputs,
  });
  manualCompactActionRef.current = handleManualCompact;
  const conversationSurfaceProject = useMemo(
    () => ({
      projectId: activeWorkspaceProject?.id ?? `conversation:${currentConversationId}`,
      projectPathKey: displayedConversationWorkdir || `conversation:${currentConversationId}`,
    }),
    [activeWorkspaceProject?.id, currentConversationId, displayedConversationWorkdir],
  );
  // Shared by the current-conversation controller and every background pane
  // controller: all actions route by explicit conversationId through refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Controller methods deliberately route through latest-action refs; the runtime registry itself is stable for the page lifetime.
  const conversationControllerActions = useMemo<ConversationControllerActions>(
    () => ({
      async hydrate({ conversationId }) {
        if (conversationId === currentConversationIdRef.current) {
          await openInitialActionRef.current(conversationId);
        } else {
          await hydrateConversationActionRef.current(conversationId);
        }
      },
      async send({ conversationId, draft }) {
        // Uploads must come from the target conversation's own store — the
        // page-level pending list belongs to the focused conversation and
        // would cross-attach on a background send.
        const uploads = conversationRuntimeRegistry.uploads.getSnapshot(conversationId).slice();
        const accepted = await sendActionRef.current({
          conversationIdOverride: conversationId,
          composerDraftOverride: draft,
          uploadedFilesOverride: uploads,
        });
        if (accepted) {
          conversationRuntimeRegistry.uploads.set(conversationId, []);
        }
      },
      stop({ conversationId }) {
        stopConversationActionRef.current(conversationId);
      },
      async compact({ conversationId }) {
        await manualCompactActionRef.current({ conversationId });
      },
      async retry({ conversationId }) {
        if (conversationId === currentConversationIdRef.current) {
          await openInitialActionRef.current(conversationId);
        } else {
          await hydrateConversationActionRef.current(conversationId);
        }
      },
    }),
    [],
  );
  const conversationSurfaceController = useMemo(
    () =>
      createConversationSurfaceController({
        conversationId: currentConversationId,
        project: conversationSurfaceProject,
        registry: conversationRuntimeRegistry,
        actions: conversationControllerActions,
      }),
    [
      conversationControllerActions,
      conversationRuntimeRegistry,
      conversationSurfaceProject,
      currentConversationId,
    ],
  );
  useEffect(
    () => () => {
      conversationSurfaceController.dispose();
    },
    [conversationSurfaceController],
  );

  const handleSelectExecutionMode = useCallback(
    (mode: "text" | "tools") =>
      setSettings((prev) => updateExecutionModeFromChatSelection(prev, mode)),
    [setSettings],
  );

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleNewConversation = useCallback(() => {
    openController.cancel();
    prepareComposerForConversationChange();
    startNewConversationActionRef.current({
      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    });
  }, [
    activeWorkspaceProjectPath,
    isAgentMode,
    openController,
    prepareComposerForConversationChange,
  ]);

  // 动作总线（Rust `app:action`）里 ChatPage 拥有的动作在下方统一监听
  // （handleSelectConversation 定义之后）；这里先备好 ref 镜像。
  const handleNewConversationRef = useRef(handleNewConversation);
  handleNewConversationRef.current = handleNewConversation;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const isDraftConversationRef = useRef(isDraftConversation);
  isDraftConversationRef.current = isDraftConversation;

  const handleSelectConversation = useCallback(
    (id: string) => {
      const targetConversationId = id.trim();
      if (!targetConversationId) {
        return;
      }
      prepareComposerForConversationChange();
      openController.open(targetConversationId);
    },
    [openController, prepareComposerForConversationChange],
  );

  // 托盘/快捷键动作参数的 ref 镜像：监听 effect 是 []-dep，闭包内一律
  // 经 ref 取最新值（handleSelectWorkspaceProject 等依赖 settings，不稳定）。
  const sidebarRunningConversationIds = useSidebarSelector(
    sidebarStore,
    selectRunningConversationIds,
  );
  useEffect(() => {
    onRunningConversationCountChange?.(sidebarRunningConversationIds.size);
  }, [onRunningConversationCountChange, sidebarRunningConversationIds.size]);
  useEffect(
    () => () => {
      onRunningConversationCountChange?.(0);
    },
    [onRunningConversationCountChange],
  );
  const appActionParamsRef = useRef({
    handleSelectConversation,
    handleSelectWorkspaceProject,
    stopConversation,
    consumeConversationStop,
    isConversationRunning,
    workspaceProjects,
    sidebarRunningConversationIds,
    addNotify,
    t,
  });
  appActionParamsRef.current = {
    handleSelectConversation,
    handleSelectWorkspaceProject,
    stopConversation,
    consumeConversationStop,
    isConversationRunning,
    workspaceProjects,
    sidebarRunningConversationIds,
    addNotify,
    t,
  };

  useEffect(() => {
    // 单个会话的停止：完整序列在 stopConversation（stop intent + 队列取消 +
    // abort + force 清理）。未停到任何东西且会话未运行时必须消费掉 stop
    // intent，否则该会话下一次 send 会被静默吞掉（同 gateway:chat-cancel 守卫）。
    const stopConversationRun = (conversationId: string) => {
      const params = appActionParamsRef.current;
      const stopped = params.stopConversation(conversationId);
      if (!stopped && !params.isConversationRunning(conversationId)) {
        params.consumeConversationStop(conversationId);
      }
    };

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let unlistenFeedback: (() => void) | null = null;

    // Rust 直连动作的结果反馈（目前只有托盘的 cron 启用开关）：toast 呈现，
    // 任务名从 automation store 现查（可能已被删除，回退显示 id）。
    // 勾选态本身经 automation:cron-changed → store → 托盘同步 effect 刷新。
    listen<{ action: string; id?: string; ok: boolean; error?: string; value?: string }>(
      "app:action-feedback",
      (event) => {
        const params = appActionParamsRef.current;
        if (event.payload.action !== "toggle-cron-task") {
          return;
        }
        const taskId = event.payload.id ?? "";
        const task = getAutomationState().cron.tasks.find((entry) => entry.id === taskId);
        const name = task?.name.trim() || taskId;
        if (event.payload.ok) {
          const messageKey =
            event.payload.value === "enabled" ? "tray.cronEnabled" : "tray.cronDisabled";
          params.addNotify("success", params.t(messageKey).replace("{name}", name));
        } else {
          params.addNotify(
            "error",
            params
              .t("tray.cronToggleFailed")
              .replace("{name}", name)
              .replace("{error}", event.payload.error ?? ""),
          );
        }
      },
    )
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlistenFeedback = nextUnlisten;
      })
      .catch(() => {
        // 非 Tauri 环境忽略。
      });

    listen<{ action: string; id?: string; value?: string }>("app:action", (event) => {
      const params = appActionParamsRef.current;
      switch (event.payload.action) {
        case "new-chat": {
          const wasInHub = activeViewRef.current !== "chat";
          setActiveView("chat");
          // 与侧栏"新建对话"一致：从 Hub 返回且当前已是空白草稿会话时直接复用。
          if (!wasInHub || !isDraftConversationRef.current) {
            handleNewConversationRef.current();
          }
          // 视图与会话切换渲染完成后再聚焦输入框。
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              composerRef.current?.focus();
            });
          });
          break;
        }
        case "open-conversation": {
          const conversationId = event.payload.id?.trim();
          if (!conversationId) break;
          setActiveView("chat");
          params.handleSelectConversation(conversationId);
          break;
        }
        case "view-all-conversations": {
          setActiveView("chat");
          setSidebarOpen(true);
          break;
        }
        case "switch-workspace": {
          const projectId = event.payload.id?.trim();
          if (!projectId) break;
          const project = params.workspaceProjects.find((entry) => entry.id === projectId);
          // 菜单可能滞后于项目列表；找不到就静默忽略。
          if (project) {
            setActiveView("chat");
            void params.handleSelectWorkspaceProject(project);
          }
          break;
        }
        case "stop-run": {
          const conversationId = event.payload.id?.trim();
          if (conversationId) {
            stopConversationRun(conversationId);
          }
          break;
        }
        case "stop-all-runs": {
          for (const conversationId of params.sidebarRunningConversationIds) {
            stopConversationRun(conversationId);
          }
          break;
        }
        default:
          break;
      }
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // 非 Tauri 环境忽略。
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
      if (unlistenFeedback) {
        unlistenFeedback();
      }
    };
  }, [composerRef, setActiveView]);

  // 托盘菜单同步：任一输入变化即重建模型推送（syncTrayMenu 内部按 JSON 签名
  // 去抖），300ms 尾随防抖吸收流式期间侧栏 upsert 引起的高频变化。
  // 注：全局快捷键绑定存 localStorage 无订阅，在模型构建时现读——改绑后
  // 回显会在下一次模型级变化时跟上。
  const trayPrefs = useTrayPrefs();
  const automationState = useAutomation();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void syncTrayMenu(
        buildTrayMenuModel({
          locale: settings.locale,
          theme: settings.theme,
          conversations: historyItems,
          runningConversationIds: sidebarRunningConversationIds,
          workspaceProjects,
          activeWorkspaceProjectId: activeWorkspaceProject?.id,
          archivedWorkspaceProjectPaths: settings.system.archivedWorkspaceProjectPaths,
          cronTasks: automationState.cron.tasks,
          remote: settings.remote,
          gatewayOnline: remoteRuntimeStatus.online,
          prefs: trayPrefs,
        }),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    settings.locale,
    settings.theme,
    historyItems,
    sidebarRunningConversationIds,
    workspaceProjects,
    activeWorkspaceProject,
    settings.system.archivedWorkspaceProjectPaths,
    automationState.cron.tasks,
    settings.remote,
    remoteRuntimeStatus.online,
    trayPrefs,
  ]);

  // Called by the sidebar container after the store confirmed a deletion:
  // evict local caches, replace the visible conversation when it was the
  // deleted one, and drop the row from the shared-history list.
  const handleConversationDeleted = useCallback(
    (id: string) => {
      cleanupDeletedConversationActionRef.current(id);
      removeSharedHistoryItems([id]);
    },
    [removeSharedHistoryItems],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Runtime/edit state is intentionally sampled through refs at click time.
  const handleSend = useCallback(() => {
    const conversationId = currentConversationIdRef.current.trim();
    const runtimeEntry = conversationRuntimeCacheRef.current.get(conversationId);
    if (queuedChatTurnEditSlotRef.current?.conversationId === conversationId) {
      if (enqueueCurrentComposerTurn("edit")) {
        requestQueuedChatTurnProcessing(conversationId);
      }
      return;
    }
    // 对话式计划审批:会话有待决计划时,纯批准短语("同意/开始/ok"等)即批准
    // (等同点卡片按钮);其他输入就是普通消息(修改意见),照常发送——规划 run
    // 已结束,消息直接开启新一轮 plan mode 修订,不经队列。
    // 短语批准要求 plan 开关仍开着:正常流程中提交后开关保持开启(批准才关);
    // 用户手动关掉 pill 即视为弃置当前计划,之后的"好的/ok"是普通消息,不得
    // 把陈旧计划复活成执行续轮。显式批准仍可走卡片按钮(不受开关限制)。
    if (conversationId && planModeEnabledRef.current) {
      const pendingPlan = getPendingPlanForConversation(conversationId);
      if (pendingPlan) {
        const text = composerRef.current?.getText().trim() ?? "";
        if (text && isPlanApprovalMessage(text)) {
          const outcome = answerPlanDecision(
            pendingPlan.toolCallId,
            { decision: "approve" },
            { conversationId },
          );
          if (outcome.ok) {
            composerRef.current?.clear();
            return;
          }
        }
      }
    }
    if (conversationId && (isConversationRunning(conversationId) || runtimeEntry?.isSending)) {
      enqueueCurrentComposerTurn("end");
      return;
    }
    void sendActionRef.current();
  }, [
    composerRef,
    enqueueCurrentComposerTurn,
    isConversationRunning,
    requestQueuedChatTurnProcessing,
  ]);

  const handleComposerBusyChange = useCallback((isBusy: boolean) => {
    composerBusyRef.current = isBusy;
  }, []);

  const currentConversationWorkspaceRoot = (() => {
    const currentItem = historyItems.find((item) => item.id === currentConversationId);
    const persistedCwd = currentItem?.cwd?.trim();
    if (persistedCwd) return persistedCwd;
    return displayedConversationWorkdir || undefined;
  })();
  const isCompactionRunning = compactionStatus.phase === "running";
  const isConversationHydrating = currentConversationHydrationPhase === "hydrating";
  const isConversationHydrationFailed = currentConversationHydrationPhase === "failed";
  const composerPlaceholder = isCompactionRunning
    ? t("chat.compactingContextWait")
    : isConversationHydrating
      ? "正在加载会话，请稍候..."
      : isConversationHydrationFailed
        ? "当前会话加载失败，请重新打开会话..."
        : enabledComposerSkills.length > 0
          ? t("chat.inputHintWithSkills")
          : t("chat.inputHint");
  const isComposerInputDisabled =
    isCompactionRunning ||
    isConversationHydrating ||
    isConversationHydrationFailed ||
    isImportingPastedText ||
    isUploadingFiles;
  const canDropUpload =
    isAgentMode && Boolean(displayedConversationWorkdir.trim()) && !isComposerInputDisabled;
  const fileDropTitle = canDropUpload
    ? t("chat.upload.dropReady")
    : !isAgentMode
      ? t("chat.upload.onlyInTools")
      : !displayedConversationWorkdir.trim()
        ? t("chat.upload.requireWorkdir")
        : t("chat.upload.dropBusy");
  const fileDropDescription = canDropUpload
    ? t("chat.upload.dropHint")
    : t("chat.upload.dropDisabledHint");
  const fileDropLimitHint = t("chat.upload.dropLimit").replace("{max}", String(MAX_UPLOAD_FILES));
  const resolveNativeUploadConversationTarget = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      if (!key) return null;
      const persistedWorkdir = sidebarConversationsById.get(key)?.cwd?.trim() || "";
      const runtimeWorkdir = conversationRuntimeCacheRef.current.get(key)?.workdir?.trim() || "";
      const targetWorkdir =
        persistedWorkdir ||
        runtimeWorkdir ||
        (key === currentConversationIdRef.current ? displayedConversationWorkdir.trim() : "");
      if (!targetWorkdir) return null;
      const targetProjectPathKey = workspaceProjectPathKey(targetWorkdir);
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === targetProjectPathKey,
      );
      return { conversationId: key, workdir: targetWorkdir, project };
    },
    [
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      displayedConversationWorkdir,
      sidebarConversationsById,
      workspaceProjects,
    ],
  );
  const { importUploadZonePaths } = useUploadZoneDrop({
    isAgentMode,
    canDropUpload,
    fileDropTitle,
    activeWorkspaceProject,
    importReadableFilePaths,
    resolveConversationTarget: resolveNativeUploadConversationTarget,
    addNotify,
    setErrorMessage,
    t,
  });
  // Late-bound hover focus keeps visual feedback and keyboard context aligned.
  // The final upload owner is read directly from the composer under the drop
  // point, so routing never depends on this asynchronous focus transition.
  const workbenchNativeDropHoverRef = useRef<(point: { x: number; y: number } | null) => void>(
    () => undefined,
  );
  const { isFileDropActive, isWorkspaceFolderDropActive } = useTauriFileDrop({
    importUploadZonePaths,
    importWorkspaceFolderPaths: handleDropWorkspaceFolders,
    onDropPositionChange: useCallback(
      (point: { x: number; y: number } | null) => workbenchNativeDropHoverRef.current(point),
      [],
    ),
  });

  const { handleResendFromEdit } = useEditResend({
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    currentConversationIdRef,
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    },
    sendActionRef,
  });

  const { branchPendingMessageId, handleBranchConversation } = useBranchConversation({
    currentConversationIdRef,
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    sidebarStore,
    handleSelectConversation,
    setErrorMessage,
    t,
  });

  // 提示词澄清执行器（按会话缓存）：ChatComposerBar 是 memo 组件，runner 的
  // identity 必须跨渲染稳定。背景 Pane 的 binding 在普通函数里逐 Pane 构建
  // （Pane 数量随布局变化），不能在里面 useMemo，故用 ref 缓存 + 惰性 getter：
  // 每轮澄清调用时才解析当前设置与会话模型，中途切模型下一轮即生效。
  const clarifySettingsRef = useRef(settings);
  clarifySettingsRef.current = settings;
  const clarifyRunnersRef = useRef(new Map<string, RunClarifyTurn>());
  const getConversationClarifyRunner = useCallback(
    (conversationId: string): RunClarifyTurn => {
      let runner = clarifyRunnersRef.current.get(conversationId);
      if (!runner) {
        const resolveClarifySelection = () =>
          resolveEffectiveChatModelSelection({
            settings: clarifySettingsRef.current,
            conversationSelectedModel:
              conversationRuntimeRegistry.getSnapshot(conversationId)?.selectedModel ?? undefined,
          });
        runner = createGuiClarifyRunner(resolveClarifySelection, () => {
          const selection = resolveClarifySelection();
          return createProviderRuntimeConfig(
            selection.provider,
            selection.model,
            clarifySettingsRef.current.chatRuntimeControls,
          );
        });
        clarifyRunnersRef.current.set(conversationId, runner);
      }
      return runner;
    },
    [conversationRuntimeRegistry],
  );

  // Full-featured binding for the pane hosting the page's current
  // conversation; it is the only pane wired to page-level composer bridging,
  // uploads, native drop and usage telemetry.
  const primaryPaneBinding: ConversationPaneBinding = {
    controller: conversationSurfaceController,
    changedFilesActions,
    checkpointRewind: {
      project: activeWorkspaceProject,
      disabled: !currentConversationId || isSending,
      onRewound: (info) => {
        // 显式回退通知:让用户明确知道工作区刚被回退过。文件工具缓存
        // 无需手动失效——注册表与 fileState 每用户轮都会重建。
        //
        // 已知残留:压缩摘要里的 fileLedger 是持久化在历史里的,不随轮次
        // 重建,回退后仍会列出那些路径。账本语义是"曾被触碰的路径",不断言
        // 当前内容,所以不算失真;真正会过时的是摘要正文里模型写的完成情况,
        // 那要改写已落库的摘要才能修,不在本功能范围内。
        const notice = formatCheckpointRewoundNotification(info, locale === "zh-CN");
        addNotify(notice.level, notice.message);
      },
    },
    isConversationRunning: isConversationRunning(currentConversationId),
    fileDrop: {
      active: isFileDropActive,
      canDropUpload,
      title: fileDropTitle,
      description: fileDropDescription,
      limitHint: fileDropLimitHint,
    },
    // 每个会话独立保存视图；当前 Pane 使用页面级实时数据渲染自己的轨迹。
    trajectory: {
      active: renderedConversationView === "trajectory",
      renderContent: () => (
        <ConversationTrajectorySurface
          conversationId={currentConversationId}
          host={trajectoryHost}
          transcriptItems={transcriptItems}
          liveTranscriptStore={liveTranscriptStore}
          workdir={displayedConversationWorkdir}
          hasMoreMessages={conversationState.transcript.hasMoreBefore}
          loadEarlierMessages={handleLoadEarlierHistory}
        />
      ),
    },
    transcript: {
      workspaceRoot: currentConversationWorkspaceRoot,
      gitClient: tauriGitClient,
      hasModels,
      onLoadEarlierHistory: handleLoadEarlierHistory,
      isHistorySwitching: conversationOpenState.showOverlay,
      isAgentMode,
      showUsage: isAgentDevExecutionMode,
      usageContextWindow: currentModelContextWindow,
      liveTranscriptStore,
      contentWidth: settings.customSettings.chatTranscript.width,
      onContentWidthChange: handleChatTranscriptWidthChange,
      onOpenFileLink: handleOpenChatFileLink,
      onResendFromEdit: handleResendFromEdit,
      onBranchConversation:
        isConversationHydrating || isConversationHydrationFailed
          ? undefined
          : handleBranchConversation,
      branchPendingMessageId,
      onOpenSettings,
      onSuggestionSelect: handleEmptyStateSuggestion,
      suggestionsDisabled: isSuggestionTyping,
    },
    composer: {
      surface: "desktop",
      conversationId: currentConversationId,
      isUploadingFiles,
      isInputDisabled: isComposerInputDisabled,
      // 麦克风在开启语音输入后显示；点击设置卡片会立即切换当前供应商。
      sttSessionKey: currentConversationId,
      sttProvider: settings.stt.enabled
        ? (sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud")
        : null,
      sttProviderConfigured:
        settings.stt.providers[sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud"]
          ?.configured,
      sttTransport: desktopSttTransport,
      onSttError: handleSttError,
      inputPlaceholder: composerPlaceholder,
      workdir: displayedConversationWorkdir,
      enabledSkills: enabledComposerSkills,
      mentionApps,
      executionMode: settings.system.executionMode,
      hasModels,
      currentModelLabel,
      modelOptions,
      selectedValue,
      chatRuntimeControls: chatRuntimeControlsForCurrentProvider,
      commandSafetyMode: settings.system.commandSafetyMode,
      onCommandSafetyModeChange: (mode) =>
        setSettings((prev) =>
          prev.system.commandSafetyMode === mode
            ? prev
            : updateSystem(prev, { commandSafetyMode: mode }),
        ),
      reasoningOptions: chatRuntimeReasoningOptions,
      thinkingAlwaysOn: chatRuntimeThinkingAlwaysOn,
      contextUsageTokensSource,
      contextWindow: currentModelContextWindow,
      gitClient: tauriGitClient,
      workspaceActivityClient: tauriWorkspaceActivityClient,
      onOpenWorktree: handleOpenWorktree,
      onWorktreeRemoved: handleWorktreeRemoved,
      onSend: handleSend,
      onComposerBusyChange: handleComposerBusyChange,
      onSelectModel: handleSelectModel,
      onSelectExecutionMode: handleSelectExecutionMode,
      onOpenSettings,
      onChatRuntimeControlsChange: handleChatRuntimeControlsChange,
      onPickReadableFiles: pickReadableFiles,
      onPasteFiles: importReadableFiles,
      onLoadUploadedImagePreview: loadComposerUploadedImagePreview,
      loadHistoryPrompts: loadComposerHistoryPrompts,
      // 提示词澄清：当前会话模型跑纯文本补全；clarifyContext 只喂轻量工作区
      // 信息（分支无现成状态，留空不为此新拉 git）。
      runClarifyTurn: getConversationClarifyRunner(currentConversationId),
      clarifyContext: { workdir: displayedConversationWorkdir },
      onRemovePendingUpload: removePendingUpload,
      onRunQueuedTurnNow: runQueuedTurnNow,
      onMoveQueuedTurnUp: moveQueuedTurnUp,
      onEditQueuedTurn: editQueuedTurn,
      onRemoveQueuedTurn: removeQueuedTurn,
    },
  };

  // ---- Session workbench (flag-gated) ----
  // The window-level pane tree. Invariant: the focused pane's conversation is
  // the page's current conversation; focusing another pane routes through the
  // existing conversation-select pipeline, so hydration, drafts and model
  // state keep their legacy semantics. Unfocused panes render from the
  // per-conversation runtime cache and live transcript stores.
  const initialWorkbenchProjectRef = useRef<ProjectRef>({
    projectId: `conversation:${initialConversationRef.current.conversationId}`,
    projectPathKey: `conversation:${initialConversationRef.current.conversationId}`,
  });
  const workbenchGeometryRef = useRef<WorkbenchGeometry | null>(null);
  const handleWorkbenchGeometryChange = useCallback((geometry: WorkbenchGeometry) => {
    workbenchGeometryRef.current = geometry;
  }, []);
  // Every rejected command that failed purely for lack of room gets one
  // toast, wherever it came from — drag drop, auto-dock menu, or keyboard.
  // Other codes (stale revision, duplicate surface) are internal races the
  // user never asked for and stay silent.
  const handleWorkbenchCommandError = useCallback(
    (error: WorkbenchCommandError) => {
      if (error.code === "insufficient-space") {
        addNotify("error", t("workbench.noSpaceForSplit"));
      }
    },
    [addNotify, t],
  );
  const workbench = useWindowWorkbench({
    initialConversationId: initialConversationRef.current.conversationId,
    initialProject: initialWorkbenchProjectRef.current,
    geometryRef: workbenchGeometryRef,
    // The canvas renders 6px dividers; the geometry library's default is 8.
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
    onCommandError: handleWorkbenchCommandError,
  });

  // A pane focus/drop selects its conversation asynchronously; until the
  // selection lands, syncCurrentConversation must not rebind the focused pane
  // back to the outgoing conversation.
  const workbenchPendingSelectRef = useRef<string | null>(null);

  // Right Dock follows the focused pane's project context when the pane maps
  // to a known, non-archived, non-missing workspace project. A stale
  // ProjectRef never falls back to a different project. Resolution lives in
  // resolveWorkbenchPaneProject so the invariant is model-testable.
  const activateWorkbenchPaneProject = useCallback(
    (projectPathKey?: string) => {
      const project = resolveWorkbenchPaneProject(projectPathKey, {
        workspaceProjects,
        archivedWorkspaceProjectPathKeys,
        missingWorkspaceProjectPathKeys,
      });
      if (project) activateWorkspaceProject(project);
    },
    [
      activateWorkspaceProject,
      archivedWorkspaceProjectPathKeys,
      missingWorkspaceProjectPathKeys,
      workspaceProjects,
    ],
  );

  const selectWorkbenchConversation = useCallback(
    (conversationId: string, projectPathKey?: string) => {
      if (conversationId !== currentConversationIdRef.current) {
        workbenchPendingSelectRef.current = conversationId;
        handleSelectConversation(conversationId);
      }
      activateWorkbenchPaneProject(projectPathKey);
    },
    [activateWorkbenchPaneProject, currentConversationIdRef, handleSelectConversation],
  );

  const handleWorkbenchFocusPane = useCallback(
    (paneId: string) => {
      const pane = workbench.focusPane(paneId);
      if (!pane) return;
      // Only conversation surfaces drive the page's current conversation;
      // terminal panes still steer the Right Dock's project context.
      if (pane.surface.kind !== "conversation") {
        activateWorkbenchPaneProject(surfaceProjectRef(pane.surface)?.projectPathKey);
        return;
      }
      selectWorkbenchConversation(pane.surface.conversationId, pane.surface.project.projectPathKey);
    },
    [activateWorkbenchPaneProject, selectWorkbenchConversation, workbench],
  );

  const focusWorkbenchConversationPane = useCallback(
    (conversationId: string) => {
      const paneId = workbench.paneIdForConversation(conversationId);
      if (paneId) handleWorkbenchFocusPane(paneId);
    },
    [handleWorkbenchFocusPane, workbench],
  );

  const handleWorkbenchClosePane = useCallback(
    (paneId: string) => {
      const pane = workbench.layoutRef.current.panes[paneId];
      const result = workbench.closePane(paneId);
      // Pane 关闭即结束这次会话视图投影。只有布局确认移除成功后才清理，
      // 避免失败的关闭操作把仍在画布上的轨迹视图强制切回会话。
      if (pane?.surface.kind === "conversation" && !workbench.layoutRef.current.panes[paneId]) {
        setConversationView(pane.surface.conversationId, "conversation");
      }
      // 终端 Pane 的关闭是 Detach:进程保留,租约随宿主卸载释放,会话回到
      // Right Dock;绑定一并回收,再次拖入走全新 surface 身份。先关 Pane 再删
      // 绑定,同一事件批处理内宿主已卸载,不会把空绑定误判为待新建。
      if (pane?.surface.kind === "localTerminal" || pane?.surface.kind === "sshTerminal") {
        terminalPaneBindings.delete(pane.surface.surfaceId);
      }
      if (result.closedFocused && result.nextConversationId) {
        const nextPaneId = workbench.paneIdForConversation(result.nextConversationId);
        const nextPane = nextPaneId ? workbench.layoutRef.current.panes[nextPaneId] : null;
        selectWorkbenchConversation(
          result.nextConversationId,
          nextPane ? surfaceProjectRef(nextPane.surface)?.projectPathKey : undefined,
        );
      }
    },
    [selectWorkbenchConversation, setConversationView, workbench],
  );

  const workbenchProjectForConversation = useCallback(
    (item: SidebarConversation): ProjectRef => {
      const cwd = item.cwd?.trim() || "";
      const project = cwd
        ? workspaceProjects.find(
            (entry) => workspaceProjectPathKey(entry.path) === workspaceProjectPathKey(cwd),
          )
        : undefined;
      return {
        projectId: project?.id ?? `conversation:${item.id}`,
        projectPathKey: cwd ? workspaceProjectPathKey(cwd) : `conversation:${item.id}`,
      };
    },
    [workspaceProjects],
  );

  // Workspace drops create a draft conversation through the legacy pipeline;
  // once the fresh conversation becomes current, the sync effect opens its
  // pane at the remembered target instead of rebinding the focused pane.
  const pendingWorkspaceOpenRef = useRef<{
    target: Exclude<WorkbenchDropTarget, { kind: "pane-center" }>;
    projectId: string;
    projectPathKey: string;
  } | null>(null);

  const handleWorkbenchDropCommit = useCallback(
    (commit: WorkbenchDropCommit) => {
      // Stale layout revision (focus/structure changed mid-drag): cancel the
      // transaction instead of replaying stale geometry.
      if (commit.revision !== workbench.layoutRef.current.revision) return;
      const { payload, target } = commit;
      if (payload.kind === "workspace") {
        if (target.kind === "pane-center") return;
        const pathKey = workspaceProjectPathKey(payload.projectPath);
        if (archivedWorkspaceProjectPathKeys.has(pathKey)) return;
        const project = workspaceProjects.find(
          (entry) => workspaceProjectPathKey(entry.path) === pathKey,
        );
        if (!project) return;
        pendingWorkspaceOpenRef.current = {
          target,
          projectId: project.id,
          projectPathKey: pathKey,
        };
        void handleNewConversationForProject(project);
        return;
      }
      if (payload.kind === "conversation") {
        const existingPaneId = workbench.paneIdForConversation(payload.conversationId);
        if (target.kind === "pane-center") {
          // Normalized by the drag session: pane-center only survives for the
          // conversation's own pane, meaning "focus me".
          if (existingPaneId && target.paneId === existingPaneId) {
            handleWorkbenchFocusPane(existingPaneId);
          }
          return;
        }
        if (existingPaneId) {
          if (target.kind === "canvas-empty") return;
          if (workbench.movePane(existingPaneId, target)) {
            selectWorkbenchConversation(payload.conversationId, payload.project.projectPathKey);
          }
          return;
        }
        const opened = workbench.openConversation(
          { conversationId: payload.conversationId, project: payload.project },
          target,
        );
        if (opened) {
          selectWorkbenchConversation(payload.conversationId, payload.project.projectPathKey);
        }
        return;
      }
      if (payload.kind === "terminalSession" || payload.kind === "newTerminal") {
        commitTerminalDrop(payload, target, {
          layout: workbench.layoutRef.current,
          sessions: terminalSessionsRef.current,
          lease: terminalPaneLease,
          bindings: terminalPaneBindings,
          resolveProjectPath: (project) =>
            workspaceProjects.find((entry) => entry.id === project.projectId)?.path ??
            workspaceProjects.find(
              (entry) => workspaceProjectPathKey(entry.path) === project.projectPathKey,
            )?.path ??
            null,
          createSurfaceId: createTerminalSurfaceId,
          authorizeAutoLaunch: terminalPaneAutoLaunch.authorize,
          openTerminalSurface: workbench.openTerminalSurface,
          movePane: workbench.movePane,
          focusPane: handleWorkbenchFocusPane,
        });
        return;
      }
      // Moving an existing pane by its chrome drag handle.
      if (target.kind === "canvas-empty") return;
      if (target.kind === "pane-center" && target.paneId === payload.paneId) return;
      if (workbench.movePane(payload.paneId, target)) {
        const pane = workbench.layoutRef.current.panes[payload.paneId];
        // Only conversation panes drive the page's current conversation.
        if (pane?.surface.kind === "conversation") {
          selectWorkbenchConversation(
            pane.surface.conversationId,
            pane.surface.project.projectPathKey,
          );
        }
      }
    },
    [
      archivedWorkspaceProjectPathKeys,
      handleNewConversationForProject,
      handleWorkbenchFocusPane,
      selectWorkbenchConversation,
      workbench,
      workspaceProjects,
    ],
  );

  const { dragState: workbenchDragState, beginDrag: beginWorkbenchDrag } = useWorkbenchDragSession({
    enabled: sessionWorkbench.enabled,
    layoutRef: workbench.layoutRef,
    geometryRef: workbenchGeometryRef,
    onCommit: handleWorkbenchDropCommit,
  });

  const handleConversationWorkbenchDragIntent = useCallback(
    (item: SidebarConversation, event: { pointerId: number; clientX: number; clientY: number }) => {
      beginWorkbenchDrag(
        {
          kind: "conversation",
          conversationId: item.id,
          project: workbenchProjectForConversation(item),
          title: item.title,
        },
        event,
      );
    },
    [beginWorkbenchDrag, workbenchProjectForConversation],
  );

  // Right Dock 终端 tab 拖出:既有会话进入画板。dock 的 tab 只列本地会话;
  // SSH 会话从 workspace overlay 的 shell tab 拖出(handleSshTerminalTabDragIntent)。
  const handleTerminalTabWorkbenchDragIntent = useCallback(
    (session: TerminalSession, event: { pointerId: number; clientX: number; clientY: number }) => {
      const projectPathKey = session.projectPathKey || workspaceProjectPathKey(session.cwd);
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
      );
      beginWorkbenchDrag(
        {
          kind: "terminalSession",
          sessionId: session.id,
          project: {
            projectId: project?.id ?? `terminal:${session.id}`,
            projectPathKey,
          },
          title: session.title || session.shell || "Terminal",
        },
        event,
      );
    },
    [beginWorkbenchDrag, workspaceProjects],
  );

  // SSH overlay 的 shell tab 拖出与 dock tab 同一 payload 通路;drop 时由
  // terminalSurfaceForSession 依 session.ssh.hostId 构造 sshTerminal surface,
  // 租约建立后 overlay 自动显示"已在画板中打开"占位。
  const handleSshTerminalTabDragIntent = handleTerminalTabWorkbenchDragIntent;

  // 空态"新建终端"按钮拖出:落点新建终端 Pane(几何先行,PTY 由宿主异步建)。
  const handleNewTerminalWorkbenchDragIntent = useCallback(
    (event: { pointerId: number; clientX: number; clientY: number }) => {
      if (!terminalProjectPath) return;
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === terminalProjectPathKey,
      );
      beginWorkbenchDrag(
        {
          kind: "newTerminal",
          project: {
            projectId: project?.id ?? `project:${terminalProjectPathKey}`,
            projectPathKey: terminalProjectPathKey,
          },
          title: t("projectTools.newTerminal"),
        },
        event,
      );
    },
    [beginWorkbenchDrag, t, terminalProjectPath, terminalProjectPathKey, workspaceProjects],
  );

  // 画板 Pane 持有租约的会话:overlay/占位的"前往 Pane"聚焦通路。
  const focusWorkbenchTerminalPane = useCallback(
    (sessionId: string) => {
      const paneId = terminalPaneLease.paneIdFor(sessionId);
      if (paneId && workbench.layoutRef.current.panes[paneId]) {
        handleWorkbenchFocusPane(paneId);
      }
    },
    [handleWorkbenchFocusPane, workbench],
  );

  // Right Dock 是终止进程的唯一入口(Detach-first 裁决):会话被显式关闭
  // (`closed` 事件)时,持有它的 Pane 一并关闭。缺了这一环,宿主会把
  // "绑定的会话消失"当作恢复期陈旧绑定,按 launchSpec 复活一个新 PTY,
  // 表现为 dock 上的终端"关不掉"。按绑定而非租约查找,覆盖宿主取得租约
  // 前的 connecting 窗口。
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    return tauriTerminalClient.subscribe((event) => {
      if (event.kind !== "closed") return;
      // 应用退出的 close_all 不是用户关闭单个终端:保住布局里的终端 Pane,
      // 重启后按 launchSpec 恢复。
      if (terminalAppExitGuard.isExiting()) return;
      const closedSessionId = event.sessionId?.trim() || event.session?.id || "";
      if (!closedSessionId) return;
      const paneId = findTerminalPaneForSession(closedSessionId, {
        bindings: terminalPaneBindings,
        layout: workbench.layoutRef.current,
      });
      if (paneId) handleWorkbenchClosePane(paneId);
    });
  }, [handleWorkbenchClosePane, workbench]);

  const handleProjectWorkbenchDragIntent = useCallback(
    (project: WorkspaceProject, event: { pointerId: number; clientX: number; clientY: number }) => {
      beginWorkbenchDrag(
        {
          kind: "workspace",
          projectId: project.id,
          projectPath: project.path,
          title: project.name,
        },
        event,
      );
    },
    [beginWorkbenchDrag],
  );

  // Menu alternative to dragging: dock beside the focused pane. Deterministic
  // auto-dock with the same hard minimum-size checks as drops: right first
  // (bottom first on narrow canvases), then the other axis, explicit rejection
  // when no legal space remains.
  const resolveWorkbenchAutoDockTarget = useCallback(() => {
    const layout = workbench.layoutRef.current;
    if (!layout.focusedPaneId) return { kind: "canvas-empty" } as const;
    const geometry = workbenchGeometryRef.current;
    const focusedRect = geometry?.panes.find((pane) => pane.paneId === layout.focusedPaneId)?.rect;
    if (!geometry || !focusedRect) return null;
    const preferVertical = geometry.canvas.width < 680;
    const edges = preferVertical ? (["bottom", "right"] as const) : (["right", "bottom"] as const);
    for (const edge of edges) {
      if (canSplitRectAtEdge(focusedRect, edge)) {
        return { kind: "pane-edge", paneId: layout.focusedPaneId, edge } as const;
      }
    }
    return null;
  }, [workbench]);

  const handleOpenConversationInSplit = useCallback(
    (item: SidebarConversation) => {
      const existingPaneId = workbench.paneIdForConversation(item.id);
      if (existingPaneId) {
        handleWorkbenchFocusPane(existingPaneId);
        return;
      }
      const target = resolveWorkbenchAutoDockTarget();
      if (!target) {
        addNotify("error", t("workbench.noSpaceForSplit"));
        return;
      }
      const project = workbenchProjectForConversation(item);
      const opened = workbench.openConversation({ conversationId: item.id, project }, target);
      if (opened) {
        selectWorkbenchConversation(item.id, project.projectPathKey);
      }
    },
    [
      addNotify,
      handleWorkbenchFocusPane,
      resolveWorkbenchAutoDockTarget,
      selectWorkbenchConversation,
      t,
      workbench,
      workbenchProjectForConversation,
    ],
  );

  // 同一提交通路的键盘/菜单入口:终端 tab 无需拖拽也能进工作台。已租用的会话
  // 由 commitTerminalDrop 自己走"移动既有 Pane",不会二次开 Pane。
  const handleOpenTerminalInWorkbenchSplit = useCallback(
    (session: TerminalSession) => {
      const target = resolveWorkbenchAutoDockTarget();
      if (!target) {
        addNotify("error", t("workbench.noSpaceForSplit"));
        return;
      }
      const projectPathKey = session.projectPathKey || workspaceProjectPathKey(session.cwd);
      const project = workspaceProjects.find(
        (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
      );
      commitTerminalDrop(
        {
          kind: "terminalSession",
          sessionId: session.id,
          project: {
            projectId: project?.id ?? `terminal:${session.id}`,
            projectPathKey,
          },
          title: session.title || session.shell || "Terminal",
        },
        target,
        {
          layout: workbench.layoutRef.current,
          sessions: terminalSessionsRef.current,
          lease: terminalPaneLease,
          bindings: terminalPaneBindings,
          resolveProjectPath: (ref) =>
            workspaceProjects.find((entry) => entry.id === ref.projectId)?.path ??
            workspaceProjects.find(
              (entry) => workspaceProjectPathKey(entry.path) === ref.projectPathKey,
            )?.path ??
            null,
          createSurfaceId: createTerminalSurfaceId,
          authorizeAutoLaunch: terminalPaneAutoLaunch.authorize,
          openTerminalSurface: workbench.openTerminalSurface,
          movePane: workbench.movePane,
          focusPane: handleWorkbenchFocusPane,
        },
      );
    },
    [
      addNotify,
      handleWorkbenchFocusPane,
      resolveWorkbenchAutoDockTarget,
      t,
      workbench,
      workspaceProjects,
    ],
  );

  // Native file drag hover: focus the conversation pane under the cursor for
  // visual and keyboard continuity. Final attachment ownership is carried by
  // the composer's data-file-upload-conversation-id marker at drop time.
  const lastNativeDropHoverPaneRef = useRef<string | null>(null);
  workbenchNativeDropHoverRef.current = (point) => {
    if (!sessionWorkbench.enabled || !point) {
      lastNativeDropHoverPaneRef.current = null;
      return;
    }
    const geometry = workbenchGeometryRef.current;
    const canvasElement = document.querySelector("[data-workbench-canvas]");
    if (!geometry || !canvasElement) return;
    const canvasRect = canvasElement.getBoundingClientRect();
    const target = hitTestWorkbenchDrop(
      geometry,
      point.x - canvasRect.left,
      point.y - canvasRect.top,
    );
    const paneId =
      target && (target.kind === "pane-center" || target.kind === "pane-edge")
        ? target.paneId
        : null;
    if (!paneId || paneId === lastNativeDropHoverPaneRef.current) return;
    lastNativeDropHoverPaneRef.current = paneId;
    if (workbench.layoutRef.current.focusedPaneId !== paneId) {
      handleWorkbenchFocusPane(paneId);
    }
  };

  // Keep the focused pane bound to the page's current conversation (the
  // legacy "conversation swaps beneath the stable pane" behaviour), unless a
  // pane-initiated selection is still in flight.
  const lastWorkbenchSyncedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const pending = workbenchPendingSelectRef.current;
    if (
      pending &&
      pending !== currentConversationId &&
      lastWorkbenchSyncedConversationRef.current === currentConversationId
    ) {
      return;
    }
    workbenchPendingSelectRef.current = null;
    const previousSynced = lastWorkbenchSyncedConversationRef.current;
    lastWorkbenchSyncedConversationRef.current = currentConversationId;

    // Workspace drop: the fresh draft conversation opens a NEW pane at the
    // remembered drop target instead of rebinding the focused pane. The
    // pending intent is one-shot and verified against the draft's workdir so
    // a failed directory check can never misplace a later conversation.
    const pendingWorkspaceOpen = pendingWorkspaceOpenRef.current;
    if (pendingWorkspaceOpen && previousSynced !== currentConversationId) {
      pendingWorkspaceOpenRef.current = null;
      const draftWorkdir =
        conversationRuntimeCacheRef.current.get(currentConversationId)?.workdir?.trim() || "";
      const hasNoPane = !workbench.paneIdForConversation(currentConversationId);
      if (
        hasNoPane &&
        draftWorkdir &&
        workspaceProjectPathKey(draftWorkdir) === pendingWorkspaceOpen.projectPathKey
      ) {
        const opened = workbench.openConversation(
          {
            conversationId: currentConversationId,
            project: {
              projectId: pendingWorkspaceOpen.projectId,
              projectPathKey: pendingWorkspaceOpen.projectPathKey,
            },
          },
          pendingWorkspaceOpen.target,
        );
        if (opened) return;
      }
    }
    workbench.syncCurrentConversation(currentConversationId, conversationSurfaceProject);
  }, [currentConversationId, conversationSurfaceProject, conversationRuntimeCacheRef, workbench]);

  // Close panes whose conversation was deleted from history (the focused
  // pane already falls back through the legacy new-conversation path).
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const layout = workbench.layoutRef.current;
    for (const pane of Object.values(layout.panes)) {
      if (pane.surface.kind !== "conversation") continue;
      const conversationId = pane.surface.conversationId;
      if (conversationId === currentConversationId) continue;
      const item = sidebarConversationsById.get(conversationId);
      if (!item && conversationPersistenceCursorRef.current.has(conversationId)) {
        handleWorkbenchClosePane(pane.paneId);
      }
    }
  }, [
    conversationPersistenceCursorRef,
    currentConversationId,
    handleWorkbenchClosePane,
    sidebarConversationsById,
    workbench,
  ]);

  // Keyboard equivalents for workbench pane commands, all on Meta/Ctrl+Alt:
  // Arrow focuses the adjacent pane, Shift+Arrow moves the focused pane there,
  // W closes it, and =/+ equalizes its parent split. Every command needs at
  // least two panes; with one pane the workbench has nothing to navigate.
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const layout = workbench.layoutRef.current;
      const focusedPaneId = layout.focusedPaneId;
      if (!focusedPaneId || Object.keys(layout.panes).length < 2) return;

      const direction =
        event.key === "ArrowLeft"
          ? ("left" as const)
          : event.key === "ArrowRight"
            ? ("right" as const)
            : event.key === "ArrowUp"
              ? ("top" as const)
              : event.key === "ArrowDown"
                ? ("bottom" as const)
                : null;
      if (direction) {
        const geometry = workbenchGeometryRef.current;
        if (!geometry) return;
        const nextPaneId = findAdjacentPaneId(geometry, focusedPaneId, direction);
        if (!nextPaneId) return;
        event.preventDefault();
        // Shift grafts the focused pane onto the neighbour's far edge, so the
        // pane ends up exactly where a plain focus move would have gone.
        if (event.shiftKey) {
          workbench.movePane(focusedPaneId, {
            kind: "pane-edge",
            paneId: nextPaneId,
            edge: direction,
          });
          return;
        }
        handleWorkbenchFocusPane(nextPaneId);
        return;
      }

      if (event.shiftKey) return;
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        handleWorkbenchClosePane(focusedPaneId);
        return;
      }
      if (event.key === "=" || event.key === "+") {
        const splitId = findParentSplitId(layout, focusedPaneId);
        if (!splitId) return;
        event.preventDefault();
        workbench.equalizeSplit(splitId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleWorkbenchClosePane, handleWorkbenchFocusPane, workbench]);

  // Background pane controllers (conversations visible in unfocused panes).
  const backgroundControllersRef = useRef(new Map<string, ConversationSurfaceController>());
  const getBackgroundConversationController = useCallback(
    (conversationId: string, project: ProjectRef): ConversationSurfaceController => {
      const existing = backgroundControllersRef.current.get(conversationId);
      if (existing) return existing;
      const controller = createConversationSurfaceController({
        conversationId,
        project,
        registry: conversationRuntimeRegistry,
        actions: conversationControllerActions,
      });
      backgroundControllersRef.current.set(conversationId, controller);
      return controller;
    },
    [conversationControllerActions, conversationRuntimeRegistry],
  );
  useEffect(() => {
    if (!sessionWorkbench.enabled) return;
    const keep = new Set(
      Object.values(workbench.layout.panes).flatMap((pane) =>
        pane.surface.kind === "conversation" ? [pane.surface.conversationId] : [],
      ),
    );
    for (const [conversationId, controller] of backgroundControllersRef.current) {
      if (!keep.has(conversationId)) {
        controller.dispose();
        backgroundControllersRef.current.delete(conversationId);
      }
    }
  }, [workbench.layout]);
  useEffect(
    () => () => {
      for (const controller of backgroundControllersRef.current.values()) {
        controller.dispose();
      }
      backgroundControllersRef.current.clear();
    },
    [],
  );

  // Read-and-interact binding for panes not hosting the current conversation.
  // Attach/send/stop/chip-remove route by this pane's conversationId. Other
  // interactions that still go through page-level current-conversation
  // machinery focus the pane first.
  const buildBackgroundPaneBinding = (
    surface: ConversationWorkbenchSurface,
  ): ConversationPaneBinding => {
    const conversationId = surface.conversationId;
    const controller = getBackgroundConversationController(conversationId, surface.project);
    const runtimeEntry = conversationRuntimeRegistry.getSnapshot(conversationId);
    const historyItem = sidebarConversationsById.get(conversationId);
    const workspaceRoot = historyItem?.cwd?.trim() || runtimeEntry?.workdir?.trim() || undefined;
    const paneSelectedModel = resolveActiveModelSelection(
      settings,
      runtimeEntry?.selectedModel ?? undefined,
    );
    const paneSelectedValue = paneSelectedModel
      ? toModelValue(paneSelectedModel.customProviderId, paneSelectedModel.model)
      : undefined;
    const paneModelLabel = (() => {
      if (!paneSelectedModel) return t("chat.selectModel");
      const option = modelOptions.find((entry) => entry.value === paneSelectedValue);
      return option ? `${option.providerName} / ${option.model}` : paneSelectedModel.model;
    })();
    const paneContextWindow = (() => {
      if (!paneSelectedModel) return undefined;
      const provider = settings.customProviders.find(
        (entry) => entry.id === paneSelectedModel.customProviderId,
      );
      if (!provider) return undefined;
      return findProviderModelConfig(provider, paneSelectedModel.model).contextWindow;
    })();
    const paneIsRunning = isConversationRunning(conversationId) || runtimeEntry?.isSending === true;
    const paneContextUsageTokensSource = createContextUsageTokensSource({
      isRunning: paneIsRunning || runtimeEntry?.compactionStatus?.phase === "running",
      conversationId,
      transcriptItems: runtimeEntry?.state.transcript.items ?? [],
      liveTranscriptStore: getConversationLiveTranscriptStore(conversationId),
      getCompactionController,
    });
    const paneTrajectoryActive = viewForConversation(conversationId) === "trajectory";
    const focusGuard = <Args extends unknown[]>(fn: (...args: Args) => void) => {
      return (...args: Args) => {
        if (currentConversationIdRef.current !== conversationId) {
          focusWorkbenchConversationPane(conversationId);
          return;
        }
        fn(...args);
      };
    };
    // Send routes by this pane's conversationId (mirroring Stop), never by the
    // page's focused conversation: a busy conversation enqueues the turn, an
    // idle one sends immediately. Uploads come from the pane conversation's
    // own store — the focused pane's pending files must never ride along.
    const paneSendDraft = async (draft: MentionComposerDraft) => {
      const uploads = conversationRuntimeRegistry.uploads.getSnapshot(conversationId).slice();
      const runtime = conversationRuntimeRegistry.getSnapshot(conversationId);
      if (isConversationRunning(conversationId) || runtime?.isSending) {
        return enqueueComposerTurnForConversation({
          conversationId,
          draft,
          uploadedFiles: uploads,
        });
      }
      const accepted = await sendActionRef.current({
        conversationIdOverride: conversationId,
        composerDraftOverride: draft,
        uploadedFilesOverride: uploads,
      });
      if (accepted) {
        conversationRuntimeRegistry.uploads.set(conversationId, []);
      }
      return accepted;
    };
    return {
      controller,
      changedFilesActions,
      // 回退是写工作区的破坏性操作,只允许从焦点 Pane 发起(聚焦后走
      // primaryPaneBinding 的完整授权链);背景 Pane 一律禁用。
      checkpointRewind: {
        project: null,
        disabled: true,
        onRewound: () => undefined,
      },
      isConversationRunning: isConversationRunning(conversationId),
      // Native file drop routes only to the focused pane's composer.
      fileDrop: {
        active: false,
        canDropUpload: false,
        title: "",
        description: "",
        limitHint: "",
      },
      trajectory: {
        active: paneTrajectoryActive,
        renderContent: (snapshot) => (
          <ConversationTrajectorySurface
            conversationId={conversationId}
            host={trajectoryHost}
            transcriptItems={snapshot.runtime?.state.transcript.items ?? []}
            liveTranscriptStore={getConversationLiveTranscriptStore(conversationId)}
            workdir={workspaceRoot}
            hasMoreMessages={snapshot.runtime?.state.transcript.hasMoreBefore ?? false}
            loadEarlierMessages={() => loadEarlierHistoryActionRef.current(conversationId)}
          />
        ),
      },
      transcript: {
        workspaceRoot,
        gitClient: tauriGitClient,
        hasModels,
        onLoadEarlierHistory: () => loadEarlierHistoryActionRef.current(conversationId),
        isHistorySwitching: false,
        isAgentMode,
        showUsage: isAgentDevExecutionMode,
        usageContextWindow: paneContextWindow,
        liveTranscriptStore: getConversationLiveTranscriptStore(conversationId),
        contentWidth: settings.customSettings.chatTranscript.width,
        onContentWidthChange: handleChatTranscriptWidthChange,
        onOpenFileLink: handleOpenChatFileLink,
        onResendFromEdit: focusGuard(handleResendFromEdit),
        onBranchConversation: undefined,
        branchPendingMessageId: undefined,
        onOpenSettings,
        onSuggestionSelect: focusGuard(handleEmptyStateSuggestion),
        suggestionsDisabled: isSuggestionTyping,
      },
      composer: {
        surface: "desktop",
        conversationId,
        isUploadingFiles: false,
        isInputDisabled: false,
        // 麦克风在开启语音输入后显示；点击设置卡片会立即切换当前供应商。
        sttSessionKey: conversationId,
        sttProvider: settings.stt.enabled
          ? (sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud")
          : null,
        sttProviderConfigured:
          settings.stt.providers[sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud"]
            ?.configured,
        sttTransport: desktopSttTransport,
        onSttError: handleSttError,
        inputPlaceholder: t("chat.inputHint"),
        workdir: workspaceRoot ?? "",
        enabledSkills: enabledComposerSkills,
        mentionApps,
        executionMode: settings.system.executionMode,
        hasModels,
        currentModelLabel: paneModelLabel,
        modelOptions,
        selectedValue: paneSelectedValue,
        chatRuntimeControls: chatRuntimeControlsForCurrentProvider,
        commandSafetyMode: settings.system.commandSafetyMode,
        onCommandSafetyModeChange: (mode) =>
          setSettings((prev) =>
            prev.system.commandSafetyMode === mode
              ? prev
              : updateSystem(prev, { commandSafetyMode: mode }),
          ),
        reasoningOptions: chatRuntimeReasoningOptions,
        thinkingAlwaysOn: chatRuntimeThinkingAlwaysOn,
        contextUsageTokensSource: paneContextUsageTokensSource,
        contextWindow: paneContextWindow,
        gitClient: tauriGitClient,
        workspaceActivityClient: tauriWorkspaceActivityClient,
        onOpenWorktree: handleOpenWorktree,
        onWorktreeRemoved: handleWorktreeRemoved,
        // Overridden by ConversationPaneHost with a pane-scoped handler built
        // from sendDraft (below); only the host holds this pane's composer.
        onSend: () => undefined,
        onComposerBusyChange: () => undefined,
        onSelectModel: focusGuard(handleSelectModel),
        onSelectExecutionMode: handleSelectExecutionMode,
        onOpenSettings,
        onChatRuntimeControlsChange: focusGuard(handleChatRuntimeControlsChange),
        onPickReadableFiles: focusGuard(pickReadableFiles),
        // Paste must not wait for pane focus: Cmd+Alt+Arrow / Tab can leave
        // the caret in this composer while currentConversationIdRef is still
        // the focused pane. Same explicit target as native drop.
        onPasteFiles: (files) => {
          void importReadableFiles(files, {
            conversationId,
            workdir: workspaceRoot ?? "",
          });
        },
        onLoadUploadedImagePreview: loadComposerUploadedImagePreview,
        loadHistoryPrompts: loadComposerHistoryPrompts,
        // 背景 Pane 的澄清执行器同样按本 Pane 会话解析模型（见
        // getConversationClarifyRunner 的惰性 getter）。
        runClarifyTurn: getConversationClarifyRunner(conversationId),
        clarifyContext: { workdir: workspaceRoot ?? "" },
        onRemovePendingUpload: (relativePath) => removePendingUpload(relativePath, conversationId),
        onRunQueuedTurnNow: runQueuedTurnNow,
        onMoveQueuedTurnUp: moveQueuedTurnUp,
        onEditQueuedTurn: focusGuard(editQueuedTurn),
        onRemoveQueuedTurn: removeQueuedTurn,
      },
      sendDraft: paneSendDraft,
    };
  };

  const workbenchRegistrations: ConversationPaneRegistration[] = sessionWorkbench.enabled
    ? Object.values(workbench.layout.panes).flatMap((pane) => {
        // Only conversation panes register a host binding; terminal and
        // unsupported panes render self-contained surfaces.
        const surface = pane.surface;
        if (surface.kind !== "conversation") return [];
        return [
          {
            identity: {
              paneId: pane.paneId,
              conversationId: surface.conversationId,
              project: surface.project,
            },
            binding:
              surface.conversationId === currentConversationId
                ? primaryPaneBinding
                : buildBackgroundPaneBinding(surface),
          },
        ];
      })
    : [
        {
          identity: {
            paneId: "root-conversation-pane",
            conversationId: currentConversationId,
            project: conversationSurfaceProject,
          },
          binding: primaryPaneBinding,
        },
      ];
  const conversationPaneHostEnvironment =
    createConversationPaneHostEnvironment(workbenchRegistrations);

  // Human-readable pane title, shared by the chrome tooltip/drag payload and
  // the pane's accessible region label.
  const workbenchPaneTitle = (surface: PaneRecord["surface"]): string => {
    switch (surface.kind) {
      case "conversation":
        return sidebarConversationsById.get(surface.conversationId)?.title?.trim() || "";
      case "localTerminal":
        return surface.launchSpec.title?.trim() || surface.launchSpec.shell?.trim() || "Terminal";
      case "sshTerminal":
        return surface.launchSpec.title?.trim() || surface.launchSpec.sshHostId.trim() || "SSH";
      case "unsupported":
        return surface.originalKind;
    }
  };

  // Per-pane region label: screen readers must be able to tell panes apart, so
  // terminals never read as "Conversation pane" and conversations carry their
  // title (plus the workspace name when the pane resolves to a known project).
  const workbenchPaneRegionLabel = (pane: PaneRecord): string => {
    const surface = pane.surface;
    if (surface.kind === "unsupported") return t("workbench.paneRegionUnsupported");
    const title = workbenchPaneTitle(surface);
    if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
      return t("workbench.paneRegionTerminal").replace("{title}", title);
    }
    if (!title) return t("workbench.paneRegion");
    const workspaceName = workspaceProjects
      .find((entry) => workspaceProjectPathKey(entry.path) === surface.project.projectPathKey)
      ?.name.trim();
    if (!workspaceName) {
      return t("workbench.paneRegionConversation").replace("{title}", title);
    }
    return t("workbench.paneRegionConversationInWorkspace")
      .replace("{title}", title)
      .replace("{workspace}", workspaceName);
  };

  // 与 PaneSurfaceLayer 的 paneCount < 2(chromeless)判定保持同一口径:
  // 只要画布上有 ≥2 个 Pane,Pane chrome 就会渲染,切换点随之下沉。
  const workbenchHasMultiplePanes =
    sessionWorkbench.enabled && Object.keys(workbench.layout.panes).length >= 2;

  const renderWorkbenchPaneChrome = (
    pane: PaneRecord,
    context: { isFocused: boolean; paneCount: number; isCompact: boolean },
  ) => {
    if (context.paneCount < 2) return null;
    const surface = pane.surface;
    const title = workbenchPaneTitle(surface);
    const paneConversationView =
      surface.kind === "conversation"
        ? viewForConversation(surface.conversationId)
        : "conversation";
    return (
      <PaneChrome
        paneId={pane.paneId}
        title={title}
        isFocused={context.isFocused}
        isCompact={context.isCompact}
        dragHandleLabel={t("workbench.dragPane")}
        closeLabel={t("workbench.closePane")}
        onClose={() => handleWorkbenchClosePane(pane.paneId)}
        trajectoryToggle={
          surface.kind === "conversation"
            ? {
                isTrajectory: paneConversationView === "trajectory",
                label:
                  paneConversationView === "trajectory"
                    ? t("workbench.showConversation")
                    : t("workbench.showTrajectory"),
                onToggle: () => {
                  if (surface.kind !== "conversation") return;
                  setConversationView(
                    surface.conversationId,
                    paneConversationView === "trajectory" ? "conversation" : "trajectory",
                  );
                },
              }
            : undefined
        }
        onDragHandlePointerDown={(event) => {
          beginWorkbenchDrag(
            { kind: "pane", paneId: pane.paneId, surfaceKey: surfaceIdentityKey(surface), title },
            { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY },
          );
        }}
      />
    );
  };

  const chatContent = sessionWorkbench.enabled ? (
    <ConversationPaneHostEnvironmentProvider value={conversationPaneHostEnvironment}>
      <WorkbenchCanvas
        layout={workbench.layout}
        labels={{
          paneRegion: (pane) => workbenchPaneRegionLabel(pane),
          separator: t("workbench.resizeDivider"),
        }}
        renderPaneContent={(pane, paneContext) => {
          const surface = pane.surface;
          if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
            return (
              <TerminalPaneHost
                paneId={pane.paneId}
                surface={surface}
                isFocused={paneContext.isFocused}
                isCompact={paneContext.isCompact}
                theme={effectiveTheme}
                sessions={terminalSessions}
                sessionsLoaded={terminalSessionsLoaded}
                onSessionGhost={verifyTerminalSessionAlive}
              />
            );
          }
          if (surface.kind === "unsupported") {
            return (
              <UnsupportedPaneSurface paneId={pane.paneId} originalKind={surface.originalKind} />
            );
          }
          const conversationId = surface.conversationId;
          const isCurrent = conversationId === currentConversationId;
          const panePathKey = surface.project.projectPathKey;
          // Archived/missing workspaces: the conversation stays viewable but
          // the pane is clearly marked blocked; it never rebinds elsewhere.
          const blockedMessage = archivedWorkspaceProjectPathKeys.has(panePathKey)
            ? t("workbench.projectArchived")
            : missingWorkspaceProjectPathKeys.has(panePathKey)
              ? t("workbench.projectMissing")
              : null;
          const blockedBanner = blockedMessage ? (
            <div
              data-workbench-pane-blocked=""
              className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400"
            >
              {blockedMessage}
            </div>
          ) : null;
          const host = (
            <Suspense fallback={<PaneLoadingSkeleton label={t("app.loading")} />}>
              <RestorableConversationPaneHost
                ref={isCurrent ? conversationPaneHostRef : undefined}
                paneId={pane.paneId}
                conversationId={conversationId}
                project={surface.project}
                title={sidebarConversationsById.get(conversationId)?.title}
                deferHydration={!paneContext.isFocused}
              />
            </Suspense>
          );
          if (!blockedBanner) return host;
          return (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {blockedBanner}
              {host}
            </div>
          );
        }}
        renderPaneChrome={renderWorkbenchPaneChrome}
        onResizeSplit={workbench.resizeSplit}
        onEqualizeSplit={workbench.equalizeSplit}
        onFocusPane={handleWorkbenchFocusPane}
        onGeometryChange={handleWorkbenchGeometryChange}
        dropPreview={
          workbenchDragState?.previewRect
            ? { rect: workbenchDragState.previewRect, label: workbenchDragState.payload.title }
            : null
        }
        emptyState={
          <WorkbenchEmptyState
            title={t("workbench.emptyTitle")}
            description={t("workbench.emptyDescription")}
          />
        }
      />
    </ConversationPaneHostEnvironmentProvider>
  ) : (
    <ConversationPaneHostEnvironmentProvider value={conversationPaneHostEnvironment}>
      <Suspense fallback={<PaneLoadingSkeleton label={t("app.loading")} />}>
        <ConversationPaneHost
          ref={conversationPaneHostRef}
          paneId="root-conversation-pane"
          conversationId={currentConversationId}
          project={conversationSurfaceProject}
        />
      </Suspense>
    </ConversationPaneHostEnvironmentProvider>
  );

  const workbenchDragGhost =
    sessionWorkbench.enabled && workbenchDragState ? (
      <div
        data-workbench-drag-ghost=""
        className="layer-popover pointer-events-none fixed max-w-[220px] truncate rounded-md border border-border bg-background/95 px-2.5 py-1 text-xs text-foreground shadow-md"
        style={{
          left: workbenchDragState.pointer.x + 14,
          top: workbenchDragState.pointer.y + 10,
        }}
      >
        {workbenchDragState.payload.title || t("chat.pendingTitle")}
      </div>
    ) : null;

  return (
    <div
      data-app-frame="three-column"
      className="relative flex h-full min-h-0 w-full overflow-hidden"
    >
      <MacOsTitleBarToggle
        sidebarOpen={sidebarOpen}
        onToggle={handleToggleSidebar}
        onOpenSettings={() => onOpenSettings()}
        appUpdate={appUpdate}
      />
      {workbenchDragGhost}
      {/* ---- Left column: navigation/sidebar ---- */}
      <ChatSidebarContainer
        store={sidebarStore}
        approvalStore={conversationRuntimeRegistry.approvals}
        currentConversationId={currentConversationId}
        isOpen={sidebarOpen}
        fontScale={settings.customSettings.fontScale.sidebar}
        activeView={activeView}
        showProjects={isAgentMode}
        projects={workspaceProjects}
        workspaceProjectGroups={workspaceProjectGroups}
        activeProjectId={activeWorkspaceProject?.id}
        missingProjectPathKeys={missingWorkspaceProjectPathKeys}
        projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
        workspaceFolderDropActive={isWorkspaceFolderDropActive}
        recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
        onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
        onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
        onCreateProject={handleOpenCreateWorkspaceProject}
        onCreateWorkspaceGroup={handleCreateWorkspaceGroup}
        onRenameWorkspaceGroup={handleRenameWorkspaceGroup}
        onDeleteWorkspaceGroup={handleDeleteWorkspaceGroup}
        onMoveProjectToGroup={handleMoveWorkspaceProjectToGroup}
        onToggleWorkspaceGroupCollapsed={handleToggleWorkspaceGroupCollapsed}
        onSelectProject={handleSelectWorkspaceProject}
        onNewConversationForProject={handleNewConversationForProject}
        onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
        onBrowseProjectInSystemFileManager={handleBrowseWorkspaceProjectInSystemFileManager}
        onConfigureProject={setProjectSettingsProject}
        onSetProjectPinned={handleSetWorkspaceProjectPinned}
        onRemoveProject={handleRemoveWorkspaceProject}
        onArchiveProject={handleArchiveWorkspaceProject}
        onUnarchiveProject={handleUnarchiveWorkspaceProject}
        archivedProjectPathKeys={archivedWorkspaceProjectPathKeys}
        onNewConversation={() => {
          setActiveView("chat");
          if (activeView !== "chat" && isDraftConversation) {
            return;
          }
          handleNewConversation();
        }}
        onSelectConversation={(id) => {
          setActiveView("chat");
          handleSelectConversation(id);
        }}
        onConversationDeleted={handleConversationDeleted}
        onConversationCwdChanged={handleConversationCwdChanged}
        onConversationWorkbenchDragIntent={
          sessionWorkbench.enabled ? handleConversationWorkbenchDragIntent : undefined
        }
        onConversationOpenInWorkbenchSplit={
          sessionWorkbench.enabled ? handleOpenConversationInSplit : undefined
        }
        onProjectWorkbenchDragIntent={
          sessionWorkbench.enabled ? handleProjectWorkbenchDragIntent : undefined
        }
        canShareConversations={canShareHistory}
        sharedConversationCount={sharedHistoryItems.length}
        onShareConversation={handleOpenShareModal}
        onOpenSharedConversations={handleOpenSharedHistoryManager}
        onCloseSidebar={handleCloseSidebar}
        onOpenSettings={() => onOpenSettings()}
        appUpdate={appUpdate}
        onOpenSkillsHub={() => {
          cacheActiveComposerDraft();
          setRightDockOpen(false);
          setActiveView("skills-hub");
        }}
        onOpenMcpHub={() => {
          cacheActiveComposerDraft();
          setRightDockOpen(false);
          setActiveView("mcp-hub");
        }}
      />

      {/* ---- Center column: workbench chrome + conversation surfaces ---- */}
      <div
        data-app-frame-column="main"
        className="relative flex flex-col min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <AppWorkbenchChrome
          settings={settings}
          sidebarOpen={sidebarOpen}
          onOpenSettings={onOpenSettings}
          onToggleTheme={onToggleTheme}
          onOpenSidebar={handleOpenSidebar}
          leadingActions={
            // 多 Pane 时切换点内嵌在聚焦 Pane 的左上角(PaneChrome),顶栏
            // 不再重复;单 Pane 无 Pane chrome,保留顶栏 Tabs。
            activeView === "chat" && hasConversationReply && !workbenchHasMultiplePanes ? (
              <ConversationViewTabs
                active={renderedConversationView}
                onChange={setActiveConversationView}
              />
            ) : null
          }
          trailingActions={
            <ProjectToolsPanelToggle
              isOpen={rightDockOpen}
              sessionCount={projectTerminalSessions.length}
              disabledMessage={terminalDisabledMessage}
              onToggle={() => setRightDockOpen((open) => !open)}
            />
          }
          overlay={<NotifyToast items={notifyItems} onDismiss={dismissNotify} />}
        />

        {workspaceCreateModalOpen ? (
          <WorkspaceCloneModal
            initialParent={activeWorkspaceProjectPath || workdir}
            onOpenFolder={handleOpenWorkspaceFolder}
            onClone={handleCloneWorkspaceProject}
            onClose={() => setWorkspaceCreateModalOpen(false)}
            onLoadBranches={handleLoadWorkspaceRemoteBranches}
          />
        ) : null}
        <WorkspaceCloneTaskOverlayAdapter onOpenWorkspace={handleOpenClonedWorkspace} />

        {shareConversation ? (
          <HistoryShareModal
            conversation={shareConversation}
            share={shareStatus}
            isLoading={shareLoading}
            isUpdating={shareUpdating}
            errorMessage={shareError}
            shareOrigin={sharedManagerShareOrigin}
            shareOriginPort={sharedManagerShareOriginPort}
            shareOriginLoading={sharedManagerGatewayUrlLoading}
            onToggle={handleToggleHistoryShare}
            onRedactToolContentChange={handleSetShareRedactToolContent}
            onClose={handleCloseShareModal}
          />
        ) : null}

        {sharedManagerOpen ? (
          <SharedHistoryManagerModal
            conversations={sharedHistoryItems}
            statuses={sharedManagerStatuses}
            loadingIds={sharedManagerLoadingIds}
            updatingIds={sharedManagerUpdatingIds}
            errors={sharedManagerErrors}
            shareOrigin={sharedManagerShareOrigin}
            shareOriginPort={sharedManagerShareOriginPort}
            shareOriginLoading={sharedManagerGatewayUrlLoading}
            onRefresh={handleRefreshSharedHistoryStatuses}
            onLoadStatus={handleLoadSharedHistoryStatus}
            onDisableShare={handleDisableSharedHistory}
            onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
            onClose={() => setSharedManagerOpen(false)}
          />
        ) : null}

        {confirmDialog}

        {/* ---- Main content ----
            字体缩放仅作用于聊天视图：Skills/MCP Hub 页面存在大量未迁移的固定
            像素字号，整列缩放会造成混排（聊天区设置也只应影响聊天区）。 */}
        <ApplicationView
          activeView={activeView}
          settings={settings}
          setSettings={setSettings}
          isAgentMode={isAgentMode}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={handleOpenSidebar}
          initialSkills={availableSkills}
          initialSkillsRootDir={skillsRootDir}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
          chatClassName="zone-font-scale"
          chatStyle={
            {
              "--zone-font-scale": settings.customSettings.fontScale.chat,
            } as CSSProperties
          }
          chat={{ content: chatContent }}
          workspaceOverlays={
            <WorkspaceOverlayHost
              locale={settings.locale}
              theme={effectiveTheme}
              workspaceEditorMounted={workspaceOverlays.workspaceEditorMounted}
              workspaceEditorOpenRequest={workspaceOverlays.workspaceEditorOpenRequest}
              workspaceEditorCloseRequestId={workspaceOverlays.workspaceEditorCloseRequestId}
              workspaceEditorOpen={workspaceOverlays.workspaceEditorOpen}
              workspaceEditorCleanupPending={workspaceOverlays.workspaceEditorCleanupPending}
              onWorkspaceEditorPreviewFile={workspaceOverlays.openWorkspaceFilePreview}
              onWorkspaceEditorInsertCodeMention={handleInsertCodeMention}
              onWorkspaceEditorHide={workspaceOverlays.handleWorkspaceEditorHide}
              onWorkspaceEditorClose={workspaceOverlays.handleWorkspaceEditorClosed}
              workspaceFilePreviewMounted={workspaceOverlays.workspaceFilePreviewMounted}
              workspaceFilePreviewOpenRequest={workspaceOverlays.workspaceFilePreviewOpenRequest}
              workspaceFilePreviewOpen={workspaceOverlays.workspaceFilePreviewOpen}
              onWorkspaceFilePreviewOpenEditor={workspaceOverlays.openWorkspaceEditorFile}
              onWorkspaceFilePreviewRequestClose={
                workspaceOverlays.requestWorkspaceFilePreviewClose
              }
              onWorkspaceFilePreviewClose={workspaceOverlays.handleWorkspaceFilePreviewClosed}
              workspaceSshTerminalMounted={workspaceOverlays.workspaceSshTerminalMounted}
              workspaceSshTerminalOpenRequest={workspaceOverlays.workspaceSshTerminalOpenRequest}
              workspaceSshTerminalOpen={workspaceOverlays.workspaceSshTerminalOpen}
              terminalProjectPathKey={terminalProjectPathKey}
              terminalClient={tauriTerminalClient}
              sftpClient={tauriSftpClient}
              terminalSessions={terminalSessions}
              onWorkspaceSshTerminalHide={() =>
                workspaceOverlays.setWorkspaceSshTerminalOpen(false)
              }
              onSshTerminalOpenFile={workspaceOverlays.handleOpenSftpFile}
              sshTerminalPaneLeasedSessionIds={leasedDockSessionIds}
              onSshTerminalFocusLeasedSession={
                sessionWorkbench.enabled ? focusWorkbenchTerminalPane : undefined
              }
              onSshTerminalSessionTabDragStart={
                sessionWorkbench.enabled ? handleSshTerminalTabDragIntent : undefined
              }
            />
          }
        />
      </div>
      <RightDockPanel
        isOpen={activeView === "chat" && rightDockOpen}
        collapseImmediately={activeView !== "chat"}
        fontScale={settings.customSettings.fontScale.rightDock}
        projectPathKey={terminalProjectPathKey}
        cwd={terminalProjectPath}
        sessions={terminalSessions}
        sessionsLoaded={terminalSessionsLoaded}
        leasedSessionIds={leasedDockSessionIds}
        width={settings.customSettings.rightDock.width}
        theme={effectiveTheme}
        disabledMessage={terminalDisabledMessage}
        projectState={rightDockProjectState}
        fileTreeState={rightDockFileTreeState}
        sshHosts={settings.ssh.hosts}
        associatedSshHostIds={associatedSshHostIds}
        client={tauriTerminalClient}
        gitClient={tauriGitClient}
        gitWriteEnabled
        textGenerationClient={projectToolTextGenerationClient}
        tunnelClient={isAgentMode ? tauriTunnelClient : null}
        tunnelEnabled={tunnelEnabled}
        tunnelDisabledMessage={tunnelDisabledMessage}
        tunnelPublicBaseUrl={settings.remote.gatewayUrl.trim()}
        workspaceActivityClient={tauriWorkspaceActivityClient}
        onWidthChange={handleRightDockWidthChange}
        onProjectStateChange={handleRightDockProjectStateChange}
        onFileTreeStateChange={handleRightDockFileTreeStateChange}
        onSshProjectHostIdsChange={handleSshProjectHostIdsChange}
        onOpenSshSession={handleOpenSshTerminal}
        onSessionsChange={handleRightDockSessionsChange}
        onTerminalTabDragStart={
          sessionWorkbench.enabled ? handleTerminalTabWorkbenchDragIntent : undefined
        }
        onNewTerminalDragStart={
          sessionWorkbench.enabled ? handleNewTerminalWorkbenchDragIntent : undefined
        }
        onOpenTerminalInWorkbench={
          sessionWorkbench.enabled ? handleOpenTerminalInWorkbenchSplit : undefined
        }
        onSessionGhost={verifyTerminalSessionAlive}
        onInsertFileMention={handleRightDockInsertFileMention}
        onOpenFile={handleOpenWorkspaceFile}
        gitReviewFocusRequest={gitReviewFocusRequest}
        onGitReviewFocusRequestHandled={handleGitReviewFocusRequestHandled}
        onInsertCodeReviewSkill={codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined}
        onInsertCommitMention={handleRightDockInsertCommitMention}
        onInsertGitFileMention={handleRightDockInsertGitFileMention}
      />
      {projectSettingsProject ? (
        <WorkspaceProjectSettingsModal
          project={projectSettingsProject}
          settings={settings}
          skills={availableSkills}
          rootClient={desktopWorkspaceProjectRootClient}
          onClose={() => setProjectSettingsProject(null)}
          onRenameProject={(name) => {
            commitWorkspaceProjectRename(projectSettingsProject, name);
          }}
          onSave={(draft) => {
            setSettings((prev) =>
              updateWorkspaceResourceSettings(prev, projectSettingsProject.path, draft),
            );
          }}
        />
      ) : null}
    </div>
  );
}
