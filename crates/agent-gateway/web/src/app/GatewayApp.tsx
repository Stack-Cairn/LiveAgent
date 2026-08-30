import { useApplicationViewState } from "@liveagent/ui/application/useApplicationViewState";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import type { NotifyItem } from "@liveagent/ui/components/chat/NotifyToast";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { LocaleContext, t as translate, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import { useMentionApps } from "@liveagent/ui/lib/chat/useMentionApps";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "@liveagent/ui/lib/sidebar/openController";
import { createSidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import {
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "@liveagent/ui/lib/terminal/sessionStore";
import { useWorkspaceProjectDeletion } from "@liveagent/ui/lib/useWorkspaceProjectRemoval";
import { useWorkspaceProjectSettingsActions } from "@liveagent/ui/lib/workspaceProjectRemoval";
import type { ChatQueueTurnPreview } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createGatewayWorkspaceProjectRootClient } from "@/agent-ui-adapters/workspaceProjectRoots";
import type { GatewayTranscriptNavHandle } from "@/components/GatewayTranscript";
import { registerAskUserQuestionAnswerHandler } from "@/lib/chat/askUserQuestionBridge";
import type { HistoryWindowState } from "@/lib/chat/historyWindow";
import { registerPlanDecisionHandler } from "@/lib/chat/planModeBridge";
import { createActivityStore } from "@/lib/chat/stream/activityStore";
import {
  ChatCommandPipeline,
  type PendingChatCommand,
} from "@/lib/chat/stream/chatCommandPipeline";
import type { ChatCommandUpdate } from "@/lib/chat/stream/streamTypes";
import { createTranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { registerToolApprovalDecisionHandler } from "@/lib/chat/toolApprovalBridge";
import type {
  AgentStatus,
  ChatEvent,
  ChatQueueItemSummary,
  ChatQueueSnapshot,
  HistoryDetail,
} from "@/lib/gatewayTypes";
import { parseHistoryShareToken } from "@/lib/historyShare";
import {
  openRightDockSingletonTab,
  parseSelectedModelJson,
  resolveEffectiveTheme,
  type SelectedModel,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@/lib/settings";
import { createIdleSidebarBackend, createWebSidebarBackend } from "@/lib/sidebar/webSidebarBackend";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsSyncLoading } from "@/pages/SettingsSyncLoading";
import { SharedHistoryPage } from "@/pages/SharedHistoryPage";
import {
  asErrorMessage,
  readTunnelManagerToolChange,
  resolveActiveModelSelection,
} from "./chatEventUtils";
import { HISTORY_LIST_PAGE_SIZE, PROTECTED_DRAFT_CONVERSATION } from "./constants";
import { GatewayAppView } from "./GatewayAppView";
import { createGatewayChatCommandActions } from "./gatewayChatCommandActions";
import { createGatewayConversationActions } from "./gatewayConversationActions";
import {
  createOpenConversationInitial,
  createRefreshDisplayedConversationHistorySnapshot,
} from "./gatewayHistoryWindowActions";
import { createLocalDraftConversationId, isLocalDraftConversationId } from "./gatewayLocalDraft";
import { resolveVisibleConversationId, shouldOpenSidebarByDefault } from "./historyUtils";
import { useDirectoryDropActions } from "./hooks/useDirectoryDropActions";
import { useGatewayChatConfiguration } from "./hooks/useGatewayChatConfiguration";
import { useGatewayChatPresentation } from "./hooks/useGatewayChatPresentation";
import { useGatewayClients } from "./hooks/useGatewayClients";
import {
  type ManualCompactPendingRequest,
  useGatewayConversationRuntime,
} from "./hooks/useGatewayConversationRuntime";
import { useGatewayConversationState } from "./hooks/useGatewayConversationState";
import { useGatewayHistoryReconciliation } from "./hooks/useGatewayHistoryReconciliation";
import { useGatewayProjectTools } from "./hooks/useGatewayProjectTools";
import { useGatewayRuntimePreparation } from "./hooks/useGatewayRuntimePreparation";
import { useGatewaySession } from "./hooks/useGatewaySession";
import { useGatewaySettingsOverlay } from "./hooks/useGatewaySettingsOverlay";
import { useGatewaySettingsSync } from "./hooks/useGatewaySettingsSync";
import { useGatewaySharedHistory } from "./hooks/useGatewaySharedHistory";
import { useGatewayTransportStatus } from "./hooks/useGatewayTransportStatus";
import { useGatewayWorkspaceProjects } from "./hooks/useGatewayWorkspaceProjects";
import { usePendingUploads } from "./hooks/usePendingUploads";
import { useStableCallback } from "./hooks/useStableCallback";
import type { SendChatFn } from "./types";
import { sessionWorkbench } from "./workbench/sessionWorkbench";
import { useGatewayWorkbench } from "./workbench/useGatewayWorkbench";

function useGatewayAppController() {
  const historyShareToken = useMemo(() => parseHistoryShareToken(), []);
  const {
    token,
    loginToken,
    authSubmitting,
    authError,
    setLoginToken,
    setAuthError,
    login: handleLoginSubmit,
    clearSession,
  } = useGatewaySession(historyShareToken);
  const { api, terminalClient, sftpClient, gitClient } = useGatewayClients(token);
  const [activeAgentId, setActiveAgentId] = useState(() => api?.getActiveAgent() ?? "");
  const activeAgentIdRef = useRef(activeAgentId);
  const activeAgentScope = activeAgentId || api?.getActiveAgent() || "";
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // True only after an authenticated gateway connection has been established
  // and then dropped; the initial connect never shows lost-connection UI.
  const [gatewayConnectionLost, setGatewayConnectionLost] = useState(false);
  // A cached Agent status is usable only after it has been observed on the
  // currently authenticated browser-socket epoch.
  const [sidebarAgentStatusFresh, setSidebarAgentStatusFresh] = useState(false);
  const [conversationId, setConversationId] = useState("");
  // 本地未持久化的会话模型切换（按会话 id 键）；发消息随 selected_model
  // 落库后由 history-sync 回声在清理 effect 中收敛删除。
  const [conversationModelOverrides, setConversationModelOverrides] = useState<
    ReadonlyMap<string, SelectedModel>
  >(new Map());
  const [chatError, setChatError] = useState<string | null>(null);
  // 用量环手动压缩：以 operationId 关联桌面终态，避免 accepted 被误当作完成。
  // 按会话 id 键化（issue #359 缺陷 #3）：不同会话各自独立 pending，一个会话压缩
  // 期间绝不静默屏蔽另一个会话的压缩请求。state 与 ref 经唯一 setter/clearer 同步
  // 写以保证两者一致。
  const [manualCompactPendingByConversation, setManualCompactPendingState] = useState<
    ReadonlyMap<string, ManualCompactPendingRequest>
  >(() => new Map());
  const manualCompactPendingRef = useRef<ReadonlyMap<string, ManualCompactPendingRequest>>(
    manualCompactPendingByConversation,
  );
  const setManualCompactPendingRequest = useCallback((request: ManualCompactPendingRequest) => {
    const next = new Map(manualCompactPendingRef.current);
    next.set(request.conversationId, request);
    manualCompactPendingRef.current = next;
    setManualCompactPendingState(next);
  }, []);
  const clearManualCompactPendingRequest = useCallback(
    (conversationId: string, operationId: string) => {
      const current = manualCompactPendingRef.current;
      const pending = current.get(conversationId);
      if (!pending || pending.operationId !== operationId) return false;
      const next = new Map(current);
      next.delete(conversationId);
      manualCompactPendingRef.current = next;
      setManualCompactPendingState(next);
      return true;
    },
    [],
  );
  // Top-right toast stack for upload/attachment feedback — mirrors the GUI's
  // NotifyToast usage so upload failures never render as conversation output.
  const [notifyItems, setNotifyItems] = useState<NotifyItem[]>([]);
  const notifyIdCounter = useRef(0);
  const addNotify = useCallback((type: NotifyItem["type"], message: string) => {
    const id = `notify-${++notifyIdCounter.current}`;
    setNotifyItems((prev) => [...prev, { id, type, message }]);
  }, []);
  const dismissNotify = useCallback((id: string) => {
    setNotifyItems((prev) => prev.filter((item) => item.id !== id));
  }, []);
  // Sidebar errors raised outside the sidebar store (project removal flow).
  const [sidebarActionError, setSidebarActionError] = useState<string | null>(null);
  const [queuedChatTurns, setQueuedChatTurns] = useState<ChatQueueItemSummary[]>([]);
  const [, setChatQueueRevision] = useState(0);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(null);
  // Two-phase conversation open (openController): "opening" gates the
  // composer/transcript loading affordances; showOverlay drives the switch
  // overlay (appears only after ~150ms of still-loading).
  const [conversationOpenState, setConversationOpenState] = useState<ConversationOpenState>({
    conversationId: "",
    phase: "idle",
    showOverlay: false,
    errorCode: null,
  });
  // Explicit "load full history" request from the transcript header.
  const [fullHistoryLoading, setFullHistoryLoading] = useState(false);
  // Bumped whenever the command pipeline's pending set changes so busy state
  // re-derives.
  const [pendingCommandRevision, setPendingCommandRevision] = useState(0);
  const { settings, setSettings, settingsSyncReady, settingsSyncError, settingsSaveState } =
    useGatewaySettingsSync({ token, api, activeAgentId: activeAgentScope });
  const workspaceProjectRootClient = useMemo(
    () => (api ? createGatewayWorkspaceProjectRootClient(api) : undefined),
    [api],
  );
  const [workspaceRootRevision, setWorkspaceRootRevision] = useState(0);
  const handleWorkspaceDirectoriesMounted = useCallback(() => {
    setWorkspaceRootRevision((revision) => revision + 1);
  }, []);
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const isAgentMode = settings.system.executionMode !== "text";
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault);
  const {
    settingsOpen,
    overlay,
    openSettings,
    closeSettings,
    handleSettingsTransitionEnd,
    resetSettingsOverlay,
    settingsSection,
    settingsProviderId,
  } = useGatewaySettingsOverlay(setSidebarOpen);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const {
    activeView,
    setActiveView,
    projectSettingsProject,
    setProjectSettingsProject,
    rightDockOpen,
    setRightDockOpen,
  } = useApplicationViewState<WorkspaceProject>();
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();
  // Both elements arrive via callback refs → state so the scroll-follow hook
  // re-binds on element identity change and can never keep listeners on a
  // dead node.
  const [transcriptScrollAreaRoot, setTranscriptScrollAreaRoot] = useState<HTMLDivElement | null>(
    null,
  );
  const [transcriptViewport, setTranscriptViewport] = useState<HTMLDivElement | null>(null);
  const transcriptStageRef = useRef<HTMLElement | null>(null);
  const { handle: transcriptFollow, following: transcriptFollowing } = useScrollFollow({
    viewport: transcriptViewport,
    listenerRoot: transcriptScrollAreaRoot,
    trackKeys: true,
  });
  // 楼层导航：当前楼层由转写区上报，跳转经 navRef 直达虚拟列表；粘底跟随
  // 激活时程序化滚动会被立即拽回底部——跳转前先按「跳入历史」语义解除跟随。
  const transcriptNavRef = useRef<GatewayTranscriptNavHandle | null>(null);
  const [activeFloorKey, setActiveFloorKey] = useState<string | null>(null);
  const handleFloorJump = useCallback(
    (rowKey: string) => {
      transcriptFollow.breakFollow();
      transcriptNavRef.current?.scrollToRowKey(rowKey);
    },
    [transcriptFollow],
  );
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  const composerDraftOwnerRef = useRef("");
  const conversationIdRef = useRef(conversationId);
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  const statusRef = useRef<AgentStatus | null>(status);
  const queuedChatTurnsRef = useRef<ChatQueueItemSummary[]>([]);
  const chatQueueConversationIdRef = useRef("");
  const chatQueueRevisionRef = useRef(0);
  const queuedChatEditSessionRef = useRef<{ itemId: string; revision: number } | null>(null);
  const selectedHistoryRef = useRef(selectedHistory);
  // Per-conversation runtime workdir (drafts have no persisted summary yet).
  const conversationWorkdirsRef = useRef<Map<string, string>>(new Map());
  // Lazy history windows: per conversation, the persisted-message edge the
  // loaded transcript starts at (see lib/chat/historyWindow.ts). Entries are
  // (re)established by every applied history fetch and dropped with the
  // conversation's other per-id resources.
  const historyWindowStatesRef = useRef<Map<string, HistoryWindowState>>(new Map());
  const displayedConversationWorkdirRef = useRef("");
  const pendingUploadContextRef = useRef<{
    conversationId: string;
    workdir: string;
    executionMode: string;
  } | null>(null);
  const displayedConversationBusyRef = useRef(false);
  const historyLoadSequenceRef = useRef(0);
  const visibleConversationRevisionRef = useRef(0);
  const previousDisplayedConversationIdRef = useRef("");
  const pendingDisplayedConversationAutoBottomRef = useRef<string | null>(null);
  const protectedConversationRef = useRef("");
  const chatRuntimePreparePromiseRef = useRef<Promise<AgentStatus> | null>(null);
  const submitInFlightRef = useRef(false);
  // clientRequestId → draft conversation id, until the command binds.
  const draftClientRequestsRef = useRef<Map<string, string>>(new Map());
  const sendChatRef = useRef<SendChatFn | null>(null);
  const isImportingPastedTextRef = useRef(false);
  const resetProjectToolsRuntimeRef = useRef<() => void>(() => undefined);

  // --- Chat streaming infrastructure (Phase 4) -----------------------------
  // Transcript stores (one per conversation), the global activity map, and
  // the command pipeline replace the old live-store registry, running-id
  // unions, and recovery machinery.
  // Ref indirection: the registry memo is stable across token changes while
  // the api client is not, and divergence resyncs must reach the live client.
  const apiRef = useRef(api);
  apiRef.current = api;
  const transcriptStoreRegistry = useMemo(
    () =>
      createTranscriptStoreRegistry({
        onDivergence: (divergedConversationId) =>
          apiRef.current?.resyncConversation(divergedConversationId),
      }),
    [],
  );
  const activityStore = useMemo(() => createActivityStore(), []);
  const pipelineOnBoundRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnQueuedInGuiRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnFailedRef = useRef<
    (pending: PendingChatCommand, errorCode: string | null, message: string) => void
  >(() => undefined);
  const chatCommandPipeline = useMemo(
    () =>
      new ChatCommandPipeline({
        getTranscriptStore: (targetConversationId) =>
          transcriptStoreRegistry.get(targetConversationId),
        onBound: (update, pending) => pipelineOnBoundRef.current(update, pending),
        onQueuedInGui: (update, pending) => pipelineOnQueuedInGuiRef.current(update, pending),
        onFailed: (pending, errorCode, message) =>
          pipelineOnFailedRef.current(pending, errorCode, message),
        onPendingChanged: () => setPendingCommandRevision((current) => current + 1),
      }),
    [transcriptStoreRegistry],
  );

  // --- Sidebar state layer --------------------------------------------------
  // One external store owns the whole sidebar domain (list, workdirs, running
  // set, per-row mutations); GatewayApp only creates it, feeds it the scope,
  // and makes imperative peek/upsertLocal/removeLocal calls. All rendering
  // subscriptions live in <GatewaySidebarContainer/>.
  const getSidebarProtectedConversationIds = useCallback(() => {
    // Authoritative reconciles keep only these ids when the server list omits
    // them: in-flight commands, the protected (displayed) conversation, and
    // running conversations. Never a blanket retain-all — that resurrects
    // deletions made by other clients while this one was offline.
    const ids = new Set<string>(chatCommandPipeline.pendingConversationIds());
    const protectedId = protectedConversationRef.current.trim();
    if (protectedId && protectedId !== PROTECTED_DRAFT_CONVERSATION) {
      ids.add(protectedId);
    }
    for (const id of activityStore.getSnapshot().activities.keys()) {
      ids.add(id);
    }
    return ids;
  }, [activityStore, chatCommandPipeline]);
  const getActivityKeepConversationIds = useCallback(
    () => chatCommandPipeline.pendingConversationIds(),
    [chatCommandPipeline],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Agent ID 是侧边栏 Store 的数据隔离边界。
  const sidebarStore = useMemo(
    () =>
      createSidebarStore(
        api
          ? createWebSidebarBackend({
              api,
              activityStore,
              getProtectedConversationIds: getSidebarProtectedConversationIds,
              getActivityKeepConversationIds,
            })
          : createIdleSidebarBackend(),
        { pageSize: HISTORY_LIST_PAGE_SIZE },
      ),
    [
      activeAgentScope,
      activityStore,
      api,
      getActivityKeepConversationIds,
      getSidebarProtectedConversationIds,
    ],
  );
  useEffect(() => {
    if (!api) {
      return;
    }
    sidebarStore.start();
    return () => {
      sidebarStore.stop();
    };
  }, [api, sidebarStore]);

  // Narrow app-root subscriptions: workdirs (rare commits — project merge
  // inputs) and the byId index (list commits only; never running/idle ticks).
  const sidebarWorkdirs = useSidebarSelector(sidebarStore, (snapshot) => snapshot.workdirs);
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (snapshot) => snapshot.byId);
  const {
    handleCloseShareModal,
    handleDisableSharedHistory,
    handleLoadSharedHistoryStatus,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleRefreshSharedHistoryStatuses,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleToggleHistoryShare,
    removeSharedHistoryItems,
    resetSharedHistory,
    setSharedManagerOpen,
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
  } = useGatewaySharedHistory({ api, gatewayConnectionLost, sidebarStore, status });

  const startNewConversationRef = useRef<
    (options?: { workdir?: string; preserveCurrentComposerDraft?: boolean }) => string
  >(() => "");
  const {
    activateWorkspaceProject,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    archivedWorkspaceProjectPathKeys,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleCloneWorkspaceProject,
    handleCommitWorkspaceProjectRename,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDismissWorkspaceCloneTask,
    handleLoadWorkspaceRemoteBranches,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleRenameWorkspaceGroup,
    handleSelectWorkspaceProject,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleToggleWorkspaceGroupCollapsed,
    handleWorkdirPickerSelect,
    missingWorkspaceProjectPathKeys,
    projectPickerOpen,
    setActiveWorkspaceProjectId,
    setProjectPickerOpen,
    setWorkspaceCreateModalOpen,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceProjects,
  } = useGatewayWorkspaceProjects({
    api,
    displayedConversationWorkdirRef,
    setActiveView,
    setRightDockOpen,
    setSettings,
    setSidebarOpen,
    settings,
    sidebarStore,
    sidebarWorkdirs,
    startNewConversationRef,
  });

  // Conversation-open controller: the web end paints the conversation's whole
  // established history window in the single open phase — messages above the
  // window edge stay unfetched until the user pages up. Deps go through refs
  // (assigned per render) so the controller instance stays stable.
  const openInitialRef = useRef<(id: string) => Promise<"cache-hit" | "painted">>(() =>
    Promise.resolve("painted"),
  );
  const openController = useMemo(
    () =>
      createConversationOpenController({
        openInitial: (id) => openInitialRef.current(id),
        onStateChange: setConversationOpenState,
      }),
    [],
  );

  const resolveActiveAgentID = useCallback(async () => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      throw new Error("Gateway 尚未连接。");
    }
    let agentID = currentApi.getActiveAgent().trim();
    if (!agentID) {
      await currentApi.listAgents();
      agentID = currentApi.getActiveAgent().trim();
    }
    if (!agentID) {
      throw new Error("没有可用的 Agent。");
    }
    return agentID;
  }, []);

  const { workspaceFolderDropActive, workspaceFolderDropHandlers, mountDroppedDirectories } =
    useDirectoryDropActions({
      token,
      historyShareToken,
      locale: settings.locale,
      resolveAgentID: resolveActiveAgentID,
      addNotify,
      activeWorkspaceProject,
      workspaceProjectRootClient,
      onWorkspaceCreated: handleWorkdirPickerSelect,
      onWorkspaceDirectoriesMounted: handleWorkspaceDirectoriesMounted,
    });

  // 无会话兜底：等价于点一次“新对话”，返回新草稿会话 id 供上传立即挂靠。
  const ensureUploadConversation = useCallback(() => startNewConversationRef.current(), []);
  const workdirForConversation = useCallback(
    (targetConversationId: string) =>
      sidebarStore.peek(targetConversationId)?.cwd?.trim() ||
      conversationWorkdirsRef.current.get(targetConversationId)?.trim() ||
      (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : ""),
    [activeWorkspaceProjectPath, isAgentMode, settings.system.workdir, sidebarStore],
  );

  const {
    pendingUploadedFiles,
    isUploadingFiles,
    isFileDropActive,
    fileInputRef,
    folderInputRef,
    setUploadingFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    moveConversationUploads,
    clearPendingUploads,
    handleImportReadableFiles,
    handleImportSelectedDirectoryFiles,
    handleFileDragEnter,
    handleFileDragOver: handlePendingFileDragOver,
    handleFileDragLeave,
    handleFileDrop: handlePendingFileDrop,
  } = usePendingUploads({
    token,
    resolveAgentID: resolveActiveAgentID,
    historyShareToken,
    settingsSyncReady,
    settingsOpen,
    activeView,
    locale: settings.locale,
    executionMode: settings.system.executionMode,
    conversationId,
    selectedHistoryId,
    displayedConversationWorkdirRef,
    composerRef,
    addNotify,
    onDropDirectories: mountDroppedDirectories,
    ensureUploadConversation,
    workdirForConversation,
  });

  const applyChatQueueSnapshot = useCallback((snapshot: ChatQueueSnapshot | null | undefined) => {
    if (!snapshot) return;
    const visibleConversationId = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    );
    if (snapshot.conversationId !== visibleConversationId) {
      return;
    }
    const revision = Number(snapshot.revision ?? 0);
    const isSameQueueConversation = snapshot.conversationId === chatQueueConversationIdRef.current;
    if (isSameQueueConversation && revision < chatQueueRevisionRef.current) {
      return;
    }
    chatQueueConversationIdRef.current = snapshot.conversationId;
    chatQueueRevisionRef.current = revision;
    queuedChatTurnsRef.current = snapshot.items.slice();
    setChatQueueRevision(revision);
    setQueuedChatTurns(snapshot.items.slice());
  }, []);

  useEffect(() => {
    if (!api) return;
    return api.subscribeChatQueue((snapshot) => {
      applyChatQueueSnapshot(snapshot);
    });
  }, [api, applyChatQueueSnapshot]);

  // AskUserQuestion 卡片的应答出口：经网关 chat_queue.tool_answer 送达桌面端
  // 的工具挂起表；桌面端 resolve 后照常以 tool_result 事件流回本端。
  useEffect(() => {
    if (!api) {
      registerAskUserQuestionAnswerHandler(null);
      return;
    }
    registerAskUserQuestionAnswerHandler(async (toolCallId, answers) => {
      const conversationIdValue = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueueToolAnswer(
          conversationIdValue,
          toolCallId,
          JSON.stringify(answers),
        );
        return { ok: response.accepted, message: response.message || undefined };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the answer.") };
      }
    });
    return () => registerAskUserQuestionAnswerHandler(null);
  }, [api]);

  // 工具审批卡片的决定出口：经网关 chat_queue.tool_approval 送达桌面端审批挂起表;
  // 桌面端据此放行/拒绝该工具,结果照常以 tool_result 事件流回本端。
  useEffect(() => {
    if (!api) {
      registerToolApprovalDecisionHandler(null);
      return;
    }
    registerToolApprovalDecisionHandler(async (toolCallId, decision, targetConversationId) => {
      // 背景 Pane 显式携带自己的会话 id;主视图缺省仍按当前展示会话路由。
      const conversationIdValue = (
        targetConversationId?.trim() ||
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current)
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueueToolApproval(
          conversationIdValue,
          toolCallId,
          JSON.stringify({ decision }),
        );
        return { ok: response.accepted, message: response.message || undefined };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the decision.") };
      }
    });
    return () => registerToolApprovalDecisionHandler(null);
  }, [api]);

  // 计划卡片的决定出口：经网关 chat_queue.plan_decision 送达桌面端计划挂起表;
  // 桌面端据此批准/退回计划,结果照常以 tool_result 事件流回本端。
  useEffect(() => {
    if (!api) {
      registerPlanDecisionHandler(null);
      return;
    }
    registerPlanDecisionHandler(async (toolCallId, answer) => {
      const conversationIdValue = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueuePlanDecision(
          conversationIdValue,
          toolCallId,
          JSON.stringify(answer),
        );
        return {
          ok: response.accepted,
          message: response.message || undefined,
          errorCode: response.errorCode || undefined,
        };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the decision.") };
      }
    });
    return () => registerPlanDecisionHandler(null);
  }, [api]);

  const {
    applyLiveConversationTitle,
    cacheVisibleComposerDraft,
    clearCachedComposerDraft,
    getDisplayedConversationId,
    getVisibleComposerConversationId,
    isConversationBusy,
    isDisplayedConversation,
    loadComposerHistoryPrompts,
    prepareComposerForConversationChange,
    restoreCachedComposerDraft,
  } = useGatewayConversationState({
    activeWorkspaceProjectPath,
    activityStore,
    chatCommandPipeline,
    composerDraftCacheRef,
    composerDraftOwnerRef,
    composerRef,
    conversationId,
    conversationIdRef,
    conversationWorkdirsRef,
    getPendingUploadsForConversation,
    isAgentMode,
    isLocalDraftConversationId,
    selectedHistory,
    selectedHistoryId,
    selectedHistoryIdRef,
    selectedHistoryRef,
    sidebarStore,
    status,
    statusRef,
    transcriptStoreRegistry,
  });

  const refreshDisplayedConversationHistorySnapshot = useMemo(
    () =>
      createRefreshDisplayedConversationHistorySnapshot({
        api,
        conversationIdRef,
        historyWindowStatesRef,
        isConversationBusy,
        isLocalDraftConversationId,
        selectedHistoryIdRef,
        selectedHistoryRef,
        setSelectedHistory,
        transcriptStoreRegistry,
      }),
    [api, isConversationBusy, transcriptStoreRegistry],
  );

  const markVisibleConversationRevision = useCallback(() => {
    visibleConversationRevisionRef.current += 1;
    return visibleConversationRevisionRef.current;
  }, []);

  const invalidateHistoryLoad = useCallback(() => {
    historyLoadSequenceRef.current += 1;
    return historyLoadSequenceRef.current;
  }, []);

  // Session Workbench：草稿转正时把承载草稿的 Pane 原位重绑到真实会话 id，
  // 与 setConversationId 同批提交——聚焦 Pane 不会闪现只读预览，DOM 不重挂载。
  // workbenchController 在下方创建后回填本 ref。
  const workbenchRenameConversationRef = useRef<(fromId: string, toId: string) => void>(() => {});
  const workbenchClearRef = useRef<() => void>(() => {});

  // A draft conversation got its real id (authoritative `command_update
  // bound`): re-key every draft-scoped resource onto the real conversation.
  const bindDraftConversation = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      transcriptStoreRegistry.move(previousId, nextId);
      workbenchRenameConversationRef.current(previousId, nextId);

      const windowState = historyWindowStatesRef.current.get(previousId);
      if (windowState !== undefined) {
        historyWindowStatesRef.current.delete(previousId);
        historyWindowStatesRef.current.set(nextId, windowState);
      }

      const workdir = conversationWorkdirsRef.current.get(previousId);
      if (workdir !== undefined) {
        conversationWorkdirsRef.current.delete(previousId);
        conversationWorkdirsRef.current.set(nextId, workdir);
      }

      const cachedComposerDraft = composerDraftCacheRef.current.get(previousId);
      if (cachedComposerDraft) {
        composerDraftCacheRef.current.delete(previousId);
        composerDraftCacheRef.current.set(nextId, cachedComposerDraft);
      }
      if (composerDraftOwnerRef.current === previousId) {
        composerDraftOwnerRef.current = nextId;
      }
      moveConversationUploads(previousId, nextId);
      if (chatQueueConversationIdRef.current === previousId) {
        chatQueueConversationIdRef.current = nextId;
      }

      if (conversationIdRef.current === previousId) {
        conversationIdRef.current = nextId;
        setConversationId(nextId);
      }
      if (selectedHistoryIdRef.current === previousId) {
        selectedHistoryIdRef.current = nextId;
        setSelectedHistoryId(nextId);
      }
      if (protectedConversationRef.current.trim() === previousId) {
        protectedConversationRef.current = nextId;
      }

      // Re-key the sidebar row: drop the draft row, merge its fields under
      // the real id. The row stays pending until a server upsert confirms it.
      const draftRow = sidebarStore.peek(previousId);
      sidebarStore.removeLocal(previousId);
      if (draftRow) {
        const existingNext = sidebarStore.peek(nextId);
        sidebarStore.upsertLocal({
          id: nextId,
          title: existingNext?.title?.trim() || draftRow.title,
          providerId: existingNext?.providerId || draftRow.providerId,
          model: existingNext?.model || draftRow.model,
          sessionId: existingNext?.sessionId || draftRow.sessionId,
          cwd: existingNext?.cwd || draftRow.cwd,
          messageCount: existingNext?.messageCount ?? draftRow.messageCount,
          createdAt: existingNext?.createdAt ?? draftRow.createdAt,
          updatedAt: existingNext?.updatedAt ?? draftRow.updatedAt,
          isPinned: existingNext?.isPinned ?? draftRow.isPinned,
          pinnedAt: existingNext ? existingNext.pinnedAt : draftRow.pinnedAt,
          isShared: existingNext?.isShared ?? draftRow.isShared,
          selectedModelJson: existingNext?.selectedModelJson || draftRow.selectedModelJson,
          isPending: existingNext && existingNext.isPending !== true ? undefined : true,
        });
      }
      // Re-key the local model override so the pick made on the draft keeps
      // applying to the bound conversation.
      setConversationModelOverrides((prev) => {
        const override = prev.get(previousId);
        if (!override) return prev;
        const next = new Map(prev);
        next.delete(previousId);
        if (!next.has(nextId)) next.set(nextId, override);
        return next;
      });
    },
    [moveConversationUploads, sidebarStore, transcriptStoreRegistry],
  );

  const ensureTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "tunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  // Tunnel list refreshes arrive through the tunnel.state push; the chat
  // event only opens the tunnel tool tab when the agent creates a tunnel.
  const handleTunnelManagerChatEvent = useCallback(
    (event: ChatEvent) => {
      const change = readTunnelManagerToolChange(event);
      if (!change) return;
      if (change.action === "create") {
        ensureTunnelToolTab(change.projectPathKey);
      }
    },
    [ensureTunnelToolTab],
  );

  useGatewayTransportStatus({
    activityStore,
    api,
    chatCommandPipeline,
    setGatewayConnectionLost,
    setSidebarAgentStatusFresh,
    setStatus,
    setStatusError,
    statusRef,
  });

  const refreshChatQueueSnapshot = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }
      void currentApi
        .chatQueueGet(conversationIdValue)
        .then((response) => applyChatQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyChatQueueSnapshot],
  );

  // Command pipeline hooks (assigned per render so they see fresh closures).
  pipelineOnBoundRef.current = (update, pending) => {
    const draftId = draftClientRequestsRef.current.get(pending.clientRequestId)?.trim() ?? "";
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const realId = update.conversationId?.trim() ?? "";
    if (draftId && realId && draftId !== realId) {
      bindDraftConversation(draftId, realId);
    }
  };
  pipelineOnQueuedInGuiRef.current = (update, pending) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    refreshChatQueueSnapshot(update.conversationId?.trim() || pending.conversationId);
    if (pending.isEditResend) {
      // The seeded `rebased` already truncated committed optimistically, but
      // the command was parked — server-side history is unchanged; a quiet
      // window refresh restores the truncated suffix (the edit anchor always
      // sits inside the loaded window, so the window covers the whole cut).
      void refreshDisplayedConversationHistorySnapshot(
        update.conversationId?.trim() || pending.conversationId,
        api,
      );
    }
  };
  pipelineOnFailedRef.current = (pending, _errorCode, message) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const conversationIdValue = pending.conversationId.trim();
    if (pending.isEditResend) {
      void refreshDisplayedConversationHistorySnapshot(conversationIdValue, api);
    }
    if (isLocalDraftConversationId(conversationIdValue)) {
      // The draft never materialized: drop its optimistic sidebar row. The
      // transcript keeps the pipeline's error entry.
      sidebarStore.removeLocal(conversationIdValue);
    }
    if (isDisplayedConversation(conversationIdValue)) {
      setChatError(message);
    }
  };

  // THE transcript source: the displayed conversation's store snapshot plus a
  // persistent stream subscription (subscribed whenever the id is real —
  // regardless of running state, which is what makes GUI queue auto-sends
  // race-free: the next run's events simply flow in).
  const displayedConversationId = resolveVisibleConversationId(selectedHistoryId, conversationId);

  // 会话生效模型：本地 override > sidebar 行携带的持久化选择 > 全局默认。
  const selectionForConversation = useCallback(
    (targetConversationId: string) =>
      resolveActiveModelSelection({
        settings,
        override: conversationModelOverrides.get(targetConversationId),
        persistedSelectedModelJson: sidebarStore.peek(targetConversationId)?.selectedModelJson,
      }),
    [conversationModelOverrides, settings, sidebarStore],
  );
  const activeSelectedModel = useMemo(
    () =>
      resolveActiveModelSelection({
        settings,
        override: conversationModelOverrides.get(displayedConversationId),
        persistedSelectedModelJson:
          sidebarConversationsById.get(displayedConversationId)?.selectedModelJson,
      }),
    [conversationModelOverrides, displayedConversationId, settings, sidebarConversationsById],
  );
  // override 的持久化回声（本会话 selected_model 落库后随 history-sync 回流）
  // 到达即清理，会话从此走服务器权威值。
  useEffect(() => {
    if (conversationModelOverrides.size === 0) return;
    let changed = false;
    const next = new Map(conversationModelOverrides);
    for (const [id, override] of conversationModelOverrides) {
      const persisted = parseSelectedModelJson(sidebarConversationsById.get(id)?.selectedModelJson);
      if (
        persisted &&
        persisted.customProviderId === override.customProviderId &&
        persisted.model === override.model
      ) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setConversationModelOverrides(next);
  }, [conversationModelOverrides, sidebarConversationsById]);

  const {
    displayedConversationBusy,
    displayedTranscript,
    manualCompactPending,
    manualCompactTransientConversations,
  } = useGatewayConversationRuntime({
    activityStore,
    api,
    applyLiveConversationTitle,
    chatCommandPipeline,
    clearManualCompactPendingRequest,
    displayedConversationBusyRef,
    displayedConversationId,
    handleTunnelManagerChatEvent,
    isLocalDraftConversationId,
    locale: settings.locale,
    manualCompactPendingByConversation,
    manualCompactPendingRef,
    pendingCommandRevision,
    refreshChatQueueSnapshot,
    setChatError,
    transcriptStoreRegistry,
  });

  // Open in flight (history-window fetch, before the replace apply paints).
  const historyDetailLoading = conversationOpenState.phase === "opening";

  useGatewayHistoryReconciliation({
    api,
    conversationIdRef,
    displayedConversationBusy,
    displayedConversationId,
    historyWindowStatesRef,
    isConversationBusy,
    needsHistoryRefresh: displayedTranscript.needsHistoryRefresh,
    refreshDisplayedConversationHistorySnapshot,
    selectedHistoryIdRef,
    transcriptStoreRegistry,
  });

  // --- Conversation open (controller deps) ----------------------------------
  // Single-phase open: paint the conversation's established history window
  // (first opens fetch the initial tail, revisits everything the user has
  // paged up to). Sets the selection state synchronously (controller.open
  // calls this in the same tick), fetches the window, and replace-applies it
  // to the transcript store. The web end has no synchronous local-activation
  // path, so it always resolves "painted" (never "cache-hit") — revisits
  // still show the cached transcript instantly because the registry store
  // keeps rendering underneath. Messages above the window edge stay
  // unfetched until the user pages up ("load earlier history"): hydrating
  // the full record on open would put open cost back on the conversation's
  // lifetime size, which is exactly what the lazy window avoids.
  const openConversationInitial = useMemo(
    () =>
      createOpenConversationInitial({
        api,
        conversationIdRef,
        conversationWorkdirsRef,
        getDisplayedConversationId,
        historyLoadSequenceRef,
        historyWindowStatesRef,
        invalidateHistoryLoad,
        localeErrorMessage: translate("chat.history.openFailed", settings.locale),
        markVisibleConversationRevision,
        pendingDisplayedConversationAutoBottomRef,
        protectedConversationRef,
        selectedHistoryIdRef,
        setChatError,
        setConversationId,
        setSelectedHistory,
        setSelectedHistoryId,
        transcriptStoreRegistry,
        visibleConversationRevisionRef,
      }),
    [
      api,
      getDisplayedConversationId,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      settings.locale,
      transcriptStoreRegistry,
    ],
  );

  openInitialRef.current = openConversationInitial;

  const prepareChatRuntime = useGatewayRuntimePreparation({
    api,
    historyShareToken,
    locale: settings.locale,
    preparePromiseRef: chatRuntimePreparePromiseRef,
    setStatus,
    setStatusError,
    statusOnline: status?.online,
    statusRef,
  });

  const branchInFlightRef = useRef(false);
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const {
    handleBranchConversation: handleBranchConversationImpl,
    handleLoadUploadedImagePreview: handleLoadUploadedImagePreviewImpl,
    handleResendFromEdit: handleResendFromEditImpl,
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
    handleSidebarNewConversation,
    handleSidebarOpenMcpHub,
    handleSidebarOpenSkillsHub,
    handleSidebarSelectConversation,
    startNewConversation,
  } = createGatewayConversationActions({
    activeView,
    activeWorkspaceProjectPath,
    api,
    branchFailureMessage: translate("chat.branchFailed", settings.locale),
    branchInFlightRef,
    cacheVisibleComposerDraft,
    clearCachedComposerDraft,
    composerDraftCacheRef,
    composerDraftOwnerRef,
    composerRef,
    conversationIdRef,
    conversationWorkdirsRef,
    createLocalDraftConversationId,
    getDisplayedConversationId,
    getVisibleComposerConversationId,
    historyWindowStatesRef,
    invalidateHistoryLoad,
    isAgentMode,
    isConversationBusy,
    isLocalDraftConversationId,
    markVisibleConversationRevision,
    openController,
    pendingDisplayedConversationAutoBottomRef,
    prepareComposerForConversationChange,
    protectedConversationRef,
    removeSharedHistoryItems,
    restoreCachedComposerDraft,
    selectedHistoryIdRef,
    sendChatRef,
    setActiveView,
    setBranchPendingMessageId,
    setChatError,
    setConversationId,
    setPendingUploadsForConversation,
    setRightDockOpen,
    setSelectedHistory,
    setSelectedHistoryId,
    setSidebarOpen,
    sidebarStore,
    submitInFlightRef,
    transcriptStoreRegistry,
  });
  startNewConversationRef.current = startNewConversation;

  // The factory above rebuilds every closure per render so handlers always see
  // fresh state, but these three flow into the memo'd transcript region
  // (GatewayTranscriptListRegion / row components / ChatComposerBar). Pin their
  // identities — same pattern as sendChatRef in the pre-split monolith — so
  // unrelated GatewayApp renders (composer keystrokes, queue ticks, status
  // polls) cannot defeat that memo boundary.
  const handleBranchConversation = useStableCallback(handleBranchConversationImpl);
  const handleResendFromEdit = useStableCallback(handleResendFromEditImpl);
  const handleLoadUploadedImagePreview = useStableCallback(handleLoadUploadedImagePreviewImpl);

  const translateWorkspaceProject = useCallback(
    (key: string) => translate(key, settings.locale),
    [settings.locale],
  );
  const beforeRemoveWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!workspaceProjectRootClient) {
        throw new Error(translateWorkspaceProject("chat.workspaceRootGrantsRevokeFailed"));
      }
      await workspaceProjectRootClient.revoke(project);
    },
    [translateWorkspaceProject, workspaceProjectRootClient],
  );

  const {
    removeWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  } = useWorkspaceProjectSettingsActions({
    setSettings,
    workspaceProjects,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activateWorkspaceProject,
    setActiveWorkspaceProjectId,
    t: translateWorkspaceProject,
    setErrorMessage: setSidebarActionError,
    beforeRemoveWorkspaceProject,
  });

  const isWorkspaceProjectRunning = useCallback(
    (pathKey: string) => {
      if (sidebarStore.getSnapshot().runningWorkdirPathKeys.has(pathKey)) {
        return true;
      }
      for (const [conversationId, activity] of activityStore.getSnapshot().activities) {
        const runtimeWorkdir =
          activity.workdir?.trim() ||
          conversationWorkdirsRef.current.get(conversationId)?.trim() ||
          "";
        const persistedWorkdir = sidebarStore.peek(conversationId)?.cwd?.trim() || "";
        if (workspaceProjectPathKey(runtimeWorkdir || persistedWorkdir) === pathKey) {
          return true;
        }
      }
      return false;
    },
    [activityStore, sidebarStore],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: workbench setter and version ref are stable hook outputs declared later in the composition
  const pruneWorkspaceProjectTerminalSessions = useCallback((pathKey: string) => {
    terminalSessionsVersionRef.current += 1;
    setTerminalSessions((current) =>
      current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
    );
  }, []);
  const closeWorkspaceProjectRightDock = useCallback(
    (pathKey: string) => {
      if (workspaceProjectPathKey(activeWorkspaceProjectPath) === pathKey) {
        setRightDockOpen(false);
      }
    },
    [activeWorkspaceProjectPath, setRightDockOpen],
  );
  const getDisplayedConversationWorkdir = useCallback(
    () => displayedConversationWorkdirRef.current,
    [],
  );
  const refreshWorkspaceProjectWorkdirs = useCallback(() => {
    void sidebarStore.refreshWorkdirs("delete");
  }, [sidebarStore]);
  const handleRemoveWorkspaceProject = useWorkspaceProjectDeletion({
    settings,
    t: translateWorkspaceProject,
    requestConfirmDialog,
    setErrorMessage: setSidebarActionError,
    removeWorkspaceProject,
    gitClient,
    terminalClient,
    shouldInspectTerminalSessions:
      settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal,
    isWorkspaceProjectRunning,
    onPruneTerminalSessions: pruneWorkspaceProjectTerminalSessions,
    onCloseRightDockProject: closeWorkspaceProjectRightDock,
    getDisplayedConversationWorkdir,
    startNewConversation,
    onWorktreeRemoved: refreshWorkspaceProjectWorkdirs,
  });

  const handleComposerBusyChange = useCallback((_isBusy: boolean) => {}, []);

  const handleLogout = useCallback(() => {
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    // Dropping the api swaps in a fresh (empty) sidebar store; the start/stop
    // effect stops the old one.
    openController.cancel();
    clearSession();
    chatCommandPipeline.reset();
    transcriptStoreRegistry.clear();
    activityStore.clear();
    draftClientRequestsRef.current.clear();
    historyWindowStatesRef.current.clear();
    conversationWorkdirsRef.current.clear();
    composerDraftCacheRef.current.clear();
    composerDraftOwnerRef.current = "";
    composerRef.current?.clear();
    conversationIdRef.current = "";
    selectedHistoryIdRef.current = "";
    selectedHistoryRef.current = null;
    resetSharedHistory();
    clearPendingUploads();
    protectedConversationRef.current = "";
    submitInFlightRef.current = false;
    setUserMenuOpen(false);
    setProjectSettingsProject(null);
    resetSettingsOverlay();
    setStatus(null);
    setStatusError(null);
    setConversationId("");
    setChatError(null);
    setSidebarActionError(null);
    setFullHistoryLoading(false);
    queuedChatTurnsRef.current = [];
    chatQueueConversationIdRef.current = "";
    chatQueueRevisionRef.current = 0;
    queuedChatEditSessionRef.current = null;
    setQueuedChatTurns([]);
    setChatQueueRevision(0);
    resetProjectToolsRuntimeRef.current();
    workbenchClearRef.current();
    setSelectedHistoryId("");
    setSelectedHistory(null);
  }, [
    activityStore,
    chatCommandPipeline,
    clearPendingUploads,
    clearSession,
    invalidateHistoryLoad,
    markVisibleConversationRevision,
    openController,
    resetSharedHistory,
    transcriptStoreRegistry,
    resetSettingsOverlay,
    setProjectSettingsProject,
  ]);

  const currentUserLabel = translate("common.currentUser", settings.locale);
  const userMenuLabel =
    (status?.name || status?.agent_id || currentUserLabel).trim() || currentUserLabel;
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();
  const handleActiveAgentChange = useCallback(
    (agentId: string) => {
      const nextAgentId = agentId.trim();
      const previousAgentId = activeAgentIdRef.current.trim();
      activeAgentIdRef.current = nextAgentId;
      setActiveAgentId(nextAgentId);
      setStatusError(null);
      setChatError(null);
      setSidebarActionError(null);
      if (!previousAgentId || previousAgentId === nextAgentId) {
        return;
      }

      invalidateHistoryLoad();
      markVisibleConversationRevision();
      openController.cancel();
      chatCommandPipeline.reset();
      transcriptStoreRegistry.clear();
      activityStore.clear();
      draftClientRequestsRef.current.clear();
      conversationWorkdirsRef.current.clear();
      composerDraftCacheRef.current.clear();
      composerDraftOwnerRef.current = "";
      composerRef.current?.clear();
      clearPendingUploads();
      pendingUploadContextRef.current = null;
      protectedConversationRef.current = "";
      submitInFlightRef.current = false;
      conversationIdRef.current = "";
      selectedHistoryIdRef.current = "";
      selectedHistoryRef.current = null;
      previousDisplayedConversationIdRef.current = "";
      pendingDisplayedConversationAutoBottomRef.current = null;
      displayedConversationWorkdirRef.current = "";
      resetSharedHistory();
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      queuedChatEditSessionRef.current = null;
      statusRef.current = null;
      setStatus(null);
      setSidebarAgentStatusFresh(false);
      setGatewayConnectionLost(false);
      setConversationId("");
      setSelectedHistoryId("");
      setSelectedHistory(null);
      setConversationModelOverrides(new Map());
      setFullHistoryLoading(false);
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      setProjectPickerOpen(false);
      setProjectSettingsProject(null);
      resetSettingsOverlay();
      setActiveView("chat");
      setRightDockOpen(false);
      setNotifyItems([]);
      resetProjectToolsRuntimeRef.current();
      workbenchClearRef.current();
    },
    [
      activityStore,
      chatCommandPipeline,
      clearPendingUploads,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      openController,
      resetSharedHistory,
      transcriptStoreRegistry,
      setRightDockOpen,
      setActiveView,
      resetSettingsOverlay,
      setProjectSettingsProject,
      setProjectPickerOpen,
    ],
  );

  const localeContextValue = useLocaleContextValue(settings.locale);

  const resourceWorkdir =
    sidebarConversationsById.get(displayedConversationId)?.cwd?.trim() ||
    conversationWorkdirsRef.current.get(displayedConversationId)?.trim() ||
    (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");
  const {
    activeProviders,
    availableSkills,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    codeReviewSkill,
    currentModelContextWindow,
    currentModelLabel,
    enabledComposerSkills,
    handleChatRuntimeControlsChange,
    handleSelectModel,
    isAgentDevExecutionMode,
    modelOptions,
    selectedValue,
    skillsRootDir,
    workspaceResources,
  } = useGatewayChatConfiguration({
    activeSelectedModel,
    displayedConversationId,
    isAgentMode,
    resourceWorkdir,
    setConversationModelOverrides,
    setSettings,
    settings,
  });
  // @ 弹层的应用候选：门控与 GUI 完全同源（agent 模式 + 工作区挂
  // cua-driver），列表经 Gateway 直通中继自桌面宿主本机。
  const mentionApps = useMentionApps(workspaceResources.mcpServers, isAgentMode);
  const {
    cancelChat,
    commitQueuedChatEdit,
    editQueuedTurn,
    materializeComposerDraftForSend,
    moveQueuedTurnUp,
    removeQueuedTurn,
    runQueuedTurnNow,
    sendChat,
    submitCurrentComposerToGuiQueue,
  } = createGatewayChatCommandActions({
    activeProviders,
    activeWorkspaceProjectPath,
    activityStore,
    api,
    apiRef,
    applyChatQueueSnapshot,
    chatCommandPipeline,
    chatQueueRevisionRef,
    chatRuntimeControlsForCurrentProvider,
    clearCachedComposerDraft,
    composerRef,
    conversationIdRef,
    conversationWorkdirsRef,
    displayedConversationWorkdirRef,
    draftClientRequestsRef,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
    isAgentMode,
    isDisplayedConversation,
    isImportingPastedTextRef,
    isLocalDraftConversationId,
    pendingUploadedFiles,
    prepareChatRuntime,
    protectedConversationRef,
    queuedChatEditSessionRef,
    refreshChatQueueSnapshot,
    resolveActiveAgentID,
    selectedHistoryIdRef,
    selectionForConversation,
    sendChatRef,
    setChatError,
    setConversationId,
    setPendingUploadsForConversation,
    setSelectedHistoryId,
    setUploadingFiles,
    settings,
    sidebarStore,
    token,
    transcriptFollow,
    transcriptStoreRegistry,
  });

  const canShareHistory = Boolean(
    api &&
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() &&
      settings.remote.token.trim(),
  );
  // Sidebar rows, running dots, and project activity all render inside
  // <GatewaySidebarContainer/> from the sidebar store — no app-root memos.
  const currentConversationPersistedCwd =
    sidebarConversationsById.get(displayedConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationWorkdirsRef.current.get(displayedConversationId)?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");
  displayedConversationWorkdirRef.current = displayedConversationWorkdir;
  // Switching conversations keeps every conversation's uploads, but a workdir
  // change within the same conversation (a draft switching projects)
  // invalidates them (staged uploads stay readable, workspace picks do not),
  // and a mode flip away from tools invalidates all of them — mirroring the
  // GUI-side rule in usePendingUploads.
  useEffect(() => {
    const executionMode = settings.system.executionMode;
    const previous = pendingUploadContextRef.current;
    pendingUploadContextRef.current = {
      conversationId: displayedConversationId,
      workdir: displayedConversationWorkdir,
      executionMode,
    };
    if (!previous) return;
    if (previous.executionMode !== executionMode) {
      clearPendingUploads();
      return;
    }
    if (previous.conversationId !== displayedConversationId) return;
    if (previous.workdir === displayedConversationWorkdir) return;
    setPendingUploadsForConversation(displayedConversationId, []);
  }, [
    clearPendingUploads,
    displayedConversationId,
    displayedConversationWorkdir,
    settings.system.executionMode,
    setPendingUploadsForConversation,
  ]);
  useEffect(() => {
    if (!api || !displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      return;
    }
    if (chatQueueConversationIdRef.current !== displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = displayedConversationId;
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
    }
    let cancelled = false;
    void api
      .chatQueueGet(displayedConversationId)
      .then((response) => {
        if (!cancelled) applyChatQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, applyChatQueueSnapshot, displayedConversationId]);
  const queuedChatTurnsForDisplayedConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      })),
    [queuedChatTurns],
  );
  const {
    associatedSshHostIds,
    changedFilesActions,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleEmptyStateSuggestion,
    handleChatTranscriptWidthChange,
    handleInsertCodeMention,
    handleOpenChatFileLink,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    handleOpenWorkspaceFile,
    handleProjectTerminalSessionsChange,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSshProjectHostIdsChange,
    handleWorkspaceEditorClosed,
    handleWorkspaceEditorHide,
    handleWorkspaceFilePreviewClosed,
    hideWorkspaceSshTerminalOverlay,
    isSuggestionTyping,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    projectTerminalSessions,
    projectToolsDisabledMessage,
    requestWorkspaceFilePreviewClose,
    rightDockFileTreeState,
    rightDockProjectState,
    terminalDisabledMessage,
    terminalProjectPath,
    terminalProjectPathKey,
    terminalSessions,
    terminalSessionsLoaded,
    terminalSessionsVersionRef,
    setTerminalSessions,
    tunnelDisabledMessage,
    tunnelEnabled,
    workspaceActivityClient,
    workspaceEditorCleanupPending,
    workspaceEditorCloseRequestId,
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorOpenRequest,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
  } = useGatewayProjectTools({
    activeWorkspaceProjectPath,
    addNotify,
    api,
    codeReviewSkill,
    composerRef,
    displayedConversationId,
    displayedConversationWorkdir,
    isAgentMode,
    resetProjectToolsRuntimeRef,
    setRightDockOpen,
    setSettings,
    settings,
    settingsSyncReady,
    status,
    terminalClient,
  });

  const verifyTerminalSessionAlive = useCallback(
    async (_sessionId: string) => {
      if (!terminalClient) return;
      try {
        const sessions = await terminalClient.list();
        terminalSessionsVersionRef.current += 1;
        setTerminalSessions(sortTerminalSessions(sessions));
      } catch {
        // 瞬时网关错误不应把仍存活的终端误判为幽灵会话。
      }
    },
    [setTerminalSessions, terminalClient, terminalSessionsVersionRef],
  );

  // --- Session Workbench（多看板分屏）----------------------------------------
  // 布局与聚焦语义复用共享 reducer；聚焦 Pane 的会话 === 页面当前会话
  // （与桌面端相同不变式）。每个会话 Pane 渲染同一套完整宿主，焦点切换
  // 只换绑定不拆 DOM；侧栏选中走 syncCurrentConversation（已有 Pane 则
  // 聚焦，否则重绑聚焦 Pane）。拖拽体系与桌面端共用。
  const workbenchController = useGatewayWorkbench({
    enabled: sessionWorkbench.enabled,
    displayedConversationId,
    sidebarStore,
    workspaceProjects,
    archivedProjectPathKeys: archivedWorkspaceProjectPathKeys,
    missingProjectPathKeys: missingWorkspaceProjectPathKeys,
    activateWorkspaceProject,
    terminalClient,
    terminalSessions,
    terminalProjectPath,
    newTerminalTitle: translate("projectTools.newTerminal", settings.locale),
    selectConversation: handleSidebarSelectConversation,
    startConversationForProject: handleNewConversationForProject,
    conversationWorkdirFor: (conversationId) =>
      conversationWorkdirsRef.current.get(conversationId)?.trim() ||
      sidebarStore.peek(conversationId)?.cwd?.trim() ||
      null,
    onNoSpaceForSplit: () =>
      addNotify("error", translate("workbench.noSpaceForSplit", settings.locale)),
    onDropStateChanged: () =>
      addNotify("error", translate("workbench.dropStateChanged", settings.locale)),
    onConversationAlreadyOpen: () =>
      addNotify("success", translate("workbench.conversationAlreadyOpen", settings.locale)),
  });
  workbenchRenameConversationRef.current = workbenchController.workbench.renameConversation;
  workbenchClearRef.current = workbenchController.clearWorkbench;

  // 会话从权威索引消失（批量删除等）：先收起对应 Pane，再走既有移除通路；
  // displayed 被删时的选中迁移完成后，syncCurrentConversation 会把聚焦 Pane
  // 重新绑定到新的当前会话。草稿 id 必须跳过——草稿转正会经 removeLocal 把
  // 草稿 id 移出权威索引，此时 Pane 已由 rename 通路原位重绑，收 Pane 会误关
  // 聚焦面板；与底层处理器跳过草稿的口径一致。用户手动删草稿走
  // onLocalDraftDeleted 通路。
  const handleSidebarConversationsRemovedWithWorkbench = (ids: readonly string[]) => {
    workbenchController.closePanesForRemovedConversations(
      ids.filter((id) => !isLocalDraftConversationId(id)),
    );
    handleSidebarConversationsRemoved(ids);
  };
  const handleSidebarLocalDraftDeletedWithWorkbench = (id: string) => {
    workbenchController.closePanesForRemovedConversations([id]);
    handleSidebarLocalDraftDeleted(id);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutRef is a ref sampled at restore time; pane-count changes must not re-trigger the draft restore.
  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = displayedConversationId.trim();
    if (!targetConversationId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // 多 Pane 时每个宿主自己管草稿,页面级 restore 会把焦点 Pane
      // 正在输入的内容清掉(owner 对不上新 composer)。
      const paneCount = Object.keys(workbenchController.workbench.layoutRef.current.panes).length;
      if (sessionWorkbench.enabled && paneCount > 1) {
        composerDraftOwnerRef.current = targetConversationId;
        return;
      }
      const composer = composerRef.current;
      if (
        !composer ||
        (composerDraftOwnerRef.current === targetConversationId && composer.hasContent())
      ) {
        return;
      }
      restoreCachedComposerDraft(targetConversationId);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeView, displayedConversationId, restoreCachedComposerDraft]);

  const {
    approvalBar,
    approvalConversationIds,
    canDropUpload,
    chatProtocolIncompatibleMessage,
    composerCompactionBlocked,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    contextUsageTokensSource,
    displayedTranscriptRowCount,
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    handleFileDragOver,
    handleFileDrop,
    handleLoadEarlierHistory,
    handleManualCompact,
    historyDetailLoadingTitle,
    loadingOlderHistory,
    selectedHistoryHasMore,
    sidebarSectionsDisabled,
    taskProgressSnapshot,
    transcriptBusy,
    transcriptError,
    transcriptFloors,
    transcriptHistoryLoading,
    transcriptLiveStartIndex,
    transcriptRows,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
  } = useGatewayChatPresentation({
    activeView,
    activeWorkspaceProject,
    api,
    chatCommandHasPending: (conversationId) => chatCommandPipeline.hasPending(conversationId),
    chatError,
    clearManualCompactPendingRequest,
    displayedConversationBusy,
    displayedConversationId,
    displayedConversationWorkdir,
    displayedTranscript,
    enabledComposerSkills,
    fullHistoryLoading,
    gatewayConnectionLost,
    handlePendingFileDragOver,
    handlePendingFileDrop,
    historyDetailLoading,
    historyShareToken,
    isAgentMode,
    isDisplayedConversation,
    isLocalDraftConversationId,
    isUploadingFiles,
    manualCompactPendingRef,
    refreshDisplayedConversationHistorySnapshot,
    selectedHistory,
    selectedHistoryId,
    setChatError,
    setFullHistoryLoading,
    setManualCompactPendingRequest,
    settings,
    sidebarAgentStatusFresh,
    sidebarConversationsById,
    status,
    token,
    transcriptStoreRegistry,
  });

  useEffect(() => {
    const nextDisplayedConversationId = displayedConversationId.trim();
    const previousDisplayedConversationId = previousDisplayedConversationIdRef.current.trim();
    previousDisplayedConversationIdRef.current = nextDisplayedConversationId;
    if (
      !nextDisplayedConversationId ||
      !previousDisplayedConversationId ||
      previousDisplayedConversationId === nextDisplayedConversationId
    ) {
      return;
    }
    // Switching away folds the settled turns so revisits start clean.
    transcriptStoreRegistry.peek(previousDisplayedConversationId)?.foldSettledTurns();
    pendingDisplayedConversationAutoBottomRef.current = nextDisplayedConversationId;
  }, [displayedConversationId, transcriptStoreRegistry]);

  useLayoutEffect(() => {
    const targetConversationId = pendingDisplayedConversationAutoBottomRef.current?.trim() ?? "";
    if (
      !targetConversationId ||
      historyDetailLoading ||
      displayedConversationId.trim() !== targetConversationId ||
      displayedTranscriptRowCount === 0
    ) {
      return;
    }

    transcriptFollow.stickToBottom();
    pendingDisplayedConversationAutoBottomRef.current = null;
  }, [
    displayedConversationId,
    displayedTranscriptRowCount,
    historyDetailLoading,
    transcriptFollow,
  ]);

  if (historyShareToken) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <SharedHistoryPage token={historyShareToken} />
      </LocaleContext.Provider>
    );
  }

  if (!token) {
    return (
      <LoginPage
        token={loginToken}
        error={authError}
        isSubmitting={authSubmitting}
        onTokenChange={(nextToken) => {
          setLoginToken(nextToken);
          if (authError) {
            setAuthError(null);
          }
        }}
        onSubmit={handleLoginSubmit}
      />
    );
  }

  if (!api) {
    return null;
  }

  if (!settingsSyncReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <div className="gateway-shell">
          <main className="gateway-main-shell">
            <div className="gateway-main-backdrop" />
            <div className="gateway-chat-frame flex items-center justify-center">
              <SettingsSyncLoading locale={settings.locale} />
            </div>
          </main>
        </div>
      </LocaleContext.Provider>
    );
  }
  // --- 多看板背景 Pane 的按会话绑定能力(复刻桌面端 buildBackgroundPaneBinding
  // 的数据面):工作区、草稿缓存、附件导入全部按显式 conversationId 路由。---
  const getCachedComposerDraft = (targetConversationId: string) =>
    composerDraftCacheRef.current.get(targetConversationId);
  const setCachedComposerDraft = (targetConversationId: string, draft: MentionComposerDraft) => {
    composerDraftCacheRef.current.set(targetConversationId, draft);
  };
  const importFilesForConversation = (
    targetConversationId: string,
    workdir: string,
    files: File[],
  ) => handleImportReadableFiles(files, { conversationId: targetConversationId, workdir });

  const viewModel = {
    activeFloorKey,
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
    conversationId,
    conversationOpenState,
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
    handleSidebarConversationsRemoved: handleSidebarConversationsRemovedWithWorkbench,
    handleSidebarLocalDraftDeleted: handleSidebarLocalDraftDeletedWithWorkbench,
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
    loadComposerHistoryPrompts,
    loadingOlderHistory,
    localeContextValue,
    manualCompactPending,
    manualCompactTransientConversations,
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
  };
  return viewModel;
}

export type GatewayAppViewModel = Extract<
  ReturnType<typeof useGatewayAppController>,
  { activeFloorKey: string | null }
>;

export default function GatewayApp() {
  const result = useGatewayAppController();
  if (!result || !("activeFloorKey" in result)) {
    return result;
  }
  return <GatewayAppView viewModel={result} />;
}
