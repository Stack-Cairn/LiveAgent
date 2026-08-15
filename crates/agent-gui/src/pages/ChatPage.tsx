import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { useApplicationViewState } from "@liveagent/ui/application/useApplicationViewState";
import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import { HistoryShareModal } from "@liveagent/ui/components/chat/HistoryShareModal";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { NotifyToast } from "@liveagent/ui/components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import { WorkspaceCloneModal } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import { WorkspaceProjectSettingsModal } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { ProjectToolsPanelToggle } from "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle";
import { RightDockPanel } from "@liveagent/ui/components/project-tools/RightDockPanel";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useWorkspaceOverlays } from "@liveagent/ui/components/workspace-editor/useWorkspaceOverlays";
import { WorkspaceOverlayHost } from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import { useLocale } from "@liveagent/ui/i18n/index";
import { getAutomationState, useAutomation } from "@liveagent/ui/lib/automation/index";
import { useChangedFilesActions } from "@liveagent/ui/lib/chat/useChangedFilesActions";
import { useChatFileLinkNavigation } from "@liveagent/ui/lib/chat/useChatFileLinkNavigation";
import {
  useComposerActions,
  useComposerSkillSelection,
  useInsertCodeReviewSkill,
} from "@liveagent/ui/lib/chat/useComposerActions";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
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
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { buildSkillsSystemPrompt, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { terminalSessionBelongsToProject } from "@liveagent/ui/lib/terminal/sessionStore";
import type { LocalTunnelClient } from "@liveagent/ui/lib/tunnels/constants";
import { listen } from "@tauri-apps/api/event";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadComposerUploadedImagePreview } from "../agent-ui-adapters/composerImagePreview";
import { WorkspaceCloneTaskOverlayAdapter } from "../agent-ui-adapters/workspaceCloneTasks";
import { desktopWorkspaceProjectRootClient } from "../agent-ui-adapters/workspaceProjectRoots";
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
import {
  isAgentDevMode,
  isAgentExecutionMode,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
  resolveEffectiveTheme,
  resolveWorkspaceResources,
  type SelectedModel,
  updateExecutionModeFromChatSelection,
  updateWorkspaceResourceSettings,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "../lib/settings";
import { tauriSftpClient } from "../lib/sftp/tauriSftpClient";
import { createGuiSidebarBackend } from "../lib/sidebar/guiSidebarBackend";
import { createSubagentStoreManager } from "../lib/subagents";
import { tauriTerminalClient } from "../lib/terminal/tauriTerminalClient";
import { cancelPendingAskUserQuestionsForConversation } from "../lib/tools/askUserQuestionTools";
import { cancelPendingToolApprovalsForConversation } from "../lib/tools/toolApproval";
import { buildTrayMenuModel, syncTrayMenu } from "../lib/tray/trayMenu";
import { useTrayPrefs } from "../lib/tray/trayPrefs";
import { createTauriTunnelClient } from "../lib/tunnels/tauriTunnelClient";
import { tauriWorkspaceActivityClient } from "../lib/workspace-activity/tauriWorkspaceActivityClient";
import {
  ChatComposerBar,
  ChatTranscript,
  createChatRuntimeHost,
  type EnsureGatewayBridgeConversationReadyOptions,
  MAX_UPLOAD_FILES,
  pruneIdleConversationRuntimeCaches,
  type SendChatAction,
  useChatPageRuntimeStore,
  useChatSkills,
  useConversationHistoryActions,
  useEditResend,
  useGatewayBridgeListeners,
  useLiveTranscriptController,
  usePendingUploads,
} from "./chat";
import type { ChatPageProps } from "./chat/chatPageTypes";
import { CurrentTaskProgress } from "./chat/components/CurrentTaskProgress";
import { PendingToolApprovalBar } from "./chat/components/PendingToolApprovalBar";
import { useComposerDraftCache } from "./chat/composer/useComposerDraftCache";
import { useComposerHistoryPrompts } from "./chat/composer/useComposerHistoryPrompts";
import { useGatewayBridgeReadiness } from "./chat/gateway/useGatewayBridgeReadiness";
import { useGatewayRunMirrorCoordinator } from "./chat/gateway/useGatewayRunMirrorCoordinator";
import { useGatewayStatus } from "./chat/gateway/useGatewayStatus";
import { useBranchConversation } from "./chat/history/useBranchConversation";
import { useSharedHistory } from "./chat/history/useSharedHistory";
import { useContextUsageTokensSource } from "./chat/hooks/useContextUsageTokensSource";
import { useMirroredNullableState } from "./chat/hooks/useMirroredNullableState";
import { useNotifyToasts } from "./chat/hooks/useNotifyToasts";
import { useTauriFileDrop } from "./chat/hooks/useTauriFileDrop";
import {
  getQueuedConversationIds,
  removeQueuedChatTurnsForConversation,
} from "./chat/queue/chatTurnQueue";
import { useChatTurnQueue } from "./chat/queue/useChatTurnQueue";
import { syncMovedConversationRuntimeWorkdir } from "./chat/runtime/chatPageRuntime";
import { useChatModelSelection } from "./chat/runtime/useChatModelSelection";
import {
  type ManualCompactionRequest,
  type ManualCompactionResult,
  useManualCompaction,
} from "./chat/runtime/useManualCompaction";
import { useProjectToolTextGenerationClient } from "./chat/runtime/useProjectToolTextGenerationClient";
import { useSendChatTurn } from "./chat/runtime/useSendChatTurn";
import { ChatSidebarContainer } from "./chat/sidebar/ChatSidebarContainer";
import { useProjectTerminals } from "./chat/workspace/useProjectTerminals";
import { useWorkspaceProjectRemoval } from "./chat/workspace/useWorkspaceProjectRemoval";
import { useWorkspaceProjects } from "./chat/workspace/useWorkspaceProjects";

export function ChatPage(props: ChatPageProps) {
  const {
    settings,
    setSettings,
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
  const { t } = useLocale();
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
  const [hydratingConversationId, setHydratingConversationId, hydratingConversationIdRef] =
    useMirroredNullableState<string>();
  const [
    hydrationFailedConversationId,
    setHydrationFailedConversationId,
    hydrationFailedConversationIdRef,
  ] = useMirroredNullableState<string>();
  const [currentConversationId, setCurrentConversationId] = useState<string>(
    () => initialConversationRef.current.conversationId,
  );
  const [currentConversationSessionId, setCurrentConversationSessionId] = useState<string>(
    () => initialConversationRef.current.sessionId,
  );
  const [currentConversationCreatedAt, setCurrentConversationCreatedAt] = useState(
    () => initialConversationRef.current.createdAt,
  );
  const [currentConversationSelectedModel, setCurrentConversationSelectedModel] = useState<
    SelectedModel | undefined
  >(undefined);
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
    const activeTemplate = settings.agents.find(
      (template) => template.enabled && template.prompt.trim(),
    );
    return activeTemplate?.prompt.trim() ?? "";
  }, [settings.agents]);
  // The sidebar store owns all sidebar domain state (conversation list,
  // workdirs, running set); ChatPage only issues imperative calls and keeps a
  // few narrow selector subscriptions.
  const sidebarStore = useMemo(() => createSidebarStore(createGuiSidebarBackend()), []);
  useEffect(() => {
    sidebarStore.start();
    return () => {
      sidebarStore.stop();
    };
  }, [sidebarStore]);
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
  const currentRequestContext = useMemo(
    () => buildRequestContext(conversationState),
    [conversationState],
  );
  const chatRuntimeHost = useMemo(() => createChatRuntimeHost(), []);

  const scrollFollowRef = useRef<ScrollFollowHandle | null>(null);
  const composerBusyRef = useRef(false);
  const composerRef = useRef<MentionComposerHandle | null>(null);
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
  const {
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
  } = useGatewayRunMirrorCoordinator();

  // 用量环读数：与 WebUI 同一把共享扫描器（deriveContextUsageTokens），
  // 历史项 + 流式实时轮次（live store 每帧批量提交）联合倒扫。经订阅源
  // 直达环组件，流式读数逐帧更新而不回流 ChatPage。
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
    currentConversationSessionId,
    currentConversationCreatedAt,
    currentConversationSelectedModel,
    setConversationState,
    setCompactionStatus,
    setIsSending,
    setErrorMessage,
    setHookWarning,
    setCurrentConversationSessionId,
    setCurrentConversationCreatedAt,
    setCurrentConversationSelectedModel,
    setRunningConversationIds,
  });
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
    setHydratingConversationId(null);
    setHydrationFailedConversationId(null);
  }

  const isDraftConversation = !historyItems.some((item) => item.id === currentConversationId);

  const approvalBar = <PendingToolApprovalBar conversationId={currentConversationId} />;
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
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  const {
    terminalSessions,
    setTerminalSessions,
    terminalSessionsLoaded,
    handleRightDockSessionsChange,
  } = useProjectTerminals({
    terminalProjectPathKey,
    requestConfirmDialog,
    t,
    setErrorMessage,
  });
  const projectTerminalSessions = useMemo(
    () =>
      terminalProjectPathKey
        ? terminalSessions.filter((session) =>
            terminalSessionBelongsToProject(session, terminalProjectPathKey),
          )
        : [],
    [terminalProjectPathKey, terminalSessions],
  );
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
  const handleOpenChatFileLink = useChatFileLinkNavigation({
    conversationId: currentConversationId,
    conversationWorkdir: displayedConversationWorkdir,
    terminalProjectPathKey,
    notifyError: notifyChatFileLinkError,
    onRevealInFileTree: handleChangedFileReveal,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
  });

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
    currentConversationIdRef,
    composerRef,
    setErrorMessage,
    addNotify,
  });
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
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

  const {
    composerDraftCacheRef,
    cacheActiveComposerDraft,
    prepareComposerForConversationChange,
    restoreCachedComposerDraft,
    clearCachedComposerDraft,
    deleteCachedComposerDraftState,
  } = useComposerDraftCache({
    composerRef,
    currentConversationIdRef,
    activeView,
    currentConversationId,
  });

  prepareComposerForConversationChangeActionRef.current = prepareComposerForConversationChange;

  const {
    queuedChatTurnsRef,
    queuedChatTurnEditSlotRef,
    setQueuedChatTurnsState,
    queuedChatTurnsForCurrentConversation,
    publishChatQueueSnapshots,
    collectChatQueueSnapshotConversationIds,
    stopSending,
    stopConversation,
    enqueueCurrentComposerTurn,
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
    [deleteConversationArtifacts, setPendingUploadsForConversation, setQueuedChatTurnsState],
  );

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
          cancelPendingAskUserQuestionsForConversation(conversationId);
          cancelPendingToolApprovalsForConversation(conversationId);
        },
      });
    },
    [
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      deleteConversationLocalCaches,
      isConversationRunning,
      conversationPersistenceCursorRef,
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
    getDefaultNewConversationWorkdir: () =>
      isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    resolveConversationSelectedModel: (json) =>
      normalizeSelectedModelForProviders(parseSelectedModelJson(json), settings.customProviders),
    setCurrentConversationId,
    setErrorMessage,
    setHydratingConversationId,
    setHydrationFailedConversationId,
  });

  startNewConversationActionRef.current = startNewConversation;
  openInitialActionRef.current = openConversationInitial;
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
    hydratingConversationIdRef,
    hydrationFailedConversationIdRef,
    setHydratingConversationId,
    setHydrationFailedConversationId,
  });

  ensureGatewayBridgeConversationReadyRef.current = ensureGatewayBridgeConversationReady;

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
    // Per-conversation pending uploads are restored inside usePendingUploads
    // when its conversationId param changes.
  }, [currentConversationId]);

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
      hydratingConversationId === currentConversationId ||
      hydrationFailedConversationId === currentConversationId ||
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
    historyItems,
    hydrationFailedConversationId,
    hydratingConversationId,
    isSending,
    openController,
    pendingUploadedFiles,
  ]);

  useEffect(() => {
    hydratingConversationIdRef.current = hydratingConversationId;
  }, [hydratingConversationId]);

  useEffect(() => {
    hydrationFailedConversationIdRef.current = hydrationFailedConversationId;
  }, [hydrationFailedConversationId]);

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
    hydratingConversationIdRef,
    hydrationFailedConversationIdRef,
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
    activeAgentPrompt,
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
        return { skillsPrompt: "", memoryPrompt: "" };
      }
      const promptWorkdir = input.workdir?.trim() ?? "";
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
      return { skillsPrompt, memoryPrompt };
    },
    [availableSkills, isAgentMode, settings, skillsRootDir],
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
    activeAgentPrompt,
    resolveManualCompactionPromptInputs,
  });
  manualCompactActionRef.current = handleManualCompact;

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
  }, [activeWorkspaceProjectPath, isAgentMode, openController]);

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
      restoreCachedComposerDraft(targetConversationId);
    },
    [openController],
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
  }, []);

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

  const handleSend = useCallback(() => {
    const conversationId = currentConversationIdRef.current.trim();
    const runtimeEntry = conversationRuntimeCacheRef.current.get(conversationId);
    if (queuedChatTurnEditSlotRef.current?.conversationId === conversationId) {
      if (enqueueCurrentComposerTurn("edit")) {
        requestQueuedChatTurnProcessing(conversationId);
      }
      return;
    }
    if (conversationId && (isConversationRunning(conversationId) || runtimeEntry?.isSending)) {
      enqueueCurrentComposerTurn("end");
      return;
    }
    void sendActionRef.current();
  }, [enqueueCurrentComposerTurn, isConversationRunning]);

  const handleStopSending = useCallback(() => {
    stopSendingActionRef.current();
  }, []);

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
  const isConversationHydrating = hydratingConversationId === currentConversationId;
  const isConversationHydrationFailed = hydrationFailedConversationId === currentConversationId;
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
  const { isFileDropActive } = useTauriFileDrop({
    canDropUpload,
    fileDropTitle,
    importReadableFilePaths,
    setErrorMessage,
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

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <MacOsTitleBarToggle
          sidebarOpen={sidebarOpen}
          onToggle={handleToggleSidebar}
          onOpenSettings={() => onOpenSettings()}
          appUpdate={appUpdate}
        />
        {/* ---- Sidebar ---- */}
        <ChatSidebarContainer
          store={sidebarStore}
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
          chat={{
            onSelectExecutionMode: (mode) =>
              setSettings((prev) => updateExecutionModeFromChatSelection(prev, mode)),
            hasModels,
            currentModelLabel,
            modelOptions,
            selectedValue,
            sidebarOpen,
            onSelectModel: handleSelectModel,
            onOpenSettings,
            onToggleTheme,
            onOpenSidebar: handleOpenSidebar,
            trailingActions: (
              <ProjectToolsPanelToggle
                isOpen={rightDockOpen}
                sessionCount={projectTerminalSessions.length}
                disabledMessage={terminalDisabledMessage}
                onToggle={() => setRightDockOpen((open) => !open)}
              />
            ),
            headerClassName: "relative z-20",
            headerOverlay: <NotifyToast items={notifyItems} onDismiss={dismissNotify} />,
            content: (
              <>
                <ChangedFilesActionsProvider value={changedFilesActions}>
                  <ChatTranscript
                    conversationId={currentConversationId}
                    workspaceRoot={currentConversationWorkspaceRoot}
                    gitClient={tauriGitClient}
                    followRef={scrollFollowRef}
                    hasModels={hasModels}
                    historyItems={transcriptItems}
                    hasMoreHistory={conversationState.transcript.hasMoreBefore}
                    onLoadEarlierHistory={handleLoadEarlierHistory}
                    isHistorySwitching={conversationOpenState.showOverlay}
                    isSending={isSending}
                    isAgentMode={isAgentMode}
                    showUsage={isAgentDevExecutionMode}
                    usageContextWindow={currentModelContextWindow}
                    liveTranscriptStore={liveTranscriptStore}
                    isCompactionRunning={isCompactionRunning}
                    bottomReservePx={composerOverlayHeight}
                    contentWidth={settings.customSettings.chatTranscript.width}
                    onContentWidthChange={handleChatTranscriptWidthChange}
                    onOpenFileLink={handleOpenChatFileLink}
                    onResendFromEdit={handleResendFromEdit}
                    onBranchConversation={
                      // 会话加载中或加载失败时直接不传操作，展示明确的禁用态。
                      isConversationHydrating || isConversationHydrationFailed
                        ? undefined
                        : handleBranchConversation
                    }
                    branchPendingMessageId={branchPendingMessageId}
                    onOpenSettings={onOpenSettings}
                    onSuggestionSelect={handleEmptyStateSuggestion}
                    suggestionsDisabled={isSuggestionTyping}
                  />
                </ChangedFilesActionsProvider>

                <ChatComposerBar
                  surface="desktop"
                  composerRef={composerRef}
                  isSending={isSending}
                  isUploadingFiles={isUploadingFiles}
                  isInputDisabled={isComposerInputDisabled}
                  inputPlaceholder={composerPlaceholder}
                  workdir={displayedConversationWorkdir}
                  enabledSkills={enabledComposerSkills}
                  isAgentMode={isAgentMode}
                  chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                  reasoningOptions={chatRuntimeReasoningOptions}
                  thinkingAlwaysOn={chatRuntimeThinkingAlwaysOn}
                  contextUsageTokensSource={contextUsageTokensSource}
                  contextWindow={currentModelContextWindow}
                  onManualCompactConfirm={handleManualCompact}
                  manualCompactBlocked={isCompactionRunning}
                  gitClient={tauriGitClient}
                  workspaceActivityClient={tauriWorkspaceActivityClient}
                  onOpenWorktree={handleOpenWorktree}
                  onWorktreeRemoved={handleWorktreeRemoved}
                  onSend={handleSend}
                  onStop={handleStopSending}
                  onComposerBusyChange={handleComposerBusyChange}
                  onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                  onPickReadableFiles={pickReadableFiles}
                  onPasteFiles={importReadableFiles}
                  onLoadUploadedImagePreview={loadComposerUploadedImagePreview}
                  loadHistoryPrompts={loadComposerHistoryPrompts}
                  pendingUploadedFiles={pendingUploadedFiles}
                  onRemovePendingUpload={removePendingUpload}
                  queuedTurns={queuedChatTurnsForCurrentConversation}
                  onRunQueuedTurnNow={runQueuedTurnNow}
                  onMoveQueuedTurnUp={moveQueuedTurnUp}
                  onEditQueuedTurn={editQueuedTurn}
                  onRemoveQueuedTurn={removeQueuedTurn}
                  onHeightChange={setComposerOverlayHeight}
                  taskProgressBar={
                    <CurrentTaskProgress
                      key={currentConversationId}
                      historyItems={transcriptItems}
                      liveTranscriptStore={liveTranscriptStore}
                      isConversationRunning={
                        isSending || isConversationRunning(currentConversationId)
                      }
                    />
                  }
                  approvalBar={approvalBar}
                />
                {isFileDropActive ? (
                  <FileDropOverlay
                    canDropUpload={canDropUpload}
                    title={fileDropTitle}
                    description={fileDropDescription}
                    limitHint={fileDropLimitHint}
                  />
                ) : null}
              </>
            ),
          }}
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
