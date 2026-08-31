import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { AppWorkbenchChrome } from "@liveagent/ui/application/AppWorkbenchChrome";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { ConversationViewTabs } from "@liveagent/ui/components/chat/ConversationViewTabs";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import { HistoryShareModal } from "@liveagent/ui/components/chat/HistoryShareModal";
import { NotifyToast } from "@liveagent/ui/components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { WorkspaceCloneModal } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import { WorkspaceCloneTaskOverlay } from "@liveagent/ui/components/chat/WorkspaceCloneTaskOverlay";
import { WorkspaceProjectSettingsModal } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { FileTreePaneSurface } from "@liveagent/ui/components/project-tools/file-tree/index";
import { ProjectToolsPanelToggle } from "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle";
import { RightDockPanel } from "@liveagent/ui/components/project-tools/RightDockPanel";
import { TrajectoryView } from "@liveagent/ui/components/trajectory/TrajectoryView";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { PaneChrome } from "@liveagent/ui/components/workbench/PaneChrome";
import { UnsupportedPaneSurface } from "@liveagent/ui/components/workbench/surfaces/UnsupportedPaneSurface";
import { WorkbenchCanvas } from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import { WorkbenchEmptyState } from "@liveagent/ui/components/workbench/WorkbenchEmptyState";
import { WorkspaceOverlayHost } from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { LocaleContext, t as translate } from "@liveagent/ui/i18n/index";
import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
  formatCheckpointRewoundNotification,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@liveagent/ui/lib/chat/uploadedFiles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { toTrajectoryMessages } from "@liveagent/ui/lib/trajectory/transcriptMessages";
import { useConversationViewState } from "@liveagent/ui/lib/trajectory/useConversationViewState";
import { findPaneIdBySurfaceKey, hitTestWorkbenchDrop } from "@liveagent/ui/lib/workbench/index";
import type { PaneRecord } from "@liveagent/ui/lib/workbench/types";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { FloorNavRail } from "@liveagent/ui/pages/chat/transcript/FloorNavRail";
import {
  CHAT_TRANSCRIPT_WIDTH_CSS_VAR,
  TranscriptWidthControls,
} from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import { SettingsPage } from "@liveagent/ui/pages/settings/SettingsPage";
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createGatewayTrajectoryHost } from "@/agent-ui-adapters/trajectory";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import type { SttProviderId } from "@/lib/settings";
import {
  getNextTheme,
  getRightDockFileTreeState,
  normalizeChatRuntimeControlsForProvider,
  resolvePromptClarifyModel,
  updateExecutionModeFromChatSelection,
  updateRightDockFileTreeState,
  updateSystem,
  updateWorkspaceResourceSettings,
  workspaceProjectPathKey,
} from "@/lib/settings";
import { createWebSttSettingsService } from "@/lib/stt/webSttSettingsService";
import { webSttTransport } from "@/lib/stt/webSttTransport";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";
import { WorkdirPickerModal } from "@/pages/settings/WorkdirPickerModal";
import { AgentSelector } from "./AgentSelector";
import { ConversationStatsBarHost } from "./ConversationStatsBarHost";
import { asErrorMessage } from "./chatEventUtils";
import { CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS } from "./constants";
import type { GatewayAppViewModel } from "./GatewayApp";
import { isLocalDraftConversationId } from "./gatewayLocalDraft";
import { HistorySwitchLoadingOverlay } from "./HistorySwitchLoadingOverlay";
import { useWindowFileDropGuard } from "./hooks/useWindowFileDropGuard";
import { GatewaySidebarContainer } from "./sidebar/GatewaySidebarContainer";
import { UserMenu } from "./UserMenu";
import {
  GatewayConversationPaneHost,
  type GatewayConversationPaneHostContext,
  type GatewayConversationPrimarySurface,
} from "./workbench/GatewayConversationPaneHost";
import { GatewayTerminalPaneHost } from "./workbench/GatewayTerminalPaneHost";
import { sessionWorkbench } from "./workbench/sessionWorkbench";

