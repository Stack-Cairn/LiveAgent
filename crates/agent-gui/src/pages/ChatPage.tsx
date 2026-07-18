import type { Context, Message, UserMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  type CSSProperties,
  lazy,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HistoryShareModal } from "../components/chat/HistoryShareModal";
import type {
  MentionComposerCommitMention,
  MentionComposerDraft,
  MentionComposerGitFileMention,
  MentionComposerHandle,
  MentionComposerLargePaste,
} from "../components/chat/MentionComposer";
import { type NotifyItem, NotifyToast } from "../components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "../components/chat/SharedHistoryManagerModal";
import { Ban, PanelRightClose, PanelRightOpen, Terminal, Upload } from "../components/icons";
import { MacOsTitleBarSpacer, MacOsTitleBarToggle } from "../components/MacOsTitleBarSpacer";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "../components/project-tools/git-review";
import { RightDockPanel } from "../components/project-tools/RightDockPanel";
import { Button } from "../components/ui/button";
import { useConfirmDialog } from "../components/ui/confirm-dialog";
import type { WorkspaceCodeEditorOpenRequest } from "../components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "../components/workspace-editor/WorkspaceFilePreviewOverlay";
import type { WorkspaceSshTerminalOpenRequest } from "../components/workspace-editor/WorkspaceSshTerminalOverlay";
import { isWorkspacePreviewPath } from "../components/workspace-editor/workspaceImagePreview";
import { useLocale } from "../i18n";
import type { AppUpdateController } from "../lib/appUpdates";
import { getAutomationState } from "../lib/automation";
import { createHookRunScope } from "../lib/automation/hookRunner";
import type { CompactionStatus } from "../lib/chat/compaction/types";
import {
  buildPersistableMessagesFromSnapshot,
  type SuppressedToolTraceSnapshot,
} from "../lib/chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
  createConversationStateFromContext,
  type HistoryMessageRef,
  type RenderTimelineItem,
  truncateConversationFromMessage,
} from "../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../lib/chat/conversation/liveTranscriptStore";
import {
  createConversationHookLifecycle,
  createGatewayBridgeEventController,
} from "../lib/chat/conversation/run";
import { createTurnCancellation } from "../lib/chat/conversation/turnCancellation";
import {
  branchChatHistory,
  type ChatHistoryShareStatus,
  type ChatHistorySummary,
  deleteChatHistory,
  getChatHistory,
  getChatHistoryShare,
  listChatHistory,
  listSharedChatHistory,
  setChatHistoryModel,
  setChatHistoryShare,
} from "../lib/chat/history/chatHistory";
import { memoryExtraction } from "../lib/chat/memory/extractionController";
import type { MemoryExtractionStatusKey } from "../lib/chat/memory/extractionEngine";
import {
  type CodeMentionReference,
  escapeMarkdownReferenceLabel,
  formatCodeMentionToken,
  formatFileMentionToken,
  formatMarkdownReferenceDestination,
} from "../lib/chat/messages/mentionReferences";
import {
  createUserMessageWithUploads,
  mergePendingUploadedFiles,
  type PendingUploadedFile,
  withPastedTextDisplayMetadata,
} from "../lib/chat/messages/uploadedFiles";
import {
  BRANCH_CONVERSATION_DEFAULT_TITLE,
  buildFallbackConversationTitle,
  buildModelOptions,
  createConversationIdentity,
  createPendingHistoryItem,
  getFirstUserMessageText,
  isAbortLikeError,
} from "../lib/chat/page/chatPageHelpers";
import type { ScrollFollowHandle } from "../lib/chat-scroll/useScrollFollow";
import { createStreamDebugLogger } from "../lib/debug/agentDebug";
import { tauriGitClient } from "../lib/git/tauriGitClient";
import { memoryDeleteProject } from "../lib/memory/api";
import { buildMemoryOverviewSection } from "../lib/memory/prompts/injection";
import {
  lockMonacoNlsLocale,
  preparePreferredMonacoNlsLocale,
  setPreferredMonacoNlsLocale,
} from "../lib/monacoNls";
import {
  createModelFromConfig,
  isThinkingAlwaysOnForModel,
  toModelValue,
} from "../lib/providers/llm";
import {
  type AppSettings,
  applyMcpOpsToAppSettings,
  type ChatRuntimeControls,
  DEFAULT_WORKSPACE_PROJECT_ID,
  type ExecutionMode,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getRightDockFileTreeState,
  getRightDockProjectState,
  getSshProjectHostIds,
  isAgentDevMode,
  isAgentExecutionMode,
  isRightDockSingletonTabOpen,
  normalizeChatRuntimeControls,
  normalizeChatRuntimeControlsForProvider,
  normalizeSelectedModelForProviders,
  normalizeSystemToolSelection,
  openRightDockSingletonTab,
  parseSelectedModelJson,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  removeRightDockProjectState,
  resolveEffectiveTheme,
  resolveWorkspaceProjects,
  type SelectedModel,
  type SystemToolId,
  serializeSelectedModelJson,
  setSelectedModel,
  updateChatRuntimeControlsForProvider,
  updateCustomSettings,
  updateMemorySettings,
  updateRightDockFileTreeState,
  updateRightDockProjectState,
  updateRightDockWidth,
  updateSkills,
  updateSshProjectHostIds,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "../lib/settings";
import { tauriSftpClient } from "../lib/sftp/tauriSftpClient";
import { createUuid } from "../lib/shared/id";
import { cn } from "../lib/shared/utils";
import { createGuiSidebarBackend } from "../lib/sidebar/guiSidebarBackend";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "../lib/sidebar/openController";
import { sortSidebarConversations } from "../lib/sidebar/reconcile";
import { conversationMatchesScope, sidebarScopeKey } from "../lib/sidebar/scope";
import { selectConversations } from "../lib/sidebar/selectors";
import { createSidebarStore } from "../lib/sidebar/store";
import type { SidebarScope } from "../lib/sidebar/types";
import { useSidebarSelector } from "../lib/sidebar/useSidebarSelector";
import {
  buildSkillsSystemPrompt,
  mergeAlwaysEnabledSkillNames,
  resolveExplicitSkillMentions,
} from "../lib/skills";
import {
  collectRetainedSubagentParentToolCallIds,
  createSubagentStoreManager,
  pruneSubagentRunsForConversation,
} from "../lib/subagents";
import {
  applyTerminalEventToSessions,
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "../lib/terminal/sessionStore";
import { tauriTerminalClient } from "../lib/terminal/tauriTerminalClient";
import type { TerminalSession } from "../lib/terminal/types";
import { invokeFs } from "../lib/tools/fsBackend";
import type { SkillAccessPolicy } from "../lib/tools/skillAccessPolicy";
import { disposeTodoToolState } from "../lib/tools/todoTools";
import type {
  LocalTunnelClient,
  TunnelCreateInput,
  TunnelStateSnapshot,
  TunnelUpdateInput,
} from "../lib/tunnels/constants";
import { tauriWorkspaceActivityClient } from "../lib/workspace-activity/tauriWorkspaceActivityClient";
import {
  fallbackWorkspaceProjectName,
  findWorkspaceProject,
  mergeWorkspaceProjectsWithHistory,
} from "../lib/workspaceProjects";
import {
  type ActiveGatewayBridgeRequest,
  buildErrorAssistantMessage,
  buildPreparedContext as buildPreparedConversationContext,
  buildResumeContext as buildResumeConversationContext,
  ChatComposerBar,
  ChatHeader,
  type ChatQueueTurnPreview,
  ChatTranscript,
  createChatRuntimeHost,
  createConversationRuntimeEntry,
  type EffectiveChatModelSelection,
  type EnsureGatewayBridgeConversationReadyOptions,
  formatHookWarningMessage,
  MAX_UPLOAD_FILES,
  pruneIdleConversationRuntimeCaches,
  resolveActiveModelSelection,
  resolveEffectiveChatModelSelection,
  type SendChatAction,
  scheduleIdleHydration,
  setConversationRuntimeCacheEntry,
  startConversationTitleJob,
  useChatPageRuntimeStore,
  useChatSkills,
  useConversationHistoryActions,
  useEditResend,
  useGatewayBridgeBatcher,
  useGatewayBridgeListeners,
  useLiveTranscriptController,
  usePendingUploads,
} from "./chat";
import {
  buildGatewayRuntimeSnapshotEntries,
  type GatewayRuntimeSnapshotState,
} from "./chat/gateway/chatRuntimeSnapshot";
import {
  type GatewayChatClaimedRequest,
  normalizeGatewayExecutionMode,
  normalizeGatewayWorkdir,
} from "./chat/gateway/gatewayBridgeTypes";
import {
  appendQueuedChatTurn,
  buildQueuedChatTurnPreview,
  type ChatQueueItemDetail,
  type ChatQueueSnapshot,
  createQueuedChatTurn,
  getQueuedConversationIds,
  insertQueuedChatTurnAtSlot,
  moveQueuedChatTurn,
  promoteQueuedChatTurn,
  type QueuedChatTurn,
  type QueuedChatTurnEditSlot,
  queuedChatTurnHasContent,
  removeQueuedChatTurn,
  removeQueuedChatTurnsForConversation,
  resolveQueuedChatTurnSlotIndex,
  takeNextQueuedChatTurn,
} from "./chat/queue/chatTurnQueue";
import { ChatSidebarContainer } from "./chat/sidebar/ChatSidebarContainer";
import { McpHubPage } from "./mcp-hub/McpHubPage";
import type { SectionId } from "./settings/types";
import { SkillsHubPage } from "./skills-hub/SkillsHubPage";

const WorkspaceCodeEditorOverlay = lazy(async () => {
  await preparePreferredMonacoNlsLocale();
  const module = await import("../components/workspace-editor/WorkspaceCodeEditorOverlay");
  lockMonacoNlsLocale();
  return {
    default: module.WorkspaceCodeEditorOverlay,
  };
});

const WorkspaceFilePreviewOverlay = lazy(async () => {
  const module = await import("../components/workspace-editor/WorkspaceFilePreviewOverlay");
  return {
    default: module.WorkspaceFilePreviewOverlay,
  };
});

const WorkspaceSshTerminalOverlay = lazy(async () => {
  const module = await import("../components/workspace-editor/WorkspaceSshTerminalOverlay");
  return {
    default: module.WorkspaceSshTerminalOverlay,
  };
});

function createLocalGatewayChatRunId(conversationId: string) {
  return `conversation-live-${conversationId}-${createUuid()}`;
}

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

type GatewayRuntimeStatus = {
  online: boolean;
  enabled: boolean;
  configured: boolean;
  gatewayUrl?: string | null;
  sessionId?: string | null;
  connectedSince?: number | null;
  lastHeartbeat?: number | null;
  lastError?: string | null;
};

function isRemoteSettingsConfigured(remote: AppSettings["remote"]) {
  return remote.gatewayUrl.trim() !== "" && remote.token.trim() !== "";
}

function buildFallbackGatewayStatus(remote: AppSettings["remote"]): GatewayRuntimeStatus {
  return {
    online: false,
    enabled: remote.enabled,
    configured: isRemoteSettingsConfigured(remote),
    gatewayUrl: remote.gatewayUrl.trim(),
    sessionId: null,
    connectedSince: null,
    lastHeartbeat: null,
    lastError: null,
  };
}

type ActiveGatewayRuntimeRun = {
  conversationId: string;
  runId: string;
  clientRequestId?: string;
  workerId?: string;
  cwd?: string;
  revision: number;
  state: GatewayRuntimeSnapshotState;
  userMessage: Message;
  transcriptStore: LiveTranscriptStore;
  toolStatusIsCompaction: boolean;
};

const PROJECT_HISTORY_DELETE_PAGE_SIZE = 200;
const SHARED_HISTORY_LIST_PAGE_SIZE = 200;
const GATEWAY_RUNTIME_SNAPSHOT_DEBOUNCE_MS = 300;
// Must stay well below the desktop run ledger's 5-minute active TTL.
const GATEWAY_RUNTIME_RUN_KEEPALIVE_MS = 60_000;

function appendManagedSkillSelections(current: readonly string[], names: readonly string[]) {
  const out = mergeAlwaysEnabledSkillNames(current);
  const seen = new Set(out);
  for (const rawName of names) {
    const name = String(rawName).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

async function listChatHistoryIdsForProjectPath(projectPath: string) {
  const cwd = projectPath.trim();
  if (!cwd) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await listChatHistory(pageNumber, PROJECT_HISTORY_DELETE_PAGE_SIZE, { cwd });
    for (const item of page.items) {
      const id = item.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    if (
      page.items.length === 0 ||
      ids.length >= page.totalCount ||
      page.items.length < PROJECT_HISTORY_DELETE_PAGE_SIZE
    ) {
      break;
    }
  }
  return ids;
}

type SystemImportPastedTextsResponse = {
  files: PendingUploadedFile[];
  skipped: string[];
};

function buildPastedTextFileName(paste: MentionComposerLargePaste, index: number) {
  const baseName = paste.label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || `pasted-text-${index + 1}`}.txt`;
}

function formatComposerCommitMention(commit: MentionComposerCommitMention) {
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const subject = commit.subject.trim() || shortSha;
  const label = `commit ${shortSha}: ${subject}`;
  if (commit.githubUrl?.trim()) {
    return `[${escapeMarkdownReferenceLabel(label)}](${formatMarkdownReferenceDestination(commit.githubUrl.trim())})`;
  }
  return `${label} (${commit.sha})`;
}

function formatComposerGitFileMention(file: MentionComposerGitFileMention) {
  const refLabel = file.refName || file.shortSha || file.commitSha.slice(0, 7);
  const label = `git file ${refLabel}: ${file.path}`;
  if (file.githubUrl?.trim()) {
    return `[${escapeMarkdownReferenceLabel(label)}](${formatMarkdownReferenceDestination(file.githubUrl.trim())})`;
  }
  return `${label} (${file.commitSha})`;
}

function buildTextFromComposerDraft(
  draft: MentionComposerDraft,
  pastedFileById?: Map<string, PendingUploadedFile>,
) {
  return draft.segments
    .map((segment) => {
      if (segment.type === "text") {
        return segment.text;
      }
      if (segment.type === "fileMention") {
        return formatFileMentionToken(segment.reference);
      }
      if (segment.type === "skillMention") {
        return `$${segment.skill.name}`;
      }
      if (segment.type === "commitMention") {
        return formatComposerCommitMention(segment.commit);
      }
      if (segment.type === "gitFileMention") {
        return formatComposerGitFileMention(segment.file);
      }
      if (segment.type === "codeMention") {
        return formatCodeMentionToken(segment.reference);
      }
      const file = pastedFileById?.get(segment.paste.id);
      return file ? `[${segment.paste.label}: ${file.relativePath}]` : segment.paste.text;
    })
    .join("")
    .replace(/\u00A0/g, " ");
}

async function importPastedTextsAsFiles(workdir: string, pastes: MentionComposerLargePaste[]) {
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) {
    throw new Error("请先在项目栏选择或创建项目后再发送大段粘贴内容。");
  }
  if (pastes.length === 0) {
    return {
      files: [],
      fileByPasteId: new Map<string, PendingUploadedFile>(),
    };
  }

  const response = await invoke<SystemImportPastedTextsResponse>("system_import_pasted_texts", {
    workdir: normalizedWorkdir,
    texts: pastes.map((paste, index) => ({
      fileName: buildPastedTextFileName(paste, index),
      content: paste.text,
    })),
  });

  if (response.files.length !== pastes.length) {
    const skipped = response.skipped.length > 0 ? `\n${response.skipped.join("\n")}` : "";
    throw new Error(`部分大段粘贴内容未能导入工作区。${skipped}`);
  }

  const files = response.files.map((file, index) => {
    const paste = pastes[index];
    return paste ? withPastedTextDisplayMetadata(file, paste) : file;
  });

  const fileByPasteId = new Map<string, PendingUploadedFile>();
  files.forEach((file, index) => {
    const paste = pastes[index];
    if (paste) {
      fileByPasteId.set(paste.id, file);
    }
  });
  return {
    files,
    fileByPasteId,
  };
}

function resolveMemorySummaryModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const summaryModel = settings.memory.summaryModel;
  if (!summaryModel) {
    return null;
  }

  const provider = settings.customProviders.find(
    (item) => item.id === summaryModel.customProviderId,
  );
  if (!provider || !provider.activeModels.includes(summaryModel.model)) {
    return null;
  }

  return {
    selectedModel: summaryModel,
    provider,
    providerId: provider.type,
    model: summaryModel.model,
  };
}

function resolveConversationTitleModelSelection(
  settings: AppSettings,
  fallback: EffectiveChatModelSelection,
): EffectiveChatModelSelection {
  const titleModel = settings.customSettings.conversationTitleModel;
  if (!titleModel) {
    return fallback;
  }

  const provider = settings.customProviders.find((item) => item.id === titleModel.customProviderId);
  if (!provider || !provider.activeModels.includes(titleModel.model)) {
    return fallback;
  }

  return {
    selectedModel: titleModel,
    provider,
    providerId: provider.type,
    model: titleModel.model,
  };
}

function buildProviderRuntimeConfig(
  provider: AppSettings["customProviders"][number],
  model: string,
  controlsInput?: ChatRuntimeControls,
) {
  const modelConfig = findProviderModelConfig(provider, model);
  const reasoningParams = {
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: model,
    baseUrl: provider.baseUrl,
    modelConfig,
  };
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, reasoningParams);
  const reasoningSupported = getChatRuntimeReasoningLevelsForProvider(reasoningParams).length > 0;
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    requestFormat: provider.requestFormat,
    reasoning: reasoningSupported
      ? controls.thinkingEnabled
        ? controls.reasoning
        : "off"
      : undefined,
    promptCachingEnabled: true,
    nativeWebSearchEnabled: controls.nativeWebSearchEnabled,
    useSystemProxy: provider.useSystemProxy,
    modelConfig,
  };
}

function selectedModelsMatch(left: SelectedModel | undefined, right: SelectedModel | undefined) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left?.customProviderId === right?.customProviderId &&
    left?.model === right?.model
  );
}

function getDefaultWorkspaceProjectPath(system: AppSettings["system"]) {
  return (
    system.workspaceProjects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.path ||
    system.workdir
  );
}

function createWorkspaceProjectFromPath(path: string, kind: WorkspaceProject["kind"]) {
  const now = Date.now();
  return {
    id: `${kind}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: fallbackWorkspaceProjectName(path),
    path,
    kind,
    createdAt: now,
    updatedAt: now,
  } satisfies WorkspaceProject;
}

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
  const [notifyItems, setNotifyItems] = useState<NotifyItem[]>([]);
  const notifyIdCounter = useRef(0);
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
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
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
  const sidebarWorkdirs = useSidebarSelector(sidebarStore, (s) => s.workdirs);
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, sidebarWorkdirs),
    [sidebarWorkdirs, settings.system],
  );
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectId] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const missingWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.missingWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.missingWorkspaceProjectPaths],
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
  const sidebarScope = useMemo<SidebarScope>(
    () =>
      isAgentMode
        ? activeWorkspaceProjectPath
          ? { kind: "workdir", cwd: activeWorkspaceProjectPath }
          : { kind: "none" }
        : { kind: "unscoped" },
    [activeWorkspaceProjectPath, isAgentMode],
  );
  useEffect(() => {
    sidebarStore.setScope(sidebarScope);
  }, [sidebarScope, sidebarStore]);
  const historyScopeKey = sidebarScopeKey(sidebarScope);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeView, setActiveView] = useState<"chat" | "skills-hub" | "mcp-hub">("chat");
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const previousRightDockFileTreeOpenRef = useRef(false);
  const [workspaceEditorMounted, setWorkspaceEditorMounted] = useState(false);
  const [workspaceEditorOpen, setWorkspaceEditorOpen] = useState(false);
  const [workspaceEditorCleanupPending, setWorkspaceEditorCleanupPending] = useState(false);
  const [workspaceEditorOpenRequest, setWorkspaceEditorOpenRequest] =
    useState<WorkspaceCodeEditorOpenRequest | null>(null);
  const [workspaceEditorCloseRequestId, setWorkspaceEditorCloseRequestId] = useState(0);
  const workspaceEditorRequestIdRef = useRef(0);
  const [workspaceFilePreviewMounted, setWorkspaceFilePreviewMounted] = useState(false);
  const [workspaceFilePreviewOpen, setWorkspaceFilePreviewOpen] = useState(false);
  const [workspaceFilePreviewOpenRequest, setWorkspaceFilePreviewOpenRequest] =
    useState<WorkspaceFilePreviewOpenRequest | null>(null);
  const workspaceFilePreviewRequestIdRef = useRef(0);
  const [workspaceSshTerminalMounted, setWorkspaceSshTerminalMounted] = useState(false);
  const [workspaceSshTerminalOpen, setWorkspaceSshTerminalOpen] = useState(false);
  const [workspaceSshTerminalOpenRequest, setWorkspaceSshTerminalOpenRequest] =
    useState<WorkspaceSshTerminalOpenRequest | null>(null);
  const workspaceSshTerminalRequestIdRef = useRef(0);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [terminalSessionsLoaded, setTerminalSessionsLoaded] = useState(false);
  const [remoteRuntimeStatus, setRemoteRuntimeStatus] = useState<GatewayRuntimeStatus>(() =>
    buildFallbackGatewayStatus(settings.remote),
  );
  const tauriTunnelClient = useMemo<LocalTunnelClient>(() => {
    const listeners = new Set<(snapshot: TunnelStateSnapshot) => void>();
    let unlistenPromise: Promise<() => void> | null = null;
    const normalizeSnapshot = (payload: unknown): TunnelStateSnapshot => {
      const raw = (payload ?? {}) as Partial<TunnelStateSnapshot>;
      return {
        revision: raw.revision ?? 0,
        agentOnline: raw.agentOnline === true,
        relay: raw.relay ?? null,
        tunnels: raw.tunnels ?? [],
        gatewayUnsupported: raw.gatewayUnsupported === true,
      };
    };
    return {
      subscribeTunnelState: (listener) => {
        listeners.add(listener);
        if (!unlistenPromise) {
          unlistenPromise = listen<TunnelStateSnapshot>("gateway:tunnel-state", (event) => {
            const snapshot = normalizeSnapshot(event.payload);
            for (const subscriber of [...listeners]) {
              subscriber(snapshot);
            }
          });
        }
        void invoke<TunnelStateSnapshot>("gateway_tunnel_state")
          .then((payload) => {
            if (listeners.has(listener)) {
              listener(normalizeSnapshot(payload));
            }
          })
          .catch(() => {});
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0 && unlistenPromise) {
            const pending = unlistenPromise;
            unlistenPromise = null;
            void pending.then((unlisten) => unlisten()).catch(() => {});
          }
        };
      },
      createTunnel: (input: TunnelCreateInput) => invoke<void>("gateway_tunnel_create", { input }),
      updateTunnel: (input: TunnelUpdateInput) => invoke<void>("gateway_tunnel_update", { input }),
      closeTunnel: (id: string) => invoke<void>("gateway_tunnel_close", { tunnel_id: id }),
      checkTunnel: (id?: string) => invoke<void>("gateway_tunnel_check", { tunnel_id: id }),
    };
  }, []);

  // The only page-level subscription to the sidebar list: ChatPage's own
  // render needs (draft detection, pending-item effect, workspace root).
  const historyItems = useSidebarSelector(sidebarStore, selectConversations);
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (s) => s.byId);
  const [shareConversation, setShareConversation] = useState<ChatHistorySummary | null>(null);
  const [shareStatus, setShareStatus] = useState<ChatHistoryShareStatus | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUpdating, setShareUpdating] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharedManagerOpen, setSharedManagerOpen] = useState(false);
  const [sharedManagerStatuses, setSharedManagerStatuses] = useState<
    Record<string, ChatHistoryShareStatus | undefined>
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
  const [sharedManagerGatewayUrl, setSharedManagerGatewayUrl] = useState("");
  const [sharedManagerGatewayUrlLoading, setSharedManagerGatewayUrlLoading] = useState(false);
  const [sharedHistoryItems, setSharedHistoryItems] = useState<ChatHistorySummary[]>([]);
  const sharedHistoryItemsRef = useRef<ChatHistorySummary[]>([]);
  const sharedHistoryListRequestRef = useRef<Promise<ChatHistorySummary[]> | null>(null);
  const sharedManagerShareOrigin = useMemo(() => {
    const statusGatewayUrl = remoteRuntimeStatus.gatewayUrl?.trim() ?? "";
    const runtimeGatewayUrl = sharedManagerGatewayUrl.trim();
    return statusGatewayUrl || runtimeGatewayUrl || settings.remote.gatewayUrl;
  }, [remoteRuntimeStatus.gatewayUrl, settings.remote.gatewayUrl, sharedManagerGatewayUrl]);
  const canShareHistory =
    remoteRuntimeStatus.online === true &&
    remoteRuntimeStatus.enabled === true &&
    remoteRuntimeStatus.configured === true;

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
    async (project: WorkspaceProject) => {
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      try {
        await invokeFs("fs_list", {
          workdir: path,
          path: null,
          depth: 1,
          offset: 0,
          max_results: 1,
        });
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [setWorkspaceProjectDirectoryMissing],
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
      // 目标工作区已完全激活时提前返回，避免流式进行中触发无谓的 settings 写入与重渲染
      if (
        !options?.startConversation &&
        targetProject.id === activeWorkspaceProjectId &&
        settings.system.activeWorkspaceProjectId === targetProject.id &&
        settings.system.workspaceProjects.some((item) => item.id === targetProject.id) &&
        !settings.system.hiddenWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        ) &&
        !settings.system.missingWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        ) &&
        !settings.system.archivedWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        )
      ) {
        return;
      }
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
        prepareComposerForConversationChangeActionRef.current();
        startNewConversationActionRef.current({ workdir: targetProject.path });
      }
    },
    [setSettings, workspaceProjects, activeWorkspaceProjectId, settings.system],
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
      setActiveView("chat");
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

      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSettings],
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

  const ensureSshTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "sshTunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  const handleBrowseWorkspaceProjectInSystemFileManager = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }

      try {
        await revealItemInDir(project.path.trim());
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.workspaceOpenSystemFileManagerFailed")));
      }
    },
    [checkWorkspaceProjectDirectory, setErrorMessage, t],
  );

  const handleOpenCreateWorkspaceProject = useCallback(async () => {
    try {
      const picked = await invoke<string | null>("system_pick_folder", {
        initial_workdir: activeWorkspaceProjectPath || workdir,
      });
      const path = picked?.trim();
      if (!path) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
    } catch (error) {
      setErrorMessage(asErrorMessage(error, "选择项目目录失败"));
    }
  }, [activateWorkspaceProject, activeWorkspaceProjectPath, workdir]);

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
    let cancelled = false;

    void invoke<GatewayRuntimeStatus>("gateway_status")
      .then((status) => {
        if (!cancelled) {
          setRemoteRuntimeStatus(status);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteRuntimeStatus(buildFallbackGatewayStatus(settings.remote));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    settings.remote.agentId,
    settings.remote.autoReconnect,
    settings.remote.enabled,
    settings.remote.gatewayUrl,
    settings.remote.grpcPort,
    settings.remote.heartbeatInterval,
    settings.remote.token,
  ]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;

    void listen<GatewayRuntimeStatus>("gateway:status", (event) => {
      if (!cancelled) {
        setRemoteRuntimeStatus(event.payload);
      }
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteRuntimeStatus(buildFallbackGatewayStatus(settings.remote));
        }
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [
    settings.remote.agentId,
    settings.remote.autoReconnect,
    settings.remote.enabled,
    settings.remote.gatewayUrl,
    settings.remote.grpcPort,
    settings.remote.heartbeatInterval,
    settings.remote.token,
  ]);

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

  const modelOptions = useMemo(
    () => buildModelOptions(settings, { floatSelectedFirst: false }),
    [settings],
  );
  const activeSelectedModel = resolveActiveModelSelection(
    settings,
    currentConversationSelectedModel,
  );
  const selectedValue = activeSelectedModel
    ? toModelValue(activeSelectedModel.customProviderId, activeSelectedModel.model)
    : undefined;

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
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  const composerDraftOwnerRef = useRef(currentConversationId);
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
  const startNewConversationActionRef = useRef<(options?: { workdir?: string }) => void>(
    () => undefined,
  );
  const prepareComposerForConversationChangeActionRef = useRef<() => void>(() => undefined);
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
  const handleRightDockSessionsChange = useCallback((sessions: TerminalSession[]) => {
    setTerminalSessions(sortTerminalSessions(sessions));
  }, []);
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
  const hideWorkspaceSshTerminalOverlay = useCallback(() => {
    setWorkspaceSshTerminalOpen(false);
  }, []);
  const openWorkspaceSshTerminalRequest = useCallback(
    (request: WorkspaceSshTerminalOpenRequest) => {
      setWorkspaceFilePreviewOpen(false);
      setWorkspaceEditorOpen(false);
      setWorkspaceSshTerminalMounted(true);
      setWorkspaceSshTerminalOpen(true);
      setWorkspaceSshTerminalOpenRequest(request);
    },
    [],
  );
  const requestWorkspaceEditorClose = useCallback(() => {
    setWorkspaceEditorCloseRequestId((current) => current + 1);
  }, []);
  const openWorkspaceEditorFile = useCallback(
    (request: Omit<WorkspaceCodeEditorOpenRequest, "id">) => {
      hideWorkspaceSshTerminalOverlay();
      setWorkspaceFilePreviewOpen(false);
      workspaceEditorRequestIdRef.current += 1;
      setWorkspaceEditorCleanupPending(false);
      setWorkspaceEditorMounted(true);
      setWorkspaceEditorOpen(true);
      setWorkspaceEditorOpenRequest({
        id: workspaceEditorRequestIdRef.current,
        ...request,
      });
    },
    [hideWorkspaceSshTerminalOverlay],
  );
  const openWorkspaceFilePreview = useCallback(
    (request: Omit<WorkspaceFilePreviewOpenRequest, "id">) => {
      hideWorkspaceSshTerminalOverlay();
      setWorkspaceEditorOpen(false);
      workspaceFilePreviewRequestIdRef.current += 1;
      setWorkspaceFilePreviewMounted(true);
      setWorkspaceFilePreviewOpen(true);
      setWorkspaceFilePreviewOpenRequest({
        id: workspaceFilePreviewRequestIdRef.current,
        ...request,
      });
    },
    [hideWorkspaceSshTerminalOverlay],
  );
  const handleOpenWorkspaceFile = useCallback(
    (path: string, imagePaths?: string[]) => {
      if (!terminalProjectPath || !terminalProjectPathKey) return;
      const request = {
        projectPathKey: terminalProjectPathKey,
        workdir: terminalProjectPath,
        path,
        imagePaths,
      };
      if (isWorkspacePreviewPath(path)) {
        openWorkspaceFilePreview(request);
        return;
      }
      openWorkspaceEditorFile(request);
    },
    [
      openWorkspaceEditorFile,
      openWorkspaceFilePreview,
      terminalProjectPath,
      terminalProjectPathKey,
    ],
  );
  const handleOpenSshTerminal = useCallback(
    (session: TerminalSession, kind: WorkspaceSshTerminalOpenRequest["kind"] = "bash") => {
      if (session.kind !== "ssh") return;
      workspaceSshTerminalRequestIdRef.current += 1;
      const openRequest = {
        id: workspaceSshTerminalRequestIdRef.current,
        sessionId: session.id,
        kind,
      };
      openWorkspaceSshTerminalRequest(openRequest);
    },
    [openWorkspaceSshTerminalRequest],
  );
  const requestWorkspaceFilePreviewClose = useCallback(() => {
    setWorkspaceFilePreviewOpen(false);
  }, []);
  const handleWorkspaceFilePreviewClosed = useCallback(() => {
    setWorkspaceFilePreviewOpen(false);
    setWorkspaceFilePreviewMounted(false);
    setWorkspaceFilePreviewOpenRequest(null);
  }, []);
  useEffect(() => {
    const previousOpen = previousRightDockFileTreeOpenRef.current;
    previousRightDockFileTreeOpenRef.current = rightDockFileTreeOpen;
    if (rightDockFileTreeOpen && workspaceEditorCleanupPending) {
      setWorkspaceEditorCleanupPending(false);
    }
    if (previousOpen && !rightDockFileTreeOpen && workspaceEditorMounted) {
      setWorkspaceEditorCleanupPending(true);
      setWorkspaceEditorOpen(true);
      requestWorkspaceEditorClose();
    }
    if (previousOpen && !rightDockFileTreeOpen && workspaceFilePreviewMounted) {
      requestWorkspaceFilePreviewClose();
    }
  }, [
    rightDockFileTreeOpen,
    requestWorkspaceEditorClose,
    requestWorkspaceFilePreviewClose,
    workspaceEditorCleanupPending,
    workspaceEditorMounted,
    workspaceFilePreviewMounted,
  ]);
  useEffect(() => {
    setTerminalSessionsLoaded(false);
    if (!terminalProjectPathKey) {
      setTerminalSessions([]);
      return;
    }
    let cancelled = false;
    void tauriTerminalClient
      .list()
      .then((sessions) => {
        if (!cancelled) {
          setTerminalSessions(sortTerminalSessions(sessions));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTerminalSessions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTerminalSessionsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [terminalProjectPathKey]);
  useEffect(() => {
    if (!terminalProjectPathKey) return;
    return tauriTerminalClient.subscribe((event) => {
      if (event.kind === "output") return;
      setTerminalSessions((current) => applyTerminalEventToSessions(current, event));
    });
  }, [terminalProjectPathKey]);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listen<{ runningCount?: number }>("terminal:exit-requested", async (event) => {
      if (cancelled) return;
      const runningCount = Math.max(0, Number(event.payload?.runningCount ?? 0));
      const confirmed =
        runningCount === 0 ||
        (await requestConfirmDialog({
          title: t("chat.exitConfirmTitle"),
          subtitle: t("chat.exitConfirmSubtitle"),
          description: (
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <Terminal className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {t("chat.exitConfirmRunningLabel")}
                  </span>
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-amber-700 dark:text-amber-300">
                    {runningCount}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("chat.exitConfirmDescription")}
                </p>
              </div>
            </div>
          ),
          detail: t("chat.exitConfirmNote"),
          confirmLabel: t("chat.exitConfirmContinue"),
          cancelLabel: t("chat.cancel"),
          closeLabel: t("chat.exitConfirmClose"),
          tone: "warning",
        }));
      if (!confirmed || cancelled) return;
      try {
        await invoke("app_confirmed_exit");
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(asErrorMessage(error, "退出 LiveAgent 失败"));
        }
      }
    })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch((error) => {
        console.error("failed to listen for terminal exit requests", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [requestConfirmDialog, t]);
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

  const addNotify = useCallback((type: NotifyItem["type"], message: string) => {
    const id = `notify-${++notifyIdCounter.current}`;
    setNotifyItems((prev) => [...prev, { id, type, message }]);
  }, []);

  const dismissNotify = useCallback((id: string) => {
    setNotifyItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

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
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [queuedChatTurns, setQueuedChatTurns] = useState<QueuedChatTurn[]>([]);
  const queuedChatTurnsRef = useRef<QueuedChatTurn[]>([]);
  const queuedChatProcessingConversationIdsRef = useRef(new Set<string>());
  const queuedChatTurnEditSlotRef = useRef<
    | (QueuedChatTurnEditSlot & {
        originalId: string;
        createdAt: number;
        executionMode: ExecutionMode;
        workdir: string;
        selectedSystemToolIds: SystemToolId[];
        runtimeControls: ChatRuntimeControls;
        gatewayRequest?: QueuedChatTurn["gatewayRequest"];
      })
    | null
  >(null);
  const chatQueueRevisionRef = useRef(0);
  const chatQueueKnownConversationIdsRef = useRef(new Set<string>());
  const remoteQueuedChatTurnEditSlotsRef = useRef<
    Map<
      string,
      {
        item: QueuedChatTurn;
        slot: QueuedChatTurnEditSlot;
        revision: number;
      }
    >
  >(new Map());
  const activeGatewayRuntimeRunsRef = useRef(new Map<string, ActiveGatewayRuntimeRun>());
  const gatewayRuntimeSnapshotChainsRef = useRef(new Map<string, Promise<void>>());
  const gatewayRuntimeSnapshotTimersRef = useRef(new Map<string, number>());
  const previousRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());

  function buildChatQueueSnapshot(
    conversationId: string,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ): ChatQueueSnapshot {
    const key = conversationId.trim();
    return {
      conversationId: key,
      revision: chatQueueRevisionRef.current,
      items: queue
        .filter((item) => item.conversationId === key)
        .map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
          createdAt: item.createdAt,
          source: item.gatewayRequest ? "webui" : "gui",
          editable: true,
        })),
    };
  }

  function buildChatQueueItemDetail(item: QueuedChatTurn): ChatQueueItemDetail {
    const summary = {
      id: item.id,
      previewText: buildQueuedChatTurnPreview(item.draft),
      fileCount: item.uploadedFiles.length,
      createdAt: item.createdAt,
      source: item.gatewayRequest ? ("webui" as const) : ("gui" as const),
      editable: true,
    };
    return {
      ...summary,
      draftJson: JSON.stringify(item.draft),
      uploadedFilesJson: JSON.stringify(item.uploadedFiles),
    };
  }

  function rememberChatQueueConversationId(conversationId: string) {
    const key = conversationId.trim();
    if (key) {
      chatQueueKnownConversationIdsRef.current.add(key);
    }
    return key;
  }

  function collectChatQueueSnapshotConversationIds(
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
    extraConversationIds: readonly string[] = [],
  ) {
    const conversationIds = new Set(chatQueueKnownConversationIdsRef.current);
    for (const item of queue) {
      const key = rememberChatQueueConversationId(item.conversationId);
      if (key) conversationIds.add(key);
    }
    for (const conversationId of extraConversationIds) {
      const key = rememberChatQueueConversationId(conversationId);
      if (key) conversationIds.add(key);
    }
    return conversationIds;
  }

  function publishChatQueueSnapshot(
    conversationId: string,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ) {
    const targetConversationId = rememberChatQueueConversationId(conversationId);
    if (!targetConversationId) {
      return;
    }
    const snapshot = buildChatQueueSnapshot(targetConversationId, queue);
    void invoke("gateway_publish_chat_queue_event", {
      input: {
        conversationId: snapshot.conversationId,
        snapshotJson: JSON.stringify(snapshot),
        revision: snapshot.revision,
      },
    } as any).catch((error) => {
      console.warn("gateway_publish_chat_queue_event failed", error);
    });
  }

  function publishChatQueueSnapshots(
    conversationIds: Iterable<string>,
    queue: readonly QueuedChatTurn[] = queuedChatTurnsRef.current,
  ) {
    for (const conversationId of conversationIds) {
      publishChatQueueSnapshot(conversationId, queue);
    }
  }

  const setQueuedChatTurnsState = useCallback(
    (updater: (current: QueuedChatTurn[]) => QueuedChatTurn[]) => {
      const previous = queuedChatTurnsRef.current;
      const next = updater(previous).slice();
      queuedChatTurnsRef.current = next;
      setQueuedChatTurns(next);
      chatQueueRevisionRef.current += 1;
      const conversationIds = new Set<string>();
      for (const item of previous) conversationIds.add(item.conversationId);
      for (const item of next) conversationIds.add(item.conversationId);
      const currentId = currentConversationIdRef.current.trim();
      if (currentId) conversationIds.add(currentId);
      publishChatQueueSnapshots(conversationIds, next);
      return next;
    },
    [],
  );

  const queuedChatTurnsForCurrentConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns
        .filter((item) => item.conversationId === currentConversationId)
        .map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
        })),
    [currentConversationId, queuedChatTurns],
  );

  const deleteConversationLocalCaches = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      if (!key) return;
      composerDraftCacheRef.current.delete(key);
      if (composerDraftOwnerRef.current === key) {
        composerDraftOwnerRef.current = "";
      }
      locallySyncedHistoryUpdatedAtRef.current.delete(key);
      gatewayBridgeHistorySummaryRef.current.delete(key);
      setPendingUploadsForConversation(key, []);
      memoryExtraction.dispose(key);
      deleteConversationArtifacts(key);
      setQueuedChatTurnsState((current) => removeQueuedChatTurnsForConversation(current, key));
    },
    [deleteConversationArtifacts, setPendingUploadsForConversation, setQueuedChatTurnsState],
  );

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

  function cacheActiveComposerDraft(conversationId = composerDraftOwnerRef.current) {
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
    cacheActiveComposerDraft();
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

  prepareComposerForConversationChangeActionRef.current = prepareComposerForConversationChange;

  function clearCachedComposerDraft(conversationId = currentConversationIdRef.current) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    composerDraftCacheRef.current.delete(targetConversationId);
  }

  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = currentConversationId.trim();
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
  }, [activeView, currentConversationId]);

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

  // Bridge errorMessage / hookWarning / compaction-failed → toast notifications
  useEffect(() => {
    if (errorMessage) addNotify("error", errorMessage);
  }, [errorMessage, addNotify]);

  useEffect(() => {
    if (hookWarning) addNotify("warning", hookWarning);
  }, [hookWarning, addNotify]);

  useEffect(() => {
    if (compactionStatus.phase === "failed") {
      addNotify("error", `上下文压缩失败：${compactionStatus.message}`);
    }
  }, [compactionStatus, addNotify]);

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

  function stopConversation(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return false;
    const controller = getConversationAbortController(targetConversationId);
    if (!controller) return false;
    const transcriptStore = getConversationLiveTranscriptStore(targetConversationId);
    captureAbortSnapshot(transcriptStore);
    updateToolStatus("正在停止当前任务...", transcriptStore);
    controller.abort();
    return true;
  }

  function stopSending() {
    const conversationId = currentConversationIdRef.current.trim();
    if (!conversationId) return;
    if (!stopConversation(conversationId)) {
      requestQueuedChatTurnProcessing(conversationId);
    }
  }

  function clearCurrentComposerDraftForQueuedTurn(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current !== targetConversationId) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(targetConversationId, []);
    clearCachedComposerDraft(targetConversationId);
  }

  function enqueueCurrentComposerTurn(position: "end" | "edit") {
    const conversationId = currentConversationIdRef.current.trim();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!conversationId || !queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }

    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      buildRuntimeEntryFromVisibleState();
    const editSlot =
      position === "edit" && queuedChatTurnEditSlotRef.current?.conversationId === conversationId
        ? queuedChatTurnEditSlotRef.current
        : null;
    const executionMode = editSlot?.executionMode ?? settings.system.executionMode;
    const workdirForTurn = isAgentExecutionMode(executionMode)
      ? (
          editSlot?.workdir ??
          runtimeEntry.workdir ??
          displayedConversationWorkdir ??
          settings.system.workdir
        ).trim()
      : "";
    const queuedTurn = createQueuedChatTurn({
      id: editSlot?.originalId,
      conversationId,
      draft,
      uploadedFiles,
      executionMode,
      workdir: workdirForTurn,
      selectedSystemToolIds: editSlot?.selectedSystemToolIds ?? settings.system.selectedSystemTools,
      runtimeControls: editSlot?.runtimeControls ?? settings.chatRuntimeControls,
      createdAt: editSlot?.createdAt,
      gatewayRequest: editSlot?.gatewayRequest,
    });

    setQueuedChatTurnsState((current) => {
      if (editSlot) {
        return insertQueuedChatTurnAtSlot(current, queuedTurn, editSlot);
      }
      return appendQueuedChatTurn(current, queuedTurn);
    });
    if (editSlot) {
      queuedChatTurnEditSlotRef.current = null;
    }
    clearCurrentComposerDraftForQueuedTurn(conversationId);
    return true;
  }

  function isQueuedChatTurnEditBlockingProcessing(conversationId: string) {
    const slot = queuedChatTurnEditSlotRef.current;
    if (!slot || slot.conversationId !== conversationId.trim()) return false;
    const queue = queuedChatTurnsRef.current;
    const firstQueuedIndex = queue.findIndex((item) => item.conversationId === slot.conversationId);
    if (firstQueuedIndex < 0) return false;
    return resolveQueuedChatTurnSlotIndex(queue, slot) <= firstQueuedIndex;
  }

  function requestQueuedChatTurnProcessing(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) return;
    if (queuedChatProcessingConversationIdsRef.current.has(targetConversationId)) return;
    if (isConversationRunning(targetConversationId)) return;
    if (isQueuedChatTurnEditBlockingProcessing(targetConversationId)) return;
    if (!queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)) {
      return;
    }

    queuedChatProcessingConversationIdsRef.current.add(targetConversationId);
    let inFlightQueuedTurn: QueuedChatTurn | null = null;
    void Promise.resolve()
      .then(async () => {
        if (isConversationRunning(targetConversationId)) return;
        const taken = takeNextQueuedChatTurn(queuedChatTurnsRef.current, targetConversationId);
        if (!taken.item) return false;
        const queuedTurn = taken.item;
        inFlightQueuedTurn = queuedTurn;
        setQueuedChatTurnsState(() => taken.queue);
        const gatewayRequest = queuedTurn.gatewayRequest;
        const gatewayWorkerId = gatewayRequest?.workerId?.trim() || "gui-queue";
        const gatewayBridgeRequest: ActiveGatewayBridgeRequest | null = gatewayRequest
          ? {
              requestId: gatewayRequest.requestId,
              conversationId: targetConversationId,
              clientRequestId: gatewayRequest.clientRequestId,
              workerId: gatewayWorkerId,
              startedAt: Date.now(),
              selectedModelOverride: gatewayRequest.selectedModel,
              runtimeControlsOverride: gatewayRequest.runtimeControls
                ? normalizeChatRuntimeControls(gatewayRequest.runtimeControls)
                : queuedTurn.runtimeControls,
              executionModeOverride: queuedTurn.executionMode,
              workdirOverride: queuedTurn.workdir,
              selectedSystemToolIdsOverride: queuedTurn.selectedSystemToolIds,
            }
          : null;
        const markGatewayStarted =
          gatewayRequest && gatewayBridgeRequest
            ? async () => {
                await invoke("gateway_chat_mark_started", {
                  request_id: gatewayRequest.requestId,
                  conversation_id: targetConversationId,
                  worker_id: gatewayWorkerId,
                } as any);
              }
            : undefined;
        const accepted = await sendActionRef.current({
          composerDraftOverride: queuedTurn.draft,
          uploadedFilesOverride: queuedTurn.uploadedFiles,
          conversationIdOverride: targetConversationId,
          executionModeOverride: queuedTurn.executionMode,
          workdirOverride: queuedTurn.workdir,
          selectedSystemToolIdsOverride: queuedTurn.selectedSystemToolIds,
          runtimeControlsOverride: queuedTurn.runtimeControls,
          gatewayBridgeRequestOverride: gatewayBridgeRequest,
          preserveComposerOnStart: true,
          beforeRuntimeStart: markGatewayStarted,
          afterInitialHistoryPersist: markGatewayStarted,
        });
        if (!accepted) {
          setQueuedChatTurnsState((current) =>
            promoteQueuedChatTurn(appendQueuedChatTurn(current, queuedTurn), queuedTurn.id),
          );
          inFlightQueuedTurn = null;
        } else if (gatewayRequest) {
          void invoke("gateway_chat_complete", {
            request_id: gatewayRequest.requestId,
            conversation_id: targetConversationId,
            worker_id: gatewayWorkerId,
          } as any).catch((error) => {
            console.warn("gateway_chat_complete failed", error);
          });
        }
        return accepted;
      })
      .then((accepted) => {
        queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
        if (
          accepted &&
          !isConversationRunning(targetConversationId) &&
          queuedChatTurnsRef.current.some((item) => item.conversationId === targetConversationId)
        ) {
          requestQueuedChatTurnProcessing(targetConversationId);
        }
      })
      .catch(() => {
        const failedQueuedTurn = inFlightQueuedTurn;
        if (failedQueuedTurn) {
          setQueuedChatTurnsState((current) =>
            promoteQueuedChatTurn(
              appendQueuedChatTurn(current, failedQueuedTurn),
              failedQueuedTurn.id,
            ),
          );
          inFlightQueuedTurn = null;
        }
        queuedChatProcessingConversationIdsRef.current.delete(targetConversationId);
      });
  }

  useEffect(() => {
    const previousRunningConversationIds = previousRunningConversationIdsRef.current;
    previousRunningConversationIdsRef.current = runningConversationIds;
    for (const conversationId of getQueuedConversationIds(queuedChatTurnsRef.current)) {
      if (
        previousRunningConversationIds.has(conversationId) &&
        !runningConversationIds.has(conversationId)
      ) {
        requestQueuedChatTurnProcessing(conversationId);
      }
    }
  }, [runningConversationIds, queuedChatTurns]);

  function runQueuedTurnNow(id: string) {
    const queuedTurn = queuedChatTurnsRef.current.find((item) => item.id === id.trim());
    if (!queuedTurn) return;
    setQueuedChatTurnsState((current) => promoteQueuedChatTurn(current, queuedTurn.id));
    if (isConversationRunning(queuedTurn.conversationId)) {
      stopConversation(queuedTurn.conversationId);
      return;
    }
    requestQueuedChatTurnProcessing(queuedTurn.conversationId);
  }

  function moveQueuedTurnUp(id: string) {
    setQueuedChatTurnsState((current) => moveQueuedChatTurn(current, id, "up"));
  }

  function editQueuedTurn(id: string) {
    const key = id.trim();
    const queuedTurnIndex = queuedChatTurnsRef.current.findIndex((item) => item.id === key);
    const queuedTurn = queuedTurnIndex >= 0 ? queuedChatTurnsRef.current[queuedTurnIndex] : null;
    if (!queuedTurn) return;
    const targetConversationId = queuedTurn.conversationId.trim();
    if (!targetConversationId || currentConversationIdRef.current.trim() !== targetConversationId) {
      return;
    }

    const currentDraft = composerRef.current?.getDraft() ?? null;
    const currentUploads = pendingUploadedFiles.slice();
    if (queuedChatTurnHasContent(currentDraft, currentUploads)) {
      enqueueCurrentComposerTurn(queuedChatTurnEditSlotRef.current ? "edit" : "end");
    }

    const sameConversationQueue = queuedChatTurnsRef.current.filter(
      (item) => item.conversationId === targetConversationId,
    );
    const sameConversationIndex = sameConversationQueue.findIndex((item) => item.id === key);
    const previousId =
      sameConversationIndex > 0
        ? (sameConversationQueue[sameConversationIndex - 1]?.id ?? null)
        : null;
    const nextId =
      sameConversationIndex >= 0
        ? (sameConversationQueue[sameConversationIndex + 1]?.id ?? null)
        : null;
    queuedChatTurnEditSlotRef.current = {
      conversationId: targetConversationId,
      previousId,
      nextId,
      index: sameConversationIndex >= 0 ? sameConversationIndex : undefined,
      originalId: queuedTurn.id,
      createdAt: queuedTurn.createdAt,
      executionMode: queuedTurn.executionMode,
      workdir: queuedTurn.workdir,
      selectedSystemToolIds: queuedTurn.selectedSystemToolIds.slice(),
      runtimeControls: { ...queuedTurn.runtimeControls },
      gatewayRequest: queuedTurn.gatewayRequest ? { ...queuedTurn.gatewayRequest } : undefined,
    };
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, key));
    composerRef.current?.setDraft(queuedTurn.draft);
    setPendingUploadsForConversation(targetConversationId, queuedTurn.uploadedFiles);
    clearCachedComposerDraft(targetConversationId);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function removeQueuedTurn(id: string) {
    const queuedTurn = queuedChatTurnsRef.current.find((item) => item.id === id.trim());
    setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, id));
    const gatewayRequest = queuedTurn?.gatewayRequest;
    if (gatewayRequest) {
      void invoke("gateway_chat_cancel_request", {
        request_id: gatewayRequest.requestId,
        conversation_id: queuedTurn?.conversationId,
        worker_id: gatewayRequest.workerId ?? "gui-queue",
      } as any).catch((error) => {
        console.warn("gateway_chat_cancel_request failed", error);
      });
    }
  }

  function createTextComposerDraft(text: string): MentionComposerDraft {
    return {
      segments: text ? [{ type: "text", text }] : [],
      text,
      textWithoutLargePastes: text,
      largePastes: [],
      skillMentions: [],
      commitMentions: [],
      gitFileMentions: [],
      codeMentions: [],
      isEmpty: text.trim().length === 0,
    };
  }

  function shouldQueueGatewayChatRequest(
    conversationId: string,
    queuePolicy: "auto" | "append" | "interrupt",
  ) {
    const key = conversationId.trim();
    if (!key) return false;
    return (
      queuePolicy === "append" ||
      queuePolicy === "interrupt" ||
      queuedChatTurnsRef.current.some((item) => item.conversationId === key) ||
      isQueuedChatTurnEditBlockingProcessing(key)
    );
  }

  async function enqueueGatewayChatRequest(
    claimed: GatewayChatClaimedRequest,
    conversationId: string,
  ) {
    const payload = claimed.request;
    const requestId = payload.requestId.trim();
    const targetConversationId = conversationId.trim();
    const message = payload.message ?? "";
    const uploadedFiles = Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles : [];
    if (!requestId || !targetConversationId || (!message.trim() && uploadedFiles.length === 0)) {
      return false;
    }

    const executionMode =
      normalizeGatewayExecutionMode(payload.executionMode) ?? settings.system.executionMode;
    const workdir =
      normalizeGatewayWorkdir(payload.workdir) ??
      conversationRuntimeCacheRef.current.get(targetConversationId)?.workdir ??
      displayedConversationWorkdir ??
      settings.system.workdir;
    const runtimeControls = payload.runtimeControls
      ? normalizeChatRuntimeControls(payload.runtimeControls)
      : settings.chatRuntimeControls;
    const selectedSystemToolIds = normalizeSystemToolSelection(payload.selectedSystemTools);
    const queuedTurn = createQueuedChatTurn({
      id: `gateway-${requestId}`,
      conversationId: targetConversationId,
      draft: createTextComposerDraft(message),
      uploadedFiles,
      executionMode,
      workdir: isAgentExecutionMode(executionMode) ? workdir : "",
      selectedSystemToolIds:
        selectedSystemToolIds.length > 0
          ? selectedSystemToolIds
          : settings.system.selectedSystemTools,
      runtimeControls,
      gatewayRequest: {
        requestId,
        clientRequestId:
          payload.clientRequestId?.trim() || claimed.clientRequestId?.trim() || undefined,
        workerId: "gui-queue",
        queuePolicy:
          payload.queuePolicy === "append" || payload.queuePolicy === "interrupt"
            ? payload.queuePolicy
            : "auto",
        selectedModel: payload.selectedModel,
        runtimeControls: payload.runtimeControls,
      },
    });

    setQueuedChatTurnsState((current) => {
      const appended = appendQueuedChatTurn(current, queuedTurn);
      return payload.queuePolicy === "interrupt"
        ? promoteQueuedChatTurn(appended, queuedTurn.id)
        : appended;
    });
    if (payload.queuePolicy === "interrupt") {
      stopConversation(targetConversationId);
    }
    return true;
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    type GatewayChatQueueRequestEvent = {
      requestId: string;
      action: string;
      conversationId?: string;
      itemId?: string;
      direction?: "up" | "down" | string;
      revision?: number;
      draftJson?: string;
      uploadedFilesJson?: string;
    };

    const respond = (requestId: string, response: Record<string, unknown>) => {
      if (!requestId.trim()) return;
      void invoke("gateway_chat_queue_respond", {
        input: {
          requestId,
          accepted: response.accepted === true,
          message: typeof response.message === "string" ? response.message : "",
          snapshotJson: typeof response.snapshotJson === "string" ? response.snapshotJson : "",
          itemJson: typeof response.itemJson === "string" ? response.itemJson : "",
          errorCode: typeof response.errorCode === "string" ? response.errorCode : "",
          revision: chatQueueRevisionRef.current,
        },
      } as any).catch((error) => {
        console.warn("gateway_chat_queue_respond failed", error);
      });
    };

    const snapshotJson = (conversationId: string) =>
      JSON.stringify(buildChatQueueSnapshot(conversationId));

    void listen<GatewayChatQueueRequestEvent>("gateway:chat-queue-request", (event) => {
      if (disposed) return;
      const request = event.payload;
      const requestId = request.requestId?.trim() ?? "";
      const action = request.action?.trim() ?? "";
      const conversationId =
        request.conversationId?.trim() || currentConversationIdRef.current.trim();
      const itemId = request.itemId?.trim() ?? "";

      const fail = (message: string, errorCode = "invalid_request") => {
        respond(requestId, {
          accepted: false,
          message,
          errorCode,
          snapshotJson: conversationId ? snapshotJson(conversationId) : "",
        });
      };

      if (!requestId) return;
      if (!conversationId && action !== "get") {
        fail("conversation_id is required");
        return;
      }

      if (action === "get") {
        respond(requestId, {
          accepted: true,
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      const item = queuedChatTurnsRef.current.find(
        (candidate) => candidate.id === itemId && candidate.conversationId === conversationId,
      );

      if (action === "get_item") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        respond(requestId, {
          accepted: true,
          itemJson: JSON.stringify(buildChatQueueItemDetail(item)),
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      if (action === "run_now") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        runQueuedTurnNow(item.id);
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "move") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        const direction = request.direction === "down" ? "down" : "up";
        setQueuedChatTurnsState((current) => moveQueuedChatTurn(current, item.id, direction));
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "remove") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        removeQueuedTurn(item.id);
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "edit_begin") {
        if (!item) {
          fail("queued item not found", "not_found");
          return;
        }
        const sameConversationQueue = queuedChatTurnsRef.current.filter(
          (candidate) => candidate.conversationId === conversationId,
        );
        const sameConversationIndex = sameConversationQueue.findIndex(
          (candidate) => candidate.id === item.id,
        );
        const slot: QueuedChatTurnEditSlot = {
          conversationId,
          previousId:
            sameConversationIndex > 0
              ? (sameConversationQueue[sameConversationIndex - 1]?.id ?? null)
              : null,
          nextId:
            sameConversationIndex >= 0
              ? (sameConversationQueue[sameConversationIndex + 1]?.id ?? null)
              : null,
          index: sameConversationIndex >= 0 ? sameConversationIndex : undefined,
        };
        remoteQueuedChatTurnEditSlotsRef.current.set(item.id, {
          item,
          slot,
          revision: chatQueueRevisionRef.current,
        });
        const detail = buildChatQueueItemDetail(item);
        setQueuedChatTurnsState((current) => removeQueuedChatTurn(current, item.id));
        respond(requestId, {
          accepted: true,
          itemJson: JSON.stringify(detail),
          snapshotJson: snapshotJson(conversationId),
        });
        return;
      }

      if (action === "edit_cancel") {
        const session = remoteQueuedChatTurnEditSlotsRef.current.get(itemId);
        if (!session) {
          fail("queued edit session not found", "not_found");
          return;
        }
        if (session.slot.conversationId !== conversationId) {
          fail("queued edit session conversation mismatch", "not_found");
          return;
        }
        remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
        setQueuedChatTurnsState((current) =>
          insertQueuedChatTurnAtSlot(current, session.item, session.slot),
        );
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      if (action === "edit_commit") {
        const session = remoteQueuedChatTurnEditSlotsRef.current.get(itemId);
        if (!session) {
          fail("queued edit session not found", "not_found");
          return;
        }
        if (session.slot.conversationId !== conversationId) {
          fail("queued edit session conversation mismatch", "not_found");
          return;
        }
        if (
          typeof request.revision === "number" &&
          request.revision > 0 &&
          request.revision < chatQueueRevisionRef.current
        ) {
          fail("queued edit revision conflict", "conflict");
          return;
        }
        let draft: MentionComposerDraft;
        let uploadedFiles: PendingUploadedFile[];
        try {
          draft = JSON.parse(request.draftJson || "") as MentionComposerDraft;
          uploadedFiles = JSON.parse(request.uploadedFilesJson || "[]") as PendingUploadedFile[];
        } catch {
          fail("invalid queued edit payload", "invalid_payload");
          return;
        }
        const nextItem = createQueuedChatTurn({
          ...session.item,
          draft,
          uploadedFiles: Array.isArray(uploadedFiles) ? uploadedFiles : [],
          id: session.item.id,
          createdAt: session.item.createdAt,
        });
        remoteQueuedChatTurnEditSlotsRef.current.delete(itemId);
        setQueuedChatTurnsState((current) =>
          insertQueuedChatTurnAtSlot(current, nextItem, session.slot),
        );
        respond(requestId, { accepted: true, snapshotJson: snapshotJson(conversationId) });
        return;
      }

      fail(`unsupported chat queue action: ${action}`, "unsupported_action");
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
        const path = project.path.trim();
        const pathKey = workspaceProjectPathKey(path);
        const runningMessage = "项目中仍有后台任务运行，暂时不能删除该项目。";
        if (pathKey && sidebarStore.getSnapshot().runningWorkdirPathKeys.has(pathKey)) {
          setErrorMessage(runningMessage);
          return;
        }

        setErrorMessage(null);

        try {
          const conversationIds = await listChatHistoryIdsForProjectPath(path);
          const sidebarRunningIds = sidebarStore.getSnapshot().runningConversationIds;
          const runningConversationIdsInProject = conversationIds.filter((id) => {
            const key = id.trim();
            return key ? isConversationRunning(key) || sidebarRunningIds.has(key) : false;
          });
          if (runningConversationIdsInProject.length > 0) {
            setErrorMessage(runningMessage);
            return;
          }

          const terminalSessions = pathKey ? await tauriTerminalClient.list(pathKey) : [];
          const runningTerminalCount = terminalSessions.filter((session) => session.running).length;
          if (runningTerminalCount > 0) {
            const confirmed = await requestConfirmDialog({
              title: t("chat.workspaceRemoveConfirm").replace("{name}", project.name),
              subtitle: t("chat.workspaceRemoveDescription"),
              description: (
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                    <Terminal className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {t("chat.exitConfirmRunningLabel")}
                      </span>
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-amber-700 dark:text-amber-300">
                        {runningTerminalCount}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                      {t("chat.workspaceRemoveTerminalDescription")}
                    </p>
                  </div>
                </div>
              ),
              confirmLabel: t("chat.workspaceRemoveConfirmContinue"),
              cancelLabel: t("chat.cancel"),
              closeLabel: t("chat.workspaceRemoveConfirmClose"),
              tone: "warning",
            });
            if (!confirmed) return;
          }

          for (const conversationId of conversationIds) {
            await deleteChatHistory(conversationId);
          }

          const deletedConversationIds = new Set(conversationIds);
          if (deletedConversationIds.size > 0) {
            for (const conversationId of deletedConversationIds) {
              sidebarStore.removeLocal(conversationId);
            }
            setSharedHistoryItems((current) => {
              const next = current.filter((item) => !deletedConversationIds.has(item.id));
              sharedHistoryItemsRef.current = next;
              return next;
            });
            for (const conversationId of deletedConversationIds) {
              persistedConversationStateRef.current.delete(conversationId);
              conversationRuntimeCacheRef.current.delete(conversationId);
              locallySyncedHistoryUpdatedAtRef.current.delete(conversationId);
              deleteConversationLocalCaches(conversationId);
              subagentStoresRef.current.dispose(conversationId);
            }
          }
          if (terminalSessions.length > 0) {
            await tauriTerminalClient.closeProject(pathKey);
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          }
          if (pathKey && terminalProjectPathKey === pathKey) {
            setRightDockOpen(false);
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          }

          const visibleConversationId = currentConversationIdRef.current;
          const shouldResetVisibleConversation =
            Boolean(visibleConversationId && deletedConversationIds.has(visibleConversationId)) ||
            Boolean(pathKey && workspaceProjectPathKey(displayedConversationWorkdir) === pathKey);

          if (path) {
            await memoryDeleteProject({
              workdir: path,
              actor: "tool",
              reason: "workspace project removed",
            });
          }
          removeWorkspaceProjectFromSettings(project);
          if (shouldResetVisibleConversation) {
            startNewConversationActionRef.current({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
        } catch (error) {
          setErrorMessage(asErrorMessage(error, "删除项目失败"));
        }
      })();
    },
    [
      deleteConversationLocalCaches,
      displayedConversationWorkdir,
      isConversationRunning,
      removeWorkspaceProjectFromSettings,
      settings.system,
      sidebarStore,
      terminalProjectPathKey,
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

  // The sidebar store keeps workdir activity/summaries fresh from the
  // persist-driven upsert (locally and via sync events); no settings write,
  // no extra workdirs IPC.
  async function persistConversationWithHistorySync(
    params: Parameters<typeof persistConversation>[0],
  ) {
    return await persistConversation(params);
  }

  function clearGatewayRuntimeSnapshotTimer(conversationId: string) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    const timerId = gatewayRuntimeSnapshotTimersRef.current.get(targetConversationId);
    if (timerId === undefined) {
      return;
    }
    window.clearTimeout(timerId);
    gatewayRuntimeSnapshotTimersRef.current.delete(targetConversationId);
  }

  async function publishGatewayRuntimeSnapshot(
    run: ActiveGatewayRuntimeRun,
    state: GatewayRuntimeSnapshotState = run.state,
  ) {
    const liveTranscript = run.transcriptStore.getSnapshot();
    const entries = buildGatewayRuntimeSnapshotEntries({
      userMessage: run.userMessage,
      liveTranscript,
    });
    run.state = state;
    run.revision += 1;
    const toolStatus = liveTranscript.toolStatus?.trim() || "";

    try {
      await invoke("gateway_publish_chat_runtime_snapshot", {
        input: {
          conversationId: run.conversationId,
          runId: run.runId,
          clientRequestId: run.clientRequestId ?? "",
          workerId: run.workerId ?? "",
          state,
          cwd: run.cwd ?? "",
          updatedAt: Date.now(),
          revision: run.revision,
          entriesJson: JSON.stringify(entries),
          toolStatus,
          toolStatusIsCompaction: Boolean(toolStatus) && run.toolStatusIsCompaction,
        },
      } as any);
    } catch (error) {
      console.warn("gateway_publish_chat_runtime_snapshot failed", error);
    }
  }

  function queueGatewayRuntimeSnapshotForRun(
    run: ActiveGatewayRuntimeRun,
    options?: { state?: GatewayRuntimeSnapshotState; force?: boolean },
  ) {
    const state = options?.state ?? run.state;
    run.state = state;
    if (options?.force) {
      clearGatewayRuntimeSnapshotTimer(run.conversationId);
    } else if (gatewayRuntimeSnapshotTimersRef.current.has(run.conversationId)) {
      return gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) ?? Promise.resolve();
    }

    const publish = () => {
      gatewayRuntimeSnapshotTimersRef.current.delete(run.conversationId);
      const previous =
        gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => publishGatewayRuntimeSnapshot(run, state));
      gatewayRuntimeSnapshotChainsRef.current.set(run.conversationId, next);
      void next.finally(() => {
        if (gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) === next) {
          gatewayRuntimeSnapshotChainsRef.current.delete(run.conversationId);
        }
      });
      return next;
    };

    if (options?.force) {
      return publish();
    }

    const timerId = window.setTimeout(publish, GATEWAY_RUNTIME_SNAPSHOT_DEBOUNCE_MS);
    gatewayRuntimeSnapshotTimersRef.current.set(run.conversationId, timerId);
    return gatewayRuntimeSnapshotChainsRef.current.get(run.conversationId) ?? Promise.resolve();
  }

  function queueGatewayRuntimeSnapshot(
    conversationId: string,
    options?: { state?: GatewayRuntimeSnapshotState; force?: boolean },
  ) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return Promise.resolve();
    }
    const run = activeGatewayRuntimeRunsRef.current.get(targetConversationId);
    if (!run) {
      return Promise.resolve();
    }
    return queueGatewayRuntimeSnapshotForRun(run, options);
  }

  function registerActiveGatewayRuntimeRun(run: ActiveGatewayRuntimeRun) {
    activeGatewayRuntimeRunsRef.current.set(run.conversationId, run);
    return run;
  }

  function finishActiveGatewayRuntimeRun(
    conversationId: string,
    state: GatewayRuntimeSnapshotState,
  ) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    const run = activeGatewayRuntimeRunsRef.current.get(targetConversationId);
    if (!run) {
      return;
    }
    void queueGatewayRuntimeSnapshotForRun(run, { state, force: true }).finally(() => {
      if (activeGatewayRuntimeRunsRef.current.get(targetConversationId) === run) {
        activeGatewayRuntimeRunsRef.current.delete(targetConversationId);
      }
      clearGatewayRuntimeSnapshotTimer(targetConversationId);
    });
  }

  useEffect(
    () => () => {
      for (const timerId of gatewayRuntimeSnapshotTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      gatewayRuntimeSnapshotTimersRef.current.clear();
      activeGatewayRuntimeRunsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!canShareHistory) {
      return;
    }
    publishChatQueueSnapshots(
      collectChatQueueSnapshotConversationIds(queuedChatTurnsRef.current, [
        currentConversationIdRef.current,
      ]),
    );
    for (const run of activeGatewayRuntimeRunsRef.current.values()) {
      void queueGatewayRuntimeSnapshotForRun(run, { state: run.state, force: true });
    }
  }, [canShareHistory, remoteRuntimeStatus.connectedSince, remoteRuntimeStatus.sessionId]);

  // Keep-alive: a long silent tool call produces no chat events, and the
  // desktop run ledger treats an untouched run as lost after its active TTL
  // (which would surface a spurious failure on remote clients). Re-publishing
  // the running snapshot refreshes both the ledger and the gateway activity.
  useEffect(() => {
    if (!canShareHistory) {
      return;
    }
    const timerId = window.setInterval(() => {
      for (const run of activeGatewayRuntimeRunsRef.current.values()) {
        if (run.state === "running") {
          void queueGatewayRuntimeSnapshotForRun(run, { state: run.state });
        }
      }
    }, GATEWAY_RUNTIME_RUN_KEEPALIVE_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, [canShareHistory]);

  function applyGatewayBridgeRebase(conversationId: string, baseMessageRef: HistoryMessageRef) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      throw new Error("Remote edit_resend requires conversation_id.");
    }
    const sourceEntry =
      conversationRuntimeCacheRef.current.get(targetConversationId) ??
      (targetConversationId === currentConversationIdRef.current
        ? buildRuntimeEntryFromVisibleState()
        : null);
    if (!sourceEntry) {
      throw new Error(`Conversation is not available for edit_resend: ${targetConversationId}`);
    }
    const nextState = truncateConversationFromMessage(sourceEntry.state, baseMessageRef);
    const nextEntry = createConversationRuntimeEntry({
      ...sourceEntry,
      state: nextState,
    });
    setConversationRuntimeCacheEntry(
      conversationRuntimeCacheRef.current,
      targetConversationId,
      nextEntry,
    );
    persistedConversationStateRef.current.delete(targetConversationId);
    if (currentConversationIdRef.current === targetConversationId) {
      syncVisibleConversationRuntime(targetConversationId, nextEntry);
    }

    const keepParentToolCallIds = collectRetainedSubagentParentToolCallIds(nextState);
    subagentStoresRef.current.invalidate(targetConversationId);
    void pruneSubagentRunsForConversation({
      parentConversationId: targetConversationId,
      keepParentToolCallIds,
    }).catch((error) => {
      console.warn("gateway edit_resend subagent prune failed", error);
    });
  }

  async function ensureGatewayBridgeConversationReady(
    targetConversationId: string,
    options?: EnsureGatewayBridgeConversationReadyOptions,
  ) {
    const requestedConversationId = targetConversationId.trim();
    const baseMessageRef = options?.baseMessageRef;
    const rebased = options?.rebased === true || Boolean(baseMessageRef);
    if (!requestedConversationId) {
      const nextIdentity = createConversationIdentity();
      setConversationRuntimeCacheEntry(
        conversationRuntimeCacheRef.current,
        nextIdentity.conversationId,
        createConversationRuntimeEntry({
          state: createConversationStateFromContext({
            tools: conversationState.meta.tools,
            messages: [],
          }),
          sessionId: nextIdentity.sessionId,
          createdAt: nextIdentity.createdAt,
        }),
      );
      return nextIdentity.conversationId;
    }

    const knownConversation =
      requestedConversationId === currentConversationIdRef.current ||
      conversationRuntimeCacheRef.current.has(requestedConversationId) ||
      Boolean(sidebarStore.peek(requestedConversationId)) ||
      gatewayBridgeHistorySummaryRef.current.has(requestedConversationId);
    if (isConversationRunning(requestedConversationId)) {
      throw new Error(`Conversation is already running: ${requestedConversationId}`);
    }

    const cached = conversationRuntimeCacheRef.current.get(requestedConversationId);
    if (
      rebased &&
      baseMessageRef &&
      (cached || requestedConversationId === currentConversationIdRef.current) &&
      cached?.isSending !== true &&
      hydratingConversationIdRef.current !== requestedConversationId &&
      hydrationFailedConversationIdRef.current !== requestedConversationId
    ) {
      try {
        applyGatewayBridgeRebase(requestedConversationId, baseMessageRef);
        return requestedConversationId;
      } catch (error) {
        console.warn("gateway edit_resend cached rebase failed; hydrating history", error);
      }
    }
    if (rebased) {
      persistedConversationStateRef.current.delete(requestedConversationId);
    }
    const isPendingHistoryItem = sidebarStore.peek(requestedConversationId)?.isPending === true;
    const shouldHydrateFromHistory =
      !knownConversation ||
      rebased ||
      hydratingConversationIdRef.current === requestedConversationId ||
      hydrationFailedConversationIdRef.current === requestedConversationId ||
      !cached ||
      (!persistedConversationStateRef.current.has(requestedConversationId) &&
        !cached.isSending &&
        !isPendingHistoryItem);

    if (!shouldHydrateFromHistory) {
      if (rebased && baseMessageRef) {
        applyGatewayBridgeRebase(requestedConversationId, baseMessageRef);
      }
      return requestedConversationId;
    }

    const record = await getChatHistory(requestedConversationId);
    const nextEntry = createConversationRuntimeEntry({
      state: record.state,
      sessionId: record.sessionId ?? record.id,
      createdAt: record.createdAt,
      compactionStatus: cached?.compactionStatus,
      isSending: cached?.isSending,
      workdir: record.cwd,
      selectedModel: normalizeSelectedModelForProviders(
        parseSelectedModelJson(record.selectedModelJson),
        settings.customProviders,
      ),
    });
    const historySummary: ChatHistorySummary = {
      id: record.id,
      title: record.title,
      providerId: record.providerId,
      model: record.model,
      sessionId: record.sessionId,
      cwd: record.cwd,
      selectedModelJson: record.selectedModelJson,
      messageCount: record.state.meta.totalMessageCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      isPinned: record.isPinned,
      pinnedAt: record.pinnedAt,
    };
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, record.id, nextEntry);
    persistedConversationStateRef.current.set(record.id, record.state);
    gatewayBridgeHistorySummaryRef.current.set(record.id, historySummary);
    sidebarStore.upsertLocal(historySummary);
    if (currentConversationIdRef.current === record.id) {
      syncVisibleConversationRuntime(record.id, nextEntry);
    }
    if (hydratingConversationIdRef.current === record.id) {
      setHydratingConversationId(null);
    }
    if (hydrationFailedConversationIdRef.current === record.id) {
      setHydrationFailedConversationId(null);
    }
    if (rebased && baseMessageRef) {
      applyGatewayBridgeRebase(record.id, baseMessageRef);
    }
    return record.id;
  }

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

  const enableManagedSkills = useCallback(
    (names: readonly string[]) => {
      const normalizedNames = names.map((name) => String(name).trim()).filter(Boolean);
      if (normalizedNames.length === 0) return;
      setSettings((prev) => {
        const selected = appendManagedSkillSelections(prev.skills.selected, normalizedNames);
        if (selected.join("\n") === prev.skills.selected.join("\n")) return prev;
        return updateSkills(prev, { selected });
      });
    },
    [setSettings],
  );

  async function send(overrides?: {
    textOverride?: string;
    composerDraftOverride?: MentionComposerDraft;
    uploadedFilesOverride?: PendingUploadedFile[];
    conversationIdOverride?: string;
    executionModeOverride?: ExecutionMode;
    workdirOverride?: string;
    selectedSystemToolIdsOverride?: SystemToolId[];
    runtimeControlsOverride?: ChatRuntimeControls;
    gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
    preserveComposerOnStart?: boolean;
    beforeRuntimeStart?: () => Promise<void>;
    afterInitialHistoryPersist?: () => Promise<void>;
    editResendBaseMessageRef?: HistoryMessageRef;
  }) {
    const overrideConversationId = overrides?.conversationIdOverride?.trim() ?? "";
    const conversationId = overrideConversationId || currentConversationIdRef.current;
    if (!conversationId) {
      return false;
    }

    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      (conversationId === currentConversationIdRef.current
        ? buildRuntimeEntryFromVisibleState()
        : null);

    const gatewayBridgeRequest = overrides?.gatewayBridgeRequestOverride ?? null;
    const effectiveExecutionMode =
      overrides?.executionModeOverride ??
      gatewayBridgeRequest?.executionModeOverride ??
      settings.system.executionMode;
    const effectiveIsAgentMode = isAgentExecutionMode(effectiveExecutionMode);
    const effectiveWorkdir = (
      overrides?.workdirOverride ??
      gatewayBridgeRequest?.workdirOverride ??
      (effectiveIsAgentMode ? (runtimeEntry?.workdir ?? settings.system.workdir) : "")
    ).trim();
    const effectiveSelectedSystemToolIds =
      overrides?.selectedSystemToolIdsOverride ??
      gatewayBridgeRequest?.selectedSystemToolIdsOverride ??
      settings.system.selectedSystemTools;
    const effectiveProjectPathKey = workspaceProjectPathKey(effectiveWorkdir);
    const effectiveAssociatedSshHostIds = getSshProjectHostIds(
      settings.ssh,
      effectiveProjectPathKey,
    );
    const effectiveIsAgentDevExecutionMode = isAgentDevMode(effectiveExecutionMode);
    const effectiveSkillsEnabled = settings.skills.enabled && effectiveIsAgentMode;
    const hasRemoteGatewayTarget =
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() !== "" &&
      settings.remote.token.trim() !== "";
    const mirrorsLocalRunToGateway = !gatewayBridgeRequest && hasRemoteGatewayTarget;
    const gatewayBridgeRequestId =
      gatewayBridgeRequest?.requestId ?? createLocalGatewayChatRunId(conversationId);
    const gatewayBridgeWorkerId =
      gatewayBridgeRequest?.workerId ?? (mirrorsLocalRunToGateway ? "gui-live" : undefined);
    const gatewayBridgeEvents = createGatewayBridgeEventController({
      conversationId,
      requestId: gatewayBridgeRequestId,
      workerId: gatewayBridgeWorkerId,
      enabled: Boolean(gatewayBridgeRequest) || hasRemoteGatewayTarget,
      sendEvent: (requestId, event, options) => {
        const result = queueGatewayBridgeEventForRequest(requestId, event, options);
        void queueGatewayRuntimeSnapshot(conversationId);
        return result;
      },
      resolveErrorConversationId: () =>
        gatewayBridgeRequest?.conversationId ?? currentConversationIdRef.current,
    });
    const updateGatewayBridgeToolStatus = (status: string | null, isCompaction = false) => {
      gatewayBridgeEvents.queueToolStatus(status, isCompaction);
      updateToolStatus(status, transcriptStore);
      const run = activeGatewayRuntimeRunsRef.current.get(conversationId);
      if (run) {
        run.toolStatusIsCompaction = Boolean(status?.trim()) && isCompaction;
      }
      void queueGatewayRuntimeSnapshot(conversationId);
    };
    const setConversationErrorState = (message: string | null) => {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: message,
      }));
    };
    if (!runtimeEntry) {
      const message = `Conversation runtime not found: ${conversationId}`;
      gatewayBridgeEvents.emitError(message, conversationId);
      throw new Error(message);
    }
    if (runtimeEntry.isSending) {
      if (gatewayBridgeRequest) {
        const message = "Conversation is already sending.";
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
      }
      return false;
    }
    if (isImportingPastedTextRef.current && typeof overrides?.textOverride !== "string") {
      return false;
    }
    if (hydratingConversationIdRef.current === conversationId) {
      const message = "当前会话仍在补全完整历史，请稍候。";
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message, conversationId);
      return false;
    }
    if (hydrationFailedConversationIdRef.current === conversationId) {
      const message = "当前会话完整历史加载失败，请重新打开该会话后再继续。";
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message, conversationId);
      return false;
    }
    if (runtimeEntry.compactionStatus.phase !== "idle") {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        compactionStatus: { phase: "idle" },
      }));
    }

    let effectiveSelectedModel: EffectiveChatModelSelection;
    try {
      effectiveSelectedModel = resolveEffectiveChatModelSelection({
        settings,
        conversationSelectedModel:
          conversationRuntimeCacheRef.current.get(conversationId)?.selectedModel,
        gatewaySelectedModel: gatewayBridgeRequest?.selectedModelOverride,
      });
    } catch (error) {
      const message = asErrorMessage(error, "当前模型配置不可用，请重新选择后重试。");
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message);
      return false;
    }

    const { selectedModel, provider, providerId, model } = effectiveSelectedModel;
    updateConversationRuntimeEntry(conversationId, (prev) =>
      selectedModelsMatch(prev.selectedModel, selectedModel) ? prev : { ...prev, selectedModel },
    );
    const runtimeControls =
      gatewayBridgeRequest?.runtimeControlsOverride ??
      overrides?.runtimeControlsOverride ??
      settings.chatRuntimeControls;
    const providerConfig = buildProviderRuntimeConfig(provider, model, runtimeControls);
    const memorySummaryModelSelection = resolveMemorySummaryModelSelection(settings);
    const memoryExtractionModel = memorySummaryModelSelection
      ? {
          providerId: memorySummaryModelSelection.providerId,
          model: memorySummaryModelSelection.model,
          runtime: buildProviderRuntimeConfig(
            memorySummaryModelSelection.provider,
            memorySummaryModelSelection.model,
            runtimeControls,
          ),
          selectedModel: memorySummaryModelSelection.selectedModel,
        }
      : undefined;
    const handleMemoryExtractionModelFailure = memoryExtractionModel
      ? (failedModel: { selectedModel?: SelectedModel }) => {
          const failedSelectedModel = failedModel.selectedModel;
          setSettings((prev) => {
            if (!selectedModelsMatch(prev.memory.summaryModel, failedSelectedModel)) {
              return prev;
            }
            return updateMemorySettings(prev, { summaryModel: undefined });
          });
        }
      : undefined;
    const memoryExtractionStatusText = (
      key: MemoryExtractionStatusKey,
      counts: { accepted: number; rejected: number },
    ) =>
      t(`chat.memoryExtraction.${key}`)
        .replace("{accepted}", String(counts.accepted))
        .replace("{rejected}", String(counts.rejected));
    const runtimeModel = createModelFromConfig(
      providerId,
      model,
      provider.baseUrl.trim(),
      provider.requestFormat,
      providerConfig.modelConfig,
    );

    const textOverride =
      typeof overrides?.textOverride === "string" ? overrides.textOverride : null;
    const hasTextOverride = textOverride !== null;
    const composerDraft = hasTextOverride
      ? null
      : (overrides?.composerDraftOverride ?? composerRef.current?.getDraft() ?? null);
    let text = hasTextOverride
      ? textOverride.trim()
      : composerDraft
        ? (effectiveIsAgentMode && composerDraft.largePastes.length > 0
            ? composerDraft.textWithoutLargePastes
            : buildTextFromComposerDraft(composerDraft)
          ).trim()
        : "";
    let uploadedFiles = overrides?.uploadedFilesOverride ?? pendingUploadedFiles;

    if (
      effectiveIsAgentMode &&
      composerDraft &&
      composerDraft.largePastes.length > 0 &&
      !hasTextOverride
    ) {
      isImportingPastedTextRef.current = true;
      setIsImportingPastedText(true);
      try {
        const imported = await importPastedTextsAsFiles(
          effectiveWorkdir,
          composerDraft.largePastes,
        );
        text = buildTextFromComposerDraft(composerDraft, imported.fileByPasteId).trim();
        uploadedFiles = mergePendingUploadedFiles(uploadedFiles, imported.files);
      } catch (error) {
        const message = asErrorMessage(error, "大段粘贴内容导入工作区失败");
        setConversationErrorState(message);
        setErrorMessage(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
        return false;
      } finally {
        isImportingPastedTextRef.current = false;
        setIsImportingPastedText(false);
      }
    }

    const userMessage = createUserMessageWithUploads(text, uploadedFiles, Date.now());
    if (!userMessage) {
      if (gatewayBridgeRequest) {
        const message = "Message is required.";
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
      }
      return false;
    }
    const pendingUserMessage = userMessage;
    const content =
      typeof pendingUserMessage.content === "string" ? pendingUserMessage.content : "";

    const titleSourceText = text || uploadedFiles.map((file) => file.fileName).join(", ");

    const sessionId = runtimeEntry.sessionId;
    const createdAt = runtimeEntry.createdAt;
    const conversationCwd = effectiveWorkdir || undefined;
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      workdir: conversationCwd,
    }));
    const transcriptStore = getConversationLiveTranscriptStore(conversationId);
    const compaction = getCompactionController(conversationId);
    const isConversationVisible = () => currentConversationIdRef.current === conversationId;
    // 轮次级取消：会话 abort controller 只注册 userStop 一次；每个 LLM 请求
    // （主请求/压缩摘要/标题任务）各自派生子 scope，杜绝 abort 换代丢停止的窗口。
    const cancellation = createTurnCancellation();
    const conversationDebugLogger = createStreamDebugLogger({
      enabled: effectiveIsAgentDevExecutionMode,
      conversationId,
      executionMode: effectiveExecutionMode,
      streamKind: "conversation",
      providerId,
      model,
    });
    const recoveryDebugLogger = createStreamDebugLogger({
      enabled: effectiveIsAgentDevExecutionMode,
      conversationId,
      executionMode: effectiveExecutionMode,
      streamKind: "conversation_recovery",
      providerId,
      model,
    });
    const compactionDebugLogger = createStreamDebugLogger({
      enabled: effectiveIsAgentDevExecutionMode,
      conversationId,
      executionMode: effectiveExecutionMode,
      streamKind: "conversation_compaction",
      providerId,
      model,
    });
    const baseConversationState = runtimeEntry.state;
    const isFirstTurn = baseConversationState.meta.totalMessageCount === 0;
    const existingHistoryItem =
      sidebarStore.peek(conversationId) ??
      gatewayBridgeHistorySummaryRef.current.get(conversationId);
    // Branched conversations start with the placeholder title; the first
    // prompt sent inside the branch regenerates it like a first turn would.
    const isBranchDefaultTitle =
      !!existingHistoryItem &&
      !existingHistoryItem.isPending &&
      existingHistoryItem.title.trim() === BRANCH_CONVERSATION_DEFAULT_TITLE;
    const shouldCreatePendingHistoryItem = isFirstTurn && !existingHistoryItem;
    const pendingConversationTitle = t("chat.pendingTitle");
    const fallbackTitle =
      existingHistoryItem &&
      (!existingHistoryItem.isPending || existingHistoryItem.title !== pendingConversationTitle)
        ? existingHistoryItem.title
        : buildFallbackConversationTitle(
            getFirstUserMessageText(buildRequestContext(baseConversationState)) || titleSourceText,
          );

    let titlePromise: Promise<string | null> | null = null;
    if (isFirstTurn || isBranchDefaultTitle) {
      const titleModelSelection = resolveConversationTitleModelSelection(
        settings,
        effectiveSelectedModel,
      );
      const titleProviderConfig = buildProviderRuntimeConfig(
        titleModelSelection.provider,
        titleModelSelection.model,
        runtimeControls,
      );
      titlePromise = startConversationTitleJob({
        providerId: titleModelSelection.providerId,
        model: titleModelSelection.model,
        runtime: {
          baseUrl: titleProviderConfig.baseUrl,
          apiKey: titleProviderConfig.apiKey,
          requestFormat: titleProviderConfig.requestFormat,
          reasoning: titleProviderConfig.reasoning,
          promptCachingEnabled: titleProviderConfig.promptCachingEnabled,
          nativeWebSearchEnabled: titleProviderConfig.nativeWebSearchEnabled,
          useSystemProxy: titleProviderConfig.useSystemProxy,
          modelConfig: titleProviderConfig.modelConfig,
        },
        signal: cancellation.deriveScope().controller.signal,
        conversationId,
        titleSourceText,
        content,
        sidebarStore,
        titleJobRef,
        gatewayBridgeEvents,
      });
    }

    if (shouldCreatePendingHistoryItem) {
      sidebarStore.upsertLocal(
        createPendingHistoryItem({
          conversationId,
          title: pendingConversationTitle,
          providerId,
          model,
          sessionId,
          cwd: conversationCwd,
          createdAt,
        }),
      );
    }

    clearAbortSnapshot(transcriptStore);

    let nextConversationState = appendMessagesToConversation(baseConversationState, [
      pendingUserMessage,
    ]);
    let conversationRunStarted = false;
    let gatewayRunStarted = false;
    function acknowledgeGatewayRunStarted() {
      if (gatewayRunStarted) {
        return;
      }
      gatewayRunStarted = true;
      if (gatewayBridgeRequest || hasRemoteGatewayTarget) {
        const run = registerActiveGatewayRuntimeRun({
          conversationId,
          runId: gatewayBridgeRequestId,
          clientRequestId: gatewayBridgeRequest?.clientRequestId,
          workerId: gatewayBridgeWorkerId,
          cwd: conversationCwd,
          revision: 0,
          state: "running",
          userMessage: pendingUserMessage,
          transcriptStore,
          toolStatusIsCompaction: false,
        });
        void queueGatewayRuntimeSnapshotForRun(run, { state: "running", force: true });
      }
    }
    function markConversationRunStarted() {
      if (conversationRunStarted) {
        return;
      }
      conversationRunStarted = true;
      applyConversationState(nextConversationState);
      resetLiveTranscript(transcriptStore);
      setConversationAbortController(conversationId, cancellation.userStop);
      setConversationSendingState(conversationId, true);
      // Queue-drained auto-starts are not a user gesture: the reader may be
      // deep in history when the previous run finishes, and force-pinning
      // for the next queued turn would yank them to the bottom. Manual sends
      // still pin (here and via resetVisibleTransientState below).
      if (isConversationVisible() && !overrides?.preserveComposerOnStart) {
        scrollFollowRef.current?.stickToBottom();
      }
    }
    function markConversationRunStopped(state: GatewayRuntimeSnapshotState = "completed") {
      if (!conversationRunStarted) {
        return;
      }
      setConversationAbortController(conversationId, null);
      setConversationSendingState(conversationId, false);
      if (gatewayRunStarted) {
        finishActiveGatewayRuntimeRun(conversationId, state);
      }
    }
    let localGatewayRunStarted = false;
    async function markLocalGatewayRunStarted() {
      if (!mirrorsLocalRunToGateway || localGatewayRunStarted) {
        return;
      }
      await invoke("gateway_chat_mark_local_started", {
        request_id: gatewayBridgeRequestId,
        conversation_id: conversationId,
      } as any);
      localGatewayRunStarted = true;
    }

    markConversationRunStarted();
    // Clear the composer in the same beat as the optimistic user bubble.
    // Everything below until the runtime turn starts (gateway mark-started
    // IPC, initial history persist, skills refresh, memory overview read) may
    // await for seconds; the input box must not keep the sent text visible in
    // the meantime. Early-failure paths below restore the cleared draft.
    let composerClearedOnStart = false;
    let clearedComposerDraft: MentionComposerDraft | null = null;
    let clearedPendingUploads: PendingUploadedFile[] = [];
    if (!hasTextOverride && !overrides?.composerDraftOverride) {
      clearCachedComposerDraft(conversationId);
    }
    if (!overrides?.preserveComposerOnStart) {
      if (isConversationVisible()) {
        composerClearedOnStart = true;
        const liveDraft = composerDraft ?? composerRef.current?.getDraft() ?? null;
        clearedComposerDraft = liveDraft && !liveDraft.isEmpty ? liveDraft : null;
        clearedPendingUploads = pendingUploadedFiles;
      }
      resetVisibleTransientState(conversationId);
    } else {
      setConversationErrorState(null);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        hookWarning: null,
      }));
    }
    const restoreComposerOnStartFailure = () => {
      if (!composerClearedOnStart) {
        return;
      }
      if (isConversationVisible()) {
        if (clearedComposerDraft && composerRef.current && !composerRef.current.hasContent()) {
          composerRef.current.setDraft(clearedComposerDraft);
        }
      } else if (clearedComposerDraft && !composerDraftCacheRef.current.has(conversationId)) {
        composerDraftCacheRef.current.set(conversationId, clearedComposerDraft);
      }
      if (
        clearedPendingUploads.length > 0 &&
        getPendingUploadsForConversation(conversationId).length === 0
      ) {
        setPendingUploadsForConversation(conversationId, clearedPendingUploads);
      }
    };
    if (mirrorsLocalRunToGateway) {
      try {
        await markLocalGatewayRunStarted();
      } catch (error) {
        console.warn("gateway_chat_mark_local_started failed", error);
      }
    }
    if (overrides?.beforeRuntimeStart) {
      try {
        await overrides.beforeRuntimeStart();
      } catch (error) {
        const message = asErrorMessage(error, "启动远程对话运行失败");
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
        markConversationRunStopped("failed");
        restoreComposerOnStartFailure();
        return false;
      }
    }

    // Persist the user turn immediately so WebUI/GUI sidebars can surface the
    // latest conversation before the assistant round finishes. The live runtime
    // itself is mirrored through ChatRuntimeSnapshot, not history_sync.
    const initialPersist = persistConversationWithHistorySync({
      conversationId,
      sessionId,
      providerId,
      model,
      selectedModel,
      cwd: conversationCwd,
      state: nextConversationState,
      fallbackTitle,
      createdAt,
      titlePromise,
      titleLookahead: true,
    });
    if (overrides?.afterInitialHistoryPersist && !overrides.beforeRuntimeStart) {
      const persisted = await initialPersist;
      if (!persisted) {
        const message = "历史记录保存失败，已取消回滚与重发。";
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
        markConversationRunStopped("failed");
        restoreComposerOnStartFailure();
        return true;
      }
      try {
        await overrides.afterInitialHistoryPersist();
      } catch (error) {
        const message = asErrorMessage(error, "回滚历史失败");
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
        markConversationRunStopped("failed");
        restoreComposerOnStartFailure();
        return true;
      }
    } else {
      const initialPersistConfirmation = initialPersist
        .then(async (persisted) => {
          if (!persisted) {
            console.warn(
              "initial conversation history persist did not complete before chat runtime",
            );
            return false;
          }
          if (overrides?.afterInitialHistoryPersist) {
            await overrides.afterInitialHistoryPersist();
          }
          return true;
        })
        .catch((error) => {
          console.warn("initial conversation history persist confirmation failed", error);
          return false;
        });
      void initialPersistConfirmation;
    }
    if (gatewayBridgeRequest || hasRemoteGatewayTarget) {
      const persisted = await initialPersist.catch((error) => {
        console.warn("initial conversation history persist before gateway stream failed", error);
        return false;
      });
      if (!persisted) {
        console.warn("gateway stream started before initial user turn was persisted");
      }
    }
    await gatewayBridgeEvents.queueUserMessage(text, uploadedFiles, {
      baseMessageRef: overrides?.editResendBaseMessageRef,
    });
    acknowledgeGatewayRunStarted();
    let skillsPrompt = "";
    let memoryPrompt = "";
    let skillsRootDirForTools = skillsRootDir;
    let skillAccessPolicyForTools: SkillAccessPolicy | undefined = effectiveSkillsEnabled
      ? {
          allowedSkillNames: [],
          allowedSkillBaseDirs: [],
          allowSkillInventory: false,
          allowSkillManagement: false,
          allowSkillMutation: true,
        }
      : undefined;

    function buildPreparedContext(
      state: ConversationViewState,
      tools?: Context["tools"],
      options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
    ): Context {
      return buildPreparedConversationContext({
        state,
        tools,
        activeAgentPrompt,
        skillsPrompt,
        memoryPrompt,
        includeAbortedMessages: options?.includeAbortedMessages,
        includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
      });
    }

    function buildResumeContext(
      state: ConversationViewState,
      resumeMessage?: UserMessage,
      tools?: Context["tools"],
      options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
    ): Context {
      return buildResumeConversationContext({
        state,
        resumeMessage,
        tools,
        activeAgentPrompt,
        skillsPrompt,
        memoryPrompt,
        includeAbortedMessages: options?.includeAbortedMessages,
        includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
      });
    }

    compaction.bindTurn({
      providerId,
      model,
      runtime: {
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        requestFormat: providerConfig.requestFormat,
        reasoning: providerConfig.reasoning,
        promptCachingEnabled: providerConfig.promptCachingEnabled,
        nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
        useSystemProxy: providerConfig.useSystemProxy,
        modelConfig: providerConfig.modelConfig,
      },
      cancellation,
      debugLogger: compactionDebugLogger,
      buildPreparedContext,
      buildResumeContext,
      presend: {
        baseState: baseConversationState,
        pendingUserText: content,
        composerText: content,
        uploadedFiles,
        composeAppliedState: (state) => appendMessagesToConversation(state, [pendingUserMessage]),
      },
      sinks: {
        applyState: applyConversationState,
        applyStateMidRun: rebaseConversationStateDuringRun,
        publishStatus: (status) =>
          updateConversationRuntimeEntry(conversationId, (prev) => ({
            ...prev,
            compactionStatus: status,
          })),
        setBridgeToolStatus: updateGatewayBridgeToolStatus,
        queueCheckpoint: (state) => gatewayBridgeEvents.queueCheckpoint(state),
        persist: (state) =>
          persistConversation({
            conversationId,
            sessionId,
            providerId,
            model,
            selectedModel,
            cwd: conversationCwd,
            state,
            fallbackTitle,
            createdAt,
            titlePromise,
          }),
        restoreComposer: (composerText, restoredUploads) => {
          if (isConversationVisible() && typeof composerText === "string") {
            composerRef.current?.setText(composerText);
            composerRef.current?.focus();
          }
          setPendingUploadsForConversation(conversationId, restoredUploads);
        },
        persistRollback: async (state) => {
          abortedConversationCommitted = true;
          await persistConversationWithHistorySync({
            conversationId,
            sessionId,
            providerId,
            model,
            selectedModel,
            cwd: conversationCwd,
            state,
            fallbackTitle,
            createdAt,
            titlePromise,
          });
        },
      },
    });

    // Optionally append skills metadata to system prompt (progressive disclosure).
    if (effectiveSkillsEnabled && selectedSkillNames.length > 0) {
      // In case the user sends quickly after startup (availableSkills not loaded yet),
      // do a best-effort refresh before failing.
      let skillsList = availableSkills;
      let rootDir = skillsRootDir;
      let byName = new Map(skillsList.map((s) => [s.name, s]));
      let missing = selectedSkillNames.filter((n) => !byName.has(n));
      if (missing.length > 0) {
        const fresh = await refreshSkills();
        if (fresh) {
          skillsList = fresh.skills;
          rootDir = fresh.rootDir;
          byName = new Map(skillsList.map((s) => [s.name, s]));
          missing = selectedSkillNames.filter((n) => !byName.has(n));
        }
      }

      if (missing.length > 0) {
        const message = `找不到以下 Skills：${missing.join(", ")}（请先重新扫描固定 Skills 目录）`;
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
        markConversationRunStopped("failed");
        restoreComposerOnStartFailure();
        return true;
      }

      const selectedSkills = selectedSkillNames.map((n) => byName.get(n)!).filter(Boolean);
      const allowBuiltinSkillManagement = selectedSkills.some(
        (skill) => skill.name === "skills-creator" || skill.name === "skills-installer",
      );

      // IMPORTANT: Claude Code-style skills are progressive disclosure.
      // We only provide metadata in the system prompt. The model decides whether to read the skill file.
      skillsRootDirForTools = rootDir;
      skillAccessPolicyForTools = {
        allowedSkillNames: selectedSkills.map((skill) => skill.name),
        allowedSkillBaseDirs: selectedSkills.map((skill) => skill.baseDir),
        protectedSkillNames: selectedSkills
          .filter((skill) => skill.builtIn === true)
          .map((skill) => skill.name),
        protectedSkillBaseDirs: selectedSkills
          .filter((skill) => skill.builtIn === true)
          .map((skill) => skill.baseDir),
        allowSkillInventory: true,
        allowSkillManagement: allowBuiltinSkillManagement,
        allowSkillMutation: true,
      };
      const explicitSkills = resolveExplicitSkillMentions({
        text,
        structured: composerDraft?.skillMentions ?? [],
        enabledSkills: selectedSkills,
      });
      skillsPrompt = buildSkillsSystemPrompt({
        rootDir,
        selected: selectedSkills,
        explicit: explicitSkills,
      });
    }

    try {
      memoryPrompt = await buildMemoryOverviewSection(effectiveWorkdir);
    } catch (error) {
      console.warn("Failed to build memory overview prompt", error);
      memoryPrompt = "";
    }

    const hookScope = createHookRunScope({
      hooks: getAutomationState().hooks.hooks,
      conversationId,
      workdir: effectiveWorkdir,
      onWarning: (warning) => {
        updateConversationRuntimeEntry(conversationId, (prev) => ({
          ...prev,
          hookWarning: formatHookWarningMessage(settings.locale, t, warning),
        }));
      },
    });

    const hookLifecycle = createConversationHookLifecycle((event) => {
      hookScope.dispatch(event);
    });

    let abortedConversationCommitted = false;
    let persistableAgentProgress: {
      completedThroughRound: number;
      suppressedToolTrace: SuppressedToolTraceSnapshot[];
    } = {
      completedThroughRound: 0,
      suppressedToolTrace: [],
    };
    const commitVisibleAbortedConversation = () => {
      if (abortedConversationCommitted) return true;

      const snapshot = getAbortSnapshot(transcriptStore);
      const partialMessages = buildPersistableMessagesFromSnapshot({
        executionMode: effectiveExecutionMode,
        model: runtimeModel,
        draftAssistantText: snapshot.draftAssistantText,
        liveRounds: snapshot.liveRounds,
        completedThroughRound: persistableAgentProgress.completedThroughRound,
        suppressedToolTrace: persistableAgentProgress.suppressedToolTrace,
      });

      if (partialMessages.length === 0) return false;

      const finalState = appendMessagesToConversation(nextConversationState, partialMessages);
      abortedConversationCommitted = true;
      resetLiveTranscript(transcriptStore);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state: finalState,
      }));
      void persistConversationWithHistorySync({
        conversationId,
        sessionId,
        providerId,
        model,
        selectedModel,
        cwd: conversationCwd,
        state: finalState,
        fallbackTitle,
        createdAt,
        titlePromise,
      });
      return true;
    };

    const commitErroredConversation = (rawMessage: string) => {
      const snapshot = getAbortSnapshot(transcriptStore);
      const partialMessages = buildPersistableMessagesFromSnapshot({
        executionMode: effectiveExecutionMode,
        model: runtimeModel,
        draftAssistantText: snapshot.draftAssistantText,
        liveRounds: snapshot.liveRounds,
        completedThroughRound: persistableAgentProgress.completedThroughRound,
        suppressedToolTrace: persistableAgentProgress.suppressedToolTrace,
      });
      const errorAssistant = buildErrorAssistantMessage({
        model: runtimeModel,
        errorMessage: rawMessage,
        timestamp: Date.now() + partialMessages.length,
      });
      const finalState = appendMessagesToConversation(nextConversationState, [
        ...partialMessages,
        errorAssistant,
      ]);
      abortedConversationCommitted = true;
      resetLiveTranscript(transcriptStore);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state: finalState,
        errorMessage: null,
      }));
      void persistConversationWithHistorySync({
        conversationId,
        sessionId,
        providerId,
        model,
        selectedModel,
        cwd: conversationCwd,
        state: finalState,
        fallbackTitle,
        createdAt,
        titlePromise,
      });
    };

    function applyConversationState(nextState: ConversationViewState) {
      nextConversationState = nextState;
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state: nextState,
      }));
    }

    function rebaseConversationStateDuringRun(nextState: ConversationViewState) {
      // Once a compaction/prune result is committed into visible history, the
      // corresponding live transcript becomes stale and must be cleared.
      applyConversationState(nextState);
      resetLiveTranscript(transcriptStore);
    }

    let gatewayRuntimeFinalState: GatewayRuntimeSnapshotState = "completed";
    try {
      if (effectiveIsAgentMode) {
        await chatRuntimeHost.runTurn({
          mode: "agent",
          params: {
            providerId,
            model,
            runtime: {
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              requestFormat: providerConfig.requestFormat,
              reasoning: providerConfig.reasoning,
              promptCachingEnabled: providerConfig.promptCachingEnabled,
              nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
              useSystemProxy: providerConfig.useSystemProxy,
              modelConfig: providerConfig.modelConfig,
            },
            runtimeModel,
            selectedModel,
            memoryExtractionModel,
            onMemoryExtractionModelFailure: handleMemoryExtractionModelFailure,
            memoryExtractionStatusText,
            effectiveWorkdir,
            effectiveSkillsEnabled,
            showSilentMemoryExtraction: effectiveIsAgentDevExecutionMode,
            skillsRootDir: skillsRootDirForTools,
            skillAccessPolicy: skillAccessPolicyForTools,
            onManagedSkillsChanged: (change) => {
              enableManagedSkills(change.names);
            },
            agentTemplates: settings.agents,
            selectedSystemToolIds: effectiveSelectedSystemToolIds,
            getMcpSettings,
            applyMcpOps: (ops) => {
              setSettings((prev) => applyMcpOpsToAppSettings(prev, ops));
            },
            remoteWebTunnelsEnabled: settings.remote.enableWebTunnels,
            tunnelPublicBaseUrl: settings.remote.gatewayUrl.trim(),
            sshHosts: settings.ssh.hosts,
            associatedSshHostIds: effectiveAssociatedSshHostIds,
            sshManagerRemoteAllowed:
              !gatewayBridgeRequest || settings.remote.enableWebSshTerminal === true,
            onSshSessionsChanged: (change) => {
              if (change.action === "create") {
                ensureSshTunnelToolTab(change.projectPathKey);
              }
            },
            onTunnelsChanged: (change) => {
              if (change.action === "create") {
                ensureTunnelToolTab(change.projectPathKey);
              }
            },
            sessionId,
            conversationId,
            conversationCwd,
            fallbackTitle,
            createdAt,
            titlePromise,
            transcriptStore,
            gatewayBridgeEvents,
            hookLifecycle,
            conversationDebugLogger,
            subagentStore: subagentStoresRef.current.get(conversationId),
            getNextConversationState: () => nextConversationState,
            applyConversationState,
            buildPreparedContext,
            compaction,
            cancellation,
            resetLiveTranscript,
            batchLiveRoundsUpdate,
            updateToolStatus,
            updatePersistableAgentProgress: (progress) => {
              persistableAgentProgress = progress;
            },
            commitVisibleAbortedConversation,
            updateConversationRuntimeEntry,
            persistConversationWithHistorySync,
          },
        });
      } else {
        await chatRuntimeHost.runTurn({
          mode: "text",
          params: {
            providerId,
            model,
            runtime: {
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              requestFormat: providerConfig.requestFormat,
              reasoning: providerConfig.reasoning,
              promptCachingEnabled: providerConfig.promptCachingEnabled,
              nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
              useSystemProxy: providerConfig.useSystemProxy,
              modelConfig: providerConfig.modelConfig,
            },
            runtimeModel,
            selectedModel,
            memoryExtractionModel,
            onMemoryExtractionModelFailure: handleMemoryExtractionModelFailure,
            memoryExtractionStatusText,
            sessionId,
            conversationId,
            conversationCwd,
            fallbackTitle,
            createdAt,
            titlePromise,
            transcriptStore,
            gatewayBridgeEvents,
            hookLifecycle,
            conversationDebugLogger,
            recoveryDebugLogger,
            getNextConversationState: () => nextConversationState,
            applyConversationState,
            buildPreparedContext,
            compaction,
            cancellation,
            resetLiveTranscript,
            appendDraftAssistantText,
            batchLiveRoundsUpdate,
            updateGatewayBridgeToolStatus,
            commitVisibleAbortedConversation,
            updateConversationRuntimeEntry,
            persistConversationWithHistorySync,
          },
        });
      }
    } catch (err) {
      const aborted = cancellation.userStop.signal.aborted || isAbortLikeError(err);
      gatewayRuntimeFinalState = aborted ? "cancelled" : "failed";
      const remoteErrorMessage = aborted
        ? "Cancelled"
        : (err instanceof Error ? err.message : String(err)) || "Request failed";
      gatewayBridgeEvents.emitError(remoteErrorMessage, conversationId);
      gatewayBridgeEvents.close();
      if (aborted) {
        hookScope.cancel();
        const rolledBack = await compaction.handleTurnAbort();
        if (!rolledBack) {
          commitVisibleAbortedConversation();
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        commitErroredConversation(msg || "Request failed");
      }
      if (shouldCreatePendingHistoryItem && !abortedConversationCommitted) {
        sidebarStore.removeLocal(conversationId);
      }
      if (titleJobRef.current?.conversationId === conversationId) {
        titleJobRef.current = null;
      }
    } finally {
      compaction.unbindTurn();
      hookLifecycle.endAgent();
      hookScope.close();
      clearAbortSnapshot(transcriptStore);
      markConversationRunStopped(gatewayRuntimeFinalState);
      pruneIdleConversationCaches([conversationId]);
      requestQueuedChatTurnProcessing(conversationId);
    }
    return true;
  }

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

  const setSharedHistoryItemsState = useCallback((items: ChatHistorySummary[]) => {
    const nextItems = sortSidebarConversations(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  // Called by the sidebar container after the store confirmed a deletion:
  // evict local caches, replace the visible conversation when it was the
  // deleted one, and drop the row from the shared-history list.
  const handleConversationDeleted = useCallback(
    (id: string) => {
      cleanupDeletedConversationActionRef.current(id);
      setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
    },
    [setSharedHistoryItemsState],
  );

  const updateSharedManagerIdSet = useCallback(
    (
      setter: (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
      id: string,
      enabled: boolean,
    ) => {
      setter((current) => {
        const next = new Set(current);
        if (enabled) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    },
    [],
  );

  const setSharedManagerError = useCallback((id: string, message: string | null) => {
    setSharedManagerErrors((current) => {
      const next = { ...current };
      if (message) {
        next[id] = message;
      } else {
        delete next[id];
      }
      return next;
    });
  }, []);

  const refreshSharedHistoryItems = useCallback(async () => {
    if (sharedHistoryListRequestRef.current) {
      return sharedHistoryListRequestRef.current;
    }

    const request = (async () => {
      const byId = new Map<string, ChatHistorySummary>();
      let totalCount = 0;
      for (let pageNumber = 1; ; pageNumber += 1) {
        const page = await listSharedChatHistory(pageNumber, SHARED_HISTORY_LIST_PAGE_SIZE);
        totalCount = Math.max(0, page.totalCount);
        for (const item of page.items) {
          byId.set(item.id, { ...item, isShared: true });
        }
        if (page.items.length === 0 || byId.size >= totalCount) {
          break;
        }
      }

      const nextItems = Array.from(byId.values());
      setSharedHistoryItemsState(nextItems);
      return sortSidebarConversations(nextItems);
    })();

    sharedHistoryListRequestRef.current = request;
    try {
      return await request;
    } catch (error) {
      setErrorMessage(asErrorMessage(error, "读取已分享历史列表失败"));
      return sharedHistoryItemsRef.current;
    } finally {
      if (sharedHistoryListRequestRef.current === request) {
        sharedHistoryListRequestRef.current = null;
      }
    }
  }, [setSharedHistoryItemsState]);

  useEffect(() => {
    void refreshSharedHistoryItems();
  }, [refreshSharedHistoryItems]);

  const markSharedConversation = useCallback(
    (id: string, isShared: boolean, source?: ChatHistorySummary | null) => {
      const existing = sidebarStore.peek(id);
      if (existing && existing.isShared !== isShared) {
        sidebarStore.upsertLocal({ ...existing, isShared });
      }
      if (!isShared) {
        setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
        return;
      }

      const conversation =
        source ??
        sidebarStore.peek(id) ??
        sharedHistoryItemsRef.current.find((item) => item.id === id);
      if (!conversation) {
        return;
      }
      setSharedHistoryItemsState([
        { ...conversation, isShared: true },
        ...sharedHistoryItemsRef.current.filter((item) => item.id !== id),
      ]);
    },
    [setSharedHistoryItemsState, sidebarStore],
  );

  const handleLoadSharedHistoryStatus = useCallback(
    (conversation: ChatHistorySummary) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }
      setSharedManagerError(id, null);
      updateSharedManagerIdSet(setSharedManagerLoadingIds, id, true);
      void getChatHistoryShare(id)
        .then((status) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, conversation);
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "读取分享状态失败"));
        })
        .finally(() => {
          updateSharedManagerIdSet(setSharedManagerLoadingIds, id, false);
        });
    },
    [markSharedConversation, setSharedManagerError, updateSharedManagerIdSet],
  );

  const refreshSharedManagerGatewayUrl = useCallback(() => {
    setSharedManagerGatewayUrlLoading(true);
    void invoke<GatewayRuntimeStatus>("gateway_status")
      .then((status) => {
        setRemoteRuntimeStatus(status);
        setSharedManagerGatewayUrl(status.gatewayUrl?.trim() ?? "");
      })
      .catch(() => {
        setSharedManagerGatewayUrl("");
      })
      .finally(() => {
        setSharedManagerGatewayUrlLoading(false);
      });
  }, []);

  const handleOpenShareModal = useCallback(
    (conversation: ChatHistorySummary) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }

      setShareConversation(conversation);
      setShareStatus(null);
      setShareError(null);
      setShareLoading(false);
      setShareUpdating(false);
      setSharedManagerGatewayUrl(
        remoteRuntimeStatus.gatewayUrl?.trim() || settings.remote.gatewayUrl.trim(),
      );
      refreshSharedManagerGatewayUrl();

      if (!canShareHistory) {
        setShareError("Remote 尚未配置并连接成功，暂时不能分享会话。");
        return;
      }

      setShareLoading(true);
      void getChatHistoryShare(id)
        .then((status) => {
          setShareStatus(status);
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          setSharedManagerError(id, null);
          markSharedConversation(id, status.enabled === true, conversation);
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, "读取分享状态失败"));
        })
        .finally(() => {
          setShareLoading(false);
        });
    },
    [
      canShareHistory,
      markSharedConversation,
      refreshSharedManagerGatewayUrl,
      remoteRuntimeStatus.gatewayUrl,
      setSharedManagerError,
      settings.remote.gatewayUrl,
    ],
  );

  const handleCloseShareModal = useCallback(() => {
    setShareConversation(null);
    setShareStatus(null);
    setShareError(null);
    setShareLoading(false);
    setShareUpdating(false);
  }, []);

  const handleToggleHistoryShare = useCallback(
    (enabled: boolean, options?: { redactToolContent?: boolean }) => {
      const id = shareConversation?.id.trim() ?? "";
      if (!id) {
        return;
      }
      if (enabled && !canShareHistory) {
        setShareError("Remote 尚未配置并连接成功，暂时不能开启分享。");
        return;
      }

      setShareError(null);
      setSharedManagerError(id, null);
      setShareUpdating(true);
      if (enabled) {
        refreshSharedManagerGatewayUrl();
      }

      void setChatHistoryShare(id, enabled, options)
        .then((status) => {
          setShareStatus(status);
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, shareConversation);
          setShareConversation((current) =>
            current?.id === id ? { ...current, isShared: status.enabled === true } : current,
          );
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, enabled ? "开启分享失败" : "关闭分享失败"));
        })
        .finally(() => {
          setShareUpdating(false);
        });
    },
    [
      canShareHistory,
      markSharedConversation,
      refreshSharedManagerGatewayUrl,
      setSharedManagerError,
      shareConversation,
    ],
  );

  const handleSetShareRedactToolContent = useCallback(
    (redactToolContent: boolean) => {
      const id = shareConversation?.id.trim() ?? "";
      if (!id) {
        return;
      }

      setShareError(null);
      setSharedManagerError(id, null);
      setShareUpdating(true);

      void setChatHistoryShare(id, true, { redactToolContent })
        .then((status) => {
          setShareStatus(status);
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, shareConversation);
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, "更新分享脱敏设置失败"));
        })
        .finally(() => {
          setShareUpdating(false);
        });
    },
    [markSharedConversation, setSharedManagerError, shareConversation],
  );

  const handleRefreshSharedHistoryStatuses = useCallback(() => {
    refreshSharedManagerGatewayUrl();
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }, [handleLoadSharedHistoryStatus, refreshSharedHistoryItems, refreshSharedManagerGatewayUrl]);

  const handleOpenSharedHistoryManager = useCallback(() => {
    setSharedManagerGatewayUrl(settings.remote.gatewayUrl.trim());
    refreshSharedManagerGatewayUrl();
    setSharedManagerOpen(true);
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }, [
    handleLoadSharedHistoryStatus,
    refreshSharedHistoryItems,
    refreshSharedManagerGatewayUrl,
    settings.remote.gatewayUrl,
  ]);

  const handleDisableSharedHistory = useCallback(
    (conversation: ChatHistorySummary) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }
      setSharedManagerError(id, null);
      updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
      void setChatHistoryShare(id, false)
        .then((status) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, conversation);
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "关闭分享失败"));
        })
        .finally(() => {
          updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
        });
    },
    [markSharedConversation, setSharedManagerError, updateSharedManagerIdSet],
  );

  const handleSetSharedHistoryRedactToolContent = useCallback(
    (conversation: ChatHistorySummary, redactToolContent: boolean) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }

      setSharedManagerError(id, null);
      updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
      void setChatHistoryShare(id, true, { redactToolContent })
        .then((status) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, conversation);
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
    },
    [
      markSharedConversation,
      setSharedManagerError,
      shareConversation?.id,
      updateSharedManagerIdSet,
    ],
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

  const hasModels = modelOptions.length > 0;

  const currentModelLabel = (() => {
    if (!activeSelectedModel) return t("chat.selectModel");
    const opt = modelOptions.find((o) => o.value === selectedValue);
    if (opt) return `${opt.providerName} / ${opt.model}`;
    return activeSelectedModel.model;
  })();

  const currentModelContextWindow = (() => {
    if (!activeSelectedModel) return undefined;
    const provider = settings.customProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    if (!provider) return undefined;
    return findProviderModelConfig(provider, activeSelectedModel.model).contextWindow;
  })();
  const currentChatProvider = activeSelectedModel
    ? settings.customProviders.find((item) => item.id === activeSelectedModel.customProviderId)
    : undefined;
  const currentChatModelId = activeSelectedModel?.model;

  const handleSelectModel = useCallback(
    (selection: SelectedModel) => {
      const conversationId = currentConversationIdRef.current;
      updateConversationRuntimeEntry(conversationId, (prev) =>
        selectedModelsMatch(prev.selectedModel, selection)
          ? prev
          : { ...prev, selectedModel: selection },
      );
      const persistedRow = sidebarStore.peek(conversationId);
      const selectedModelJson = serializeSelectedModelJson(selection);
      if (persistedRow && !persistedRow.isPending && selectedModelJson) {
        void setChatHistoryModel(conversationId, selectedModelJson)
          .then((summary) => sidebarStore.upsertLocal({ ...summary, isPending: undefined }))
          .catch((error) => {
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              errorMessage: asErrorMessage(error, "保存会话模型选择失败。"),
            }));
          });
      }
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [currentConversationIdRef, setSettings, sidebarStore, updateConversationRuntimeEntry],
  );

  // 跨端收敛：history-sync 带回的会话模型选择（如 WebUI 发消息后落库）
  // 写回当前会话的 runtime entry；值相等或发送中不动，无回环。
  const displayedConversationPersistedModelJson =
    sidebarConversationsById.get(currentConversationId)?.selectedModelJson;
  useEffect(() => {
    const parsed = normalizeSelectedModelForProviders(
      parseSelectedModelJson(displayedConversationPersistedModelJson),
      settings.customProviders,
    );
    if (!parsed) return;
    const entry = conversationRuntimeCacheRef.current.get(currentConversationId);
    if (!entry || entry.isSending) return;
    if (selectedModelsMatch(entry.selectedModel, parsed)) return;
    updateConversationRuntimeEntry(currentConversationId, (prev) => ({
      ...prev,
      selectedModel: parsed,
    }));
  }, [
    conversationRuntimeCacheRef,
    currentConversationId,
    displayedConversationPersistedModelJson,
    settings.customProviders,
    updateConversationRuntimeEntry,
  ]);

  const currentChatModelConfig = useMemo(
    () =>
      currentChatProvider && currentChatModelId
        ? findProviderModelConfig(currentChatProvider, currentChatModelId)
        : undefined,
    [currentChatProvider, currentChatModelId],
  );
  const chatRuntimeReasoningParams = useMemo(
    () => ({
      providerId: currentChatProvider?.type,
      requestFormat: currentChatProvider?.requestFormat,
      modelId: currentChatModelId,
      baseUrl: currentChatProvider?.baseUrl,
      modelConfig: currentChatModelConfig,
    }),
    [
      currentChatModelConfig,
      currentChatModelId,
      currentChatProvider?.baseUrl,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
    ],
  );
  const chatRuntimeReasoningOptions = useMemo(
    () => getChatRuntimeReasoningLevelsForProvider(chatRuntimeReasoningParams),
    [chatRuntimeReasoningParams],
  );
  const chatRuntimeThinkingAlwaysOn = useMemo(
    () =>
      isThinkingAlwaysOnForModel(
        currentChatProvider?.type ?? "claude_code",
        currentChatModelId ?? "",
        currentChatProvider?.baseUrl ?? "",
        currentChatProvider?.requestFormat,
        currentChatModelConfig,
      ),
    [
      currentChatModelConfig,
      currentChatModelId,
      currentChatProvider?.baseUrl,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
    ],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(
        settings.chatRuntimeControls,
        chatRuntimeReasoningParams,
      ),
    [chatRuntimeReasoningParams, settings.chatRuntimeControls],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(
          prev.chatRuntimeControls,
          patch,
          chatRuntimeReasoningParams,
        ),
      }));
    },
    [chatRuntimeReasoningParams, setSettings],
  );
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

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsFileDropActive(true);
          return;
        }

        if (event.payload.type === "drop") {
          setIsFileDropActive(false);
          if (!canDropUpload) {
            setErrorMessage(fileDropTitle);
            return;
          }
          void importReadableFilePaths(event.payload.paths);
          return;
        }

        setIsFileDropActive(false);
      })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("failed to listen for Tauri file drop events", error);
      });

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [canDropUpload, fileDropTitle, importReadableFilePaths]);

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

  // Copies the conversation prefix up to (and including) the picked assistant
  // reply into a fresh "新分支" conversation, then switches to it. Defined
  // after the hydration flags above so the guard reads the same sources as
  // useEditResend.
  const branchInFlightRef = useRef(false);
  // 驱动被点行的转圈与全行禁用；ref 仍是同步防重入的真源。
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const handleBranchConversation = useCallback(
    async (messageRef: HistoryMessageRef) => {
      const conversationId = currentConversationIdRef.current.trim();
      if (!conversationId) return;
      if (isSending || isConversationHydrating || isConversationHydrationFailed) return;
      // 分支 invoke 会排在同会话 persist 写锁后面，期间按钮仍可点：
      // 用 ref 挡掉重复确认，避免一次点击风暴造出多份"新分支"。
      if (branchInFlightRef.current) return;
      branchInFlightRef.current = true;
      setBranchPendingMessageId(messageRef.messageId);
      try {
        const summary = await branchChatHistory(conversationId, messageRef);
        sidebarStore.upsertLocal({ ...summary, isPending: undefined });
        handleSelectConversation(summary.id);
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.branchFailed")));
      } finally {
        branchInFlightRef.current = false;
        setBranchPendingMessageId(null);
      }
    },
    [
      currentConversationIdRef,
      handleSelectConversation,
      isConversationHydrating,
      isConversationHydrationFailed,
      isSending,
      sidebarStore,
      t,
    ],
  );

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
                <div
                  className="file-drop-overlay pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4 sm:p-6 bg-white/30 backdrop-blur-md dark:bg-black/30"
                  aria-hidden="true"
                >
                  <div
                    className={`file-drop-overlay-zone absolute inset-3 sm:inset-4 rounded-2xl border border-dashed ${
                      canDropUpload
                        ? "border-foreground/20 bg-foreground/[0.015] dark:border-white/15 dark:bg-white/[0.015]"
                        : "border-destructive/35 bg-destructive/[0.03]"
                    }`}
                  />
                  <div
                    className={`file-drop-overlay-card relative flex w-full max-w-[380px] flex-col items-center gap-5 rounded-2xl border bg-white/70 px-8 py-7 text-center shadow-[0_24px_60px_-20px_rgba(0,0,0,0.25),0_8px_20px_-12px_rgba(0,0,0,0.15)] backdrop-blur-2xl dark:bg-zinc-900/70 dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7),0_8px_20px_-12px_rgba(0,0,0,0.5)] ${
                      canDropUpload
                        ? "border-black/[0.06] ring-1 ring-inset ring-white/40 dark:border-white/10 dark:ring-white/[0.04]"
                        : "border-destructive/20 ring-1 ring-inset ring-destructive/10 dark:border-destructive/30"
                    }`}
                  >
                    <div
                      className={`flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ring-inset ${
                        canDropUpload
                          ? "bg-foreground/[0.04] text-foreground/85 ring-foreground/10 dark:bg-white/[0.06] dark:text-white/90 dark:ring-white/10"
                          : "bg-destructive/[0.08] text-destructive/90 ring-destructive/15"
                      }`}
                    >
                      {canDropUpload ? (
                        <Upload className="h-6 w-6" strokeWidth={1.75} />
                      ) : (
                        <Ban className="h-6 w-6" strokeWidth={1.75} />
                      )}
                    </div>

                    <div className="flex flex-col items-center gap-1.5">
                      <div className="text-[calc(15px*var(--zone-font-scale,1))] font-semibold leading-tight tracking-tight text-foreground">
                        {fileDropTitle}
                      </div>
                      <div className="max-w-[280px] text-xs leading-5 text-muted-foreground">
                        {fileDropDescription}
                      </div>
                    </div>

                    <div
                      className="h-px w-12 bg-foreground/10 dark:bg-white/10"
                      aria-hidden="true"
                    />

                    <div
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium ${
                        canDropUpload
                          ? "border-foreground/[0.08] bg-foreground/[0.03] text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]"
                          : "border-destructive/20 bg-destructive/[0.05] text-destructive/80"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-flex h-1.5 w-1.5 rounded-full ${
                          canDropUpload ? "bg-foreground/35 dark:bg-white/50" : "bg-destructive/55"
                        }`}
                      />
                      {fileDropLimitHint}
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
        {workspaceEditorMounted ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 z-50 flex min-h-0 flex-col border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
                <MacOsTitleBarSpacer className="bg-muted/45" />
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  {t("workspaceEditor.loading")}
                </div>
              </div>
            }
          >
            <WorkspaceCodeEditorOverlay
              openRequest={workspaceEditorOpenRequest}
              closeRequestId={workspaceEditorCloseRequestId}
              isOpen={workspaceEditorOpen}
              finalCloseRequested={workspaceEditorCleanupPending}
              theme={effectiveTheme}
              onPreviewFile={(request) => openWorkspaceFilePreview(request)}
              onInsertCodeMention={handleInsertCodeMention}
              onHide={() => setWorkspaceEditorOpen(false)}
              onClose={() => {
                setWorkspaceEditorOpen(false);
                setWorkspaceEditorMounted(false);
                setWorkspaceEditorCleanupPending(false);
                setWorkspaceEditorOpenRequest(null);
                setWorkspaceEditorCloseRequestId(0);
              }}
            />
          </Suspense>
        ) : null}
        {workspaceFilePreviewMounted ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 z-50 flex min-h-0 flex-col border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
                <MacOsTitleBarSpacer className="bg-muted/45" />
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  {t("workspaceFilePreview.loading")}
                </div>
              </div>
            }
          >
            <WorkspaceFilePreviewOverlay
              openRequest={workspaceFilePreviewOpenRequest}
              isOpen={workspaceFilePreviewOpen}
              onOpenEditor={(request) => openWorkspaceEditorFile(request)}
              onRequestClose={requestWorkspaceFilePreviewClose}
              onClose={handleWorkspaceFilePreviewClosed}
            />
          </Suspense>
        ) : null}
        {workspaceSshTerminalMounted ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 z-50 flex min-h-0 flex-col border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
                <MacOsTitleBarSpacer className="bg-muted/45" />
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  {t("workspaceSshTerminal.loading")}
                </div>
              </div>
            }
          >
            <WorkspaceSshTerminalOverlay
              openRequest={workspaceSshTerminalOpenRequest}
              projectPathKey={terminalProjectPathKey}
              sessions={terminalSessions}
              client={tauriTerminalClient}
              sftpClient={tauriSftpClient}
              theme={effectiveTheme}
              isOpen={workspaceSshTerminalOpen}
              onHide={() => setWorkspaceSshTerminalOpen(false)}
            />
          </Suspense>
        ) : null}
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
        onInsertCodeReviewSkill={codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined}
        onInsertCommitMention={handleRightDockInsertCommitMention}
        onInsertGitFileMention={handleRightDockInsertGitFileMention}
      />
    </div>
  );
}
