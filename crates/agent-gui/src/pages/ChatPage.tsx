import type { Context } from "@earendil-works/pi-ai";
import { listen } from "@tauri-apps/api/event";
import {
  type CSSProperties,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ChangedFilesActions,
  ChangedFilesActionsProvider,
} from "../components/chat/ChangedFilesCard";
import { HistoryShareModal } from "../components/chat/HistoryShareModal";
import type { MentionComposerHandle } from "../components/chat/MentionComposer";
import { NotifyToast } from "../components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "../components/chat/SharedHistoryManagerModal";
import { PanelRightClose, PanelRightOpen } from "../components/icons";
import { MacOsTitleBarToggle } from "../components/MacOsTitleBarSpacer";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "../components/project-tools/git-review";
import type { GitReviewFocusRequest } from "../components/project-tools/RightDockContext";
import { RightDockPanel } from "../components/project-tools/RightDockPanel";
import { expandedPathsForFileTreePath } from "../components/project-tools/rightDockModel";
import { Button } from "../components/ui/button";
import { useConfirmDialog } from "../components/ui/confirm-dialog";
import { useLocale } from "../i18n";
import type { AppUpdateController } from "../lib/appUpdates";
import type { CompactionStatus } from "../lib/chat/compaction/types";
import {
  buildRequestContext,
  type ConversationViewState,
  createConversationStateFromContext,
  type RenderTimelineItem,
} from "../lib/chat/conversation/conversationState";
import type { ChatHistorySummary } from "../lib/chat/history/chatHistory";
import { memoryExtraction } from "../lib/chat/memory/extractionController";
import type { CodeMentionReference } from "../lib/chat/messages/mentionReferences";
import {
  buildFallbackConversationTitle,
  createConversationIdentity,
  createPendingHistoryItem,
  getFirstUserMessageText,
} from "../lib/chat/page/chatPageHelpers";
import type { ScrollFollowHandle } from "../lib/chat-scroll/useScrollFollow";
import { tauriGitClient } from "../lib/git/tauriGitClient";
import { setPreferredMonacoNlsLocale } from "../lib/monacoNls";
import {
  type AppSettings,
  getRightDockFileTreeState,
  getRightDockProjectState,
  getSshProjectHostIds,
  isAgentDevMode,
  isAgentExecutionMode,
  isRightDockSingletonTabOpen,
  normalizeSelectedModelForProviders,
  openRightDockSingletonTab,
  parseSelectedModelJson,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  resolveEffectiveTheme,
  type SelectedModel,
  updateRightDockFileTreeState,
  updateRightDockProjectState,
  updateRightDockWidth,
  updateSkills,
  updateSshProjectHostIds,
  updateSystem,
  workspaceProjectPathKey,
} from "../lib/settings";
import { cn } from "../lib/shared/utils";
import { createGuiSidebarBackend } from "../lib/sidebar/guiSidebarBackend";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "../lib/sidebar/openController";
import { conversationMatchesScope } from "../lib/sidebar/scope";
import { selectConversations } from "../lib/sidebar/selectors";
import { createSidebarStore } from "../lib/sidebar/store";
import { useSidebarSelector } from "../lib/sidebar/useSidebarSelector";
import { mergeAlwaysEnabledSkillNames } from "../lib/skills";
import { createSubagentStoreManager } from "../lib/subagents";
import { terminalSessionBelongsToProject } from "../lib/terminal/sessionStore";
import { tauriTerminalClient } from "../lib/terminal/tauriTerminalClient";
import { cancelPendingAskUserQuestionsForConversation } from "../lib/tools/askUserQuestionTools";
import { disposeTodoToolState } from "../lib/tools/todoTools";
import type { LocalTunnelClient } from "../lib/tunnels/constants";
import { createTauriTunnelClient } from "../lib/tunnels/tauriTunnelClient";
import { tauriWorkspaceActivityClient } from "../lib/workspace-activity/tauriWorkspaceActivityClient";
import {
  ChatComposerBar,
  ChatHeader,
  ChatTranscript,
  createChatRuntimeHost,
  type EnsureGatewayBridgeConversationReadyOptions,
  MAX_UPLOAD_FILES,
  pruneIdleConversationRuntimeCaches,
  type SendChatAction,
  scheduleIdleHydration,
  useChatPageRuntimeStore,
  useChatSkills,
  useConversationHistoryActions,
  useEditResend,
  useGatewayBridgeBatcher,
  useGatewayBridgeListeners,
  useLiveTranscriptController,
  usePendingUploads,
} from "./chat";
import { appendManagedSkillSelections } from "./chat/chatPageUtils";
import { ChatFileDropOverlay } from "./chat/components/ChatFileDropOverlay";
import { WorkspaceOverlayHost } from "./chat/components/WorkspaceOverlayHost";
import { useComposerDraftCache } from "./chat/composer/useComposerDraftCache";
import { useGatewayBridgeReadiness } from "./chat/gateway/useGatewayBridgeReadiness";
import { useGatewayRuntimeSnapshots } from "./chat/gateway/useGatewayRuntimeSnapshots";
import { useGatewayStatus } from "./chat/gateway/useGatewayStatus";
import { useBranchConversation } from "./chat/history/useBranchConversation";
import { useSharedHistory } from "./chat/history/useSharedHistory";
import { useNotifyToasts } from "./chat/hooks/useNotifyToasts";
import { useTauriFileDrop } from "./chat/hooks/useTauriFileDrop";
import {
  getQueuedConversationIds,
  removeQueuedChatTurnsForConversation,
} from "./chat/queue/chatTurnQueue";
import { useChatTurnQueue } from "./chat/queue/useChatTurnQueue";
import { useChatModelSelection } from "./chat/runtime/useChatModelSelection";
import { useSendChatTurn } from "./chat/runtime/useSendChatTurn";
import { ChatSidebarContainer } from "./chat/sidebar/ChatSidebarContainer";
import { useProjectTerminals } from "./chat/workspace/useProjectTerminals";
import { useWorkspaceOverlays } from "./chat/workspace/useWorkspaceOverlays";
import { useWorkspaceProjectRemoval } from "./chat/workspace/useWorkspaceProjectRemoval";
import { useWorkspaceProjects } from "./chat/workspace/useWorkspaceProjects";
import { WorkspaceCloneModal } from "./chat/workspace/WorkspaceCloneModal";
import { McpHubPage } from "./mcp-hub/McpHubPage";
import type { SectionId } from "./settings/types";
import { SkillsHubPage } from "./skills-hub/SkillsHubPage";

type ChatPageProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  /** Reads the authoritative settingsRef (not render-time state) so tools never see a stale snapshot. */
  getMcpSettings: () => AppSettings["mcp"];
  context: Context;
  setContext: (next: Context) => void;
  onOpenSettings: (section?: SectionId) => void;
  onToggleTheme: () => void;
  appUpdate?: AppUpdateController;
};

export function ChatPage(props: ChatPageProps) {
  const {
    settings,
    setSettings,
    getMcpSettings,
    context,
    setContext,
    onOpenSettings,
    onToggleTheme,
    appUpdate,
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
  const [hydratingConversationId, setHydratingConversationIdState] = useState<string | null>(null);
  const [hydrationFailedConversationId, setHydrationFailedConversationIdState] = useState<
    string | null
  >(null);
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
  const skillsConfigured = settings.skills.enabled;
  const skillsEnabled = skillsConfigured && isAgentMode;
  const activeAgentPrompt = useMemo(() => {
    const activeTemplate = settings.agents.find(
      (template) => template.enabled && template.prompt.trim(),
    );
    return activeTemplate?.prompt.trim() ?? "";
  }, [settings.agents]);
  const selectedSkillNames = useMemo(
    () => (skillsEnabled ? mergeAlwaysEnabledSkillNames(settings.skills.selected) : []),
    [skillsEnabled, settings.skills.selected],
  );
  const workdir = settings.system.workdir.trim();
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
  const [activeView, setActiveView] = useState<"chat" | "skills-hub" | "mcp-hub">("chat");
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const {
    workspaceProjects,
    setActiveWorkspaceProjectId,
    missingWorkspaceProjectPathKeys,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    sidebarScope,
    historyScopeKey,
    projectRenamingId,
    setProjectRenamingId,
    projectRenameDraft,
    setProjectRenameDraft,
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
    handleLoadWorkspaceRemoteBranches,
    handleStartRenamingWorkspaceProject,
    handleCommitWorkspaceProjectRename,
    handleCancelWorkspaceProjectRename,
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

  const historyRenderItems = useMemo<RenderTimelineItem[]>(
    () => conversationState.historyRenderItems,
    [conversationState],
  );
  // Sent-prompt history for the composer's ↑/↓ recall. Read lazily through a
  // ref so the memoized composer bar never re-renders on transcript growth.
  const historyRenderItemsRef = useRef<RenderTimelineItem[]>(historyRenderItems);
  useEffect(() => {
    historyRenderItemsRef.current = historyRenderItems;
  }, [historyRenderItems]);
  const loadComposerHistoryPrompts = useCallback(() => {
    const prompts: string[] = [];
    for (const item of historyRenderItemsRef.current) {
      if (item.kind === "user" && item.text.trim()) prompts.push(item.text);
    }
    return prompts;
  }, []);
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
  const hydrateFullActionRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const cleanupDeletedConversationActionRef = useRef<(id: string) => void>(() => undefined);
  // Two-phase conversation open: paint the active segment fast, hydrate the
  // full transcript at idle. The overlay appears only after 150ms of
  // still-opening — no minimum overlay duration.
  const openController = useMemo(
    () =>
      createConversationOpenController({
        openInitial: (conversationId) => openInitialActionRef.current(conversationId),
        hydrateFull: (conversationId) => hydrateFullActionRef.current(conversationId),
        scheduleIdle: scheduleIdleHydration,
        onStateChange: setConversationOpenState,
      }),
    [],
  );
  const sendActionRef = useRef<SendChatAction>(async () => false);
  const ensureGatewayBridgeConversationReadyRef = useRef<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >(async (id) => id.trim());
  const stopSendingActionRef = useRef<() => void>(() => undefined);
  const hydratingConversationIdRef = useRef<string | null>(hydratingConversationId);
  const hydrationFailedConversationIdRef = useRef<string | null>(hydrationFailedConversationId);
  const setHydratingConversationId = useCallback((next: SetStateAction<string | null>) => {
    const current = hydratingConversationIdRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    hydratingConversationIdRef.current = resolved;
    setHydratingConversationIdState(resolved);
  }, []);
  const setHydrationFailedConversationId = useCallback((next: SetStateAction<string | null>) => {
    const current = hydrationFailedConversationIdRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    hydrationFailedConversationIdRef.current = resolved;
    setHydrationFailedConversationIdState(resolved);
  }, []);
  const {
    liveTranscriptStore,
    getConversationLiveTranscriptStore,
    getCompactionController,
    deleteConversationArtifacts,
    clearAbortSnapshot,
    captureAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
  } = useLiveTranscriptController({
    currentConversationId,
  });
  const { queueGatewayBridgeEventForRequest } = useGatewayBridgeBatcher();
  const {
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    isConversationRunning,
    setConversationAbortController,
    getConversationAbortController,
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

  function cancelConversationHydration() {
    conversationLoadSequenceRef.current += 1;
    setHydratingConversationId(null);
    setHydrationFailedConversationId(null);
  }

  const isDraftConversation = !historyItems.some((item) => item.id === currentConversationId);
  const currentConversationPersistedCwd =
    historyItems.find((item) => item.id === currentConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationRuntimeCacheRef.current.get(currentConversationId)?.workdir?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (isAgentMode ? activeWorkspaceProjectPath || workdir : "");
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
  const associatedSshHostIds = useMemo(
    () => getSshProjectHostIds(settings.ssh, terminalProjectPathKey),
    [settings.ssh, terminalProjectPathKey],
  );
  const terminalDisabledMessage = !isAgentMode
    ? "Project tools require Agent project mode."
    : !terminalProjectPath
      ? "Select a project to use project tools."
      : undefined;
  const tunnelEnabled = settings.remote.enableWebTunnels === true;
  const tunnelDisabledMessage = !settings.remote.enableWebTunnels
    ? t("projectTools.tunnelWebDisabled")
    : undefined;
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
      const selected = appendManagedSkillSelections(prev.skills.selected, [codeReviewSkill.name]);
      if (selected.join("\n") === prev.skills.selected.join("\n")) return prev;
      return updateSkills(prev, { selected });
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
  const workspaceOverlays = useWorkspaceOverlays({
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
  });
  const { handleOpenWorkspaceFile, handleOpenSshTerminal } = workspaceOverlays;
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
    getConversationLiveTranscriptStore,
    captureAbortSnapshot,
    updateToolStatus,
    composerRef,
    pendingUploadedFiles,
    setPendingUploadsForConversation,
    clearCachedComposerDraft,
    displayedConversationWorkdir,
    sendActionRef,
  });

  const {
    activeGatewayRuntimeRunsRef,
    queueGatewayRuntimeSnapshot,
    queueGatewayRuntimeSnapshotForRun,
    registerActiveGatewayRuntimeRun,
    finishActiveGatewayRuntimeRun,
  } = useGatewayRuntimeSnapshots({
    canShareHistory,
    remoteRuntimeStatus,
    currentConversationIdRef,
    queuedChatTurnsRef,
    publishChatQueueSnapshots,
    collectChatQueueSnapshotConversationIds,
  });

  const deleteConversationLocalCaches = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      if (!key) return;
      deleteCachedComposerDraftState(key);
      locallySyncedHistoryUpdatedAtRef.current.delete(key);
      gatewayBridgeHistorySummaryRef.current.delete(key);
      setPendingUploadsForConversation(key, []);
      memoryExtraction.dispose(key);
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
        persistedStateCache: persistedConversationStateRef.current,
        keepConversationIds: [
          currentConversationIdRef.current,
          ...extraKeepIds,
          ...queuedConversationIds,
        ],
        isConversationRunning,
        onPruneConversation: (conversationId) => {
          deleteConversationLocalCaches(conversationId);
          subagentStoresRef.current.dispose(conversationId);
          disposeTodoToolState(conversationId);
          cancelPendingAskUserQuestionsForConversation(conversationId);
        },
      });
    },
    [
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      deleteConversationLocalCaches,
      isConversationRunning,
      persistedConversationStateRef,
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
    hydrateFull: hydrateConversationFull,
    cleanupDeletedConversation,
    persistConversation,
  } = useConversationHistoryActions({
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    markLocalHistorySnapshotSynced,
    isConversationRunning,
    conversationLoadSequenceRef,
    sidebarStore,
    titleJobRef,
    t,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    cancelConversationHydration,
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
  hydrateFullActionRef.current = hydrateConversationFull;
  cleanupDeletedConversationActionRef.current = cleanupDeletedConversation;

  const {
    handleRemoveWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
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
    setProjectRenamingId,
    setProjectRenameDraft,
    isConversationRunning,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    locallySyncedHistoryUpdatedAtRef,
    deleteConversationLocalCaches,
    disposeSubagentsForConversation: (conversationId) => {
      subagentStoresRef.current.dispose(conversationId);
    },
    removeSharedHistoryItems,
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
    if (persistedConversationStateRef.current.has(conversationId)) {
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
    persistedConversationStateRef,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    isConversationRunning,
    sidebarStore,
    gatewayBridgeHistorySummaryRef,
    hydratingConversationIdRef,
    hydrationFailedConversationIdRef,
    setHydratingConversationId,
    setHydrationFailedConversationId,
    subagentStoresRef,
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
  });

  const { send } = useSendChatTurn({
    settings,
    setSettings,
    getMcpSettings,
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
    setConversationSendingState,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    getConversationLiveTranscriptStore,
    getCompactionController,
    clearAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
    queueGatewayBridgeEventForRequest,
    activeGatewayRuntimeRunsRef,
    queueGatewayRuntimeSnapshot,
    queueGatewayRuntimeSnapshotForRun,
    registerActiveGatewayRuntimeRun,
    finishActiveGatewayRuntimeRun,
    gatewayBridgeHistorySummaryRef,
    availableSkills,
    skillsRootDir,
    refreshSkills,
    selectedSkillNames,
    activeAgentPrompt,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    persistConversation,
    pruneIdleConversationCaches,
    requestQueuedChatTurnProcessing,
  });

  sendActionRef.current = send;
  stopSendingActionRef.current = stopSending;

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

  // 全局快捷键「新建对话」：Rust 端呼出窗口后发事件，这里切回对话视图
  // （可能停在 Skills/MCP Hub）、开新会话并聚焦输入框，行为对齐侧栏按钮。
  const handleNewConversationRef = useRef(handleNewConversation);
  handleNewConversationRef.current = handleNewConversation;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const isDraftConversationRef = useRef(isDraftConversation);
  isDraftConversationRef.current = isDraftConversation;
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen("global-shortcut:new-chat", () => {
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
    };
  }, []);

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
      ? "正在补全完整历史，请稍候..."
      : isConversationHydrationFailed
        ? "当前会话完整历史加载失败，请重新打开会话..."
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
    conversationState,
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    currentConversationIdRef,
    composerRef,
    setPendingUploadsForConversation,
    updateConversationRuntimeEntry,
    invalidateSubagentsForConversation: (conversationId) => {
      subagentStoresRef.current.invalidate(conversationId);
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
          activeProjectId={activeWorkspaceProject?.id}
          missingProjectPathKeys={missingWorkspaceProjectPathKeys}
          projectRenamingId={projectRenamingId}
          projectRenameDraft={projectRenameDraft}
          projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
          recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
          onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
          onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
          onCreateProject={handleOpenCreateWorkspaceProject}
          onSelectProject={handleSelectWorkspaceProject}
          onNewConversationForProject={handleNewConversationForProject}
          onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
          onBrowseProjectInSystemFileManager={handleBrowseWorkspaceProjectInSystemFileManager}
          onStartRenamingProject={handleStartRenamingWorkspaceProject}
          onProjectRenameDraftChange={setProjectRenameDraft}
          onCommitProjectRename={handleCommitWorkspaceProjectRename}
          onCancelProjectRename={handleCancelWorkspaceProjectRename}
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

        {shareConversation ? (
          <HistoryShareModal
            conversation={shareConversation}
            share={shareStatus}
            isLoading={shareLoading}
            isUpdating={shareUpdating}
            errorMessage={shareError}
            shareOrigin={sharedManagerShareOrigin}
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
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
            activeView === "chat" && "zone-font-scale",
          )}
          style={
            activeView === "chat"
              ? ({
                  "--zone-font-scale": settings.customSettings.fontScale.chat,
                } as CSSProperties)
              : undefined
          }
        >
          {activeView === "skills-hub" ? (
            <SkillsHubPage
              settings={settings}
              setSettings={setSettings}
              initialSkills={availableSkills}
              initialRootDir={skillsRootDir}
              isAgentMode={isAgentMode}
              sidebarOpen={sidebarOpen}
              onOpenSidebar={handleOpenSidebar}
            />
          ) : activeView === "mcp-hub" ? (
            <McpHubPage
              settings={settings}
              setSettings={setSettings}
              isAgentMode={isAgentMode}
              sidebarOpen={sidebarOpen}
              onOpenSidebar={handleOpenSidebar}
            />
          ) : (
            <>
              <div className="relative z-20">
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
                  hasModels={hasModels}
                  currentModelLabel={currentModelLabel}
                  modelOptions={modelOptions}
                  selectedValue={selectedValue}
                  sidebarOpen={sidebarOpen}
                  onSelectModel={handleSelectModel}
                  onOpenSettings={onOpenSettings}
                  onToggleTheme={onToggleTheme}
                  onOpenSidebar={handleOpenSidebar}
                  trailingActions={
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRightDockOpen((open) => !open)}
                      disabled={Boolean(terminalDisabledMessage) && !rightDockOpen}
                      aria-expanded={rightDockOpen}
                      title={
                        rightDockOpen
                          ? "Collapse project tools panel"
                          : (terminalDisabledMessage ?? "Expand project tools panel")
                      }
                      className={`relative h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95 ${
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
                  }
                />
                <NotifyToast items={notifyItems} onDismiss={dismissNotify} />
              </div>

              <ChangedFilesActionsProvider value={changedFilesActions}>
                <ChatTranscript
                  conversationId={currentConversationId}
                  workspaceRoot={currentConversationWorkspaceRoot}
                  gitClient={tauriGitClient}
                  followRef={scrollFollowRef}
                  hasModels={hasModels}
                  historyItems={historyRenderItems}
                  isHistorySwitching={conversationOpenState.showOverlay}
                  isSending={isSending}
                  isAgentMode={isAgentMode}
                  showUsage={isAgentDevExecutionMode}
                  usageContextWindow={currentModelContextWindow}
                  liveTranscriptStore={liveTranscriptStore}
                  isCompactionRunning={isCompactionRunning}
                  bottomReservePx={composerOverlayHeight}
                  onResendFromEdit={handleResendFromEdit}
                  onBranchConversation={
                    // 水合中/水合失败时 handler 只会静默 return——直接不传，
                    // 让 AssistantRow 的 disabled 分支给出可见的禁用态。
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
                gitClient={tauriGitClient}
                workspaceActivityClient={tauriWorkspaceActivityClient}
                onSend={handleSend}
                onStop={handleStopSending}
                onComposerBusyChange={handleComposerBusyChange}
                onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                onPickReadableFiles={pickReadableFiles}
                onPasteFiles={importReadableFiles}
                loadHistoryPrompts={loadComposerHistoryPrompts}
                pendingUploadedFiles={pendingUploadedFiles}
                onRemovePendingUpload={removePendingUpload}
                queuedTurns={queuedChatTurnsForCurrentConversation}
                onRunQueuedTurnNow={runQueuedTurnNow}
                onMoveQueuedTurnUp={moveQueuedTurnUp}
                onEditQueuedTurn={editQueuedTurn}
                onRemoveQueuedTurn={removeQueuedTurn}
                onHeightChange={setComposerOverlayHeight}
              />
              {isFileDropActive ? (
                <ChatFileDropOverlay
                  canDropUpload={canDropUpload}
                  title={fileDropTitle}
                  description={fileDropDescription}
                  limitHint={fileDropLimitHint}
                />
              ) : null}
            </>
          )}
        </div>
        <WorkspaceOverlayHost
          overlays={workspaceOverlays}
          theme={effectiveTheme}
          terminalProjectPathKey={terminalProjectPathKey}
          terminalSessions={terminalSessions}
          onInsertCodeMention={handleInsertCodeMention}
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
    </div>
  );
}