export function GatewayAppView({ viewModel }: { viewModel: GatewayAppViewModel }) {
  useWindowFileDropGuard();
  const {
    activeFloorKey,
    activeSelectedModel,
    activeView,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    addNotify,
    api,
    approvalBar,
    approvalConversationIds,
    archivedWorkspaceProjectPathKeys,
    associatedSshHostIds,
    availableSkills,
    branchPendingMessageId,
    canDropUpload,
    canShareHistory,
    cancelChat,
    changedFilesActions,
    chatError,
    chatProtocolIncompatibleMessage,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    closeSettings,
    codeReviewSkill,
    commitQueuedChatEdit,
    composerCompactionBlocked,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    composerRef,
    confirmDialog,
    contextUsageTokensSource,
    conversationOpenState,
    currentChatProvider,
    currentModelContextWindow,
    currentModelLabel,
    dismissNotify,
    displayedConversationBusyRef,
    displayedConversationId,
    displayedConversationWorkdir,
    displayedTranscript,
    displayedTranscriptRowCount,
    editQueuedTurn,
    effectiveTheme,
    enabledComposerSkills,
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    fileInputRef,
    folderInputRef,
    gatewayConnectionLost,
    getCachedComposerDraft,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
    subscribePendingUploads,
    gitClient,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleActiveAgentChange,
    handleArchiveWorkspaceProject,
    handleBranchConversation,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleChatRuntimeControlsChange,
    handleChatTranscriptWidthChange,
    handleCloneWorkspaceProject,
    handleCloseShareModal,
    handleCommitWorkspaceProjectRename,
    handleComposerBusyChange,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDisableSharedHistory,
    handleDismissWorkspaceCloneTask,
    handleEmptyStateSuggestion,
    handleFileDragEnter,
    handleFileDragLeave,
    handleFileDragOver,
    handleFileDrop,
    handleFloorJump,
    handleGitReviewFocusRequestHandled,
    handleImportReadableFiles,
    handleImportSelectedDirectoryFiles,
    handleInsertCodeMention,
    handleLoadEarlierHistory,
    handleLoadSharedHistoryStatus,
    handleLoadUploadedImagePreview,
    handleLoadWorkspaceRemoteBranches,
    handleLogout,
    handleManualCompact,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenChatFileLink,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    handleOpenWorkspaceFile,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleProjectTerminalSessionsChange,
    handleRefreshSharedHistoryStatuses,
    handleRemoveWorkspaceProject,
    handleRenameWorkspaceGroup,
    handleResendFromEdit,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSelectModel,
    handleSelectWorkspaceProject,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleSetWorkspaceProjectPinned,
    handleSettingsTransitionEnd,
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
    handleSidebarNewConversation,
    handleSidebarOpenMcpHub,
    handleSidebarOpenSkillsHub,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleSidebarSelectConversation,
    handleSshProjectHostIdsChange,
    handleToggleHistoryShare,
    handleToggleWorkspaceGroupCollapsed,
    handleUnarchiveWorkspaceProject,
    handleWorkdirPickerSelect,
    handleWorkspaceEditorClosed,
    handleWorkspaceEditorHide,
    handleWorkspaceFilePreviewClosed,
    handleWorktreeRemoved,
    hideWorkspaceSshTerminalOverlay,
    historyDetailLoadingTitle,
    historyShareToken,
    importFilesForConversation,
    isAgentDevExecutionMode,
    isAgentMode,
    isConversationBusy,
    isFileDropActive,
    isImportingPastedTextRef,
    isSuggestionTyping,
    isUploadingFiles,
    uploadingConversationId,
    loadComposerHistoryPrompts,
    loadingOlderHistory,
    localeContextValue,
    manualCompactPending,
    manualCompactTransientConversations,
    mentionableConversations,
    searchMentionableConversations,
    materializeComposerDraftForSend,
    mentionApps,
    missingWorkspaceProjectPathKeys,
    modelOptions,
    moveQueuedTurnUp,
    notifyItems,
    openSettings,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    overlay,
    pendingUploadedFiles,
    prepareChatRuntime,
    projectPickerOpen,
    projectTerminalSessions,
    projectToolsDisabledMessage,
    queuedChatEditSessionRef,
    queuedChatTurnsForDisplayedConversation,
    removeQueuedTurn,
    requestWorkspaceFilePreviewClose,
    projectSettingsProject,
    rightDockFileTreeState,
    rightDockOpen,
    rightDockProjectState,
    runQueuedTurnNow,
    selectedHistoryHasMore,
    selectedValue,
    selectionForConversation,
    sendChat,
    setActiveFloorKey,
    setCachedComposerDraft,
    setPendingUploadsForConversation,
    setProjectPickerOpen,
    setProjectSettingsProject,
    setRightDockOpen,
    setSettings,
    setSharedManagerOpen,
    setSidebarOpen,
    setTranscriptScrollAreaRoot,
    setTranscriptViewport,
    setUserMenuOpen,
    setWorkspaceCreateModalOpen,
    settings,
    settingsOpen,
    settingsProviderId,
    settingsSaveState,
    settingsSection,
    settingsSyncError,
    sftpClient,
    shareConversation,
    shareError,
    shareLoading,
    shareStatus,
    shareUpdating,
    sharedHistoryItems,
    sharedHistoryListError,
    sharedManagerErrors,
    sharedManagerLoadingIds,
    sharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerUpdatingIds,
    sidebarActionError,
    sidebarOpen,
    sidebarSectionsDisabled,
    sidebarStore,
    skillsRootDir,
    status,
    statusError,
    submitCurrentComposerToGuiQueue,
    submitInFlightRef,
    taskProgressSnapshot,
    terminalClient,
    terminalDisabledMessage,
    terminalProjectPath,
    terminalProjectPathKey,
    terminalSessions,
    terminalSessionsLoaded,
    transcriptBusy,
    transcriptError,
    transcriptFloors,
    transcriptFollow,
    transcriptFollowing,
    transcriptHistoryLoading,
    transcriptLiveStartIndex,
    transcriptNavRef,
    transcriptRows,
    transcriptStageRef,
    transcriptStoreRegistry,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
    transcriptViewport,
    tunnelDisabledMessage,
    tunnelEnabled,
    updatePendingUploadsForConversation,
    verifyTerminalSessionAlive,
    userAvatarLabel,
    userMenuLabel,
    userMenuOpen,
    workbenchController,
    workdirForConversation,
    workspaceActivityClient,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceEditorCleanupPending,
    workspaceEditorCloseRequestId,
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorOpenRequest,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceFolderDropActive,
    workspaceFolderDropHandlers,
    workspaceProjects,
    workspaceProjectRootClient,
    workspaceRootRevision,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
  } = viewModel;
  const [sttProviderOverride, setSttProviderOverride] = useState<SttProviderId | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Saved provider changes invalidate the temporary card selection.
  useEffect(() => {
    setSttProviderOverride(null);
  }, [settings.stt.provider]);
  const sttSettingsService = useMemo(
    () =>
      createWebSttSettingsService(async (sttSecretUpdate) => {
        if (!api) throw new Error("桌面 Agent 未连接，无法同步 STT 配置");
        await api.updateSettings({ sttSecretUpdate });
      }),
    [api],
  );

  const {
    activeConversationView,
    setActiveConversationView,
    viewForConversation,
    setConversationView,
  } = useConversationViewState(displayedConversationId);
  const trajectoryHost = useMemo(
    () => createGatewayTrajectoryHost(api, handleOpenChatFileLink),
    [api, handleOpenChatFileLink],
  );
  // 正文只在切到轨迹页时才需要；转换本身很轻，跟随转录行 memo 即可。
  const trajectoryMessages = useMemo(() => toTrajectoryMessages(transcriptRows), [transcriptRows]);
  const hasConversationReply =
    displayedConversationId !== "" &&
    !isLocalDraftConversationId(displayedConversationId) &&
    trajectoryMessages.some((message) => message.role === "assistant");
  const renderedConversationView = hasConversationReply ? activeConversationView : "conversation";
  // 实时骨架来自 ChatEvent 流；账本层按事件身份去重，所以与落盘那份合并安全。
  const liveTrajectory = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryEvents(displayedConversationId),
  );
  const trajectoryAuthoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(displayedConversationId),
  );
  const handleSelectExecutionMode = useCallback(
    (mode: "text" | "tools") =>
      setSettings((prev) => updateExecutionModeFromChatSelection(prev, mode)),
    [setSettings],
  );
  // 语音输入失败（麦克风不可用等）以 toast 提示，不占用输入框区域。
  const handleSttError = useCallback((message: string) => addNotify("error", message), [addNotify]);
  const resolveCheckpointAuthorizedRoots = useCallback(async () => {
    const roots: string[] = [];
    const push = (value?: string | null) => {
      const normalized = value?.trim();
      if (normalized && !roots.includes(normalized)) roots.push(normalized);
    };
    push(displayedConversationWorkdir);
    if (
      activeWorkspaceProject &&
      activeWorkspaceProjectPath &&
      activeWorkspaceProjectPath === displayedConversationWorkdir
    ) {
      try {
        const grants = await api.listWorkspaceRootGrants(
          activeWorkspaceProject.id,
          activeWorkspaceProject.path,
        );
        for (const grant of grants) {
          if (grant.state === "active" && grant.access === "write") push(grant.canonicalPath);
        }
      } catch {
        // Keep the primary root when additional grant lookup fails.
      }
    }
    return roots;
  }, [activeWorkspaceProject, activeWorkspaceProjectPath, api, displayedConversationWorkdir]);
  const checkpointClient = useMemo<CheckpointRewindClient>(
    () => ({
      list: (conversationId) => api.listCheckpointTurns(conversationId),
      preview: (params) => api.previewCheckpointRewind(params),
      rewind: (params) => api.rewindCheckpoint(params),
    }),
    [api],
  );

  const handleCheckpointRewound = useCallback(
    (info: CheckpointRewoundInfo) => {
      const notice = formatCheckpointRewoundNotification(info, settings.locale === "zh-CN");
      addNotify(notice.level, notice.message);
    },
    [addNotify, settings.locale],
  );
  // 提示词澄清执行器：经 gateway 中继到桌面宿主，用当前会话模型跑一轮纯文本补全。
  // Web 端无轻量 git 分支状态，gitBranch 传空串（spec 允许只喂 workdir 的轻量上下文）。
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    async (messages, _signal) => {
      // 设置里的「澄清对话模型」优先；未选或失效时回退当前对话模型。覆盖
      // 生效时 runtime controls 按覆盖供应商/模型重新归一化。
      const override = resolvePromptClarifyModel(settings);
      const provider = override?.provider ?? currentChatProvider;
      const model = override?.model ?? activeSelectedModel?.model;
      if (!provider || !model) {
        throw new Error("no active model selected");
      }
      const result = await api.clarifyPromptTurn({
        messages,
        providerId: provider.id,
        model,
        requestFormat: provider.requestFormat ?? "",
        runtimeControls: override
          ? normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
              providerId: provider.type,
              requestFormat: provider.requestFormat,
              modelId: model,
            })
          : chatRuntimeControlsForCurrentProvider,
        workdir: displayedConversationWorkdir,
        gitBranch: "",
      });
      if (result.error_code) {
        throw new Error(result.error_message || result.error_code);
      }
      return result.final_text;
    },
    [
      settings,
      activeSelectedModel,
      currentChatProvider,
      chatRuntimeControlsForCurrentProvider,
      displayedConversationWorkdir,
      api,
    ],
  );

  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (displayedConversationWorkdir ? { workdir: displayedConversationWorkdir } : undefined),
    [displayedConversationWorkdir],
  );

  // --- Session Workbench（多看板分屏）----------------------------------------
  // Pane 标题/无障碍标签取自侧栏权威索引；标题变化需要触发重渲染，所以走
  // useSidebarSelector 而不是 store.peek。
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (snapshot) => snapshot.byId);
  // 与桌面端 workbenchPaneTitle 同口径:chrome 提示、拖拽幽灵与无障碍标签共用。
  const workbenchPaneTitle = useCallback(
    (surface: PaneRecord["surface"]): string => {
      switch (surface.kind) {
        case "conversation":
          return sidebarConversationsById.get(surface.conversationId)?.title?.trim() || "";
        case "fileTree":
          return translate("projectTools.fileTreeTitle", settings.locale);
        case "localTerminal":
          return surface.launchSpec.title?.trim() || surface.launchSpec.shell?.trim() || "Terminal";
        case "sshTerminal":
          return surface.launchSpec.title?.trim() || surface.launchSpec.sshHostId.trim() || "SSH";
        case "unsupported":
          return surface.originalKind;
      }
    },
    [settings.locale, sidebarConversationsById],
  );

  const workbenchHasMultiplePanes =
    sessionWorkbench.enabled && Object.keys(workbenchController.workbench.layout.panes).length >= 2;
  const primarySendInFlightConversationRef = useRef<string | null>(null);

  const handlePrimaryComposerSend = useCallback(() => {
    const sendConversationId = getDisplayedConversationId();
    if (primarySendInFlightConversationRef.current === sendConversationId) return;
    // 上传在途只封锁归属会话:背景 Pane 的导入不应吞掉主 Pane 的发送。
    // 归属未知(null)时保守封锁,与旧全局互斥语义一致。
    const uploadBlocksSend =
      isUploadingFiles &&
      (!uploadingConversationId || uploadingConversationId === sendConversationId);
    if (uploadBlocksSend || isImportingPastedTextRef.current) return;
    if (composerInputDisabled) return;
    if (queuedChatEditSessionRef.current) {
      primarySendInFlightConversationRef.current = sendConversationId;
      void (async () => {
        try {
          await commitQueuedChatEdit();
        } finally {
          if (primarySendInFlightConversationRef.current === sendConversationId) {
            primarySendInFlightConversationRef.current = null;
          }
        }
      })();
      return;
    }
    if (
      displayedConversationBusyRef.current ||
      queuedChatTurnsForDisplayedConversation.length > 0
    ) {
      primarySendInFlightConversationRef.current = sendConversationId;
      void (async () => {
        try {
          await submitCurrentComposerToGuiQueue("append");
        } finally {
          if (primarySendInFlightConversationRef.current === sendConversationId) {
            primarySendInFlightConversationRef.current = null;
          }
        }
      })();
      return;
    }
    primarySendInFlightConversationRef.current = sendConversationId;
    void (async () => {
      try {
        const draft = composerRef.current?.getDraft() ?? null;
        let text: string;
        let files: PendingUploadedFile[];
        let referencedConversations = draft?.conversationMentions ?? [];
        try {
          const materialized = draft
            ? await materializeComposerDraftForSend(
                draft,
                pendingUploadedFiles,
                displayedConversationWorkdir,
                sendConversationId,
              )
            : { text: "", uploadedFiles: pendingUploadedFiles, referencedConversations: [] };
          text = materialized.text;
          files = materialized.uploadedFiles;
          referencedConversations = materialized.referencedConversations;
        } catch (error) {
          addNotify("error", asErrorMessage(error, "大段粘贴内容导入失败"));
          return;
        }
        if (!text && files.length === 0) return;
        if (getDisplayedConversationId() === sendConversationId) {
          composerRef.current?.clear();
        }
        setPendingUploadsForConversation(sendConversationId, []);
        void sendChat(text, {
          conversationId: sendConversationId,
          uploadedFiles: files,
          referencedConversations,
          runtimeControls: chatRuntimeControlsForCurrentProvider,
        }).catch(() => {
          updatePendingUploadsForConversation(sendConversationId, (current) =>
            mergePendingUploadedFiles(current, files),
          );
        });
      } finally {
        if (primarySendInFlightConversationRef.current === sendConversationId) {
          primarySendInFlightConversationRef.current = null;
        }
      }
    })();
  }, [
    addNotify,
    chatRuntimeControlsForCurrentProvider,
    commitQueuedChatEdit,
    composerInputDisabled,
    composerRef,
    displayedConversationBusyRef,
    displayedConversationWorkdir,
    getDisplayedConversationId,
    isImportingPastedTextRef,
    isUploadingFiles,
    uploadingConversationId,
    materializeComposerDraftForSend,
    pendingUploadedFiles,
    queuedChatEditSessionRef,
    queuedChatTurnsForDisplayedConversation.length,
    sendChat,
    setPendingUploadsForConversation,
    submitCurrentComposerToGuiQueue,
    updatePendingUploadsForConversation,
  ]);

  const handlePrimaryComposerStop = useCallback(() => {
    const nextQueuedTurn = queuedChatTurnsForDisplayedConversation[0];
    if (nextQueuedTurn) {
      runQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    void cancelChat(displayedConversationId);
  }, [
    cancelChat,
    displayedConversationId,
    queuedChatTurnsForDisplayedConversation,
    runQueuedTurnNow,
  ]);

  // 背景会话 Pane 的共享上下文(复刻桌面端 buildBackgroundPaneBinding):所有
  // 会话级动作按 Pane 自己的 conversationId 显式路由;页面级机制(选模型、
  // 编辑队列项等)由宿主内部先聚焦本 Pane(focusGuard 口径)。
  const conversationPaneHostContext: GatewayConversationPaneHostContext = {
    api,
    registry: transcriptStoreRegistry,
    settings,
    hasModels: modelOptions.length > 0,
    showUsage: isAgentDevExecutionMode,
    isInputDisabled: composerInputDisabled,
    transportInputDisabled: !status?.online || Boolean(chatProtocolIncompatibleMessage),
    uploadingConversationId,
    inputPlaceholder: composerPlaceholder,
    modelOptions,
    enabledSkills: enabledComposerSkills,
    mentionableConversations,
    searchMentionableConversations,
    mentionApps,
    contextDisplayMode: settings.customSettings.composerContextDisplay,
    commandSafetyMode: settings.system.commandSafetyMode,
    onCommandSafetyModeChange: (mode) =>
      setSettings((prev) =>
        prev.system.commandSafetyMode === mode
          ? prev
          : updateSystem(prev, { commandSafetyMode: mode }),
      ),
    sttProvider: settings.stt.enabled
      ? (sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud")
      : null,
    sttProviderConfigured:
      settings.stt.providers[sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud"]
        ?.configured,
    sttTransport: webSttTransport,
    onSttError: handleSttError,
    gitClient,
    gitWriteEnabled: settings.remote.enableWebGit,
    gitDisabledMessage,
    workspaceActivityClient,
    onOpenWorktree: handleOpenWorktree,
    onWorktreeRemoved: handleWorktreeRemoved,
    openSettings,
    onOpenFileLink: handleOpenChatFileLink,
    onLoadUploadedImagePreview: handleLoadUploadedImagePreview,
    transcriptContentWidth: settings.customSettings.chatTranscript.width,
    selectionForConversation,
    workdirForConversation,
    isConversationBusy,
    sendChat,
    cancelChat,
    materializeComposerDraftForSend,
    getPendingUploads: getPendingUploadsForConversation,
    subscribePendingUploads,
    updatePendingUploads: updatePendingUploadsForConversation,
    importFilesForConversation,
    getCachedComposerDraft,
    setCachedComposerDraft,
    notifyError: (message) => addNotify("error", message),
    trajectoryHost,
  };

  // 文件拖入时按指针命中聚焦会话 Pane,使 overlay 落在焦点输入框(桌面端
  // workbenchNativeDropHoverRef 同口径;Web 走 HTML5 DnD)。
  const lastFileDropHoverPaneRef = useRef<string | null>(null);
  const focusWorkbenchPaneUnderPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!sessionWorkbench.enabled) return;
      const geometry = workbenchController.geometryRef.current;
      const canvasElement = document.querySelector("[data-workbench-canvas]");
      if (!geometry || !canvasElement) return;
      const canvasRect = canvasElement.getBoundingClientRect();
      const target = hitTestWorkbenchDrop(
        geometry,
        clientX - canvasRect.left,
        clientY - canvasRect.top,
      );
      const paneId =
        target && (target.kind === "pane-center" || target.kind === "pane-edge")
          ? target.paneId
          : null;
      if (!paneId || paneId === lastFileDropHoverPaneRef.current) return;
      lastFileDropHoverPaneRef.current = paneId;
      if (workbenchController.workbench.layoutRef.current.focusedPaneId !== paneId) {
        workbenchController.handleFocusPane(paneId);
      }
    },
    [workbenchController],
  );
  const handleChatFileDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragEnter(event);
      focusWorkbenchPaneUnderPoint(event.clientX, event.clientY);
    },
    [focusWorkbenchPaneUnderPoint, handleFileDragEnter],
  );
  const handleChatFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragOver(event);
      focusWorkbenchPaneUnderPoint(event.clientX, event.clientY);
    },
    [focusWorkbenchPaneUnderPoint, handleFileDragOver],
  );
  const handleChatFileDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragLeave(event);
      lastFileDropHoverPaneRef.current = null;
    },
    [handleFileDragLeave],
  );
  const handleChatFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      lastFileDropHoverPaneRef.current = null;
      handleFileDrop(event);
    },
    [handleFileDrop],
  );

  const primaryConversationSurface: GatewayConversationPrimarySurface = {
    isSending: composerIsSending,
    // 上传态只归属目标会话:背景 Pane 的导入不在主 Pane 显示"上传中"。
    isUploadingFiles:
      isUploadingFiles &&
      (!uploadingConversationId || uploadingConversationId === displayedConversationId),
    isInputDisabled: composerInputDisabled,
    onSend: handlePrimaryComposerSend,
    onStop: handlePrimaryComposerStop,
    onSelectModel: handleSelectModel,
    onSelectExecutionMode: handleSelectExecutionMode,
    onChatRuntimeControlsChange: handleChatRuntimeControlsChange,
    onPrepareChatRuntime: () => {
      if (!api || historyShareToken) return;
      void prepareChatRuntime(
        "composer-focus",
        api,
        CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
      ).catch(() => undefined);
    },
    onComposerBusyChange: handleComposerBusyChange,
    onPickReadableFiles: () => fileInputRef.current?.click(),
    onPickWorkspaceFolder: () => folderInputRef.current?.click(),
    onPasteFiles: handleImportReadableFiles,
    loadHistoryPrompts: loadComposerHistoryPrompts,
    pendingUploadedFiles,
    onRemovePendingUpload: (relativePath) => {
      updatePendingUploadsForConversation(getDisplayedConversationId(), (current) =>
        current.filter((file) => file.relativePath !== relativePath),
      );
    },
    queuedTurns: queuedChatTurnsForDisplayedConversation,
    onRunQueuedTurnNow: runQueuedTurnNow,
    onMoveQueuedTurnUp: moveQueuedTurnUp,
    onEditQueuedTurn: editQueuedTurn,
    onRemoveQueuedTurn: removeQueuedTurn,
    onManualCompactConfirm: handleManualCompact,
    manualCompactBlocked: manualCompactPending || composerCompactionBlocked,
    approvalBar,
    taskProgressBar: (
      <TaskProgressBar
        key={displayedConversationId}
        snapshot={taskProgressSnapshot}
        isConversationRunning={transcriptBusy}
      />
    ),
    statsBar: (
      <ConversationStatsBarHost
        key={`stats-${displayedConversationId}`}
        conversationId={displayedConversationId}
        host={trajectoryHost}
        enabled={renderedConversationView !== "trajectory"}
        contextUsageTokensSource={contextUsageTokensSource}
        contextWindow={currentModelContextWindow}
        onManualCompactConfirm={handleManualCompact}
        manualCompactBlocked={manualCompactPending || composerCompactionBlocked}
      />
    ),
    fileDropOverlay: isFileDropActive ? (
      <FileDropOverlay
        variant="composer"
        canDropUpload={canDropUpload}
        title={fileDropTitle}
        description={fileDropDescription}
        limitHint={fileDropLimitHint}
      />
    ) : null,
    transcriptExtras: (
      <>
        <TranscriptWidthControls
          hostRef={transcriptStageRef}
          width={settings.customSettings.chatTranscript.width}
          onWidthChange={handleChatTranscriptWidthChange}
          resizeLabel={
            settings.locale === "en-US" ? "Resize conversation content" : "调整对话正文宽度"
          }
          resetLabel={settings.locale === "en-US" ? "Double-click to reset" : "双击恢复默认宽度"}
        />
        {displayedTranscriptRowCount > 0 && !conversationOpenState.showOverlay ? (
          <FloorNavRail
            conversationId={displayedConversationId}
            floors={transcriptFloors}
            activeRowKey={activeFloorKey}
            bottomOffset="calc(var(--gateway-chat-composer-overlay-height, 176px) + 12px)"
            scrollViewport={transcriptViewport}
            onJump={handleFloorJump}
          />
        ) : null}
        {conversationOpenState.showOverlay ? (
          <HistorySwitchLoadingOverlay locale={settings.locale} />
        ) : null}
      </>
    ),
    stageRef: transcriptStageRef,
    setTranscriptScrollAreaRoot,
    setTranscriptViewport,
    isViewportFollowing: transcriptFollow.isFollowing,
    viewportFollowing: transcriptFollowing,
    onJumpToBottom: transcriptFollow.jumpToBottom,
    navRef: transcriptNavRef,
    onAnchorUserRowChange: setActiveFloorKey,
    onResendFromEdit: handleResendFromEdit,
    onBranchConversation: handleBranchConversation,
    branchPendingMessageId,
    onSuggestionSelect: handleEmptyStateSuggestion,
    suggestionsDisabled: isSuggestionTyping,
    hasMoreHistory: selectedHistoryHasMore,
    isLoadingMoreHistory: loadingOlderHistory,
    onLoadEarlierHistory: selectedHistoryHasMore ? handleLoadEarlierHistory : undefined,
    isLoading: transcriptHistoryLoading,
    loadingTitle: historyDetailLoadingTitle,
    transcriptError,
    changedFilesActions,
    checkpoint: {
      client: checkpointClient,
      disabled: !displayedConversationId || transcriptBusy,
      resolveAuthorizedRoots: resolveCheckpointAuthorizedRoots,
      onRewound: handleCheckpointRewound,
    },
  };

  // 每个会话 Pane 始终渲染同一宿主(桌面端 RestorableConversationPaneHost
  // 口径):焦点只换 primary 绑定,绝不把页面舞台注入聚焦 Pane,也不按
  // conversationId 做 key(会在焦点切换时拆掉宿主)。终端 / unsupported 走
  // 各自的自包含表面。
  const renderConversationWorkbench = (): ReactNode => {
    const { workbench, dragState } = workbenchController;
    return (
      <WorkbenchCanvas
        layout={workbench.layout}
        labels={{
          paneRegion: (pane) => {
            const surface = pane.surface;
            if (surface.kind === "unsupported") {
              return translate("workbench.paneRegionUnsupported", settings.locale);
            }
            const title = workbenchPaneTitle(surface);
            if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
              return translate("workbench.paneRegionTerminal", settings.locale).replace(
                "{title}",
                title,
              );
            }
            if (!title) return translate("workbench.paneRegion", settings.locale);
            const workspaceName =
              surface.kind === "conversation"
                ? workspaceProjects
                    .find(
                      (entry) =>
                        workspaceProjectPathKey(entry.path) === surface.project.projectPathKey,
                    )
                    ?.name.trim()
                : undefined;
            if (!workspaceName) {
              return translate("workbench.paneRegionConversation", settings.locale).replace(
                "{title}",
                title,
              );
            }
            return translate("workbench.paneRegionConversationInWorkspace", settings.locale)
              .replace("{title}", title)
              .replace("{workspace}", workspaceName);
          },
          separator: translate("workbench.resizeDivider", settings.locale),
        }}
        renderPaneContent={(pane, paneContext) => {
          const surface = pane.surface;
          if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
            if (!terminalClient) return null;
            return (
              <GatewayTerminalPaneHost
                paneId={pane.paneId}
                surface={surface}
                isFocused={paneContext.isFocused}
                isCompact={paneContext.isCompact}
                theme={effectiveTheme}
                client={terminalClient}
                sessions={terminalSessions}
                sessionsLoaded={terminalSessionsLoaded}
                onSessionGhost={verifyTerminalSessionAlive}
              />
            );
          }
          if (surface.kind === "fileTree") {
            const project = workspaceProjects.find(
              (entry) => workspaceProjectPathKey(entry.path) === surface.project.projectPathKey,
            );
            if (!project) {
              return (
                <UnsupportedPaneSurface paneId={pane.paneId} originalKind="fileTree:missing" />
              );
            }
            return (
              <FileTreePaneSurface
                active
                projectPathKey={surface.project.projectPathKey}
                cwd={project.path}
                state={getRightDockFileTreeState(
                  settings.customSettings,
                  surface.project.projectPathKey,
                )}
                workspaceProject={project}
                workspaceProjectRootClient={workspaceProjectRootClient}
                workspaceRootRevision={workspaceRootRevision}
                workspaceActivityClient={workspaceActivityClient}
                onStateChange={(patch) =>
                  setSettings((current) =>
                    updateRightDockFileTreeState(current, surface.project.projectPathKey, patch),
                  )
                }
                onInsertFileMention={
                  surface.project.projectPathKey === terminalProjectPathKey
                    ? handleRightDockInsertFileMention
                    : undefined
                }
                onOpenFile={(path, imagePaths) => {
                  const request = {
                    projectPathKey: surface.project.projectPathKey,
                    workdir: project.path,
                    path,
                    imagePaths,
                  };
                  if (isWorkspacePreviewPath(path)) {
                    openWorkspaceFilePreview(request);
                  } else {
                    openWorkspaceEditorFile(request);
                  }
                }}
              />
            );
          }
          if (surface.kind === "unsupported") {
            return (
              <UnsupportedPaneSurface paneId={pane.paneId} originalKind={surface.originalKind} />
            );
          }
          const conversationId = surface.conversationId;
          const isPrimary = conversationId === displayedConversationId;
          const panePathKey = surface.project.projectPathKey;
          const blockedMessage = archivedWorkspaceProjectPathKeys.has(panePathKey)
            ? translate("workbench.projectArchived", settings.locale)
            : missingWorkspaceProjectPathKeys.has(panePathKey)
              ? translate("workbench.projectMissing", settings.locale)
              : null;
          return (
            <GatewayConversationPaneHost
              paneId={pane.paneId}
              conversationId={conversationId}
              context={conversationPaneHostContext}
              isPrimary={isPrimary}
              onFocusPane={() => workbenchController.handleFocusPane(pane.paneId)}
              pageComposerRef={isPrimary ? composerRef : undefined}
              primary={isPrimary ? primaryConversationSurface : undefined}
              blockedMessage={blockedMessage}
              trajectoryActive={viewForConversation(conversationId) === "trajectory"}
            />
          );
        }}
        renderPaneChrome={(pane, context) => {
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
              dragHandleLabel={translate("workbench.dragPane", settings.locale)}
              closeLabel={translate("workbench.closePane", settings.locale)}
              onClose={() => workbenchController.handleClosePane(pane.paneId)}
              trajectoryToggle={
                surface.kind === "conversation"
                  ? {
                      isTrajectory: paneConversationView === "trajectory",
                      label:
                        paneConversationView === "trajectory"
                          ? translate("workbench.showConversation", settings.locale)
                          : translate("workbench.showTrajectory", settings.locale),
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
                workbenchController.beginPaneDrag(pane, title, {
                  pointerId: event.pointerId,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  currentTarget: event.currentTarget,
                });
              }}
            />
          );
        }}
        onResizeSplit={workbench.resizeSplit}
        onEqualizeSplit={workbench.equalizeSplit}
        onFocusPane={workbenchController.handleFocusPane}
        onGeometryChange={workbenchController.handleGeometryChange}
        dropPreview={
          dragState?.previewRect
            ? { rect: dragState.previewRect, label: dragState.payload.title }
            : null
        }
        emptyState={
          <WorkbenchEmptyState
            title={translate("workbench.emptyTitle", settings.locale)}
            description={translate("workbench.emptyDescription", settings.locale)}
          />
        }
      />
    );
  };

  // 被画布 Pane 租用的会话从 Right Dock 的终端 tab 中隐藏(终端任一时刻只
  // 出现在一个宿主里);Pane 关闭(Detach)释放租约后自动回归 dock。
  const workbenchLeasedDockSessionIds = useMemo(
    () =>
      workbenchController.leasedDockSessionIds.length > 0
        ? new Set(workbenchController.leasedDockSessionIds)
        : undefined,
    [workbenchController.leasedDockSessionIds],
  );

  // 拖拽幽灵:跟随指针的载荷标题,提交/取消后随 dragState 清空。
  const workbenchDragGhost =
    sessionWorkbench.enabled && workbenchController.dragState ? (
      <div
        ref={workbenchController.dragGhostRef}
        data-workbench-drag-ghost=""
        className="layer-popover pointer-events-none fixed max-w-[220px] truncate rounded-md border border-border bg-background/95 px-2.5 py-1 text-xs text-foreground shadow-md"
        style={{
          left: 0,
          top: 0,
          transform:
            "translate3d(var(--workbench-drag-ghost-x, -9999px), var(--workbench-drag-ghost-y, -9999px), 0)",
          willChange: "transform",
        }}
      >
        {workbenchController.dragState.payload.title ||
          translate("chat.pendingTitle", settings.locale)}
      </div>
    ) : null;
  return (
    <LocaleContext.Provider value={localeContextValue}>
      <AppErrorBoundary>
        <div className="gateway-shell">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label={translate("chat.upload.selectFiles", settings.locale)}
            className="gateway-hidden-file-input"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              void handleImportReadableFiles(files);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={(element) => {
              folderInputRef.current = element;
              element?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            aria-label={translate("chat.upload.selectFolder", settings.locale)}
            className="gateway-hidden-file-input"
            onChange={(event) => {
              handleImportSelectedDirectoryFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          {workbenchDragGhost}

          <div className="gateway-editor-host">
            <GatewaySidebarContainer
              store={sidebarStore}
              approvalConversationIds={approvalConversationIds}
              transientRunningConversations={manualCompactTransientConversations}
              currentConversationId={displayedConversationId}
              isOpen={sidebarOpen}
              fontScale={settings.customSettings.fontScale.sidebar}
              activeView={activeView}
              showProjects={isAgentMode && status?.online === true}
              projects={workspaceProjects}
              workspaceProjectGroups={settings.system.workspaceProjectGroups}
              activeProjectId={activeWorkspaceProject?.id}
              missingProjectPathKeys={missingWorkspaceProjectPathKeys}
              projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
              workspaceFolderDropActive={workspaceFolderDropActive}
              workspaceFolderDropHandlers={workspaceFolderDropHandlers}
              recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
              canShareConversations={canShareHistory}
              sharedConversationCount={sharedHistoryItems.length}
              externalErrorMessage={sidebarActionError}
              connectionLost={gatewayConnectionLost}
              sectionsDisabled={sidebarSectionsDisabled}
              isLocalDraftConversationId={isLocalDraftConversationId}
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
              onConfigureProject={setProjectSettingsProject}
              onSetProjectPinned={handleSetWorkspaceProjectPinned}
              onRemoveProject={handleRemoveWorkspaceProject}
              onArchiveProject={handleArchiveWorkspaceProject}
              onUnarchiveProject={handleUnarchiveWorkspaceProject}
              archivedProjectPathKeys={archivedWorkspaceProjectPathKeys}
              onNewConversation={handleSidebarNewConversation}
              onSelectConversation={handleSidebarSelectConversation}
              onConversationOpenInWorkbenchSplit={
                sessionWorkbench.enabled
                  ? workbenchController.handleOpenConversationInSplit
                  : undefined
              }
              onConversationWorkbenchDragIntent={
                sessionWorkbench.enabled
                  ? workbenchController.handleConversationDragIntent
                  : undefined
              }
              onProjectWorkbenchDragIntent={
                sessionWorkbench.enabled ? workbenchController.handleProjectDragIntent : undefined
              }
              onShareConversation={handleOpenShareModal}
              onOpenSharedConversations={handleOpenSharedHistoryManager}
              onLocalDraftDeleted={handleSidebarLocalDraftDeleted}
              onConversationsRemoved={handleSidebarConversationsRemoved}
              onCloseSidebar={() => setSidebarOpen(false)}
              onOpenSettings={() => openSettings()}
              onOpenSkillsHub={handleSidebarOpenSkillsHub}
              onOpenMcpHub={handleSidebarOpenMcpHub}
            />

            {shareConversation ? (
              <HistoryShareModal
                conversation={shareConversation}
                share={shareStatus}
                isLoading={shareLoading}
                isUpdating={shareUpdating}
                errorMessage={shareError}
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
                listError={sharedHistoryListError}
                onRefresh={handleRefreshSharedHistoryStatuses}
                onLoadStatus={handleLoadSharedHistoryStatus}
                onDisableShare={handleDisableSharedHistory}
                onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
                onClose={() => setSharedManagerOpen(false)}
              />
            ) : null}

            {projectPickerOpen ? (
              <WorkdirPickerModal
                initialWorkdir={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                onClose={() => setProjectPickerOpen(false)}
                onSelect={handleWorkdirPickerSelect}
              />
            ) : null}

            {workspaceCreateModalOpen ? (
              <WorkspaceCloneModal
                initialParent={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                canClone={settings.remote.enableWebGit}
                cloneDisabledMessage={translate("chat.workspaceCloneWebDisabled", settings.locale)}
                onOpenFolder={handleOpenWorkspaceFolder}
                onClone={handleCloneWorkspaceProject}
                onLoadBranches={handleLoadWorkspaceRemoteBranches}
                onClose={() => setWorkspaceCreateModalOpen(false)}
              />
            ) : null}
            <WorkspaceCloneTaskOverlay
              tasks={workspaceCloneTasks}
              onCancel={handleCancelWorkspaceCloneTask}
              onDismiss={handleDismissWorkspaceCloneTask}
              onOpenWorkspace={handleOpenClonedWorkspace}
            />

            {confirmDialog}

            <main className="gateway-main-shell">
              <div className="gateway-main-backdrop" />
              <AppWorkbenchChrome
                settings={settings}
                sidebarOpen={sidebarOpen}
                onOpenSettings={openSettings}
                onToggleTheme={() =>
                  setSettings((prev) => ({
                    ...prev,
                    theme: getNextTheme(prev.theme),
                  }))
                }
                onOpenSidebar={() => setSidebarOpen(true)}
                leadingActions={
                  activeView === "chat" && hasConversationReply && !workbenchHasMultiplePanes ? (
                    <ConversationViewTabs
                      active={renderedConversationView}
                      onChange={setActiveConversationView}
                    />
                  ) : null
                }
                trailingActions={
                  <>
                    <ProjectToolsPanelToggle
                      isOpen={rightDockOpen}
                      sessionCount={projectTerminalSessions.length}
                      disabledMessage={projectToolsDisabledMessage}
                      className="gateway-project-tools-panel-toggle"
                      onToggle={() => setRightDockOpen((open) => !open)}
                    />
                    <UserMenu
                      open={userMenuOpen}
                      onOpenChange={setUserMenuOpen}
                      userMenuLabel={userMenuLabel}
                      userAvatarLabel={userAvatarLabel}
                      agentStatus={
                        status === null ? "unknown" : status.online ? "online" : "offline"
                      }
                      agentSelector={
                        <AgentSelector api={api} onAgentChange={handleActiveAgentChange} />
                      }
                      onLogout={handleLogout}
                    />
                  </>
                }
                overlay={
                  <div className="relative z-50">
                    <NotifyToast items={notifyItems} onDismiss={dismissNotify} />
                  </div>
                }
              />
              <ApplicationView
                activeView={activeView}
                settings={settings}
                setSettings={setSettings}
                isAgentMode={isAgentMode}
                sidebarOpen={sidebarOpen}
                onOpenSidebar={() => setSidebarOpen(true)}
                initialSkills={availableSkills}
                initialSkillsRootDir={skillsRootDir}
                className="contents"
                chat={{
                  containerProps: {
                    className: "gateway-chat-frame zone-font-scale",
                    style: {
                      "--zone-font-scale": settings.customSettings.fontScale.chat,
                    } as CSSProperties,
                    onDragEnter: handleChatFileDragEnter,
                    onDragOver: handleChatFileDragOver,
                    onDragLeave: handleChatFileDragLeave,
                    onDrop: handleChatFileDrop,
                  },
                  content: (
                    <>
                      {statusError ? (
                        <div className="gateway-banner-error">{statusError}</div>
                      ) : null}
                      {chatProtocolIncompatibleMessage && !statusError ? (
                        <div className="gateway-banner-error">
                          {chatProtocolIncompatibleMessage}
                        </div>
                      ) : null}
                      {settingsSyncError ? (
                        <div className="gateway-banner-error">{settingsSyncError}</div>
                      ) : null}
                      {chatError && displayedTranscriptRowCount === 0 ? (
                        <div className="gateway-banner-error">{chatError}</div>
                      ) : null}

                      {sessionWorkbench.enabled ? (
                        renderConversationWorkbench()
                      ) : (
                        <section
                          ref={transcriptStageRef}
                          className="gateway-transcript-stage"
                          // Preferred (persisted) width, so a fresh mount paints at
                          // the user's width instead of the default.
                          // TranscriptWidthControls narrows this same variable to
                          // the stage in a layout effect — see its header.
                          style={
                            {
                              [CHAT_TRANSCRIPT_WIDTH_CSS_VAR]: `${settings.customSettings.chatTranscript.width}px`,
                            } as CSSProperties
                          }
                        >
                          {renderedConversationView === "trajectory" ? (
                            <TrajectoryView
                              conversationId={displayedConversationId}
                              host={trajectoryHost}
                              messages={trajectoryMessages}
                              workdir={displayedConversationWorkdir}
                              hasMoreMessages={selectedHistoryHasMore}
                              loadEarlierMessages={
                                selectedHistoryHasMore ? handleLoadEarlierHistory : undefined
                              }
                              liveEvents={liveTrajectory}
                              authoritativeRevision={trajectoryAuthoritativeRevision}
                            />
                          ) : (
                            <div className="gateway-transcript-scroll-shell">
                              <ScrollArea
                                ref={setTranscriptScrollAreaRoot}
                                viewportRef={setTranscriptViewport}
                                className="gateway-transcript-scroll"
                              >
                                <ChangedFilesActionsProvider value={changedFilesActions}>
                                  <CheckpointRewindProvider
                                    client={checkpointClient}
                                    conversationId={displayedConversationId}
                                    disabled={!displayedConversationId || transcriptBusy}
                                    resolveAuthorizedRoots={resolveCheckpointAuthorizedRoots}
                                    onRewound={handleCheckpointRewound}
                                  >
                                    <GatewayTranscript
                                      conversationId={displayedConversationId}
                                      rows={transcriptRows}
                                      liveStartIndex={transcriptLiveStartIndex}
                                      activeTurnKey={displayedTranscript.activeTurnKey}
                                      contentWidth={settings.customSettings.chatTranscript.width}
                                      isViewportFollowing={transcriptFollow.isFollowing}
                                      viewportFollowing={transcriptFollowing}
                                      navRef={transcriptNavRef}
                                      onAnchorUserRowChange={setActiveFloorKey}
                                      error={transcriptError}
                                      toolStatus={transcriptToolStatus}
                                      toolStatusIsCompaction={transcriptToolStatusIsCompaction}
                                      retryAttempts={displayedTranscript.retryAttempts}
                                      isStreaming={transcriptBusy}
                                      isLoading={transcriptHistoryLoading}
                                      loadingTitle={historyDetailLoadingTitle}
                                      hasModels={modelOptions.length > 0}
                                      onOpenSettings={openSettings}
                                      hasMoreHistory={selectedHistoryHasMore}
                                      isLoadingMoreHistory={loadingOlderHistory}
                                      onLoadEarlierHistory={
                                        selectedHistoryHasMore
                                          ? handleLoadEarlierHistory
                                          : undefined
                                      }
                                      showUsage={isAgentDevExecutionMode}
                                      usageContextWindow={currentModelContextWindow}
                                      workspaceRoot={displayedConversationWorkdir}
                                      onOpenFileLink={handleOpenChatFileLink}
                                      gitClient={gitClient}
                                      onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                                      onResendFromEdit={handleResendFromEdit}
                                      onBranchConversation={handleBranchConversation}
                                      branchPendingMessageId={branchPendingMessageId}
                                      onSuggestionSelect={handleEmptyStateSuggestion}
                                      suggestionsDisabled={isSuggestionTyping}
                                    />
                                  </CheckpointRewindProvider>
                                </ChangedFilesActionsProvider>
                              </ScrollArea>
                              <TranscriptWidthControls
                                hostRef={transcriptStageRef}
                                width={settings.customSettings.chatTranscript.width}
                                onWidthChange={handleChatTranscriptWidthChange}
                                resizeLabel={
                                  settings.locale === "en-US"
                                    ? "Resize conversation content"
                                    : "调整对话正文宽度"
                                }
                                resetLabel={
                                  settings.locale === "en-US"
                                    ? "Double-click to reset"
                                    : "双击恢复默认宽度"
                                }
                              />
                              {displayedTranscriptRowCount > 0 &&
                              !conversationOpenState.showOverlay ? (
                                <FloorNavRail
                                  conversationId={displayedConversationId}
                                  floors={transcriptFloors}
                                  activeRowKey={activeFloorKey}
                                  bottomOffset="calc(var(--gateway-chat-composer-overlay-height, 176px) + 12px)"
                                  scrollViewport={transcriptViewport}
                                  onJump={handleFloorJump}
                                />
                              ) : null}
                              {conversationOpenState.showOverlay ? (
                                <HistorySwitchLoadingOverlay locale={settings.locale} />
                              ) : null}
                            </div>
                          )}
                          {renderedConversationView === "conversation" && !transcriptFollowing ? (
                            <button
                              type="button"
                              className="gateway-scroll-to-bottom"
                              onClick={transcriptFollow.jumpToBottom}
                              aria-label="滚动到底部"
                              title="滚动到底部"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </button>
                          ) : null}
                          <ChatComposerBar
                            surface="web"
                            runClarifyTurn={
                              settings.customSettings.promptClarifyEnabled
                                ? runClarifyTurn
                                : undefined
                            }
                            clarifyContext={clarifyContext}
                            conversationId={displayedConversationId}
                            // 轨迹页是只读分析视图：挂起输入区（保持挂载，草稿不丢）。
                            hidden={renderedConversationView === "trajectory"}
                            composerRef={composerRef}
                            isSending={composerIsSending}
                            isUploadingFiles={isUploadingFiles}
                            isInputDisabled={composerInputDisabled}
                            // 麦克风在开启语音输入后显示；点击设置卡片会立即切换当前供应商。
                            sttSessionKey={displayedConversationId}
                            sttProvider={
                              settings.stt.enabled
                                ? (sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud")
                                : null
                            }
                            sttProviderConfigured={
                              settings.stt.providers[
                                sttProviderOverride ?? settings.stt.provider ?? "tencent_cloud"
                              ]?.configured
                            }
                            sttTransport={webSttTransport}
                            onSttError={handleSttError}
                            inputPlaceholder={composerPlaceholder}
                            workdir={displayedConversationWorkdir}
                            enabledSkills={enabledComposerSkills}
                            mentionableConversations={mentionableConversations}
                            searchMentionableConversations={searchMentionableConversations}
                            mentionApps={mentionApps}
                            executionMode={settings.system.executionMode}
                            hasModels={modelOptions.length > 0}
                            currentModelLabel={currentModelLabel}
                            modelOptions={modelOptions}
                            selectedValue={selectedValue}
                            chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                            commandSafetyMode={settings.system.commandSafetyMode}
                            onCommandSafetyModeChange={(mode) =>
                              setSettings((prev) =>
                                prev.system.commandSafetyMode === mode
                                  ? prev
                                  : updateSystem(prev, { commandSafetyMode: mode }),
                              )
                            }
                            reasoningOptions={chatRuntimeReasoningOptions}
                            thinkingAlwaysOn={chatRuntimeThinkingAlwaysOn}
                            contextUsageTokensSource={contextUsageTokensSource}
                            contextWindow={currentModelContextWindow}
                            contextDisplayMode={settings.customSettings.composerContextDisplay}
                            onManualCompactConfirm={handleManualCompact}
                            manualCompactBlocked={manualCompactPending || composerCompactionBlocked}
                            gitClient={gitClient}
                            onOpenWorktree={handleOpenWorktree}
                            onWorktreeRemoved={handleWorktreeRemoved}
                            gitWriteEnabled={settings.remote.enableWebGit}
                            gitDisabledMessage={gitDisabledMessage}
                            workspaceActivityClient={workspaceActivityClient}
                            onSelectModel={handleSelectModel}
                            onSelectExecutionMode={handleSelectExecutionMode}
                            onOpenSettings={openSettings}
                            onSend={() => {
                              if (
                                submitInFlightRef.current ||
                                isUploadingFiles ||
                                isImportingPastedTextRef.current ||
                                composerInputDisabled
                              ) {
                                return;
                              }
                              if (queuedChatEditSessionRef.current) {
                                submitInFlightRef.current = true;
                                void (async () => {
                                  try {
                                    await commitQueuedChatEdit();
                                  } finally {
                                    submitInFlightRef.current = false;
                                  }
                                })();
                                return;
                              }
                              if (
                                displayedConversationBusyRef.current ||
                                queuedChatTurnsForDisplayedConversation.length > 0
                              ) {
                                submitInFlightRef.current = true;
                                void (async () => {
                                  try {
                                    await submitCurrentComposerToGuiQueue("append");
                                  } finally {
                                    submitInFlightRef.current = false;
                                  }
                                })();
                                return;
                              }
                              submitInFlightRef.current = true;
                              void (async () => {
                                try {
                                  const draft = composerRef.current?.getDraft() ?? null;
                                  // Capture the send target before the paste import
                                  // awaits: switching conversations mid-import must
                                  // not reroute the message or clear the composer of
                                  // the newly displayed conversation.
                                  const sendConversationId = getDisplayedConversationId();
                                  let text: string;
                                  let files: PendingUploadedFile[];
                                  let referencedConversations = draft?.conversationMentions ?? [];
                                  try {
                                    const materialized = draft
                                      ? await materializeComposerDraftForSend(
                                          draft,
                                          pendingUploadedFiles,
                                          displayedConversationWorkdir,
                                          sendConversationId,
                                        )
                                      : {
                                          text: "",
                                          uploadedFiles: pendingUploadedFiles,
                                          referencedConversations: [],
                                        };
                                    text = materialized.text;
                                    files = materialized.uploadedFiles;
                                    referencedConversations = materialized.referencedConversations;
                                  } catch (error) {
                                    addNotify(
                                      "error",
                                      asErrorMessage(error, "大段粘贴内容导入失败"),
                                    );
                                    return;
                                  }

                                  if (!text && files.length === 0) {
                                    return;
                                  }
                                  if (getDisplayedConversationId() === sendConversationId) {
                                    composerRef.current?.clear();
                                  }
                                  setPendingUploadsForConversation(sendConversationId, []);
                                  void sendChat(text, {
                                    conversationId: sendConversationId,
                                    uploadedFiles: files,
                                    referencedConversations,
                                    runtimeControls: chatRuntimeControlsForCurrentProvider,
                                  }).catch(() => {
                                    updatePendingUploadsForConversation(
                                      sendConversationId,
                                      (current) => mergePendingUploadedFiles(current, files),
                                    );
                                  });
                                } finally {
                                  submitInFlightRef.current = false;
                                }
                              })();
                            }}
                            onStop={() => {
                              const nextQueuedTurn = queuedChatTurnsForDisplayedConversation[0];
                              if (nextQueuedTurn) {
                                // Keep WebUI's stop button aligned with the desktop
                                // composer: stop the active run, then drain the queue.
                                runQueuedTurnNow(nextQueuedTurn.id);
                                return;
                              }
                              void cancelChat(displayedConversationId);
                            }}
                            onPrepareChatRuntime={() => {
                              if (!api || historyShareToken) {
                                return;
                              }
                              void prepareChatRuntime(
                                "composer-focus",
                                api,
                                CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
                              ).catch(() => undefined);
                            }}
                            onComposerBusyChange={handleComposerBusyChange}
                            onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                            onPickReadableFiles={() => fileInputRef.current?.click()}
                            onPickWorkspaceFolder={() => folderInputRef.current?.click()}
                            onPasteFiles={handleImportReadableFiles}
                            onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                            loadHistoryPrompts={loadComposerHistoryPrompts}
                            pendingUploadedFiles={pendingUploadedFiles}
                            onRemovePendingUpload={(relativePath) => {
                              updatePendingUploadsForConversation(
                                getDisplayedConversationId(),
                                (current) =>
                                  current.filter((file) => file.relativePath !== relativePath),
                              );
                            }}
                            queuedTurns={queuedChatTurnsForDisplayedConversation}
                            onRunQueuedTurnNow={runQueuedTurnNow}
                            onMoveQueuedTurnUp={moveQueuedTurnUp}
                            onEditQueuedTurn={editQueuedTurn}
                            onRemoveQueuedTurn={removeQueuedTurn}
                            taskProgressBar={
                              <TaskProgressBar
                                key={displayedConversationId}
                                snapshot={taskProgressSnapshot}
                                isConversationRunning={transcriptBusy}
                              />
                            }
                            approvalBar={approvalBar}
                            statsBar={
                              <ConversationStatsBarHost
                                // 前缀防与同级 taskProgressBar 的 key（裸会话 id）碰撞：React 对
                                // 同键兄弟的 keyed diff 会让旧 fiber 逃过删除，DOM 残留逐次累积。
                                key={`stats-${displayedConversationId}`}
                                conversationId={displayedConversationId}
                                host={trajectoryHost}
                                // 轨迹视图下输入区隐藏，状态栏无需拉取。
                                enabled={renderedConversationView !== "trajectory"}
                                contextUsageTokensSource={contextUsageTokensSource}
                                contextWindow={currentModelContextWindow}
                                onManualCompactConfirm={handleManualCompact}
                                manualCompactBlocked={
                                  manualCompactPending || composerCompactionBlocked
                                }
                              />
                            }
                            fileDropOverlay={
                              isFileDropActive ? (
                                <FileDropOverlay
                                  variant="composer"
                                  canDropUpload={canDropUpload}
                                  title={fileDropTitle}
                                  description={fileDropDescription}
                                  limitHint={fileDropLimitHint}
                                />
                              ) : null
                            }
                          />
                        </section>
                      )}
                    </>
                  ),
                }}
                workspaceOverlays={
                  <WorkspaceOverlayHost
                    locale={settings.locale}
                    theme={effectiveTheme}
                    workspaceEditorMounted={workspaceEditorMounted}
                    workspaceEditorOpenRequest={workspaceEditorOpenRequest}
                    workspaceEditorCloseRequestId={workspaceEditorCloseRequestId}
                    workspaceEditorOpen={workspaceEditorOpen}
                    workspaceEditorCleanupPending={workspaceEditorCleanupPending}
                    onWorkspaceEditorPreviewFile={openWorkspaceFilePreview}
                    onWorkspaceEditorInsertCodeMention={handleInsertCodeMention}
                    onWorkspaceEditorHide={handleWorkspaceEditorHide}
                    onWorkspaceEditorClose={handleWorkspaceEditorClosed}
                    workspaceFilePreviewMounted={workspaceFilePreviewMounted}
                    workspaceFilePreviewOpenRequest={workspaceFilePreviewOpenRequest}
                    workspaceFilePreviewOpen={workspaceFilePreviewOpen}
                    onWorkspaceFilePreviewOpenEditor={openWorkspaceEditorFile}
                    onWorkspaceFilePreviewRequestClose={requestWorkspaceFilePreviewClose}
                    onWorkspaceFilePreviewClose={handleWorkspaceFilePreviewClosed}
                    workspaceSshTerminalMounted={workspaceSshTerminalMounted}
                    workspaceSshTerminalOpenRequest={workspaceSshTerminalOpenRequest}
                    workspaceSshTerminalOpen={workspaceSshTerminalOpen}
                    terminalProjectPathKey={terminalProjectPathKey}
                    terminalClient={terminalClient}
                    sftpClient={sftpClient}
                    terminalSessions={terminalSessions}
                    onWorkspaceSshTerminalHide={hideWorkspaceSshTerminalOverlay}
                    onSshTerminalOpenFile={handleOpenSftpFile}
                    sshTerminalPaneLeasedSessionIds={workbenchLeasedDockSessionIds}
                    onSshTerminalFocusLeasedSession={
                      sessionWorkbench.enabled
                        ? workbenchController.focusTerminalPaneForSession
                        : undefined
                    }
                    onSshTerminalSessionTabDragStart={
                      sessionWorkbench.enabled
                        ? workbenchController.handleTerminalTabDragIntent
                        : undefined
                    }
                  />
                }
              />
            </main>
          </div>

          {terminalClient ? (
            <RightDockPanel
              isOpen={activeView === "chat" && rightDockOpen}
              collapseImmediately={activeView !== "chat"}
              fontScale={settings.customSettings.fontScale.rightDock}
              projectPathKey={terminalProjectPathKey}
              cwd={terminalProjectPath}
              workspaceProject={activeWorkspaceProject}
              workspaceProjectRootClient={workspaceProjectRootClient}
              workspaceRootRevision={workspaceRootRevision}
              sessions={terminalSessions}
              sessionsLoaded={terminalSessionsLoaded}
              leasedSessionIds={workbenchLeasedDockSessionIds}
              fileTreeLeased={Boolean(
                findPaneIdBySurfaceKey(
                  workbenchController.workbench.layout,
                  `fileTree:${terminalProjectPathKey}`,
                ),
              )}
              width={settings.customSettings.rightDock.width}
              theme={effectiveTheme}
              disabledMessage={projectToolsDisabledMessage}
              terminalDisabledMessage={terminalDisabledMessage}
              projectState={rightDockProjectState}
              fileTreeState={rightDockFileTreeState}
              sshHosts={settings.ssh.hosts}
              associatedSshHostIds={associatedSshHostIds}
              client={terminalClient}
              gitClient={gitClient}
              gitWriteEnabled={settings.remote.enableWebGit}
              gitDisabledMessage={gitDisabledMessage}
              tunnelClient={isAgentMode ? api : null}
              tunnelEnabled={tunnelEnabled}
              tunnelDisabledMessage={tunnelDisabledMessage}
              tunnelPublicBaseUrl={window.location.origin}
              workspaceActivityClient={workspaceActivityClient}
              onWidthChange={handleRightDockWidthChange}
              onProjectStateChange={handleRightDockProjectStateChange}
              onFileTreeStateChange={handleRightDockFileTreeStateChange}
              onSshProjectHostIdsChange={handleSshProjectHostIdsChange}
              onOpenSshSession={handleOpenSshTerminal}
              onSessionsChange={handleProjectTerminalSessionsChange}
              onTerminalTabDragStart={
                sessionWorkbench.enabled
                  ? workbenchController.handleTerminalTabDragIntent
                  : undefined
              }
              onNewTerminalDragStart={
                sessionWorkbench.enabled
                  ? workbenchController.handleNewTerminalDragIntent
                  : undefined
              }
              onOpenTerminalInWorkbench={
                sessionWorkbench.enabled ? workbenchController.handleOpenTerminalInSplit : undefined
              }
              onFileTreeTabDragStart={
                sessionWorkbench.enabled
                  ? workbenchController.handleFileTreeTabDragIntent
                  : undefined
              }
              onOpenFileTreeInWorkbench={
                sessionWorkbench.enabled ? workbenchController.handleOpenFileTreeInSplit : undefined
              }
              onOpenNewTerminalInWorkbench={
                sessionWorkbench.enabled
                  ? workbenchController.handleOpenNewTerminalInSplit
                  : undefined
              }
              onSessionGhost={verifyTerminalSessionAlive}
              onInsertFileMention={handleRightDockInsertFileMention}
              onOpenFile={handleOpenWorkspaceFile}
              gitReviewFocusRequest={gitReviewFocusRequest}
              onGitReviewFocusRequestHandled={handleGitReviewFocusRequestHandled}
              onInsertCodeReviewSkill={
                codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined
              }
              onInsertCommitMention={handleRightDockInsertCommitMention}
              onInsertGitFileMention={handleRightDockInsertGitFileMention}
              onClose={handleRightDockClose}
            />
          ) : null}

          {projectSettingsProject ? (
            <WorkspaceProjectSettingsModal
              project={projectSettingsProject}
              settings={settings}
              skills={availableSkills}
              rootClient={workspaceProjectRootClient}
              rootClientUnavailableDescription={
                workspaceProjectRootClient
                  ? undefined
                  : translate(
                      "chat.workspaceSettingsDirectoriesGatewayDescription",
                      settings.locale,
                    )
              }
              onClose={() => setProjectSettingsProject(null)}
              onRenameProject={(name) => {
                handleCommitWorkspaceProjectRename(projectSettingsProject, name);
              }}
              onSave={(draft) => {
                setSettings((prev) =>
                  updateWorkspaceResourceSettings(prev, projectSettingsProject.path, draft),
                );
              }}
            />
          ) : null}

          {settingsOpen ? (
            <div
              className={cn(
                "gateway-settings-overlay",
                overlay === "open" ? "gateway-settings-overlay-open" : "",
              )}
              onTransitionEnd={handleSettingsTransitionEnd}
            >
              <SettingsPage
                settings={settings}
                setSettings={setSettings}
                saveState={settingsSaveState}
                onBack={closeSettings}
                initialSection={settingsSection}
                initialProviderId={settingsProviderId}
                hiddenSections={["remote"]}
                sttSettingsService={sttSettingsService}
                onSttProviderChange={setSttProviderOverride}
                onAgentDirectoryChanged={async () => {
                  if (!api) return;
                  await api.listAgents();
                  handleActiveAgentChange(api.getActiveAgent());
                }}
              />
            </div>
          ) : null}
        </div>
      </AppErrorBoundary>
    </LocaleContext.Provider>
  );
}
