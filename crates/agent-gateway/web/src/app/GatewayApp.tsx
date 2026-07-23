import {
  type CSSProperties,
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@/components/chat/MentionComposer";
import { type NotifyItem, NotifyToast } from "@/components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "@/components/chat/SharedHistoryManagerModal";
import { ChevronDown, PanelRightClose, PanelRightOpen, Terminal } from "@/components/icons";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "@/components/project-tools/git-review";
import { RightDockPanel } from "@/components/project-tools/RightDockPanel";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LocaleContext, t as translate } from "@/i18n";
import { registerAskUserQuestionAnswerHandler } from "@/lib/chat/askUserQuestionBridge";
import type { ChatHistorySummary } from "@/lib/chat/chatHistory";
import { buildModelOptions } from "@/lib/chat/chatPageHelpers";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { CodeMentionReference } from "@/lib/chat/mentionReferences";
import { createActivityStore } from "@/lib/chat/stream/activityStore";
import {
  type ChatCommandOutcome,
  ChatCommandPipeline,
  type PendingChatCommand,
} from "@/lib/chat/stream/chatCommandPipeline";
import {
  type ChatCommandUpdate,
  type ConversationActivityEvent,
  type ConversationStreamEvent,
  type ConversationSubscribeResult,
  readEventRunId,
} from "@/lib/chat/stream/streamTypes";
import {
  createTranscriptStoreRegistry,
  useConversationChat,
} from "@/lib/chat/stream/useConversationChat";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@/lib/chat/uploadedFiles";
import {
  buildOptimisticConversationTitle,
  type ChatEntry,
  resolveConversationBrowserTitle,
} from "@/lib/chatUi";
import type { GatewayChatCommandInput } from "@/lib/gatewaySocket";
import type {
  AgentStatus,
  ChatEvent,
  ChatQueueItemSummary,
  ChatQueueSnapshot,
  HistoryDetail,
  HistoryShareStatus,
} from "@/lib/gatewayTypes";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";
import { memoryDeleteProject } from "@/lib/memory/api";
import { toModelValue } from "@/lib/providers/llm";
import {
  type ChatRuntimeControls,
  DEFAULT_WORKSPACE_PROJECT_ID,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getNextTheme,
  getRightDockFileTreeState,
  getRightDockProjectState,
  getSshProjectHostIds,
  isAgentDevMode,
  isRightDockSingletonTabOpen,
  isThinkingAlwaysOnForModel,
  normalizeChatRuntimeControlsForProvider,
  openRightDockSingletonTab,
  parseSelectedModelJson,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  removeRightDockProjectState,
  resolveEffectiveTheme,
  resolveWorkspaceProjects,
  type SelectedModel,
  setSelectedModel,
  updateChatRuntimeControlsForProvider,
  updateCustomSettings,
  updateRightDockFileTreeState,
  updateRightDockProjectState,
  updateRightDockWidth,
  updateSkills,
  updateSshProjectHostIds,
  updateSystem,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@/lib/settings";
import { createUuid } from "@/lib/shared/id";
import { mergeAlwaysEnabledSkillNames } from "@/lib/skills";
import { terminalSessionBelongsToProject } from "@/lib/terminal/sessionStore";
import type { TerminalSession } from "@/lib/terminal/types";
import { createGatewayWorkspaceActivityClient } from "@/lib/workspace-activity/gatewayWorkspaceActivityClient";
import { ChatComposerBar, type ChatQueueTurnPreview } from "@/pages/chat/ChatComposerBar";
import { ChatHeader } from "@/pages/chat/ChatHeader";
import { queuedChatTurnHasContent } from "@/pages/chat/queue/chatTurnQueue";
import { useChatSkills } from "@/pages/chat/useChatSkills";
import { McpHubPage } from "@/pages/mcp-hub/McpHubPage";
import { SettingsPage } from "@/pages/SettingsPage";
import type { SectionId } from "@/pages/settings/types";
import { SkillsHubPage } from "@/pages/skills-hub/SkillsHubPage";

const LOCAL_DRAFT_PREFIX = "__local_draft__:";
function createLocalDraftConversationId() {
  return `${LOCAL_DRAFT_PREFIX}${createUuid()}`;
}
function isLocalDraftConversationId(id: string) {
  return id.trim().startsWith(LOCAL_DRAFT_PREFIX);
}

import {
  type ChangedFilesActions,
  ChangedFilesActionsProvider,
} from "@/components/chat/ChangedFilesCard";
import { HistoryShareModal } from "@/components/chat/HistoryShareModal";
import { GatewayTranscript, type GatewayTranscriptNavHandle } from "@/components/GatewayTranscript";
import type { GitReviewFocusRequest } from "@/components/project-tools/RightDockContext";
import { expandedPathsForFileTreePath } from "@/components/project-tools/rightDockModel";
import { buildFloorEntries } from "@/lib/chat-floor-nav/floorModel";
import { useScrollFollow } from "@/lib/chat-scroll/useScrollFollow";
import { parseHistoryShareToken } from "@/lib/historyShare";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "@/lib/sidebar/openController";
import { sortSidebarConversations } from "@/lib/sidebar/reconcile";
import { createSidebarStore } from "@/lib/sidebar/store";
import { useSidebarSelector } from "@/lib/sidebar/useSidebarSelector";
import {
  createIdleSidebarBackend,
  createWebSidebarBackend,
  normalizeGatewayConversationSummary,
  normalizeRunningConversationItems,
} from "@/lib/sidebar/webSidebarBackend";
import { findWorkspaceProject, mergeWorkspaceProjectsWithHistory } from "@/lib/workspaceProjects";
import { FloorNavRail } from "@/pages/chat/transcript/FloorNavRail";
import { WorkspaceCloneModal } from "@/pages/chat/WorkspaceCloneModal";
import {
  type WorkspaceCloneTask,
  WorkspaceCloneTaskOverlay,
} from "@/pages/chat/WorkspaceCloneTaskOverlay";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsSyncLoading } from "@/pages/SettingsSyncLoading";
import { SharedHistoryPage } from "@/pages/SharedHistoryPage";
import { WorkdirPickerModal } from "@/pages/settings/WorkdirPickerModal";
import { AgentSelector } from "./AgentSelector";
import { buildTextFromComposerDraft, importPastedTextsAsFiles } from "./chatDraft";
import {
  asErrorMessage,
  buildGatewaySelectedModel,
  buildGatewaySystemSettings,
  isAbortError,
  isChatEventTitleFinal,
  readChatEventTitle,
  readTunnelManagerToolChange,
  resolveActiveModelSelection,
} from "./chatEventUtils";
import {
  CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
  CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS,
  CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
  CHAT_RUNTIME_PREPARING_STATUS,
  DEFAULT_BROWSER_TITLE,
  HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
  HISTORY_LIST_PAGE_SIZE,
  MAX_UPLOAD_FILES,
  MCP_HUB_BROWSER_TITLE,
  NEW_CONVERSATION_BROWSER_TITLE,
  PROJECT_HISTORY_DELETE_PAGE_SIZE,
  PROTECTED_DRAFT_CONVERSATION,
  SHARED_HISTORY_BROWSER_TITLE,
  SHARED_HISTORY_LIST_PAGE_SIZE,
  SKILLS_HUB_BROWSER_TITLE,
} from "./constants";
import { FileDropOverlay } from "./FileDropOverlay";
import { HistorySwitchLoadingOverlay } from "./HistorySwitchLoadingOverlay";
import {
  createWorkspaceProjectFromPath,
  formatTranslation,
  getDefaultWorkspaceProjectPath,
  isMobileSidebarLayout,
  resolveVisibleConversationId,
  shouldOpenSidebarByDefault,
} from "./historyUtils";
import { useGatewayClients } from "./hooks/useGatewayClients";
import { useGatewaySession } from "./hooks/useGatewaySession";
import { useGatewaySettingsSync } from "./hooks/useGatewaySettingsSync";
import { usePendingUploads } from "./hooks/usePendingUploads";
import { useProjectToolsRuntime } from "./hooks/useProjectToolsRuntime";
import { GatewaySidebarContainer } from "./sidebar/GatewaySidebarContainer";
import {
  type GatewaySidebarStatusFreshnessEvent,
  INITIAL_GATEWAY_SIDEBAR_STATUS_FRESHNESS,
  reduceGatewaySidebarStatusFreshness,
  shouldDisableGatewaySidebarSections,
} from "./sidebar/gatewaySidebarAvailability";
import type { ModelProviderSource, OverlayState, SendChatFn, SendChatOptions } from "./types";
import { UserMenu } from "./UserMenu";
import { WorkspaceOverlayHost } from "./WorkspaceOverlayHost";

const STALE_HISTORY_RETRY_INITIAL_DELAY_MS = 1_000;
const STALE_HISTORY_RETRY_MAX_DELAY_MS = 30_000;

// Two-phase open: schedule the quiet full hydration at browser idle time,
// with a hard timeout so it still runs on busy pages (mirrors the GUI helper
// semantics).
const HYDRATE_IDLE_TIMEOUT_MS = 1_500;
function scheduleIdleTask(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => task(), { timeout: HYDRATE_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const timeoutId = window.setTimeout(task, 300);
  return () => window.clearTimeout(timeoutId);
}

export default function GatewayApp() {
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
  const [workspaceCloneTasks, setWorkspaceCloneTasks] = useState<WorkspaceCloneTask[]>([]);
  const dismissedWorkspaceCloneTaskIds = useRef(new Set<string>());
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [workspaceCreateModalOpen, setWorkspaceCreateModalOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [overlay, setOverlay] = useState<OverlayState>("closed");
  const { settings, setSettings, settingsSyncReady, settingsSyncError, settingsSaveState } =
    useGatewaySettingsSync({ token, api, activeAgentId: activeAgentScope });
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const isAgentMode = settings.system.executionMode !== "text";
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectId] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const missingWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.missingWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault);
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [shareConversation, setShareConversation] = useState<ChatHistorySummary | null>(null);
  const [shareStatus, setShareStatus] = useState<HistoryShareStatus | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUpdating, setShareUpdating] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharedManagerOpen, setSharedManagerOpen] = useState(false);
  const [sharedManagerStatuses, setSharedManagerStatuses] = useState<
    Record<string, HistoryShareStatus | undefined>
  >({});
  const [sharedManagerLoadingIds, setSharedManagerLoadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerUpdatingIds, setSharedManagerUpdatingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerErrors, setSharedManagerErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [sharedHistoryListError, setSharedHistoryListError] = useState<string | null>(null);
  const [sharedHistoryItems, setSharedHistoryItems] = useState<ChatHistorySummary[]>([]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<"chat" | "skills-hub" | "mcp-hub">("chat");
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();
  // Both elements arrive via callback refs → state so the scroll-follow hook
  // re-binds on element identity change and can never keep listeners on a
  // dead node.
  const [transcriptScrollAreaRoot, setTranscriptScrollAreaRoot] = useState<HTMLDivElement | null>(
    null,
  );
  const [transcriptViewport, setTranscriptViewport] = useState<HTMLDivElement | null>(null);
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
  const sharedHistoryItemsRef = useRef<ChatHistorySummary[]>([]);
  const sharedHistoryListRequestRef = useRef<{
    generation: string;
    promise: Promise<ChatHistorySummary[]>;
  } | null>(null);
  // Per-conversation runtime workdir (drafts have no persisted summary yet).
  const conversationWorkdirsRef = useRef<Map<string, string>>(new Map());
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
  const resetProjectToolsRuntimeRef = useRef(() => undefined as void);

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

  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, sidebarWorkdirs),
    [settings.system, sidebarWorkdirs],
  );
  const archivedWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.archivedWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.archivedWorkspaceProjectPaths],
  );
  // Archived workspaces can never be active. Falling back to the full list
  // only guards a transient synced state where everything is archived.
  const selectableWorkspaceProjects = useMemo(() => {
    const active = workspaceProjects.filter(
      (project) => !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
    );
    return active.length > 0 ? active : workspaceProjects;
  }, [archivedWorkspaceProjectPathKeys, workspaceProjects]);
  const activeWorkspaceProject = useMemo(
    () => findWorkspaceProject(selectableWorkspaceProjects, activeWorkspaceProjectId),
    [activeWorkspaceProjectId, selectableWorkspaceProjects],
  );
  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId]);
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";

  // Scope derivation: agent mode with a project → that workdir; agent mode
  // without a project → "none" (resolves to an empty list locally, no wire
  // sentinel); text mode → unscoped.
  useEffect(() => {
    sidebarStore.setScope(
      isAgentMode
        ? activeWorkspaceProjectPath
          ? { kind: "workdir", cwd: activeWorkspaceProjectPath }
          : { kind: "none" }
        : { kind: "unscoped" },
    );
  }, [activeWorkspaceProjectPath, isAgentMode, sidebarStore]);

  // Two-phase open controller: phase 1 paints the message tail fast, phase 2
  // hydrates the full transcript at idle. Deps go through refs (assigned per
  // render) so the controller instance stays stable.
  const openInitialRef = useRef<(id: string, seq: number) => Promise<"cache-hit" | "painted">>(() =>
    Promise.resolve("painted"),
  );
  const hydrateFullRef = useRef<(id: string, seq: number) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const openController = useMemo(
    () =>
      createConversationOpenController({
        openInitial: (id, seq) => openInitialRef.current(id, seq),
        hydrateFull: (id, seq) => hydrateFullRef.current(id, seq),
        scheduleIdle: scheduleIdleTask,
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

  const {
    pendingUploadedFiles,
    isUploadingFiles,
    isFileDropActive,
    fileInputRef,
    setUploadingFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    moveConversationUploads,
    clearPendingUploads,
    handleImportReadableFiles,
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
      const conversationIdValue = getDisplayedConversationId();
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

  function getVisibleComposerConversationId() {
    return resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current);
  }

  function cacheVisibleComposerDraft(conversationId = composerDraftOwnerRef.current) {
    const targetConversationId = conversationId.trim();
    const composer = composerRef.current;
    if (
      !targetConversationId ||
      composerDraftOwnerRef.current !== targetConversationId ||
      !composer
    ) {
      return;
    }

    const draft = composer.getDraft();
    if (draft.isEmpty || !draft.text.trim()) {
      composerDraftCacheRef.current.delete(targetConversationId);
      return;
    }

    composerDraftCacheRef.current.set(targetConversationId, draft);
  }

  function prepareComposerForConversationChange() {
    cacheVisibleComposerDraft();
    composerDraftOwnerRef.current = "";
  }

  function restoreCachedComposerDraft(conversationId: string) {
    const targetConversationId = conversationId.trim();
    const composer = composerRef.current;
    if (!targetConversationId || !composer) {
      return;
    }

    const cachedDraft = composerDraftCacheRef.current.get(targetConversationId);
    if (cachedDraft) {
      composer.setDraft(cachedDraft);
    } else {
      composer.clear();
    }
    composerDraftOwnerRef.current = targetConversationId;
  }

  function clearCachedComposerDraft(conversationId = getVisibleComposerConversationId()) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    composerDraftCacheRef.current.delete(targetConversationId);
  }

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    selectedHistoryIdRef.current = selectedHistoryId;
  }, [selectedHistoryId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    selectedHistoryRef.current = selectedHistory;
  }, [selectedHistory]);

  function getDisplayedConversationId() {
    return resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    ).trim();
  }

  function isDisplayedConversation(targetConversationId: string) {
    const conversationIdValue = targetConversationId.trim();
    return conversationIdValue !== "" && getDisplayedConversationId() === conversationIdValue;
  }

  // Sent-prompt history for the composer's ↑/↓ recall. Read lazily from the
  // displayed conversation's transcript snapshot at the moment recall starts,
  // so transcript growth never re-renders the memoized composer bar.
  const loadComposerHistoryPrompts = useCallback(() => {
    const store = transcriptStoreRegistry.peek(getDisplayedConversationId());
    if (!store) return [];
    const prompts: string[] = [];
    for (const row of store.getSnapshot().rows) {
      if (row.kind === "user" && row.text.trim()) prompts.push(row.text);
    }
    return prompts;
  }, [transcriptStoreRegistry]);

  const applyLiveConversationTitle = useCallback(
    (targetConversationId: string, nextTitle: string) => {
      const conversationIdValue = targetConversationId.trim();
      const title = nextTitle.trim();
      if (!conversationIdValue || !title) {
        return;
      }

      // Position-preserving local upsert: reuse the existing row's updatedAt
      // so a live title never reorders the sidebar (the store's own position
      // locks cover mutation confirmations).
      const now = Date.now();
      const existing = sidebarStore.peek(conversationIdValue);
      sidebarStore.upsertLocal({
        id: conversationIdValue,
        title,
        providerId: existing?.providerId ?? "",
        model: existing?.model ?? "",
        sessionId: existing?.sessionId,
        cwd: existing?.cwd,
        messageCount: existing?.messageCount ?? 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing?.updatedAt ?? now,
        isPinned: existing?.isPinned,
        pinnedAt: existing ? existing.pinnedAt : null,
        isShared: existing?.isShared,
        isPending: existing?.isPending,
      });
    },
    [sidebarStore],
  );

  // Total entry count of a conversation's transcript store.
  const getConversationTranscriptEntryCount = useCallback(
    (targetConversationId: string) => {
      const store = transcriptStoreRegistry.peek(targetConversationId.trim());
      return store ? store.getSnapshot().entryCount : 0;
    },
    [transcriptStoreRegistry],
  );

  const isConversationBusy = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return false;
      }
      return (
        activityStore.isRunning(conversationIdValue) ||
        chatCommandPipeline.hasPending(conversationIdValue) ||
        transcriptStoreRegistry.peek(conversationIdValue)?.getSnapshot().activeRun != null
      );
    },
    [activityStore, chatCommandPipeline, transcriptStoreRegistry],
  );

  // Keep an empty draft conversation's workdir following the active project.
  useEffect(() => {
    const nextWorkdir = activeWorkspaceProjectPath.trim();
    if (!isAgentMode || !nextWorkdir) {
      return;
    }
    const conversationIdValue = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    ).trim();
    if (!conversationIdValue || !isLocalDraftConversationId(conversationIdValue)) {
      return;
    }
    if (isConversationBusy(conversationIdValue)) {
      return;
    }
    if (
      getConversationTranscriptEntryCount(conversationIdValue) > 0 ||
      getPendingUploadsForConversation(conversationIdValue).length > 0
    ) {
      return;
    }
    conversationWorkdirsRef.current.set(conversationIdValue, nextWorkdir);
  }, [
    activeWorkspaceProjectPath,
    getConversationTranscriptEntryCount,
    getPendingUploadsForConversation,
    isAgentMode,
    isConversationBusy,
  ]);

  // Quiet history refresh for the displayed conversation: fetch → parse →
  // id-preserving merge into the transcript store (no flicker, no remount).
  // Only runs while the conversation is idle; a run started mid-fetch aborts
  // the merge so a stale snapshot can never truncate freshly folded entries.
  const refreshDisplayedConversationHistorySnapshot = useCallback(
    async (targetConversationId: string, currentApi = api, options?: { forceFull?: boolean }) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue || isLocalDraftConversationId(conversationIdValue)) {
        return;
      }

      const isStillDisplayedAndIdle = () =>
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
          conversationIdValue && !isConversationBusy(conversationIdValue);
      if (!isStillDisplayedAndIdle()) {
        return;
      }

      // If the full history is already loaded, refresh the full transcript so
      // the merge cannot truncate it back to the most recent page.
      const hasFullHistoryLoaded =
        options?.forceFull === true ||
        (selectedHistoryRef.current?.conversation_id === conversationIdValue &&
          selectedHistoryRef.current.has_more === false);

      let detail: HistoryDetail;
      let entries: ChatEntry[];
      try {
        detail = await currentApi.getHistory(
          conversationIdValue,
          hasFullHistoryLoaded ? undefined : { maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES },
        );
        entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (
          detail.has_more === true &&
          entries.length < getConversationTranscriptEntryCount(conversationIdValue)
        ) {
          // Partial window smaller than what is currently rendered: merging
          // it would truncate the top of a longer transcript. Refetch full.
          detail = await currentApi.getHistory(conversationIdValue);
          entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
        }
      } catch {
        return;
      }
      if (!isStillDisplayedAndIdle()) {
        return;
      }
      const detailConversationId = detail.conversation_id.trim();
      if (detailConversationId !== "" && detailConversationId !== conversationIdValue) {
        return;
      }

      if (selectedHistoryIdRef.current.trim() === conversationIdValue) {
        selectedHistoryRef.current = detail;
        setSelectedHistory(detail);
      }
      transcriptStoreRegistry
        .get(conversationIdValue)
        .applyHistorySnapshot(entries, { mode: "enrich" });
    },
    [api, getConversationTranscriptEntryCount, isConversationBusy, transcriptStoreRegistry],
  );

  const markVisibleConversationRevision = useCallback(() => {
    visibleConversationRevisionRef.current += 1;
    return visibleConversationRevisionRef.current;
  }, []);

  const invalidateHistoryLoad = useCallback(() => {
    historyLoadSequenceRef.current += 1;
    return historyLoadSequenceRef.current;
  }, []);

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

  const setWorkspaceProjectDirectoryMissing = useCallback(
    (project: WorkspaceProject, missing: boolean) => {
      const key = workspaceProjectPathKey(project.path);
      const path = project.path.trim();
      if (!key || !path) return;
      setSettings((prev) => {
        const hasMissingPath = prev.system.missingWorkspaceProjectPaths.some(
          (item) => workspaceProjectPathKey(item) === key,
        );
        if (hasMissingPath === missing) {
          return prev;
        }
        const missingWorkspaceProjectPaths = missing
          ? [...prev.system.missingWorkspaceProjectPaths, path]
          : prev.system.missingWorkspaceProjectPaths.filter(
              (item) => workspaceProjectPathKey(item) !== key,
            );
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              missingWorkspaceProjectPaths,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const checkWorkspaceProjectDirectory = useCallback(
    async (project: WorkspaceProject, currentApi = api) => {
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      if (!currentApi) {
        return !missingWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path));
      }
      try {
        await currentApi.listDirs(path, 1);
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [api, missingWorkspaceProjectPathKeys, setWorkspaceProjectDirectoryMissing],
  );

  const activateWorkspaceProject = useCallback(
    (project: WorkspaceProject, options?: { startConversation?: boolean }) => {
      const pathKey = project.path.trim();
      if (!pathKey) return;
      const normalizedPathKey = workspaceProjectPathKey(pathKey);
      const targetProject =
        workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        ) ?? project;
      setActiveWorkspaceProjectId(targetProject.id);
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        );
        const nextProject = existing ?? targetProject;
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    name: item.id === DEFAULT_WORKSPACE_PROJECT_ID ? item.name : nextProject.name,
                    path: nextProject.path,
                    kind:
                      item.id === DEFAULT_WORKSPACE_PROJECT_ID
                        ? "managed"
                        : nextProject.kind === "history"
                          ? item.kind
                          : nextProject.kind,
                    updatedAt: item.updatedAt,
                    lastConversationAt:
                      Math.max(item.lastConversationAt ?? 0, nextProject.lastConversationAt ?? 0) ||
                      undefined,
                  }
                : item,
            )
          : [...prev.system.workspaceProjects, nextProject];
        const nextSystem = resolveWorkspaceProjects(
          {
            ...prev.system,
            workspaceProjects,
            activeWorkspaceProjectId: existing?.id ?? nextProject.id,
            hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
            missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
            // Activating a workspace always brings it back from the archive.
            archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
          },
          getDefaultWorkspaceProjectPath(prev.system),
        );
        return {
          ...prev,
          system: nextSystem,
        };
      });
      if (options?.startConversation) {
        setActiveView("chat");
        startNewConversation({
          workdir: targetProject.path,
          preserveCurrentComposerDraft: true,
        });
      }
    },
    [setSettings, workspaceProjects],
  );

  const handleSelectWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleNewConversationForProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      if (isMobileSidebarLayout()) {
        setSidebarOpen(false);
      }
      activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleBrowseWorkspaceProjectInFileTree = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) {
        return;
      }

      if (isMobileSidebarLayout()) {
        setSidebarOpen(false);
      }
      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSettings],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setWorkspaceCreateModalOpen(true);
  }, []);

  const handleOpenWorkspaceFolder = useCallback(() => {
    setWorkspaceCreateModalOpen(false);
    setProjectPickerOpen(true);
  }, []);

  const handleCloneWorkspaceProject = useCallback(
    async (remoteUrl: string, parent: string, name: string, branch: string) => {
      if (!api) {
        throw new Error("网关未连接。");
      }
      const task = await api.gitRequest<WorkspaceCloneTask>("clone_start", parent, {
        name,
        remoteUrl,
        branch: branch || undefined,
      });
      dismissedWorkspaceCloneTaskIds.current.delete(task.id);
      setWorkspaceCloneTasks((tasks) => [task, ...tasks.filter((item) => item.id !== task.id)]);
    },
    [api],
  );

  const refreshWorkspaceCloneTasks = useCallback(async () => {
    if (!api) return;
    const tasks = await api.gitRequest<WorkspaceCloneTask[]>("clone_tasks", "");
    setWorkspaceCloneTasks(
      tasks.filter((task) => !dismissedWorkspaceCloneTaskIds.current.has(task.id)),
    );
  }, [api]);

  useEffect(() => {
    void refreshWorkspaceCloneTasks().catch(() => {
      // The next clone operation or connection change retries.
    });
  }, [refreshWorkspaceCloneTasks]);

  const hasActiveWorkspaceCloneTask = workspaceCloneTasks.some(
    (task) => task.status === "running" || task.status === "cancelling",
  );

  useEffect(() => {
    if (!hasActiveWorkspaceCloneTask) return;
    const timer = window.setInterval(() => {
      void refreshWorkspaceCloneTasks().catch(() => {
        // Keep the last task snapshot visible while transport reconnects.
      });
    }, 750);
    return () => window.clearInterval(timer);
  }, [hasActiveWorkspaceCloneTask, refreshWorkspaceCloneTasks]);

  const handleCancelWorkspaceCloneTask = useCallback(
    (taskId: string) => {
      if (!api) return;
      void api
        .gitRequest<WorkspaceCloneTask>("clone_cancel", "", { taskId })
        .then((task) =>
          setWorkspaceCloneTasks((tasks) =>
            tasks.map((item) => (item.id === task.id ? task : item)),
          ),
        )
        .catch(() => {
          // Keep the running task visible so the next poll can reconcile it.
        });
    },
    [api],
  );

  const handleDismissWorkspaceCloneTask = useCallback(
    (taskId: string) => {
      dismissedWorkspaceCloneTaskIds.current.add(taskId);
      setWorkspaceCloneTasks((tasks) => tasks.filter((task) => task.id !== taskId));
      if (!api) return;
      // 服务端同步移除终态任务，否则刷新页面后快照会让卡片重现。
      void api
        .gitRequest<WorkspaceCloneTask[]>("clone_dismiss", "", { taskId })
        .then((tasks) => {
          dismissedWorkspaceCloneTaskIds.current.delete(taskId);
          setWorkspaceCloneTasks(
            tasks.filter((task) => !dismissedWorkspaceCloneTaskIds.current.has(task.id)),
          );
        })
        .catch(() => {
          // 本地 dismissed 集合已隐藏该卡片；服务端移除失败留待下次快照。
        });
    },
    [api],
  );

  const handleOpenClonedWorkspace = useCallback(
    (path: string) => {
      activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, sidebarStore],
  );

  const handleLoadWorkspaceRemoteBranches = useCallback(
    (remoteUrl: string) =>
      api?.gitRequest<{ defaultBranch: string; branches: string[] }>("list_remote_branches", "", {
        remoteUrl,
      }) ?? Promise.reject(new Error("网关未连接。")),
    [api],
  );

  const handleWorkdirPickerSelect = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(normalizedPath, "managed"));
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, sidebarStore],
  );

  const commitWorkspaceProjectRename = useCallback(
    (project: WorkspaceProject, nextNameInput: string) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const nextName = nextNameInput.trim();
      if (!nextName || nextName === project.name) return;
      setSettings((prev) => {
        const pathKey = workspaceProjectPathKey(project.path);
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        const updatedProject: WorkspaceProject = {
          ...(existing ?? project),
          id: existing?.id ?? project.id,
          name: nextName,
          kind: (existing ?? project).kind === "history" ? "folder" : (existing ?? project).kind,
          updatedAt: Date.now(),
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleStartRenamingWorkspaceProject = useCallback((project: WorkspaceProject) => {
    if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
    setProjectRenamingId(project.id);
    setProjectRenameDraft(project.name);
  }, []);

  const handleCommitWorkspaceProjectRename = useCallback(() => {
    if (!projectRenamingId) {
      return;
    }
    const project = workspaceProjects.find((item) => item.id === projectRenamingId);
    if (project) {
      commitWorkspaceProjectRename(project, projectRenameDraft);
    }
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, [commitWorkspaceProjectRename, projectRenameDraft, projectRenamingId, workspaceProjects]);

  const handleCancelWorkspaceProjectRename = useCallback(() => {
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, []);

  const handleSetWorkspaceProjectPinned = useCallback(
    (project: WorkspaceProject, isPinned: boolean) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;

      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        if (!existing && !isPinned) {
          return prev;
        }

        const now = Date.now();
        const source = existing ?? project;
        const updatedProject: WorkspaceProject = {
          ...source,
          id: existing?.id ?? source.id,
          kind: source.id === DEFAULT_WORKSPACE_PROJECT_ID ? "managed" : source.kind,
          updatedAt: now,
          isPinned,
          pinnedAt: isPinned ? now : null,
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleSidebarProjectsCollapsedChange = useCallback(
    (projectsCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            projectsCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  const handleSidebarRecentCollapsedChange = useCallback(
    (recentCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            recentCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  useEffect(() => {
    if (!api) {
      setGatewayConnectionLost(false);
      setSidebarAgentStatusFresh(false);
      return;
    }

    let wasConnected = false;
    let freshnessState = INITIAL_GATEWAY_SIDEBAR_STATUS_FRESHNESS;
    const applyFreshnessEvent = (event: GatewaySidebarStatusFreshnessEvent) => {
      freshnessState = reduceGatewaySidebarStatusFreshness(freshnessState, event);
      setSidebarAgentStatusFresh(freshnessState.agentStatusFresh);
    };

    setGatewayConnectionLost(false);
    setSidebarAgentStatusFresh(false);
    // Subscribe to connection first so an immediately replayed cached status
    // is interpreted against the socket state that owns the current epoch.
    const unsubscribeConnection = api.subscribeConnection((connected) => {
      applyFreshnessEvent({ type: "connection", connected });
      if (connected) {
        wasConnected = true;
        setGatewayConnectionLost(false);
      } else if (wasConnected) {
        setGatewayConnectionLost(true);
      }
    });
    const unsubscribeStatus = api.subscribeStatus((nextStatus, error) => {
      applyFreshnessEvent({ type: "status" });
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setStatusError(error);
    });

    return () => {
      unsubscribeConnection();
      unsubscribeStatus();
    };
  }, [api]);

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
      // the command was parked — server-side history is unchanged; a full
      // quiet refresh restores the truncated suffix.
      void refreshDisplayedConversationHistorySnapshot(
        update.conversationId?.trim() || pending.conversationId,
        api,
        { forceFull: true },
      );
    }
  };
  pipelineOnFailedRef.current = (pending, _errorCode, message) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const conversationIdValue = pending.conversationId.trim();
    if (pending.isEditResend) {
      void refreshDisplayedConversationHistorySnapshot(conversationIdValue, api, {
        forceFull: true,
      });
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

  // chat.activity ingestion: the activity store stays the app-wide running
  // authority; the sidebar store consumes it through the adapter's diff
  // bridge (running/idle events also carry the workdir-activity bumps).
  useEffect(() => {
    if (!api) {
      activityStore.clear();
      return;
    }
    const unsubscribe = api.subscribeChatActivity((event: ConversationActivityEvent) => {
      activityStore.applyActivityEvent(event);
      // Settle pending commands from the always-on hub too: the run may
      // start (or finish) while its conversation is not the displayed one,
      // and without this the 60s startup watchdog would fire spuriously.
      // The `queued` state stays armed — the gateway watchdog plus
      // command_update failed cover that phase.
      if (event.runId && (event.running ? event.state !== "queued" : true)) {
        chatCommandPipeline.handleRunSignal(
          event.conversationId,
          event.runId,
          event.clientRequestId ?? undefined,
        );
      }
    });
    return unsubscribe;
  }, [activityStore, api, chatCommandPipeline]);

  useEffect(() => {
    if (!api) {
      return;
    }
    return api.subscribeChatCommandUpdates((update) => {
      chatCommandPipeline.handleCommandUpdate(update);
    });
  }, [api, chatCommandPipeline]);

  // Every (re)connect re-baselines the activity store from the gateway's
  // authoritative registry: chat.activity broadcasts are single-shot, so a
  // stop that raced a dropped socket would otherwise leave the green dot
  // (and streaming cursor fallback) stuck until the next history.list.
  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    const unsubscribe = api.subscribeConnection((connected) => {
      if (!connected || cancelled) {
        return;
      }
      void api
        .listChatActivities()
        .then((items) => {
          if (cancelled) {
            return;
          }
          activityStore.hydrate(normalizeRunningConversationItems(items), {
            keepConversationIds: chatCommandPipeline.pendingConversationIds(),
          });
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activityStore, api, chatCommandPipeline]);

  // App-level observation of the displayed conversation's stream: titles,
  // pipeline settlement, queue refreshes, tunnel side effects, and the one
  // scroll-compensated fold commit at run_started.
  const observeConversationStreamEvent = useCallback(
    (
      targetConversationId: string,
      event: ConversationStreamEvent,
      options?: { replay?: boolean },
    ) => {
      const isReplay = options?.replay === true;
      const eventClientRequestId =
        typeof (event as { client_request_id?: unknown }).client_request_id === "string"
          ? ((event as { client_request_id: string }).client_request_id ?? "").trim()
          : "";
      switch (event.type) {
        case "run_started": {
          // The fold this event triggers in the store is a pure data
          // transition of the single row list (identical row keys, same DOM
          // container, key-addressed measurement cache) — no scroll
          // compensation is needed.
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          return;
        }
        case "run_finished": {
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          // Settle the sidebar dot by run identity: the stream's terminal is
          // authoritative even when the chat.activity broadcast was missed.
          activityStore.settleRun(targetConversationId, readEventRunId(event));
          const finishedTitle =
            typeof (event as { title?: unknown }).title === "string"
              ? ((event as { title: string }).title ?? "").trim()
              : "";
          if (finishedTitle) {
            applyLiveConversationTitle(targetConversationId, finishedTitle);
          }
          return;
        }
        case "run_queued": {
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          if (!isReplay) {
            refreshChatQueueSnapshot(targetConversationId);
          }
          return;
        }
        default: {
          const chatEvent = event as ChatEvent;
          const liveTitle = readChatEventTitle(chatEvent);
          if (liveTitle && isChatEventTitleFinal(chatEvent)) {
            applyLiveConversationTitle(targetConversationId, liveTitle);
          }
          if (!isReplay) {
            handleTunnelManagerChatEvent(chatEvent);
          }
        }
      }
    },
    [
      activityStore,
      applyLiveConversationTitle,
      chatCommandPipeline,
      handleTunnelManagerChatEvent,
      refreshChatQueueSnapshot,
    ],
  );

  const handleConversationStreamSync = useCallback(
    (targetConversationId: string, result: ConversationSubscribeResult) => {
      if (result.activity) {
        chatCommandPipeline.handleRunSignal(
          targetConversationId,
          result.activity.runId,
          result.activity.clientRequestId,
        );
      } else if (!chatCommandPipeline.hasPending(targetConversationId)) {
        // The authoritative subscribe says nothing is running and no local
        // submission is in flight: a lingering dot for this conversation is
        // a missed-stop zombie — settle it by its own run identity.
        const currentActivity = activityStore.get(targetConversationId);
        if (currentActivity) {
          activityStore.settleRun(targetConversationId, currentActivity.runId);
        }
      }
      for (const event of result.events) {
        observeConversationStreamEvent(targetConversationId, event, { replay: true });
      }
    },
    [activityStore, chatCommandPipeline, observeConversationStreamEvent],
  );

  const handleConversationStreamEvent = useCallback(
    (targetConversationId: string, event: ConversationStreamEvent) => {
      observeConversationStreamEvent(targetConversationId, event);
    },
    [observeConversationStreamEvent],
  );

  const hasPendingChatCommand = useCallback(
    (targetConversationId: string) => chatCommandPipeline.hasPending(targetConversationId),
    [chatCommandPipeline],
  );

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

  const { transcript: displayedTranscript, busy: displayedConversationBusy } = useConversationChat({
    api,
    conversationId: displayedConversationId || null,
    registry: transcriptStoreRegistry,
    activityStore,
    isLocalDraft: isLocalDraftConversationId,
    onStreamEvent: handleConversationStreamEvent,
    onStreamSync: handleConversationStreamSync,
    hasPendingCommand: hasPendingChatCommand,
    pendingRevision: pendingCommandRevision,
  });
  displayedConversationBusyRef.current = displayedConversationBusy;

  // Phase-1 open in flight (initial tail fetch). The quiet phase-2 hydration
  // ("hydrating") intentionally does NOT gate the composer or transcript.
  const historyDetailLoading = conversationOpenState.phase === "opening";

  // Deterministic messageRef attachment: when the displayed conversation
  // transitions busy → idle (run finished), run the quiet enrich refresh so
  // the settled tail's user bubbles gain their persisted messageRef (edit
  // affordance) without waiting for a history upsert to race the idle gate.
  // The upsert-while-idle effect below stays as the backstop for the
  // persist-after-done ordering.
  const previousDisplayedBusyRef = useRef({ id: "", busy: false });
  useEffect(() => {
    const prev = previousDisplayedBusyRef.current;
    previousDisplayedBusyRef.current = {
      id: displayedConversationId,
      busy: displayedConversationBusy,
    };
    if (
      prev.id === displayedConversationId &&
      prev.busy &&
      !displayedConversationBusy &&
      displayedConversationId
    ) {
      void refreshDisplayedConversationHistorySnapshot(displayedConversationId, api);
    }
  }, [
    api,
    displayedConversationBusy,
    displayedConversationId,
    refreshDisplayedConversationHistorySnapshot,
  ]);

  // Inferred liveness failures can settle before the desktop's final history
  // write. History upserts are intentionally lossy broadcasts under WebSocket
  // backpressure, so a stale displayed turn cannot rely on that one signal:
  // keep retrying the quiet enrich at a bounded cadence until history adopts
  // the authoritative persisted reply or the conversation becomes busy again.
  useEffect(() => {
    const conversationIdValue = displayedConversationId.trim();
    if (
      !api ||
      !conversationIdValue ||
      displayedConversationBusy ||
      !displayedTranscript.needsHistoryRefresh
    ) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let retryDelayMs = STALE_HISTORY_RETRY_INITIAL_DELAY_MS;
    const retry = async () => {
      await refreshDisplayedConversationHistorySnapshot(conversationIdValue, api);
      if (cancelled) {
        return;
      }
      const stillStale =
        transcriptStoreRegistry.peek(conversationIdValue)?.getSnapshot().needsHistoryRefresh ===
        true;
      if (!stillStale || isConversationBusy(conversationIdValue)) {
        return;
      }
      retryDelayMs = Math.min(retryDelayMs * 2, STALE_HISTORY_RETRY_MAX_DELAY_MS);
      timerId = window.setTimeout(() => {
        void retry();
      }, retryDelayMs);
    };

    timerId = window.setTimeout(() => {
      void retry();
    }, retryDelayMs);
    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    api,
    displayedConversationBusy,
    displayedConversationId,
    displayedTranscript.needsHistoryRefresh,
    isConversationBusy,
    refreshDisplayedConversationHistorySnapshot,
    transcriptStoreRegistry,
  ]);

  // The upsert-while-idle backstop: the desktop reports run completion before
  // its post-run history flush lands, so the busy→idle enrich above can fetch
  // a window that misses the reply. Once the flush lands the desktop publishes
  // a history upsert — re-run the quiet enrich for the displayed conversation
  // so a turn holding stale or adopted-nothing content converges without a
  // re-open. The refresh itself re-checks displayed + idle around the fetch.
  useEffect(() => {
    if (!api) {
      return;
    }
    return api.subscribeHistory((event) => {
      if (event.kind !== "upsert") {
        return;
      }
      const conversationIdValue = event.conversation_id.trim();
      if (
        !conversationIdValue ||
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) !==
          conversationIdValue
      ) {
        return;
      }
      void refreshDisplayedConversationHistorySnapshot(conversationIdValue, api);
    });
  }, [api, refreshDisplayedConversationHistorySnapshot]);

  // --- Two-phase conversation open (controller deps) ------------------------
  // Phase 1: paint the message tail fast. Sets the selection state
  // synchronously (controller.open calls this in the same tick), fetches the
  // initial slice, and replace-applies it to the transcript store. The web
  // end has no synchronous local-activation path, so it always resolves
  // "painted" (never "cache-hit") — revisits still show the cached transcript
  // instantly because the registry store keeps rendering underneath.
  async function openConversationInitial(
    conversationIdValue: string,
    _seq: number,
  ): Promise<"cache-hit" | "painted"> {
    const currentApi = api;
    if (!currentApi) {
      throw new Error("Gateway client is not ready.");
    }

    const loadSequence = invalidateHistoryLoad();
    const selectionRevision = markVisibleConversationRevision();
    const isStale = () =>
      historyLoadSequenceRef.current !== loadSequence ||
      visibleConversationRevisionRef.current !== selectionRevision;
    const previousDisplayedConversationId = getDisplayedConversationId();
    const isChangingConversation = previousDisplayedConversationId !== conversationIdValue;
    pendingDisplayedConversationAutoBottomRef.current = conversationIdValue;
    if (isChangingConversation && previousDisplayedConversationId) {
      // Fold the previous conversation's settled turns so a revisit starts
      // with a clean virtualized transcript.
      transcriptStoreRegistry.peek(previousDisplayedConversationId)?.foldSettledTurns();
    }

    protectedConversationRef.current = conversationIdValue;
    conversationIdRef.current = conversationIdValue;
    selectedHistoryIdRef.current = conversationIdValue;
    setConversationId(conversationIdValue);
    setSelectedHistoryId(conversationIdValue);
    if (isChangingConversation) {
      setChatError(null);
      setSelectedHistory(null);
    }

    try {
      const detail = await currentApi.getHistory(conversationIdValue, {
        maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
      });
      if (isStale()) {
        return "painted";
      }
      const entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
      if (isStale()) {
        return "painted";
      }
      setSelectedHistory(detail);
      transcriptStoreRegistry
        .get(conversationIdValue)
        .applyHistorySnapshot(entries, { mode: "replace" });
      const detailWorkdir = detail.conversation?.cwd?.trim();
      if (detailWorkdir) {
        conversationWorkdirsRef.current.set(conversationIdValue, detailWorkdir);
      }
      return "painted";
    } catch (error) {
      if (!isStale()) {
        const message = asErrorMessage(
          error,
          translate("chat.history.openFailed", settings.locale),
        );
        setSelectedHistory({
          conversation_id: conversationIdValue,
          messages_json: message,
          has_more: false,
        } satisfies HistoryDetail);
        setChatError(message);
      }
      throw error;
    }
  }

  // Phase 2: quiet full hydration at idle, through the id-preserving enrich
  // path — it never clobbers live-stream transcript entries and it skips
  // entirely when phase 1 already returned the whole conversation.
  async function hydrateConversationFull(conversationIdValue: string, _seq: number): Promise<void> {
    const selected = selectedHistoryRef.current;
    if (selected?.conversation_id === conversationIdValue && selected.has_more !== true) {
      return;
    }
    await refreshDisplayedConversationHistorySnapshot(conversationIdValue, api, {
      forceFull: true,
    });
  }

  openInitialRef.current = openConversationInitial;
  hydrateFullRef.current = hydrateConversationFull;

  const prepareChatRuntime = useCallback(
    async (
      reason: string,
      currentApi = api,
      timeoutMs = CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
    ): Promise<AgentStatus> => {
      if (!currentApi) {
        throw new Error("Gateway client is not ready.");
      }

      if (!chatRuntimePreparePromiseRef.current) {
        chatRuntimePreparePromiseRef.current = currentApi
          .prepareChatRuntime(reason)
          .then((nextStatus) => {
            statusRef.current = nextStatus;
            setStatus(nextStatus);
            setStatusError(null);
            return nextStatus;
          })
          .catch((error) => {
            setStatusError(asErrorMessage(error, "status request failed"));
            throw error;
          })
          .finally(() => {
            chatRuntimePreparePromiseRef.current = null;
          });
      }

      const preparePromise = chatRuntimePreparePromiseRef.current;
      if (!preparePromise) {
        throw new Error("Gateway chat runtime preparation did not start.");
      }
      if (timeoutMs <= 0) {
        return preparePromise;
      }

      let timeoutId: number | null = null;
      try {
        return await Promise.race([
          preparePromise,
          new Promise<AgentStatus>((_, reject) => {
            timeoutId = window.setTimeout(() => {
              reject(new Error("Desktop chat runtime is recovering. Please retry shortly."));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      }
    },
    [api],
  );

  // List loading, reconnect reconciliation, and the 60s silent reconcile all
  // live in the sidebar store now (start/refresh/subscribeConnection); the
  // old mount/online reload effects are gone with reloadHistory.

  // Foreground nudge: waking the page just pings the runtime keep-warm; the
  // socket's own wakeup/reconnect plus per-conversation subscription resume
  // replaces the old page-restore recovery machinery.
  useEffect(() => {
    if (!api || historyShareToken || status?.online !== true) {
      return;
    }

    const nudgeRuntime = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void prepareChatRuntime("foreground", api, CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS).catch(
        () => undefined,
      );
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        nudgeRuntime();
      }
    };

    window.addEventListener("pageshow", nudgeRuntime);
    window.addEventListener("focus", nudgeRuntime);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("resume", nudgeRuntime);
    nudgeRuntime();

    return () => {
      window.removeEventListener("pageshow", nudgeRuntime);
      window.removeEventListener("focus", nudgeRuntime);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("resume", nudgeRuntime);
    };
  }, [api, historyShareToken, prepareChatRuntime, status?.online]);

  useEffect(() => {
    if (!api || historyShareToken || status?.online !== true) {
      return;
    }

    const keepWarm = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void prepareChatRuntime("keep-warm", api, CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS).catch(
        () => undefined,
      );
    };

    keepWarm();
    const intervalId = window.setInterval(keepWarm, CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [api, historyShareToken, prepareChatRuntime, status?.online]);

  // Lean submission flow: optimistic echo + chat.command through the pipeline.
  // Everything after run start flows through the persistent conversation
  // stream subscription — sendChat does not consume stream events at all.
  async function sendChat(
    message: string,
    options?: SendChatOptions,
  ): Promise<ChatCommandOutcome | null> {
    if (!api) {
      return null;
    }

    const uploadedFiles = options?.uploadedFiles ?? [];
    let activeConversationId = options?.conversationId?.trim() || conversationIdRef.current.trim();
    if (!activeConversationId) {
      activeConversationId = createLocalDraftConversationId();
      conversationIdRef.current = activeConversationId;
      selectedHistoryIdRef.current = activeConversationId;
      setConversationId(activeConversationId);
      setSelectedHistoryId(activeConversationId);
    }
    const startedAsDraftConversation = isLocalDraftConversationId(activeConversationId);
    if (chatCommandPipeline.hasPending(activeConversationId)) {
      // One in-flight submission per conversation; the composer routes busy
      // conversations to the GUI queue instead.
      return null;
    }
    clearCachedComposerDraft(activeConversationId);

    const clientRequestId = options?.clientRequestId?.trim() || createUuid();
    const startedAt = Date.now();
    const persistedConversationWorkdir = sidebarStore.peek(activeConversationId)?.cwd?.trim() || "";
    const runtimeConversationWorkdir =
      conversationWorkdirsRef.current.get(activeConversationId)?.trim() || "";
    const effectiveWorkdir = isAgentMode
      ? options?.workdir?.trim() ||
        persistedConversationWorkdir ||
        runtimeConversationWorkdir ||
        activeWorkspaceProjectPath ||
        settings.system.workdir.trim()
      : "";
    if (effectiveWorkdir) {
      conversationWorkdirsRef.current.set(activeConversationId, effectiveWorkdir);
    }
    protectedConversationRef.current = activeConversationId;
    setChatError(null);
    if (isDisplayedConversation(activeConversationId)) {
      transcriptFollow.stickToBottom();
    }
    const turnSelectedModel = selectionForConversation(activeConversationId);
    if (startedAsDraftConversation) {
      draftClientRequestsRef.current.set(clientRequestId, activeConversationId);
      // Optimistic pending sidebar row: survives authoritative reconciles
      // until a server upsert (post-bind) confirms the conversation.
      sidebarStore.upsertLocal({
        id: activeConversationId,
        title: buildOptimisticConversationTitle(message),
        providerId: turnSelectedModel?.customProviderId ?? "",
        model: turnSelectedModel?.model ?? "",
        cwd: effectiveWorkdir || undefined,
        messageCount: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
        isPending: true,
      });
    }

    const runtimeControls = normalizeChatRuntimeControlsForProvider(
      options?.runtimeControls ?? settings.chatRuntimeControls,
      {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
        modelId: turnSelectedModel?.model,
      },
    );
    const commandInput: GatewayChatCommandInput = {
      type: options?.editMessageRef ? "chat.edit_resend" : "chat.submit",
      message,
      conversationId: startedAsDraftConversation ? undefined : activeConversationId,
      selectedModel: buildGatewaySelectedModel(turnSelectedModel, activeProviders),
      systemSettings: buildGatewaySystemSettings(settings, effectiveWorkdir),
      uploadedFiles,
      clientRequestId,
      runtimeControls,
      baseMessageRef: options?.editMessageRef,
      queuePolicy: options?.queuePolicy ?? "auto",
    };

    const outcome = await chatCommandPipeline.submit({
      conversationId: activeConversationId,
      clientRequestId,
      message,
      attachments: uploadedFiles,
      isEditResend: Boolean(options?.editMessageRef),
      baseMessageRef: options?.editMessageRef,
      optimistic: options?.optimisticEcho !== false,
      submit: async () => {
        // Preserve the instant optimistic echo, then serialize the bounded
        // runtime wake-up ahead of dispatch. A failed/old-gateway prepare is a
        // soft degradation: chat.command remains the final wake signal.
        await prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS).catch(
          () => undefined,
        );
        return api.chatCommand(commandInput);
      },
    });

    if (outcome.kind === "accepted") {
      const acceptedConversationId = outcome.accepted.conversationId.trim();
      if (
        startedAsDraftConversation &&
        acceptedConversationId &&
        acceptedConversationId !== activeConversationId &&
        !isLocalDraftConversationId(acceptedConversationId)
      ) {
        // The accept response already carries the real conversation id; run
        // the same binding path a `command_update bound` would take.
        chatCommandPipeline.handleCommandUpdate({
          runId: outcome.accepted.runId,
          clientRequestId,
          conversationId: acceptedConversationId,
          phase: "bound",
          errorCode: null,
          message: null,
        });
      }
    } else if (outcome.kind === "failed") {
      draftClientRequestsRef.current.delete(clientRequestId);
    }
    return outcome;
  }

  // Edit-resend is memoized across settings sync; always call the latest sender
  // so model and execution-mode overrides stay aligned with the visible WebUI state.
  sendChatRef.current = sendChat;

  async function cancelChat(targetConversationId?: string) {
    const activeConversationId = targetConversationId?.trim() || getDisplayedConversationId();
    if (!api || !activeConversationId || isLocalDraftConversationId(activeConversationId)) {
      return;
    }
    // No local terminal marking: the stream's run_finished settles the UI
    // (cancelling state shows until the agent confirms or the gateway
    // watchdog forces the terminal event).
    const runId =
      transcriptStoreRegistry.peek(activeConversationId)?.getSnapshot().activeRun?.runId ??
      activityStore.get(activeConversationId)?.runId ??
      undefined;
    try {
      await api.cancelChat(activeConversationId, runId);
    } catch (error) {
      if (!isAbortError(error)) {
        setChatError(asErrorMessage(error, "cancel chat request failed"));
      }
    }
  }

  async function materializeComposerDraftForSend(
    draft: MentionComposerDraft,
    files: PendingUploadedFile[],
    workdir: string,
  ) {
    let text = (
      isAgentMode && draft.largePastes.length > 0
        ? draft.textWithoutLargePastes
        : buildTextFromComposerDraft(draft)
    ).trim();
    let uploadedFiles = files;

    if (isAgentMode && draft.largePastes.length > 0) {
      setChatError(null);
      isImportingPastedTextRef.current = true;
      setUploadingFiles(true);
      try {
        const agentID = await resolveActiveAgentID();
        const imported = await importPastedTextsAsFiles({
          token,
          agentId: agentID,
          workdir,
          pastes: draft.largePastes,
        });
        if (apiRef.current?.getActiveAgent().trim() !== agentID) {
          throw new Error("Agent 已切换，已取消发送本次大段粘贴内容。");
        }
        text = buildTextFromComposerDraft(draft, imported.fileByPasteId).trim();
        uploadedFiles = mergePendingUploadedFiles(files, imported.files);
      } finally {
        isImportingPastedTextRef.current = false;
        setUploadingFiles(false);
      }
    }

    return { text, uploadedFiles };
  }

  function clearCurrentComposerDraftForQueuedTurn(conversationId: string) {
    const key = conversationId.trim();
    if (!key || getDisplayedConversationId() !== key) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(key, []);
    clearCachedComposerDraft(key);
  }

  async function submitCurrentComposerToGuiQueue(queuePolicy: "append" | "interrupt") {
    const conversationIdValue = getDisplayedConversationId();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    let clearedComposer = false;
    if (!api || !conversationIdValue || !queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }

    const workdirForTurn = (
      conversationWorkdirsRef.current.get(conversationIdValue) ??
      displayedConversationWorkdirRef.current ??
      activeWorkspaceProjectPath ??
      settings.system.workdir
    ).trim();
    try {
      const materialized = await materializeComposerDraftForSend(
        draft,
        uploadedFiles,
        workdirForTurn,
      );
      if (!materialized.text && materialized.uploadedFiles.length === 0) {
        return false;
      }
      clearCurrentComposerDraftForQueuedTurn(conversationIdValue);
      clearedComposer = true;
      if (chatCommandPipeline.hasPending(conversationIdValue)) {
        // A command is already in flight for this conversation: park this one
        // straight into the GUI queue. The pipeline slot (pre-first-token
        // spinner + watchdog) belongs to the first command; the queue panel
        // updates via command_update/run_queued and chat_queue events.
        await prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS).catch(
          () => undefined,
        );
        await api.chatCommand({
          type: "chat.submit",
          message: materialized.text,
          conversationId: isLocalDraftConversationId(conversationIdValue)
            ? undefined
            : conversationIdValue,
          selectedModel: buildGatewaySelectedModel(
            selectionForConversation(conversationIdValue),
            activeProviders,
          ),
          systemSettings: buildGatewaySystemSettings(settings, workdirForTurn),
          uploadedFiles: materialized.uploadedFiles,
          clientRequestId: createUuid(),
          runtimeControls: chatRuntimeControlsForCurrentProvider,
          queuePolicy,
        });
        refreshChatQueueSnapshot(conversationIdValue);
        return true;
      }
      // Same pipeline path as a normal send, minus the optimistic transcript
      // echo — the prompt is queue-destined and must not flash a bubble.
      // `command_update queued_in_gui` (or the stream's run_queued event)
      // refreshes the queue snapshot; a direct start settles through
      // run_started (whose deferred seeds then render the user message).
      const outcome = await sendChat(materialized.text, {
        conversationId: conversationIdValue,
        uploadedFiles: materialized.uploadedFiles,
        runtimeControls: chatRuntimeControlsForCurrentProvider,
        workdir: workdirForTurn,
        queuePolicy,
        optimisticEcho: false,
      });
      if (!outcome) {
        // Benign no-op (client not ready): restore the composer without
        // surfacing an error.
        if (getDisplayedConversationId() === conversationIdValue) {
          if (!composerRef.current?.hasContent()) {
            composerRef.current?.setDraft(draft);
          }
          if (getPendingUploadsForConversation(conversationIdValue).length === 0) {
            setPendingUploadsForConversation(conversationIdValue, uploadedFiles);
          }
        }
        return false;
      }
      if (outcome.kind === "failed") {
        throw new Error(outcome.message);
      }
      return true;
    } catch (error) {
      if (clearedComposer && getDisplayedConversationId() === conversationIdValue) {
        if (!composerRef.current?.hasContent()) {
          composerRef.current?.setDraft(draft);
        }
        if (getPendingUploadsForConversation(conversationIdValue).length === 0) {
          setPendingUploadsForConversation(conversationIdValue, uploadedFiles);
        }
      }
      reportChatQueueActionError(conversationIdValue, error, "queued chat request failed");
      return false;
    }
  }

  async function commitQueuedChatEdit() {
    const session = queuedChatEditSessionRef.current;
    const conversationIdValue = getDisplayedConversationId();
    if (!session || !api || !conversationIdValue) return false;
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }
    try {
      const response = await api.chatQueueEditCommit({
        conversationId: conversationIdValue,
        itemId: session.itemId,
        revision: session.revision,
        draftJson: JSON.stringify(draft),
        uploadedFilesJson: JSON.stringify(uploadedFiles),
      });
      if (!response.accepted) {
        reportChatQueueActionError(
          conversationIdValue,
          response.message || "queued edit failed",
          "queued edit failed",
        );
        return false;
      }
      queuedChatEditSessionRef.current = null;
      composerRef.current?.clear();
      setPendingUploadsForConversation(conversationIdValue, []);
      clearCachedComposerDraft(conversationIdValue);
      applyChatQueueSnapshot(response.snapshot);
      return true;
    } catch (error) {
      reportChatQueueActionError(conversationIdValue, error, "queued edit failed");
      return false;
    }
  }

  function reportChatQueueActionError(conversationId: string, error: unknown, fallback: string) {
    const key = conversationId.trim();
    if (!key) return;
    if (isDisplayedConversation(key)) {
      setChatError(asErrorMessage(error, fallback));
    }
  }

  function runQueuedTurnNow(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueRunNow(conversationIdValue, id)
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
        for (const delayMs of [250, 1000]) {
          window.setTimeout(() => {
            void api
              .chatQueueGet(conversationIdValue)
              .then((nextResponse) => applyChatQueueSnapshot(nextResponse.snapshot))
              .catch(() => undefined);
          }, delayMs);
        }
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat run failed");
      });
  }

  function moveQueuedTurnUp(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueMove(conversationIdValue, id, "up")
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat move failed");
      });
  }

  function editQueuedTurn(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void (async () => {
      if (queuedChatEditSessionRef.current) {
        const committed = await commitQueuedChatEdit();
        if (!committed) return;
      } else {
        const currentDraft = composerRef.current?.getDraft() ?? null;
        const currentUploads = pendingUploadedFiles.slice();
        if (queuedChatTurnHasContent(currentDraft, currentUploads)) {
          const queued = await submitCurrentComposerToGuiQueue("append");
          if (!queued) return;
        }
      }

      const response = await api.chatQueueEditBegin(conversationIdValue, id);
      try {
        if (!response.accepted || !response.item) {
          if (!response.accepted) {
            reportChatQueueActionError(
              conversationIdValue,
              response.message || "queued edit failed",
              "queued edit failed",
            );
          }
          return;
        }
        const draft = JSON.parse(response.item.draftJson) as MentionComposerDraft;
        const uploadedFiles = JSON.parse(response.item.uploadedFilesJson) as PendingUploadedFile[];
        queuedChatEditSessionRef.current = {
          itemId: response.item.id,
          revision: response.snapshot?.revision ?? chatQueueRevisionRef.current,
        };
        composerRef.current?.setDraft(draft);
        setPendingUploadsForConversation(
          conversationIdValue,
          Array.isArray(uploadedFiles) ? uploadedFiles : [],
        );
        clearCachedComposerDraft(conversationIdValue);
        applyChatQueueSnapshot(response.snapshot);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      } catch (error) {
        throw new Error(asErrorMessage(error, "invalid queued edit payload"));
      }
    })().catch((error) => {
      reportChatQueueActionError(conversationIdValue, error, "queued chat edit failed");
    });
  }

  function removeQueuedTurn(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueRemove(conversationIdValue, id)
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat remove failed");
      });
  }

  function startNewConversation(options?: {
    workdir?: string;
    preserveCurrentComposerDraft?: boolean;
  }) {
    const currentConversationId = getVisibleComposerConversationId().trim();
    if (currentConversationId) {
      transcriptStoreRegistry.peek(currentConversationId)?.foldSettledTurns();
      if (options?.preserveCurrentComposerDraft) {
        cacheVisibleComposerDraft(currentConversationId);
      } else {
        clearCachedComposerDraft(currentConversationId);
      }
    }
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    openController.cancel();
    const nextConversationId = createLocalDraftConversationId();
    protectedConversationRef.current = PROTECTED_DRAFT_CONVERSATION;
    submitInFlightRef.current = false;
    composerDraftOwnerRef.current = "";
    composerRef.current?.clear();
    const nextWorkdir = options?.workdir?.trim() || "";
    if (nextWorkdir) {
      conversationWorkdirsRef.current.set(nextConversationId, nextWorkdir);
    }
    conversationIdRef.current = nextConversationId;
    selectedHistoryIdRef.current = nextConversationId;
    setConversationId(nextConversationId);
    setSelectedHistoryId(nextConversationId);
    setChatError(null);
    setSelectedHistory(null);
    setPendingUploadsForConversation(nextConversationId, []);
  }

  const removeWorkspaceProjectFromSettings = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const path = project.path.trim();
      const pathKey = workspaceProjectPathKey(path);
      // Removing the last non-archived workspace would leave nothing usable;
      // the default project is unarchived alongside in that case. The merged
      // list (settings + history workdirs) is the authority on what remains.
      const hasOtherActiveProjects = workspaceProjects.some(
        (item) =>
          item.id !== project.id &&
          workspaceProjectPathKey(item.path) !== pathKey &&
          !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(item.path)),
      );
      setActiveWorkspaceProjectId((current) => {
        const currentProject = workspaceProjects.find((item) => item.id === current);
        if (
          current === project.id ||
          (pathKey && currentProject && workspaceProjectPathKey(currentProject.path) === pathKey)
        ) {
          return DEFAULT_WORKSPACE_PROJECT_ID;
        }
        return current;
      });
      setSettings((prev) => {
        const nextHidden =
          pathKey &&
          prev.system.hiddenWorkspaceProjectPaths.some(
            (item) => workspaceProjectPathKey(item) === pathKey,
          )
            ? prev.system.hiddenWorkspaceProjectPaths
            : path
              ? [...prev.system.hiddenWorkspaceProjectPaths, path]
              : prev.system.hiddenWorkspaceProjectPaths;
        const nextSettings = {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects: prev.system.workspaceProjects.filter(
                (item) => item.id !== project.id && workspaceProjectPathKey(item.path) !== pathKey,
              ),
              hiddenWorkspaceProjectPaths: nextHidden,
              missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
                (item) => workspaceProjectPathKey(item) !== pathKey,
              ),
              archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
                (item) => {
                  const itemKey = workspaceProjectPathKey(item);
                  if (itemKey === pathKey) return false;
                  return (
                    hasOtherActiveProjects ||
                    itemKey !== workspaceProjectPathKey(getDefaultWorkspaceProjectPath(prev.system))
                  );
                },
              ),
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
        return removeRightDockProjectState(nextSettings, pathKey);
      });
      setProjectRenamingId((current) => (current === project.id ? null : current));
      setProjectRenameDraft("");
    },
    [archivedWorkspaceProjectPathKeys, setSettings, workspaceProjects],
  );

  const handleRemoveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;

      void (async () => {
        const currentApi = api;
        if (!currentApi) {
          setSidebarActionError("Gateway 未连接，暂时不能删除项目会话。");
          return;
        }

        const path = project.path.trim();
        const pathKey = workspaceProjectPathKey(path);
        const runningMessage = "项目中仍有后台任务运行，暂时不能删除该项目。";
        const projectHasRunningConversation = () => {
          if (!pathKey) return false;
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
        };

        if (projectHasRunningConversation()) {
          setSidebarActionError(runningMessage);
          return;
        }

        setSidebarActionError(null);
        try {
          const conversationIds: string[] = [];
          const seenConversationIds = new Set<string>();
          if (path) {
            for (let pageNumber = 1; ; pageNumber += 1) {
              const page = await currentApi.listHistory(
                pageNumber,
                PROJECT_HISTORY_DELETE_PAGE_SIZE,
                { cwd: path },
              );
              for (const item of page.conversations) {
                const id = item.id.trim();
                if (!id || seenConversationIds.has(id)) continue;
                seenConversationIds.add(id);
                conversationIds.push(id);
              }

              if (
                page.conversations.length === 0 ||
                conversationIds.length >= page.total_count ||
                page.conversations.length < PROJECT_HISTORY_DELETE_PAGE_SIZE
              ) {
                break;
              }
            }
          }

          const runningConversationIdsInProject = conversationIds.filter((id) =>
            isConversationBusy(id),
          );
          if (runningConversationIdsInProject.length > 0 || projectHasRunningConversation()) {
            setSidebarActionError(runningMessage);
            return;
          }

          let terminalSessionsToClose: TerminalSession[] = [];
          const pruneProjectTerminalSessions = () => {
            terminalSessionsVersionRef.current += 1;
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          };
          if (
            terminalClient &&
            (settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal) &&
            pathKey
          ) {
            terminalSessionsToClose = await terminalClient.list(pathKey);
            const runningTerminalCount = terminalSessionsToClose.filter(
              (session) => session.running,
            ).length;
            if (runningTerminalCount > 0) {
              const confirmed = await requestConfirmDialog({
                title: translate("chat.workspaceRemoveConfirm", settings.locale).replace(
                  "{name}",
                  project.name,
                ),
                subtitle: translate("chat.workspaceRemoveDescription", settings.locale),
                description: (
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      <Terminal className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {translate("chat.exitConfirmRunningLabel", settings.locale)}
                        </span>
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-amber-700 dark:text-amber-300">
                          {runningTerminalCount}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                        {translate("chat.workspaceRemoveTerminalDescription", settings.locale)}
                      </p>
                    </div>
                  </div>
                ),
                confirmLabel: translate("chat.workspaceRemoveConfirmContinue", settings.locale),
                cancelLabel: translate("chat.cancel", settings.locale),
                closeLabel: translate("chat.workspaceRemoveConfirmClose", settings.locale),
                tone: "warning",
              });
              if (!confirmed) {
                return;
              }
            }
          }

          const visibleConversationId = resolveVisibleConversationId(
            selectedHistoryIdRef.current,
            conversationIdRef.current,
          );
          const visibleRuntimeWorkdir =
            conversationWorkdirsRef.current.get(visibleConversationId)?.trim() || "";
          const visiblePersistedWorkdir =
            sidebarStore.peek(visibleConversationId)?.cwd?.trim() || "";
          const visibleWorkdir =
            visiblePersistedWorkdir ||
            visibleRuntimeWorkdir ||
            (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");

          for (const conversationId of conversationIds) {
            await currentApi.deleteHistory(conversationId);
          }

          const deletedConversationIds = new Set(conversationIds);
          if (deletedConversationIds.size > 0) {
            const nextSharedItems = sharedHistoryItemsRef.current.filter(
              (item) => !deletedConversationIds.has(item.id),
            );
            sharedHistoryItemsRef.current = nextSharedItems;
            setSharedHistoryItems(nextSharedItems);

            for (const conversationId of deletedConversationIds) {
              // Immediate local echo; the gateway delete events confirm.
              sidebarStore.removeLocal(conversationId);
              transcriptStoreRegistry.remove(conversationId);
              conversationWorkdirsRef.current.delete(conversationId);
              clearCachedComposerDraft(conversationId);
              setPendingUploadsForConversation(conversationId, []);
            }
          }
          if (terminalSessionsToClose.length > 0 && terminalClient) {
            await terminalClient.closeProject(pathKey);
            pruneProjectTerminalSessions();
          }
          if (pathKey && workspaceProjectPathKey(activeWorkspaceProjectPath) === pathKey) {
            setRightDockOpen(false);
            if (terminalSessionsToClose.length === 0) {
              pruneProjectTerminalSessions();
            }
          }

          const shouldResetVisibleConversation =
            Boolean(visibleConversationId && deletedConversationIds.has(visibleConversationId)) ||
            Boolean(pathKey && workspaceProjectPathKey(visibleWorkdir) === pathKey);

          if (path) {
            await memoryDeleteProject({
              workdir: path,
              actor: "tool",
              reason: "workspace project removed",
            });
          }
          removeWorkspaceProjectFromSettings(project);
          // The conversation-removal watcher may already have migrated the
          // selection; only reset when the same conversation is still shown.
          if (
            shouldResetVisibleConversation &&
            getDisplayedConversationId() === visibleConversationId.trim()
          ) {
            startNewConversation({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
          void sidebarStore.refreshWorkdirs("delete");
        } catch (error) {
          setSidebarActionError(asErrorMessage(error, "删除项目失败"));
        }
      })();
    },
    [
      activeWorkspaceProjectPath,
      activityStore,
      api,
      clearCachedComposerDraft,
      isAgentMode,
      isConversationBusy,
      removeWorkspaceProjectFromSettings,
      requestConfirmDialog,
      settings.remote.enableWebSshTerminal,
      settings.remote.enableWebTerminal,
      settings.locale,
      settings.system,
      setPendingUploadsForConversation,
      sidebarStore,
      startNewConversation,
      terminalClient,
    ],
  );

  const handleArchiveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey || archivedWorkspaceProjectPathKeys.has(pathKey)) return;
      const fallbackProject = workspaceProjects.find(
        (item) =>
          item.id !== project.id &&
          workspaceProjectPathKey(item.path) !== pathKey &&
          !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(item.path)),
      );
      // Archiving is only offered while another active workspace remains.
      if (!fallbackProject) return;
      if (
        activeWorkspaceProject &&
        (activeWorkspaceProject.id === project.id ||
          workspaceProjectPathKey(activeWorkspaceProject.path) === pathKey)
      ) {
        activateWorkspaceProject(fallbackProject);
      }
      setSettings((prev) =>
        prev.system.archivedWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === pathKey,
        )
          ? prev
          : {
              ...prev,
              system: {
                ...prev.system,
                archivedWorkspaceProjectPaths: [
                  ...prev.system.archivedWorkspaceProjectPaths,
                  project.path.trim(),
                ],
              },
            },
      );
    },
    [
      activateWorkspaceProject,
      activeWorkspaceProject,
      archivedWorkspaceProjectPathKeys,
      setSettings,
      workspaceProjects,
    ],
  );

  const handleUnarchiveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;
      setSettings((prev) => {
        const next = prev.system.archivedWorkspaceProjectPaths.filter(
          (path) => workspaceProjectPathKey(path) !== pathKey,
        );
        if (next.length === prev.system.archivedWorkspaceProjectPaths.length) {
          return prev;
        }
        return {
          ...prev,
          system: {
            ...prev.system,
            archivedWorkspaceProjectPaths: next,
          },
        };
      });
    },
    [setSettings],
  );

  function handleSidebarNewConversation() {
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    setActiveView("chat");
    const visibleConversationId = getVisibleComposerConversationId();
    if (
      activeView !== "chat" &&
      (visibleConversationId === "" || isLocalDraftConversationId(visibleConversationId))
    ) {
      return;
    }
    startNewConversation({
      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
      preserveCurrentComposerDraft: true,
    });
  }

  function handleSidebarSelectConversation(id: string) {
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    setActiveView("chat");

    const targetConversationId = id.trim();
    if (!targetConversationId) {
      return;
    }

    const currentConversationId = getVisibleComposerConversationId().trim();
    if (currentConversationId !== targetConversationId) {
      prepareComposerForConversationChange();
    }

    pendingDisplayedConversationAutoBottomRef.current = targetConversationId;

    if (isLocalDraftConversationId(targetConversationId)) {
      // Local drafts have no server history to load; the transcript store is
      // already the source (optimistic entries and error entries included).
      openController.cancel();
      invalidateHistoryLoad();
      markVisibleConversationRevision();
      if (currentConversationId && currentConversationId !== targetConversationId) {
        transcriptStoreRegistry.peek(currentConversationId)?.foldSettledTurns();
      }
      protectedConversationRef.current = targetConversationId;
      conversationIdRef.current = targetConversationId;
      selectedHistoryIdRef.current = targetConversationId;
      setConversationId(targetConversationId);
      setSelectedHistoryId(targetConversationId);
      setChatError(null);
      setSelectedHistory(null);
      restoreCachedComposerDraft(targetConversationId);
      return;
    }

    // Two-phase open: initial tail paint now, quiet full hydration at idle;
    // the overlay appears only after ~150ms of still-loading.
    openController.open(targetConversationId);
    restoreCachedComposerDraft(targetConversationId);
  }

  // Conversations that left the authoritative sidebar index (remote deletes,
  // confirmed local deletes, reconcile drops): clean per-conversation caches
  // and migrate the selection when the displayed conversation vanished.
  // Local drafts are skipped — a failed draft keeps its transcript (error
  // entry) visible; user-initiated draft removal goes through
  // handleSidebarLocalDraftDeleted instead.
  const handleSidebarConversationsRemoved = useCallback(
    (ids: readonly string[]) => {
      const displayedId = getDisplayedConversationId();
      let displayedRemoved = false;
      const removedIds = new Set<string>();
      for (const id of ids) {
        if (isLocalDraftConversationId(id)) {
          continue;
        }
        removedIds.add(id);
        transcriptStoreRegistry.remove(id);
        conversationWorkdirsRef.current.delete(id);
        composerDraftCacheRef.current.delete(id);
        setPendingUploadsForConversation(id, []);
        if (id === displayedId) {
          displayedRemoved = true;
        }
      }
      if (removedIds.size === 0) {
        return;
      }
      const nextSharedItems = sharedHistoryItemsRef.current.filter(
        (item) => !removedIds.has(item.id),
      );
      if (nextSharedItems.length !== sharedHistoryItemsRef.current.length) {
        sharedHistoryItemsRef.current = nextSharedItems;
        setSharedHistoryItems(nextSharedItems);
      }
      if (displayedRemoved) {
        startNewConversation({
          workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
        });
      }
    },
    [
      activeWorkspaceProjectPath,
      isAgentMode,
      setPendingUploadsForConversation,
      transcriptStoreRegistry,
    ],
  );

  const handleSidebarLocalDraftDeleted = useCallback(
    (id: string) => {
      transcriptStoreRegistry.remove(id);
      conversationWorkdirsRef.current.delete(id);
      composerDraftCacheRef.current.delete(id);
      setPendingUploadsForConversation(id, []);
      if (conversationIdRef.current === id || selectedHistoryIdRef.current === id) {
        startNewConversation({
          workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
        });
      }
    },
    [
      activeWorkspaceProjectPath,
      isAgentMode,
      setPendingUploadsForConversation,
      transcriptStoreRegistry,
    ],
  );

  function handleSidebarOpenSkillsHub() {
    setRightDockOpen(false);
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    cacheVisibleComposerDraft();
    setActiveView("skills-hub");
  }

  function handleSidebarOpenMcpHub() {
    setRightDockOpen(false);
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    cacheVisibleComposerDraft();
    setActiveView("mcp-hub");
  }

  function handleOpenShareModal(item: ChatHistorySummary) {
    setShareConversation(item);
    setShareStatus(null);
    setShareError(null);
    if (!api) {
      setShareError("Gateway 尚未连接，无法读取分享状态。");
      return;
    }

    setShareLoading(true);
    void api
      .getHistoryShare(item.id)
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, "读取分享状态失败"));
      })
      .finally(() => {
        setShareLoading(false);
      });
  }

  function handleCloseShareModal() {
    setShareConversation(null);
    setShareStatus(null);
    setShareError(null);
    setShareLoading(false);
    setShareUpdating(false);
  }

  function handleToggleHistoryShare(enabled: boolean, options?: { redactToolContent?: boolean }) {
    const item = shareConversation;
    if (!api || !item) {
      return;
    }

    setShareError(null);
    setShareUpdating(true);
    void api
      .setHistoryShare(item.id, enabled, options)
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, enabled ? "开启分享失败" : "关闭分享失败"));
      })
      .finally(() => {
        setShareUpdating(false);
      });
  }

  function handleSetShareRedactToolContent(redactToolContent: boolean) {
    const item = shareConversation;
    if (!api || !item) {
      return;
    }

    setShareError(null);
    setShareUpdating(true);
    void api
      .setHistoryShare(item.id, true, { redactToolContent })
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, "更新分享脱敏设置失败"));
      })
      .finally(() => {
        setShareUpdating(false);
      });
  }

  function updateSharedManagerIdSet(
    setter: (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
    id: string,
    enabled: boolean,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function setSharedManagerError(id: string, message: string | null) {
    setSharedManagerErrors((current) => {
      const next = { ...current };
      if (message) {
        next[id] = message;
      } else {
        delete next[id];
      }
      return next;
    });
  }

  const setSharedHistoryItemsState = useCallback((items: ChatHistorySummary[]) => {
    const nextItems = sortSidebarConversations(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  const refreshSharedHistoryItems = useCallback(
    async (currentApi = api, options?: { force?: boolean; generation?: string }) => {
      if (!currentApi) {
        sharedHistoryListRequestRef.current = null;
        setSharedHistoryItemsState([]);
        setSharedHistoryListError(null);
        return [];
      }
      if (sharedHistoryListRequestRef.current && options?.force !== true) {
        return sharedHistoryListRequestRef.current.promise;
      }

      const request = (async () => {
        const byId = new Map<string, ChatHistorySummary>();
        let totalCount = 0;
        for (let pageNumber = 1; ; pageNumber += 1) {
          const response = await currentApi.listSharedHistory(
            pageNumber,
            SHARED_HISTORY_LIST_PAGE_SIZE,
          );
          totalCount = Math.max(0, response.total_count);
          for (const conversation of response.conversations) {
            const item = normalizeGatewayConversationSummary(conversation);
            byId.set(item.id, { ...item, isShared: true });
          }
          if (response.conversations.length === 0 || byId.size >= totalCount) {
            break;
          }
        }

        return sortSidebarConversations(Array.from(byId.values()));
      })();

      const requestState = {
        generation: options?.generation?.trim() || "manual",
        promise: request,
      };
      sharedHistoryListRequestRef.current = requestState;
      setSharedHistoryListError(null);
      try {
        const nextItems = await request;
        if (sharedHistoryListRequestRef.current === requestState) {
          setSharedHistoryItemsState(nextItems);
          setSharedHistoryListError(null);
          return nextItems;
        }
        return sharedHistoryItemsRef.current;
      } catch (error) {
        if (sharedHistoryListRequestRef.current === requestState) {
          setSharedHistoryListError(asErrorMessage(error, "读取已分享历史列表失败"));
        }
        return sharedHistoryItemsRef.current;
      } finally {
        if (sharedHistoryListRequestRef.current === requestState) {
          sharedHistoryListRequestRef.current = null;
        }
      }
    },
    [api, setSharedHistoryItemsState],
  );

  useEffect(() => {
    if (!api) {
      sharedHistoryListRequestRef.current = null;
      setSharedHistoryItemsState([]);
      setSharedHistoryListError(null);
      return;
    }
    if (gatewayConnectionLost || status?.online !== true) {
      return;
    }
    // Force a new generation when the browser socket recovers or the desktop
    // AgentSession identity changes. A request tied to the old generation may
    // finish with `agent offline`; it must not poison the freshly loaded list.
    void refreshSharedHistoryItems(api, {
      force: true,
      generation: status.session_id?.trim() || "online",
    });
  }, [
    api,
    gatewayConnectionLost,
    refreshSharedHistoryItems,
    setSharedHistoryItemsState,
    status?.online,
    status?.session_id,
  ]);

  function markSharedConversation(
    id: string,
    isShared: boolean,
    source?: ChatHistorySummary | null,
  ) {
    const existingRow = sidebarStore.peek(id);
    if (existingRow && existingRow.isShared !== isShared) {
      sidebarStore.upsertLocal({ ...existingRow, isShared });
    }
    if (!isShared) {
      setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
      return;
    }

    const conversation =
      source ?? existingRow ?? sharedHistoryItemsRef.current.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    setSharedHistoryItemsState([
      { ...conversation, isShared: true },
      ...sharedHistoryItemsRef.current.filter((item) => item.id !== id),
    ]);
  }

  function handleLoadSharedHistoryStatus(item: ChatHistorySummary) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法读取分享状态。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerLoadingIds, id, true);
    void api
      .getHistoryShare(id)
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "读取分享状态失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerLoadingIds, id, false);
      });
  }

  function handleRefreshSharedHistoryStatuses() {
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }

  function handleOpenSharedHistoryManager() {
    setSharedManagerOpen(true);
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }

  function handleDisableSharedHistory(item: ChatHistorySummary) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法关闭分享。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
    void api
      .setHistoryShare(id, false)
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
        if (shareConversation?.id === id) {
          setShareStatus(status);
        }
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "关闭分享失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
      });
  }

  function handleSetSharedHistoryRedactToolContent(
    item: ChatHistorySummary,
    redactToolContent: boolean,
  ) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法更新分享脱敏设置。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
    void api
      .setHistoryShare(id, true, { redactToolContent })
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
        if (shareConversation?.id === id) {
          setShareStatus(status);
        }
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "更新分享脱敏设置失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
      });
  }

  const handleResendFromEdit = useCallback(
    async (messageRef: HistoryMessageRef, text: string, uploadedFiles: PendingUploadedFile[]) => {
      const activeConversationId = conversationIdRef.current.trim();
      if (
        !api ||
        !activeConversationId ||
        isLocalDraftConversationId(activeConversationId) ||
        isConversationBusy(activeConversationId)
      ) {
        return;
      }
      const normalized = text.trim();
      if (!normalized && uploadedFiles.length === 0) {
        return;
      }

      setChatError(null);
      composerRef.current?.clear();
      setPendingUploadsForConversation(activeConversationId, []);

      // Same pipeline path as a normal send, carrying the base message ref.
      // The pipeline atomically truncates the visible suffix and inserts the
      // optimistic replacement; the stream's seeded `rebased` event confirms
      // it, and `user_message` adopts the bubble by client_request_id.
      try {
        await sendChatRef.current?.(normalized, {
          conversationId: activeConversationId,
          uploadedFiles,
          editMessageRef: messageRef,
        });
      } catch (error) {
        setChatError(asErrorMessage(error, "编辑后重发失败"));
      }
    },
    [api, isConversationBusy, setPendingUploadsForConversation],
  );

  // handleSidebarSelectConversation is a plain per-render function; route the
  // branch handler through a ref (same pattern as sendChatRef) so the callback
  // stays stable for the memoized transcript region.
  const selectConversationRef = useRef(handleSidebarSelectConversation);
  selectConversationRef.current = handleSidebarSelectConversation;
  // The button stays clickable during the WS round-trip; a ref (not state)
  // blocks duplicate confirms without changing the callback identity, while
  // the pending-anchor state drives the clicked row's spinner.
  const branchInFlightRef = useRef(false);
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);

  const handleBranchConversation = useCallback(
    async (messageRef: HistoryMessageRef) => {
      if (!api) return;
      const activeConversationId = conversationIdRef.current.trim();
      if (
        !activeConversationId ||
        isLocalDraftConversationId(activeConversationId) ||
        isConversationBusy(activeConversationId)
      ) {
        return;
      }
      if (branchInFlightRef.current) return;
      branchInFlightRef.current = true;
      setBranchPendingMessageId(messageRef.messageId);
      try {
        const summary = await api.branchHistory(activeConversationId, messageRef);
        sidebarStore.upsertLocal(normalizeGatewayConversationSummary(summary));
        selectConversationRef.current(summary.id);
      } catch (error) {
        setChatError(asErrorMessage(error, translate("chat.branchFailed", settings.locale)));
      } finally {
        branchInFlightRef.current = false;
        setBranchPendingMessageId(null);
      }
    },
    [api, isConversationBusy, sidebarStore, settings.locale],
  );

  const handleLoadUploadedImagePreview = useCallback(
    async (workspaceRoot: string, absolutePath: string) => {
      if (!api) {
        return null;
      }
      const result = await api.readUploadedImagePreview(workspaceRoot, absolutePath);
      if (!result.data.trim()) {
        return null;
      }
      return result;
    },
    [api],
  );

  const handleComposerBusyChange = useCallback((_isBusy: boolean) => {}, []);

  function openSettings(section: SectionId = "system") {
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    setSettingsSection(section);
    setSettingsOpen(true);
    setOverlay("entering");
    requestAnimationFrame(() => requestAnimationFrame(() => setOverlay("open")));
  }

  function closeSettings() {
    setOverlay("leaving");
  }

  function handleSettingsTransitionEnd() {
    if (overlay === "leaving") {
      setSettingsOpen(false);
      setOverlay("closed");
    }
  }

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
    conversationWorkdirsRef.current.clear();
    composerDraftCacheRef.current.clear();
    composerDraftOwnerRef.current = "";
    composerRef.current?.clear();
    conversationIdRef.current = "";
    selectedHistoryIdRef.current = "";
    selectedHistoryRef.current = null;
    sharedHistoryItemsRef.current = [];
    sharedHistoryListRequestRef.current = null;
    clearPendingUploads();
    protectedConversationRef.current = "";
    submitInFlightRef.current = false;
    setUserMenuOpen(false);
    setSettingsOpen(false);
    setOverlay("closed");
    setStatus(null);
    setStatusError(null);
    setConversationId("");
    setChatError(null);
    setSidebarActionError(null);
    setSharedHistoryListError(null);
    setFullHistoryLoading(false);
    setSharedHistoryItems([]);
    queuedChatTurnsRef.current = [];
    chatQueueConversationIdRef.current = "";
    chatQueueRevisionRef.current = 0;
    queuedChatEditSessionRef.current = null;
    setQueuedChatTurns([]);
    setChatQueueRevision(0);
    resetProjectToolsRuntimeRef.current();
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
    transcriptStoreRegistry,
  ]);

  const userMenuLabel = (status?.name || status?.agent_id || "当前用户").trim() || "当前用户";
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
      sharedHistoryItemsRef.current = [];
      sharedHistoryListRequestRef.current = null;
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
      setSharedHistoryItems([]);
      setSharedHistoryListError(null);
      setShareConversation(null);
      setShareStatus(null);
      setShareLoading(false);
      setShareUpdating(false);
      setShareError(null);
      setSharedManagerOpen(false);
      setSharedManagerStatuses({});
      setSharedManagerLoadingIds(new Set());
      setSharedManagerUpdatingIds(new Set());
      setSharedManagerErrors({});
      setProjectPickerOpen(false);
      setSettingsOpen(false);
      setOverlay("closed");
      setActiveView("chat");
      setRightDockOpen(false);
      setNotifyItems([]);
      resetProjectToolsRuntimeRef.current();
    },
    [
      activityStore,
      chatCommandPipeline,
      clearPendingUploads,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      openController,
      transcriptStoreRegistry,
    ],
  );

  const localeContextValue = useMemo(
    () => ({
      locale: settings.locale,
      t: (key: string) => translate(key, settings.locale),
    }),
    [settings.locale],
  );

  const activeProviders = useMemo<ModelProviderSource[]>(
    // WebUI provider config should follow the synced settings payload directly.
    // Using a separately fetched provider summary here can leave the model list stale
    // after Settings has already synced in either direction.
    () => settings.customProviders,
    [settings.customProviders],
  );

  const currentModelLabel = useMemo(() => {
    if (!activeSelectedModel) {
      return "选择模型";
    }
    const provider = activeProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    return provider ? `${provider.name} / ${activeSelectedModel.model}` : activeSelectedModel.model;
  }, [activeProviders, activeSelectedModel]);
  const currentModelContextWindow = useMemo(() => {
    if (!activeSelectedModel) {
      return undefined;
    }
    const provider = settings.customProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    if (!provider) {
      return undefined;
    }
    return findProviderModelConfig(provider, activeSelectedModel.model).contextWindow;
  }, [settings.customProviders, activeSelectedModel]);
  const currentChatProvider = useMemo(() => {
    if (!activeSelectedModel) {
      return undefined;
    }
    return settings.customProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
  }, [settings.customProviders, activeSelectedModel]);
  const chatRuntimeReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
        modelId: activeSelectedModel?.model,
      }),
    [currentChatProvider?.requestFormat, currentChatProvider?.type, activeSelectedModel?.model],
  );
  const chatRuntimeThinkingAlwaysOn = useMemo(
    () =>
      isThinkingAlwaysOnForModel(
        currentChatProvider?.type ?? "claude_code",
        activeSelectedModel?.model,
      ),
    [currentChatProvider?.type, activeSelectedModel?.model],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
        modelId: activeSelectedModel?.model,
      }),
    [
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      settings.chatRuntimeControls,
      activeSelectedModel?.model,
    ],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(prev.chatRuntimeControls, patch, {
          providerId: currentChatProvider?.type,
          requestFormat: currentChatProvider?.requestFormat,
          modelId: activeSelectedModel?.model,
        }),
      }));
    },
    [
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      setSettings,
      activeSelectedModel?.model,
    ],
  );
  const isAgentDevExecutionMode = isAgentDevMode(settings.system.executionMode);

  const modelOptions = useMemo(
    () => buildModelOptions(settings, { floatSelectedFirst: false }),
    [settings],
  );
  const selectedValue = activeSelectedModel
    ? toModelValue(activeSelectedModel.customProviderId, activeSelectedModel.model)
    : undefined;

  // 选择器切换：写当前会话的本地 override（下次发消息随 selected_model 落库），
  // 并同步更新「新会话默认模型」（最近使用语义，走既有 settings 同步通道）。
  const handleSelectModel = useCallback(
    (selection: SelectedModel) => {
      const targetConversationId = displayedConversationId.trim();
      if (targetConversationId) {
        setConversationModelOverrides((prev) => {
          const next = new Map(prev);
          next.set(targetConversationId, selection);
          return next;
        });
      }
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [displayedConversationId, setSettings],
  );

  const skillsEnabled = settings.skills.enabled && isAgentMode;
  const selectedSkillNames = useMemo(
    () => (skillsEnabled ? mergeAlwaysEnabledSkillNames(settings.skills.selected) : []),
    [skillsEnabled, settings.skills.selected],
  );
  const { availableSkills, skillsRootDir } = useChatSkills({
    skillsEnabled,
    selectedSkillNames,
    setSettings,
  });
  const enabledComposerSkills = useMemo(() => {
    if (!skillsEnabled || selectedSkillNames.length === 0 || availableSkills.length === 0) {
      return [];
    }
    const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
    return selectedSkillNames
      .map((name) => byName.get(name))
      .filter((skill): skill is (typeof availableSkills)[number] => Boolean(skill));
  }, [availableSkills, selectedSkillNames, skillsEnabled]);
  const codeReviewSkill = useMemo(
    () =>
      availableSkills.find(
        (skill) => skill.name === "liveagent-code-review" && skill.builtIn === true,
      ),
    [availableSkills],
  );

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
    [displayedConversationId, queuedChatTurns],
  );
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  // getRightDockProjectState / getRightDockFileTreeState / getSshProjectHostIds
  // build fresh objects on every call, so memoize on the owning settings slice
  // + path key: RightDockPanel is memo'd and these references are props.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on settings.customSettings.rightDock (the only slice these getters read) so unrelated settings changes keep the reference stable.
  const rightDockProjectState = useMemo(
    () => getRightDockProjectState(settings.customSettings, terminalProjectPathKey),
    [settings.customSettings.rightDock, terminalProjectPathKey],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on settings.customSettings.rightDock (the only slice these getters read) so unrelated settings changes keep the reference stable.
  const rightDockFileTreeState = useMemo(
    () => getRightDockFileTreeState(settings.customSettings, terminalProjectPathKey),
    [settings.customSettings.rightDock, terminalProjectPathKey],
  );
  const rightDockFileTreeOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "fileTree",
  );
  const rightDockTunnelOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "tunnel",
  );
  const rightDockSshTunnelOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "sshTunnel",
  );
  const associatedSshHostIds = useMemo(
    () => getSshProjectHostIds(settings.ssh, terminalProjectPathKey),
    [settings.ssh, terminalProjectPathKey],
  );
  const projectToolsDisabledMessage = !settingsSyncReady
    ? "Syncing desktop settings..."
    : !isAgentMode
      ? "Project tools require Agent project mode."
      : !terminalProjectPath
        ? "Select a project to use project tools."
        : undefined;
  const terminalDisabledMessage =
    projectToolsDisabledMessage ??
    (!settings.remote.enableWebTerminal
      ? "Enable WebUI Terminal in desktop Remote settings."
      : undefined);
  const webTerminalSessionsEnabled =
    settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal;
  const {
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorCleanupPending,
    workspaceEditorOpenRequest,
    workspaceEditorCloseRequestId,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
    terminalSessions,
    terminalSessionsLoaded,
    setTerminalSessions,
    terminalSessionsVersionRef,
    terminalStatusSessionIdRef,
    projectTerminalSessions,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    handleWorkspaceEditorHide,
    handleWorkspaceEditorClosed,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
    handleOpenWorkspaceFile,
    handleOpenSshTerminal,
    handleProjectTerminalSessionsChange,
    resetTerminalSessions,
    hideWorkspaceSshTerminalOverlay,
  } = useProjectToolsRuntime({
    terminalClient,
    settingsSyncReady,
    isAgentMode,
    webTerminalSessionsEnabled,
    statusOnline: status?.online,
    statusSessionId: status?.session_id,
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
    rightDockSshTunnelOpen,
  });
  resetProjectToolsRuntimeRef.current = resetTerminalSessions;
  const gitDisabledMessage = !settings.remote.enableWebGit
    ? "WebUI Git is disabled in desktop Remote settings."
    : undefined;
  // Agent offline no longer disables the panel: state still renders (the
  // Link badge shows offline) and mutations fail server-side with a clear
  // message.
  const tunnelEnabled = settingsSyncReady && settings.remote.enableWebTunnels === true;
  const tunnelDisabledMessage = !settingsSyncReady
    ? translate("chat.runtime.tunnelSettingsSyncing", settings.locale)
    : !settings.remote.enableWebTunnels
      ? translate("projectTools.tunnelWebDisabled", settings.locale)
      : undefined;
  const workspaceActivityClient = useMemo(
    () => (api ? createGatewayWorkspaceActivityClient(api) : null),
    [api],
  );
  // ── 回复末尾「已编辑文件」卡的三个动作 ────────────────────────────────
  const gitReviewFocusNonceRef = useRef(0);
  const [gitReviewFocusRequest, setGitReviewFocusRequest] = useState<GitReviewFocusRequest | null>(
    null,
  );
  const handleGitReviewFocusRequestHandled = useCallback((nonce: number) => {
    setGitReviewFocusRequest((current) => (current && current.nonce === nonce ? null : current));
  }, []);
  const handleChangedFileOpenDiff = useCallback(
    (path: string | null) => {
      if (!terminalProjectPathKey) return;
      setRightDockOpen(true);
      setSettings((prev) => openRightDockSingletonTab(prev, terminalProjectPathKey, "gitReview"));
      gitReviewFocusNonceRef.current += 1;
      setGitReviewFocusRequest({
        path: (path ?? "").trim(),
        nonce: gitReviewFocusNonceRef.current,
      });
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleChangedFileReveal = useCallback(
    (path: string) => {
      if (!terminalProjectPathKey) return;
      const selectedPath = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!selectedPath) return;
      setRightDockOpen(true);
      setSettings((prev) => {
        const opened = openRightDockSingletonTab(prev, terminalProjectPathKey, "fileTree");
        const current = getRightDockFileTreeState(opened.customSettings, terminalProjectPathKey);
        return updateRightDockFileTreeState(opened, terminalProjectPathKey, {
          query: "",
          selectedPath,
          expandedPaths: Array.from(
            new Set([...current.expandedPaths, ...expandedPathsForFileTreePath(selectedPath)]),
          ),
          bumpRevision: true,
        });
      });
    },
    [setSettings, terminalProjectPathKey],
  );
  const changedFilesActions = useMemo<ChangedFilesActions>(
    () => ({
      onOpenFile: handleOpenWorkspaceFile,
      onRevealInFileTree: handleChangedFileReveal,
      onOpenDiff: handleChangedFileOpenDiff,
    }),
    [handleChangedFileOpenDiff, handleChangedFileReveal, handleOpenWorkspaceFile],
  );
  // RightDockPanel is memo'd: every callback handed to it must be stable or
  // the memo boundary is void (see the panel-side context useMemo).
  const handleRightDockWidthChange = useCallback(
    (nextWidth: number) => {
      setSettings((prev) => updateRightDockWidth(prev, nextWidth));
    },
    [setSettings],
  );
  const handleRightDockProjectStateChange = useCallback(
    (updater: (current: RightDockProjectState) => RightDockProjectState) => {
      setSettings((prev) => updateRightDockProjectState(prev, terminalProjectPathKey, updater));
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleRightDockFileTreeStateChange = useCallback(
    (patch: RightDockFileTreeStatePatch) => {
      setSettings((prev) => updateRightDockFileTreeState(prev, terminalProjectPathKey, patch));
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleSshProjectHostIdsChange = useCallback(
    (hostIds: string[]) => {
      setSettings((prev) => updateSshProjectHostIds(prev, terminalProjectPathKey, hostIds));
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleRightDockInsertFileMention = useCallback((path: string, kind: "file" | "dir") => {
    composerRef.current?.insertFileMention(path, kind);
    composerRef.current?.focus();
  }, []);
  const handleRightDockInsertCodeReviewSkill = useCallback(() => {
    const composer = composerRef.current;
    if (!composer || !codeReviewSkill) return;
    setSettings((prev) => {
      const selected = mergeAlwaysEnabledSkillNames(prev.skills.selected);
      if (selected.includes(codeReviewSkill.name)) return prev;
      return updateSkills(prev, { selected: [...selected, codeReviewSkill.name] });
    });
    const alreadyInserted = composer
      .getDraft()
      .skillMentions.some((skill) => skill.name === codeReviewSkill.name);
    if (!alreadyInserted) {
      composer.insertSkillMention(codeReviewSkill);
    }
    composer.focus();
  }, [codeReviewSkill, setSettings]);
  const handleRightDockInsertCommitMention = useCallback((commit: GitCommitContextPayload) => {
    composerRef.current?.insertCommitMention(commit);
    composerRef.current?.focus();
  }, []);
  const handleRightDockInsertGitFileMention = useCallback((file: GitFileContextPayload) => {
    composerRef.current?.insertGitFileMention(file);
    composerRef.current?.focus();
  }, []);
  const handleInsertCodeMention = useCallback((reference: CodeMentionReference) => {
    composerRef.current?.insertCodeMention(reference);
    composerRef.current?.focus();
  }, []);
  // Guards re-entry while a suggestion is still typing in: the cards stay
  // disabled and further clicks are ignored until the composer settles.
  const [isSuggestionTyping, setIsSuggestionTyping] = useState(false);
  const suggestionTypingRef = useRef(false);
  const handleEmptyStateSuggestion = useCallback((text: string) => {
    const composer = composerRef.current;
    if (!composer || suggestionTypingRef.current) return;
    suggestionTypingRef.current = true;
    setIsSuggestionTyping(true);
    void composer.typeText(text).finally(() => {
      suggestionTypingRef.current = false;
      setIsSuggestionTyping(false);
    });
  }, []);
  const handleRightDockClose = useCallback(() => {
    setRightDockOpen(false);
  }, []);
  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = displayedConversationId.trim();
    if (!targetConversationId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
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
  }, [activeView, displayedConversationId]);

  const displayedConversationSummary = useMemo(() => {
    const displayedId = displayedConversationId.trim();
    if (!displayedId || isLocalDraftConversationId(displayedId)) {
      return null;
    }
    return sidebarConversationsById.get(displayedId) ?? null;
  }, [displayedConversationId, sidebarConversationsById]);
  const activeProjectBrowserTitle = isAgentMode ? (activeWorkspaceProject?.name.trim() ?? "") : "";
  const displayedConversationTitle = useMemo(
    () =>
      resolveConversationBrowserTitle({
        conversation: displayedConversationSummary,
        conversationId: displayedConversationId,
        projectName: activeProjectBrowserTitle,
        isLocalDraftConversation: isLocalDraftConversationId(displayedConversationId),
        newConversationTitle: NEW_CONVERSATION_BROWSER_TITLE,
      }),
    [activeProjectBrowserTitle, displayedConversationId, displayedConversationSummary],
  );
  const browserTitle = useMemo(() => {
    if (historyShareToken) {
      return SHARED_HISTORY_BROWSER_TITLE;
    }
    if (!token.trim()) {
      return DEFAULT_BROWSER_TITLE;
    }
    if (activeView === "skills-hub") {
      return SKILLS_HUB_BROWSER_TITLE;
    }
    if (activeView === "mcp-hub") {
      return MCP_HUB_BROWSER_TITLE;
    }
    return displayedConversationTitle || DEFAULT_BROWSER_TITLE;
  }, [activeView, displayedConversationTitle, historyShareToken, token]);
  const historyDetailLoadingTitle = useMemo(() => {
    const selectedId = selectedHistoryId.trim();
    if (!selectedId) {
      return "";
    }
    const item = sidebarConversationsById.get(selectedId);
    return item?.title ?? "";
  }, [selectedHistoryId, sidebarConversationsById]);
  const transcriptRows = displayedTranscript.rows;
  const transcriptLiveStartIndex = displayedTranscript.liveStartIndex;
  const transcriptFloors = useMemo(() => buildFloorEntries(transcriptRows), [transcriptRows]);
  // Row count gates everything visual (empty state, error banner, loading
  // screen): entryCount can be non-zero while nothing renders (meta-only
  // entries), and hiding an error behind an invisible entry would strand it.
  const displayedTranscriptRowCount = transcriptRows.length;
  const transcriptHistoryLoading = historyDetailLoading && displayedTranscriptRowCount === 0;
  const selectedHistoryHasMore =
    selectedHistory?.conversation_id === displayedConversationId &&
    selectedHistory.has_more === true;
  const loadingOlderHistory = fullHistoryLoading && displayedTranscriptRowCount > 0;
  const handleLoadFullHistory = useCallback(() => {
    if (!api || !displayedConversationId) {
      return;
    }
    // Explicit full fetch through the id-preserving enrich path (same as the
    // idle hydration); no-ops while a run is streaming.
    setFullHistoryLoading(true);
    void refreshDisplayedConversationHistorySnapshot(displayedConversationId, api, {
      forceFull: true,
    }).finally(() => {
      setFullHistoryLoading(false);
    });
  }, [api, displayedConversationId, refreshDisplayedConversationHistorySnapshot]);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.title = browserTitle;
  }, [browserTitle]);
  const transcriptBusy = displayedConversationBusy;
  // Pipeline pending (pre-first-token) shows the preparing status until the
  // stream's own tool_status takes over.
  const displayedHasPendingCommand =
    displayedConversationId !== "" && chatCommandPipeline.hasPending(displayedConversationId);
  const transcriptToolStatus =
    displayedTranscript.toolStatus ??
    (displayedHasPendingCommand ? CHAT_RUNTIME_PREPARING_STATUS : null);
  const transcriptToolStatusIsCompaction = displayedTranscript.toolStatusIsCompaction;
  const composerIsSending = transcriptBusy;
  const transcriptError = displayedTranscriptRowCount === 0 ? null : chatError;
  const composerCompactionBlocked = transcriptToolStatusIsCompaction;
  const sidebarSectionsDisabled = shouldDisableGatewaySidebarSections({
    connectionLost: gatewayConnectionLost,
    agentStatusFresh: sidebarAgentStatusFresh,
    agentOnline: status?.online,
  });
  const composerInputDisabled =
    !status?.online || historyDetailLoading || composerCompactionBlocked;
  const composerPlaceholder = composerCompactionBlocked
    ? translate("chat.compactingContextWait", settings.locale)
    : historyDetailLoading
      ? "正在加载会话历史，请稍候..."
      : enabledComposerSkills.length > 0
        ? translate("chat.inputHintWithSkills", settings.locale)
        : translate("chat.inputHint", settings.locale);
  const canDropUpload =
    status?.online === true &&
    isAgentMode &&
    Boolean(displayedConversationWorkdir.trim()) &&
    !isUploadingFiles &&
    !composerInputDisabled;
  const fileDropTitle = canDropUpload
    ? translate("chat.upload.dropReady", settings.locale)
    : status?.online !== true
      ? translate("chat.upload.dropBusy", settings.locale)
      : !isAgentMode
        ? translate("chat.upload.onlyInTools", settings.locale)
        : !displayedConversationWorkdir.trim()
          ? translate("chat.upload.requireWorkdir", settings.locale)
          : translate("chat.upload.dropBusy", settings.locale);
  const fileDropDescription = canDropUpload
    ? translate("chat.upload.dropHint", settings.locale)
    : translate("chat.upload.dropDisabledHint", settings.locale);
  const fileDropLimitHint = formatTranslation(translate("chat.upload.dropLimit", settings.locale), {
    max: MAX_UPLOAD_FILES,
  });

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handlePendingFileDragOver(event, canDropUpload);
    },
    [canDropUpload, handlePendingFileDragOver],
  );

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handlePendingFileDrop(event, {
        canDropUpload,
        disabledMessage: fileDropTitle,
      });
    },
    [canDropUpload, fileDropTitle, handlePendingFileDrop],
  );

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

          <div className="gateway-editor-host">
            <GatewaySidebarContainer
              store={sidebarStore}
              currentConversationId={displayedConversationId}
              isOpen={sidebarOpen}
              fontScale={settings.customSettings.fontScale.sidebar}
              activeView={activeView}
              showProjects={isAgentMode && status?.online === true}
              projects={workspaceProjects}
              activeProjectId={activeWorkspaceProject?.id}
              missingProjectPathKeys={missingWorkspaceProjectPathKeys}
              projectRenamingId={projectRenamingId}
              projectRenameDraft={projectRenameDraft}
              projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
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
              onSelectProject={handleSelectWorkspaceProject}
              onNewConversationForProject={handleNewConversationForProject}
              onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
              onStartRenamingProject={handleStartRenamingWorkspaceProject}
              onProjectRenameDraftChange={setProjectRenameDraft}
              onCommitProjectRename={handleCommitWorkspaceProjectRename}
              onCancelProjectRename={handleCancelWorkspaceProjectRename}
              onSetProjectPinned={handleSetWorkspaceProjectPinned}
              onRemoveProject={handleRemoveWorkspaceProject}
              onArchiveProject={handleArchiveWorkspaceProject}
              onUnarchiveProject={handleUnarchiveWorkspaceProject}
              archivedProjectPathKeys={archivedWorkspaceProjectPathKeys}
              onNewConversation={handleSidebarNewConversation}
              onSelectConversation={handleSidebarSelectConversation}
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
                shareOrigin={settings.remote.gatewayUrl}
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
              {activeView === "skills-hub" ? (
                <SkillsHubPage
                  settings={settings}
                  setSettings={setSettings}
                  initialSkills={availableSkills}
                  initialRootDir={skillsRootDir}
                  isAgentMode={isAgentMode}
                  sidebarOpen={sidebarOpen}
                  onOpenSidebar={() => setSidebarOpen(true)}
                />
              ) : activeView === "mcp-hub" ? (
                <McpHubPage
                  settings={settings}
                  setSettings={setSettings}
                  isAgentMode={isAgentMode}
                  sidebarOpen={sidebarOpen}
                  onOpenSidebar={() => setSidebarOpen(true)}
                />
              ) : (
                <div
                  className="gateway-chat-frame zone-font-scale"
                  style={
                    { "--zone-font-scale": settings.customSettings.fontScale.chat } as CSSProperties
                  }
                  onDragEnter={handleFileDragEnter}
                  onDragOver={handleFileDragOver}
                  onDragLeave={handleFileDragLeave}
                  onDrop={handleFileDrop}
                >
                  <ChatHeader
                    settings={settings}
                    onSelectExecutionMode={(mode) =>
                      setSettings((prev) => {
                        const current = prev.system.executionMode;
                        if (mode === "text") {
                          return current === "text"
                            ? prev
                            : updateSystem(prev, { executionMode: "text" });
                        }
                        // 切回 Agent：仅从 Chat 切换；agent-dev 视为 Agent，保持不降级。
                        return current === "text"
                          ? updateSystem(prev, { executionMode: "tools" })
                          : prev;
                      })
                    }
                    hasModels={modelOptions.length > 0}
                    currentModelLabel={currentModelLabel}
                    modelOptions={modelOptions}
                    selectedValue={selectedValue}
                    sidebarOpen={sidebarOpen}
                    onSelectModel={handleSelectModel}
                    onOpenSettings={openSettings}
                    onToggleTheme={() =>
                      setSettings((prev) => ({
                        ...prev,
                        theme: getNextTheme(prev.theme),
                      }))
                    }
                    onOpenSidebar={() => setSidebarOpen(true)}
                    trailingActions={
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setRightDockOpen((open) => !open)}
                          disabled={Boolean(projectToolsDisabledMessage) && !rightDockOpen}
                          aria-expanded={rightDockOpen}
                          title={
                            rightDockOpen
                              ? "Collapse project tools panel"
                              : (projectToolsDisabledMessage ?? "Expand project tools panel")
                          }
                          className={`gateway-project-tools-panel-toggle relative h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95 ${
                            rightDockOpen ? "bg-muted text-foreground" : ""
                          }`}
                        >
                          {rightDockOpen ? (
                            <PanelRightClose className="h-4 w-4" />
                          ) : (
                            <PanelRightOpen className="h-4 w-4" />
                          )}
                          {projectTerminalSessions.length > 0 ? (
                            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[calc(10px*var(--zone-font-scale,1))] font-semibold leading-none text-white">
                              {projectTerminalSessions.length}
                            </span>
                          ) : null}
                        </Button>
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
                  />
                  {/* Zero-height anchor: NotifyToast positions itself below
                      the header's bottom edge, mirroring the GUI placement. */}
                  <div className="relative z-50">
                    <NotifyToast items={notifyItems} onDismiss={dismissNotify} />
                  </div>

                  {statusError ? <div className="gateway-banner-error">{statusError}</div> : null}
                  {settingsSyncError ? (
                    <div className="gateway-banner-error">{settingsSyncError}</div>
                  ) : null}
                  {chatError && displayedTranscriptRowCount === 0 ? (
                    <div className="gateway-banner-error">{chatError}</div>
                  ) : null}

                  <section className="gateway-transcript-stage">
                    <div className="gateway-transcript-scroll-shell">
                      <ScrollArea
                        ref={setTranscriptScrollAreaRoot}
                        viewportRef={setTranscriptViewport}
                        className="gateway-transcript-scroll"
                      >
                        <ChangedFilesActionsProvider value={changedFilesActions}>
                          <GatewayTranscript
                            conversationId={displayedConversationId}
                            rows={transcriptRows}
                            liveStartIndex={transcriptLiveStartIndex}
                            activeTurnKey={displayedTranscript.activeTurnKey}
                            isViewportFollowing={transcriptFollow.isFollowing}
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
                            onLoadFullHistory={
                              selectedHistoryHasMore ? handleLoadFullHistory : undefined
                            }
                            isAgentMode={isAgentMode}
                            showUsage={isAgentDevExecutionMode}
                            usageContextWindow={currentModelContextWindow}
                            workspaceRoot={displayedConversationWorkdir}
                            gitClient={gitClient}
                            onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                            onResendFromEdit={handleResendFromEdit}
                            onBranchConversation={handleBranchConversation}
                            branchPendingMessageId={branchPendingMessageId}
                            onSuggestionSelect={handleEmptyStateSuggestion}
                            suggestionsDisabled={isSuggestionTyping}
                          />
                        </ChangedFilesActionsProvider>
                      </ScrollArea>
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
                    </div>
                    {!transcriptFollowing ? (
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
                      composerRef={composerRef}
                      isSending={composerIsSending}
                      isUploadingFiles={isUploadingFiles}
                      isInputDisabled={composerInputDisabled}
                      inputPlaceholder={composerPlaceholder}
                      workdir={displayedConversationWorkdir}
                      enabledSkills={enabledComposerSkills}
                      isAgentMode={isAgentMode}
                      chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                      reasoningOptions={chatRuntimeReasoningOptions}
                      thinkingAlwaysOn={chatRuntimeThinkingAlwaysOn}
                      gitClient={gitClient}
                      gitWriteEnabled={settings.remote.enableWebGit}
                      gitDisabledMessage={gitDisabledMessage}
                      workspaceActivityClient={workspaceActivityClient}
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
                            try {
                              const materialized = draft
                                ? await materializeComposerDraftForSend(
                                    draft,
                                    pendingUploadedFiles,
                                    displayedConversationWorkdir,
                                  )
                                : { text: "", uploadedFiles: pendingUploadedFiles };
                              text = materialized.text;
                              files = materialized.uploadedFiles;
                            } catch (error) {
                              addNotify("error", asErrorMessage(error, "大段粘贴内容导入失败"));
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
                              runtimeControls: chatRuntimeControlsForCurrentProvider,
                            }).catch(() => {
                              updatePendingUploadsForConversation(sendConversationId, (current) =>
                                mergePendingUploadedFiles(current, files),
                              );
                            });
                          } finally {
                            submitInFlightRef.current = false;
                          }
                        })();
                      }}
                      onStop={() => {
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
                      onPasteFiles={handleImportReadableFiles}
                      loadHistoryPrompts={loadComposerHistoryPrompts}
                      pendingUploadedFiles={pendingUploadedFiles}
                      onRemovePendingUpload={(relativePath) => {
                        updatePendingUploadsForConversation(
                          getDisplayedConversationId(),
                          (current) => current.filter((file) => file.relativePath !== relativePath),
                        );
                      }}
                      queuedTurns={queuedChatTurnsForDisplayedConversation}
                      onRunQueuedTurnNow={runQueuedTurnNow}
                      onMoveQueuedTurnUp={moveQueuedTurnUp}
                      onEditQueuedTurn={editQueuedTurn}
                      onRemoveQueuedTurn={removeQueuedTurn}
                    />
                    {isFileDropActive ? (
                      <FileDropOverlay
                        canDropUpload={canDropUpload}
                        title={fileDropTitle}
                        description={fileDropDescription}
                        limitHint={fileDropLimitHint}
                      />
                    ) : null}
                  </section>
                </div>
              )}
            </main>
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
            />
          </div>

          {terminalClient ? (
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

          {settingsOpen ? (
            <div
              className={`gateway-settings-overlay ${
                overlay === "open" ? "gateway-settings-overlay-open" : ""
              }`}
              onTransitionEnd={handleSettingsTransitionEnd}
            >
              <SettingsPage
                settings={settings}
                setSettings={setSettings}
                saveState={settingsSaveState}
                onBack={closeSettings}
                initialSection={settingsSection}
                hiddenSections={["remote"]}
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
