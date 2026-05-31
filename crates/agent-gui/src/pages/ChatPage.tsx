import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MacOsTitleBarSpacer, MacOsTitleBarToggle } from "../components/MacOsTitleBarSpacer";
import { ChatHistorySidebar } from "../components/chat/ChatHistorySidebar";
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
import { Ban, PanelRightClose, PanelRightOpen, Upload } from "../components/icons";
import { ProjectToolsPanel } from "../components/project-tools/ProjectToolsPanel";
import { Button } from "../components/ui/button";
import { useLocale } from "../i18n";
import {
  type CompactionStatus,
  noteCompactionApplied,
  pruneConversationState,
  runMidTurnCompaction,
  runPreCompactConversation,
  shouldPreCompactConversation,
} from "../lib/chat/compaction/contextCompaction";
import { buildPersistableMessagesFromSnapshot } from "../lib/chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
  createConversationStateFromContext,
  type RenderTimelineItem,
} from "../lib/chat/conversation/conversationState";
import {
  createConversationHookLifecycle,
  createGatewayBridgeEventController,
} from "../lib/chat/conversation/run";
import {
  type ChatHistoryShareStatus,
  type ChatHistorySummary,
  type ChatHistoryWorkdirSummary,
  deleteChatHistory,
  getChatHistory,
  getChatHistoryShare,
  listChatHistory,
  listChatHistoryWorkdirs,
  listSharedChatHistory,
  setChatHistoryShare,
} from "../lib/chat/history/chatHistory";
import {
  CHAT_HISTORY_SYNC_EVENT,
  type ChatHistorySyncEvent,
} from "../lib/chat/history/chatHistorySync";
import { clearSilentMemoryDecisions } from "../lib/chat/memory/memoryDecisionLog";
import { clearMemoryExtractorState } from "../lib/chat/memory/memoryExtractor";
import { buildMemoryOverviewSection } from "../lib/chat/memory/memoryPrompt";
import {
  createUserMessageWithUploads,
  mergePendingUploadedFiles,
  type PendingUploadedFile,
  withPastedTextDisplayMetadata,
} from "../lib/chat/messages/uploadedFiles";
import {
  buildFallbackConversationTitle,
  buildModelOptions,
  createConversationIdentity,
  createPendingHistoryItem,
  getFirstUserMessageText,
  isAbortLikeError,
  mergeHistoryItem,
  PENDING_CONVERSATION_TITLE,
  sortHistoryItems,
} from "../lib/chat/page/chatPageHelpers";
import { createSubagentRuntimeManager } from "../lib/chat/subagent/subagentRuntimeManager";
import { createStreamDebugLogger } from "../lib/debug/agentDebug";
import { createConversationHookDispatcher } from "../lib/hooks/conversationHooks";
import { tauriGitClient } from "../lib/git/tauriGitClient";
import { createModelFromConfig, toModelValue } from "../lib/providers/llm";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type ExecutionMode,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getProjectToolsFileTreeProjectState,
  getProjectToolsPanelTabOrder,
  isAgentDevMode,
  isAgentExecutionMode,
  isProjectToolsFileTreeOpen,
  isProjectToolsGitReviewOpen,
  normalizeChatRuntimeControlsForProvider,
  type ProviderId,
  type SelectedModel,
  type SystemToolId,
  type WorkspaceProject,
  removeProjectToolsProjectState,
  DEFAULT_WORKSPACE_PROJECT_ID,
  resolveWorkspaceProjects,
  workspaceProjectPathKey,
  updateCustomSettings,
  updateProjectToolsFileTreeProjectState,
  updateProjectToolsFileTreeOpen,
  updateProjectToolsGitReviewOpen,
  updateProjectToolsPanelTabOrder,
  updateChatRuntimeControlsForProvider,
  updateMcp,
  updateMemorySettings,
  updateSkills,
} from "../lib/settings";
import {
  applyTerminalEventToSessions,
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "../lib/terminal/sessionStore";
import { tauriTerminalClient } from "../lib/terminal/tauriTerminalClient";
import type { TerminalSession } from "../lib/terminal/types";
import {
  applyWorkspaceProjectConversationActivityMap,
  buildWorkspaceProjectActivityUpdatedAts,
  fallbackWorkspaceProjectName,
  findWorkspaceProject,
  mergeWorkspaceProjectActivityUpdatedAts,
  mergeWorkspaceProjectsWithHistory,
  workspaceProjectActivityUpdatedAtsEqual,
} from "../lib/workspaceProjects";
import {
  buildSkillsSystemPrompt,
  mergeAlwaysEnabledSkillNames,
  resolveExplicitSkillMentions,
} from "../lib/skills";
import type { SkillAccessPolicy } from "../lib/tools/skillAccessPolicy";
import { ChatComposerBar } from "./chat/ChatComposerBar";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatTranscript } from "./chat/ChatTranscript";
import {
  buildErrorAssistantMessage,
  createConversationRuntimeEntry,
  formatHookWarningMessage,
  pruneIdleConversationRuntimeCaches,
  setConversationRuntimeCacheEntry,
} from "./chat/chatPageRuntime";
import { buildPreCompactionStatus } from "./chat/compactionStatusText";
import {
  buildCompactionContext,
  buildPreparedContext as buildPreparedConversationContext,
  buildResumeContext as buildResumeConversationContext,
} from "./chat/conversationContextBuilders";
import { startConversationTitleJob } from "./chat/conversationTitleJob";
import {
  type ActiveGatewayBridgeRequest,
  type EnsureGatewayBridgeConversationReadyOptions,
  type GatewaySelectedModelEvent,
  normalizeGatewayProviderType,
  type SendChatAction,
} from "./chat/gatewayBridgeTypes";
import { runAgentConversationTurn } from "./chat/runAgentConversationTurn";
import { runTextConversationTurn } from "./chat/runTextConversationTurn";
import { clearSilentMemoryExtractionState } from "./chat/silentMemoryExtraction";
import { useChatHistoryList } from "./chat/useChatHistoryList";
import { useChatPageRuntimeStore } from "./chat/useChatPageRuntimeStore";
import { useChatSkills } from "./chat/useChatSkills";
import { useConversationHistoryActions } from "./chat/useConversationHistoryActions";
import { useEditResend } from "./chat/useEditResend";
import { useGatewayBridgeBatcher } from "./chat/useGatewayBridgeBatcher";
import { useGatewayBridgeListeners } from "./chat/useGatewayBridgeListeners";
import { useLiveTranscriptController } from "./chat/useLiveTranscriptController";
import { MAX_UPLOAD_FILES, usePendingUploads } from "./chat/usePendingUploads";
import { McpHubPage } from "./mcp-hub/McpHubPage";
import type { SectionId } from "./settings/types";
import { SkillsHubPage } from "./skills-hub/SkillsHubPage";

type ChatPageProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  context: Context;
  setContext: (next: Context) => void;
  onOpenSettings: (section?: SectionId) => void;
  onToggleTheme: () => void;
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

type EffectiveChatModelSelection = {
  selectedModel: {
    customProviderId: string;
    model: string;
  };
  provider: AppSettings["customProviders"][number];
  providerId: ProviderId;
  model: string;
};

type SyncedRunningConversationRuntime = {
  workdir?: string;
  updatedAt: number;
};

const HISTORY_SWITCH_OVERLAY_MIN_MS = 260;
const PROJECT_HISTORY_DELETE_PAGE_SIZE = 200;
const SHARED_HISTORY_LIST_PAGE_SIZE = 200;

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

function escapeComposerCommitLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function formatComposerCommitLinkDestination(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (/[\s()<>]/.test(normalized)) {
    return `<${normalized.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
  }
  return normalized;
}

function formatComposerCommitMention(commit: MentionComposerCommitMention) {
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const subject = commit.subject.trim() || shortSha;
  const label = `commit ${shortSha}: ${subject}`;
  if (commit.githubUrl?.trim()) {
    return `[${escapeComposerCommitLinkLabel(label)}](${formatComposerCommitLinkDestination(commit.githubUrl.trim())})`;
  }
  return `${label} (${commit.sha})`;
}

function formatComposerGitFileMention(file: MentionComposerGitFileMention) {
  const refLabel = file.refName || file.shortSha || file.commitSha.slice(0, 7);
  const label = `git file ${refLabel}: ${file.path}`;
  if (file.githubUrl?.trim()) {
    return `[${escapeComposerCommitLinkLabel(label)}](${formatComposerCommitLinkDestination(file.githubUrl.trim())})`;
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
      if (segment.type === "skillMention") {
        return `$${segment.skill.name}`;
      }
      if (segment.type === "commitMention") {
        return formatComposerCommitMention(segment.commit);
      }
      if (segment.type === "gitFileMention") {
        return formatComposerGitFileMention(segment.file);
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

function resolveEffectiveChatModelSelection(
  settings: AppSettings,
  gatewaySelectedModel?: GatewaySelectedModelEvent,
): EffectiveChatModelSelection {
  const resolveLocalSelection = (): EffectiveChatModelSelection => {
    if (!settings.selectedModel) {
      throw new Error("请先在左上角选择一个模型（或先去设置添加模型）。");
    }

    const { customProviderId, model } = settings.selectedModel;
    const provider = settings.customProviders.find((item) => item.id === customProviderId);
    if (!provider) {
      throw new Error("所选供应商不存在，请重新选择模型。");
    }

    return {
      selectedModel: settings.selectedModel,
      provider,
      providerId: provider.type,
      model,
    };
  };

  if (!gatewaySelectedModel) {
    return resolveLocalSelection();
  }

  const customProviderId = gatewaySelectedModel.customProviderId.trim();
  const model = gatewaySelectedModel.model.trim();
  const providerType = normalizeGatewayProviderType(gatewaySelectedModel.providerType);
  if (!customProviderId || !model || !providerType) {
    throw new Error("远程请求携带的模型配置无效，请在 WebUI 重新选择模型后重试。");
  }

  const exactProvider = settings.customProviders.find((item) => item.id === customProviderId);
  const provider =
    exactProvider ?? settings.customProviders.find((item) => item.type === providerType);
  if (!provider) {
    throw new Error("远程请求所选模型对应的供应商不存在，请先在桌面端配置该类型供应商。");
  }

  return {
    selectedModel: {
      customProviderId: provider.id,
      model,
    },
    provider,
    providerId: provider.type,
    model,
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
  const controls = normalizeChatRuntimeControlsForProvider(controlsInput, {
    providerId: provider.type,
    requestFormat: provider.requestFormat,
  });
  const reasoningSupported =
    getChatRuntimeReasoningLevelsForProvider({
      providerId: provider.type,
      requestFormat: provider.requestFormat,
    }).length > 0;
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
    modelConfig: findProviderModelConfig(provider, model),
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
  const { settings, setSettings, context, setContext, onOpenSettings, onToggleTheme } = props;
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
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [syncedRunningConversationRuntime, setSyncedRunningConversationRuntime] = useState<
    ReadonlyMap<string, SyncedRunningConversationRuntime>
  >(() => new Map());
  const syncedRunningConversationRuntimeRef = useRef<
    ReadonlyMap<string, SyncedRunningConversationRuntime>
  >(new Map());
  const [syncedProjectActivityUpdatedAts, setSyncedProjectActivityUpdatedAts] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [historySwitchOverlay, setHistorySwitchOverlay] = useState<{
    conversationId: string;
    startedAt: number;
  } | null>(null);

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
  const [historyWorkdirs, setHistoryWorkdirs] = useState<ChatHistoryWorkdirSummary[]>([]);
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, historyWorkdirs),
    [historyWorkdirs, settings.system],
  );
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectId] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const missingWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.missingWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const activeWorkspaceProject = useMemo(
    () => findWorkspaceProject(workspaceProjects, activeWorkspaceProjectId),
    [activeWorkspaceProjectId, workspaceProjects],
  );
  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId]);
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";
  const historyListFilter = useMemo(
    () =>
      isAgentMode
        ? { cwd: activeWorkspaceProjectPath || "__liveagent_no_project__" }
        : {
            cwdEmpty: true,
          },
    [activeWorkspaceProjectPath, isAgentMode],
  );
  const historyScopeKey = isAgentMode
    ? `cwd:${activeWorkspaceProjectPath || "__liveagent_no_project__"}`
    : "cwd-empty";
  const enabledMcpServers = useMemo(
    () => settings.mcp.servers.filter((server) => server.enabled),
    [settings.mcp.servers],
  );
  const selectableMcpServers = useMemo(
    () => enabledMcpServers.filter((server) => server.id.trim()),
    [enabledMcpServers],
  );
  const enabledMcpServerIds = useMemo(
    () => selectableMcpServers.map((server) => server.id),
    [selectableMcpServers],
  );

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeView, setActiveView] = useState<"chat" | "skills-hub" | "mcp-hub">("chat");
  const [projectToolsPanelOpen, setProjectToolsPanelOpen] = useState(false);
  const [projectTerminalSessions, setProjectTerminalSessions] = useState<TerminalSession[]>([]);
  const [remoteRuntimeStatus, setRemoteRuntimeStatus] = useState<GatewayRuntimeStatus>(() =>
    buildFallbackGatewayStatus(settings.remote),
  );

  const {
    historyItems,
    setHistoryItems,
    historyItemsRef,
    historyTotal,
    historyHasMore,
    historyLoading,
    historyLoadingMore,
    historyError,
    setHistoryError,
    loadMoreHistory,
  } = useChatHistoryList(historyListFilter);
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

  const refreshHistoryWorkdirs = useCallback(async () => {
    try {
      const response = await listChatHistoryWorkdirs();
      setHistoryWorkdirs(response.workdirs);
    } catch (error) {
      console.warn("Failed to load chat history workdirs", error);
    }
  }, []);

  const persistProjectConversationActivity = useCallback(
    (activity: ReadonlyMap<string, number>) => {
      if (activity.size === 0) {
        return;
      }
      setSettings((prev) => {
        const hiddenProjectPathKeys = new Set(
          prev.system.hiddenWorkspaceProjectPaths.map(workspaceProjectPathKey),
        );
        const workspaceProjects = applyWorkspaceProjectConversationActivityMap(
          prev.system.workspaceProjects,
          activity,
          { hiddenProjectPathKeys },
        );
        if (!workspaceProjects) {
          return prev;
        }
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

  const recordProjectActivity = useCallback(
    (workdir?: string | null, updatedAt?: number | null) => {
      const pathKey = workspaceProjectPathKey(workdir ?? "");
      if (!pathKey) {
        return;
      }
      const nextUpdatedAt =
        typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
          ? updatedAt
          : Date.now();
      setSyncedProjectActivityUpdatedAts((current) => {
        if ((current.get(pathKey) ?? 0) >= nextUpdatedAt) {
          return current;
        }
        return mergeWorkspaceProjectActivityUpdatedAts(
          current,
          new Map([[pathKey, nextUpdatedAt]]),
        );
      });
      persistProjectConversationActivity(new Map([[pathKey, nextUpdatedAt]]));
    },
    [persistProjectConversationActivity],
  );

  useEffect(() => {
    const historyActivity = buildWorkspaceProjectActivityUpdatedAts(historyWorkdirs);
    if (historyActivity.size === 0) {
      return;
    }
    setSyncedProjectActivityUpdatedAts((current) => {
      const next = mergeWorkspaceProjectActivityUpdatedAts(current, historyActivity);
      return workspaceProjectActivityUpdatedAtsEqual(current, next) ? current : next;
    });
    persistProjectConversationActivity(historyActivity);
  }, [historyWorkdirs, persistProjectConversationActivity]);

  const applySyncedConversationRuntime = useCallback(
    (event: ChatHistorySyncEvent) => {
      const conversationId = event.conversationId.trim();
      if (!conversationId) {
        return;
      }

      const existing = syncedRunningConversationRuntimeRef.current.get(conversationId);
      const eventWorkdir = event.conversation?.cwd?.trim() || "";
      const workdir = eventWorkdir || existing?.workdir || "";
      const eventUpdatedAt = event.conversation?.updatedAt;
      const updatedAt =
        typeof eventUpdatedAt === "number" && Number.isFinite(eventUpdatedAt) && eventUpdatedAt > 0
          ? eventUpdatedAt
          : existing?.updatedAt || Date.now();

      if (workdir) {
        recordProjectActivity(workdir, updatedAt);
      }

      if (event.kind === "upsert" && !existing) {
        return;
      }

      setSyncedRunningConversationRuntime((current) => {
        const currentEntry = current.get(conversationId);
        if (event.kind === "idle" || event.kind === "delete") {
          if (!currentEntry) {
            syncedRunningConversationRuntimeRef.current = current;
            return current;
          }
          const next = new Map(current);
          next.delete(conversationId);
          syncedRunningConversationRuntimeRef.current = next;
          return next;
        }

        const nextEntry: SyncedRunningConversationRuntime = {
          workdir: workdir || undefined,
          updatedAt: Math.max(currentEntry?.updatedAt ?? 0, updatedAt),
        };
        if (
          currentEntry?.workdir === nextEntry.workdir &&
          currentEntry?.updatedAt === nextEntry.updatedAt
        ) {
          syncedRunningConversationRuntimeRef.current = current;
          return current;
        }
        const next = new Map(current);
        next.set(conversationId, nextEntry);
        syncedRunningConversationRuntimeRef.current = next;
        return next;
      });
    },
    [recordProjectActivity],
  );

  useEffect(() => {
    void refreshHistoryWorkdirs();
  }, [refreshHistoryWorkdirs]);

  useEffect(() => {
    const unlistenPromise = listen<ChatHistorySyncEvent>(CHAT_HISTORY_SYNC_EVENT, (event) => {
      applySyncedConversationRuntime(event.payload);
      if (
        event.payload.kind === "upsert" ||
        event.payload.kind === "delete" ||
        event.payload.kind === "idle"
      ) {
        void refreshHistoryWorkdirs();
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [applySyncedConversationRuntime, refreshHistoryWorkdirs]);

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
        await invoke("fs_list", {
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
          },
          getDefaultWorkspaceProjectPath(prev.system),
        );
        return {
          ...prev,
          system: nextSystem,
        };
      });
      if (options?.startConversation) {
        startNewConversationActionRef.current({ workdir: targetProject.path });
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
      setActiveView("chat");
      activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleOpenCreateWorkspaceProject = useCallback(async () => {
    try {
      const picked = await invoke<string | null>("system_pick_folder", {
        initialWorkdir: activeWorkspaceProjectPath || workdir,
      });
      const path = picked?.trim();
      if (!path) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
      void refreshHistoryWorkdirs();
    } catch (error) {
      setHistoryError(asErrorMessage(error, "选择项目目录失败"));
    }
  }, [
    activateWorkspaceProject,
    activeWorkspaceProjectPath,
    refreshHistoryWorkdirs,
    setHistoryError,
    workdir,
  ]);

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

  const modelOptions = useMemo(() => buildModelOptions(settings), [settings]);
  const selectedValue = settings.selectedModel
    ? toModelValue(settings.selectedModel.customProviderId, settings.selectedModel.model)
    : undefined;

  const historyRenderItems = useMemo<RenderTimelineItem[]>(
    () => conversationState.historyRenderItems,
    [conversationState],
  );
  const currentRequestContext = useMemo(
    () => buildRequestContext(conversationState),
    [conversationState],
  );

  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerBusyRef = useRef(false);
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  const conversationLoadSequenceRef = useRef(0);
  const subagentRuntimeManagerRef = useRef(createSubagentRuntimeManager());
  const previousSubagentRuntimeConversationRef = useRef(currentConversationId);
  const subagentWarmupSignatureRef = useRef("");
  const hookRunSequenceRef = useRef(0);
  const titleJobRef = useRef<{
    conversationId: string;
    promise: Promise<string | null>;
  } | null>(null);
  const previousHistoryIdsRef = useRef<Set<string>>(new Set());
  const previousHistoryScopeKeyRef = useRef(historyScopeKey);
  const currentConversationHistoryUpdatedAtRef = useRef<number | null>(null);
  const locallySyncedHistoryUpdatedAtRef = useRef(new Map<string, number>());
  const startNewConversationActionRef = useRef<(options?: { workdir?: string }) => void>(
    () => undefined,
  );
  const loadConversationActionRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const commitRenameActionRef = useRef<() => Promise<void>>(async () => undefined);
  const setPinnedActionRef = useRef<(id: string, isPinned: boolean) => Promise<void>>(
    async () => undefined,
  );
  const deleteConversationActionRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const sendActionRef = useRef<SendChatAction>(async () => undefined);
  const ensureGatewayBridgeConversationReadyRef = useRef<
    (id: string, options?: EnsureGatewayBridgeConversationReadyOptions) => Promise<string>
  >(async (id) => id.trim());
  const appliedGatewayHistoryTruncationsRef = useRef(new Map<string, string>());
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
    getCompactionThrottleState,
    deleteConversationArtifacts,
    requestAutoScroll,
    clearAbortSnapshot,
    captureAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    stickToBottom,
    updateLiveRounds,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
  } = useLiveTranscriptController({
    currentConversationId,
    scrollAreaRef,
    composerBusyRef,
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
    setConversationState,
    setCompactionStatus,
    setIsSending,
    setErrorMessage,
    setHookWarning,
    setCurrentConversationSessionId,
    setCurrentConversationCreatedAt,
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
  const terminalDisabledMessage = !isAgentMode
    ? "Project tools require Agent project mode."
    : !terminalProjectPath
      ? "Select a project to use project tools."
      : undefined;
  useEffect(() => {
    if (!terminalProjectPathKey) {
      setProjectTerminalSessions([]);
      return;
    }
    let cancelled = false;
    void tauriTerminalClient
      .list(terminalProjectPathKey)
      .then((sessions) => {
        if (!cancelled) {
          setProjectTerminalSessions(sortTerminalSessions(sessions));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectTerminalSessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [terminalProjectPathKey]);
  useEffect(() => {
    if (!terminalProjectPathKey) return;
    return tauriTerminalClient.subscribe((event) => {
      if (!terminalSessionBelongsToProject(event.session, terminalProjectPathKey)) return;
      if (event.kind === "output") return;
      setProjectTerminalSessions((current) => applyTerminalEventToSessions(current, event));
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
        window.confirm(
          `仍有 ${runningCount} 个 Terminal 正在运行。退出 LiveAgent 会关闭这些进程，是否继续？`,
        );
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
  }, [setErrorMessage]);
  const sidebarRunningConversationIds = useMemo(() => {
    const next = new Set(runningConversationIds);
    for (const conversationId of syncedRunningConversationRuntime.keys()) {
      next.add(conversationId);
    }
    return next;
  }, [runningConversationIds, syncedRunningConversationRuntime]);
  const runningProjectPathKeys = useMemo(() => {
    const next = new Set<string>();
    for (const conversationIdValue of sidebarRunningConversationIds) {
      const conversationId = conversationIdValue.trim();
      if (!conversationId) {
        continue;
      }

      const runtimeWorkdir =
        conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
      const syncedWorkdir =
        syncedRunningConversationRuntime.get(conversationId)?.workdir?.trim() || "";
      const persistedWorkdir =
        historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
      const resolvedWorkdir = runtimeWorkdir || syncedWorkdir || persistedWorkdir;
      if (resolvedWorkdir) {
        next.add(workspaceProjectPathKey(resolvedWorkdir));
      }
    }
    return next;
  }, [historyItems, sidebarRunningConversationIds, syncedRunningConversationRuntime]);
  const projectActivityUpdatedAts = useMemo(() => {
    const updatedAts = buildWorkspaceProjectActivityUpdatedAts([
      ...historyWorkdirs,
      ...Array.from(runningConversationIds).map((conversationId) => {
        const runtimeWorkdir =
          conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
        const persistedWorkdir =
          historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
        return {
          cwd: runtimeWorkdir || persistedWorkdir,
          updatedAt: Date.now(),
        };
      }),
      ...Array.from(syncedRunningConversationRuntime.values()).map((item) => ({
        cwd: item.workdir,
        updatedAt: item.updatedAt,
      })),
    ]);
    for (const [pathKey, updatedAt] of syncedProjectActivityUpdatedAts) {
      if (updatedAt > (updatedAts.get(pathKey) ?? 0)) {
        updatedAts.set(pathKey, updatedAt);
      }
    }
    return updatedAts;
  }, [
    historyItems,
    historyWorkdirs,
    runningConversationIds,
    syncedProjectActivityUpdatedAts,
    syncedRunningConversationRuntime,
  ]);

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
    setPendingUploadedFiles,
    pendingUploadsByConversationRef,
    pickReadableFiles,
    importReadableFilePaths,
    importReadableFiles,
    removePendingUpload,
  } = usePendingUploads({
    isAgentMode,
    workdir: displayedConversationWorkdir,
    currentConversationIdRef,
    composerRef,
    setErrorMessage,
    addNotify,
  });
  const [isFileDropActive, setIsFileDropActive] = useState(false);

  const deleteConversationLocalCaches = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      if (!key) return;
      composerDraftCacheRef.current.delete(key);
      locallySyncedHistoryUpdatedAtRef.current.delete(key);
      appliedGatewayHistoryTruncationsRef.current.delete(key);
      pendingUploadsByConversationRef.current.delete(key);
      clearMemoryExtractorState(key);
      clearSilentMemoryExtractionState(key);
      clearSilentMemoryDecisions(key);
      deleteConversationArtifacts(key);
    },
    [deleteConversationArtifacts, pendingUploadsByConversationRef],
  );

  function resetVisibleTransientState(targetConversationId = currentConversationIdRef.current) {
    if (currentConversationIdRef.current !== targetConversationId) {
      return;
    }
    composerRef.current?.clear();
    pendingUploadsByConversationRef.current.delete(targetConversationId);
    setPendingUploadedFiles([]);
    setErrorMessage(null);
    setHookWarning(null);
    setRenamingId(null);
    setRenameDraft("");
    setCopiedMessageKey(null);
    stickToBottom();
  }

  function cacheActiveComposerDraft(conversationId = currentConversationIdRef.current) {
    const targetConversationId = conversationId.trim();
    const composer = composerRef.current;
    if (!targetConversationId || !composer) {
      return;
    }

    const draft = composer.getDraft();
    if (draft.isEmpty || !draft.text.trim()) {
      composerDraftCacheRef.current.delete(targetConversationId);
      return;
    }

    composerDraftCacheRef.current.set(targetConversationId, draft);
  }

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
      const cachedDraft = composerDraftCacheRef.current.get(targetConversationId);
      const composer = composerRef.current;
      if (!cachedDraft || !composer || composer.hasContent()) {
        return;
      }
      composer.setDraft(cachedDraft);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeView, currentConversationId]);

  const pruneIdleConversationCaches = useCallback(
    (extraKeepIds: Iterable<string> = []) => {
      pruneIdleConversationRuntimeCaches({
        runtimeCache: conversationRuntimeCacheRef.current,
        persistedStateCache: persistedConversationStateRef.current,
        keepConversationIds: [currentConversationIdRef.current, ...extraKeepIds],
        isConversationRunning,
        onPruneConversation: (conversationId) => {
          deleteConversationLocalCaches(conversationId);
          subagentRuntimeManagerRef.current.disposeConversation(conversationId);
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

  function markCompactionRunning(
    conversationId: string,
    trigger: Extract<CompactionStatus, { phase: "running" }>["trigger"],
    sourceSegmentIndex: number,
  ) {
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      compactionStatus: {
        phase: "running",
        trigger,
        startedAt: Date.now(),
        sourceSegmentIndex,
      },
    }));
  }

  function markCompactionCompleted(
    conversationId: string,
    trigger: Extract<CompactionStatus, { phase: "completed" }>["trigger"],
    newSegmentIndex: number,
  ) {
    noteCompactionApplied(getCompactionThrottleState(conversationId));
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      compactionStatus: {
        phase: "completed",
        trigger,
        newSegmentIndex,
        completedAt: Date.now(),
      },
    }));
  }

  function markCompactionFailed(
    conversationId: string,
    trigger: Extract<CompactionStatus, { phase: "failed" }>["trigger"],
    message: string,
  ) {
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      compactionStatus: {
        phase: "failed",
        trigger,
        failedAt: Date.now(),
        message,
      },
    }));
  }

  function resetRunningCompaction(conversationId: string) {
    updateConversationRuntimeEntry(conversationId, (prev) => {
      if (prev.compactionStatus.phase !== "running") {
        return prev;
      }
      return {
        ...prev,
        compactionStatus: { phase: "idle" },
      };
    });
  }

  const markLocalHistorySnapshotSynced = useCallback(
    (conversationId: string, updatedAt: number) => {
      const key = conversationId.trim();
      if (!key) {
        return;
      }
      if (updatedAt < 0) {
        locallySyncedHistoryUpdatedAtRef.current.delete(key);
        if (currentConversationIdRef.current === key) {
          const currentItem = historyItemsRef.current.find((item) => item.id === key);
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
    [currentConversationIdRef, historyItemsRef],
  );

  function stopSending() {
    const conversationId = currentConversationIdRef.current;
    const controller = getConversationAbortController(conversationId);
    if (!controller) return;
    const transcriptStore = getConversationLiveTranscriptStore(conversationId);
    captureAbortSnapshot(transcriptStore);
    updateToolStatus("正在停止当前任务...", transcriptStore, true);
    controller.abort();
  }

  const {
    startNewConversation,
    loadConversationFromHistory,
    commitRename,
    setConversationPinned,
    requestDeleteConversation,
    persistConversation,
  } = useConversationHistoryActions({
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    markLocalHistorySnapshotSynced,
    isConversationRunning,
    conversationLoadSequenceRef,
    historyItemsRef,
    titleJobRef,
    renamingId,
    renameDraft,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    cancelConversationHydration,
    resetVisibleTransientState,
    deleteConversationArtifacts: deleteConversationLocalCaches,
    disposeSubagentsForConversation: (conversationId) => {
      subagentRuntimeManagerRef.current.disposeConversation(conversationId);
    },
    getDefaultNewConversationWorkdir: () =>
      isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    setCurrentConversationId,
    setErrorMessage,
    setHydratingConversationId,
    setHydrationFailedConversationId,
    setHistoryItems,
    setHistoryError,
    setRenamingId,
    setRenameDraft,
  });

  startNewConversationActionRef.current = startNewConversation;
  loadConversationActionRef.current = loadConversationFromHistory;
  commitRenameActionRef.current = commitRename;
  setPinnedActionRef.current = setConversationPinned;
  deleteConversationActionRef.current = requestDeleteConversation;

  const removeWorkspaceProjectFromSettings = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const path = project.path.trim();
      const pathKey = workspaceProjectPathKey(path);
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
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
        return removeProjectToolsProjectState(nextSettings, pathKey);
      });
      setProjectRenamingId((current) => (current === project.id ? null : current));
      setProjectRenameDraft("");
    },
    [setSettings, workspaceProjects],
  );

  const handleRemoveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;

      void (async () => {
        const path = project.path.trim();
        const pathKey = workspaceProjectPathKey(path);
        const runningMessage = "项目中仍有后台任务运行，暂时不能删除该项目。";
        if (pathKey && runningProjectPathKeys.has(pathKey)) {
          setHistoryError(runningMessage);
          setErrorMessage(runningMessage);
          return;
        }

        setHistoryError(null);
        setErrorMessage(null);

        try {
          const conversationIds = await listChatHistoryIdsForProjectPath(path);
          const runningConversationIdsInProject = conversationIds.filter((id) => {
            const key = id.trim();
            return key
              ? isConversationRunning(key) || sidebarRunningConversationIds.has(key)
              : false;
          });
          if (runningConversationIdsInProject.length > 0) {
            setHistoryError(runningMessage);
            setErrorMessage(runningMessage);
            return;
          }

          const terminalSessions = pathKey ? await tauriTerminalClient.list(pathKey) : [];
          const runningTerminalCount = terminalSessions.filter((session) => session.running).length;
          if (
            runningTerminalCount > 0 &&
            !window.confirm(
              `项目 "${project.name}" 中仍有 ${runningTerminalCount} 个 Terminal 正在运行。删除项目会关闭这些 Terminal，是否继续？`,
            )
          ) {
            return;
          }

          for (const conversationId of conversationIds) {
            await deleteChatHistory(conversationId);
          }

          const deletedConversationIds = new Set(conversationIds);
          if (deletedConversationIds.size > 0) {
            setHistoryItems((current) =>
              current.filter((item) => !deletedConversationIds.has(item.id)),
            );
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
              subagentRuntimeManagerRef.current.disposeConversation(conversationId);
            }
          }
          if (terminalSessions.length > 0) {
            await tauriTerminalClient.closeProject(pathKey);
            setProjectTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          }
          if (pathKey && terminalProjectPathKey === pathKey) {
            setProjectToolsPanelOpen(false);
            setProjectTerminalSessions([]);
          }

          const visibleConversationId = currentConversationIdRef.current;
          const shouldResetVisibleConversation =
            Boolean(visibleConversationId && deletedConversationIds.has(visibleConversationId)) ||
            Boolean(pathKey && workspaceProjectPathKey(displayedConversationWorkdir) === pathKey);

          removeWorkspaceProjectFromSettings(project);
          if (shouldResetVisibleConversation) {
            startNewConversationActionRef.current({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
          void refreshHistoryWorkdirs();
        } catch (error) {
          const message = asErrorMessage(error, "删除项目失败");
          setHistoryError(message);
          setErrorMessage(message);
        }
      })();
    },
    [
      deleteConversationLocalCaches,
      displayedConversationWorkdir,
      isConversationRunning,
      refreshHistoryWorkdirs,
      removeWorkspaceProjectFromSettings,
      runningProjectPathKeys,
      setHistoryError,
      setHistoryItems,
      settings.system,
      sidebarRunningConversationIds,
      terminalProjectPathKey,
    ],
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
    const historyItem = historyItemsRef.current.find((item) => item.id === conversationId);
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
    updateConversationRuntimeEntry,
  ]);

  useEffect(() => {
    const previous = previousSubagentRuntimeConversationRef.current;
    if (previous && previous !== currentConversationId) {
      subagentRuntimeManagerRef.current.disposeConversation(previous);
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
    subagentRuntimeManagerRef.current.warmupConversation({
      parentConversationId: currentConversationId,
      agentTemplates: settings.agents,
    });
  }, [currentConversationId, historyItems, settings.agents]);

  useEffect(
    () => () => {
      subagentRuntimeManagerRef.current.disposeAll();
    },
    [],
  );

  async function persistConversationWithHistorySync(
    params: Parameters<typeof persistConversation>[0],
  ) {
    const persisted = await persistConversation(params);
    if (persisted) {
      recordProjectActivity(params.cwd, Date.now());
      void refreshHistoryWorkdirs();
    }
    return persisted;
  }

  async function publishGatewayConversationActivity(
    conversationId: string,
    running: boolean,
    workdir?: string,
  ) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }

    try {
      await invoke("gateway_publish_conversation_activity", {
        conversation_id: targetConversationId,
        running,
        workdir: workdir?.trim() || null,
      } as any);
    } catch (error) {
      console.warn("gateway_publish_conversation_activity failed", error);
    }
  }

  async function ensureGatewayBridgeConversationReady(
    targetConversationId: string,
    options?: EnsureGatewayBridgeConversationReadyOptions,
  ) {
    const requestedConversationId = targetConversationId.trim();
    let forceHydrate = options?.forceHydrate === true;
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
      historyItemsRef.current.some((item) => item.id === requestedConversationId);
    if (!knownConversation) {
      throw new Error(`Conversation not found: ${requestedConversationId}`);
    }
    if (isConversationRunning(requestedConversationId)) {
      throw new Error(`Conversation is already running: ${requestedConversationId}`);
    }

    const cached = conversationRuntimeCacheRef.current.get(requestedConversationId);
    if (forceHydrate) {
      const appliedTruncation =
        appliedGatewayHistoryTruncationsRef.current.get(requestedConversationId);
      if (
        appliedTruncation &&
        appliedTruncation === options?.historyTruncationKey &&
        cached &&
        persistedConversationStateRef.current.has(requestedConversationId)
      ) {
        forceHydrate = false;
        appliedGatewayHistoryTruncationsRef.current.delete(requestedConversationId);
      } else {
        persistedConversationStateRef.current.delete(requestedConversationId);
      }
    }
    const isPendingHistoryItem = historyItemsRef.current.some(
      (item) => item.id === requestedConversationId && item.isPending,
    );
    const shouldHydrateFromHistory =
      forceHydrate ||
      hydratingConversationIdRef.current === requestedConversationId ||
      hydrationFailedConversationIdRef.current === requestedConversationId ||
      !cached ||
      (!persistedConversationStateRef.current.has(requestedConversationId) &&
        !cached.isSending &&
        !isPendingHistoryItem);

    if (!shouldHydrateFromHistory) {
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
    });
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, record.id, nextEntry);
    persistedConversationStateRef.current.set(record.id, record.state);
    if (currentConversationIdRef.current === record.id) {
      syncVisibleConversationRuntime(record.id, nextEntry);
    }
    if (hydratingConversationIdRef.current === record.id) {
      setHydratingConversationId(null);
    }
    if (hydrationFailedConversationIdRef.current === record.id) {
      setHydrationFailedConversationId(null);
    }
    return record.id;
  }

  ensureGatewayBridgeConversationReadyRef.current = ensureGatewayBridgeConversationReady;

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
    setPendingUploadedFiles(
      pendingUploadsByConversationRef.current.get(currentConversationId) ?? [],
    );
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
      settings.selectedModel?.customProviderId ??
      historyItemsRef.current.find((item) => item.id === currentConversationId)?.providerId ??
      "pending";
    const model =
      settings.selectedModel?.model ??
      historyItemsRef.current.find((item) => item.id === currentConversationId)?.model ??
      "pending";

    setHistoryItems((prev) =>
      mergeHistoryItem(prev, {
        ...createPendingHistoryItem({
          conversationId: currentConversationId,
          providerId,
          model,
          sessionId: currentConversationSessionId,
          cwd: displayedConversationWorkdir || undefined,
          createdAt: currentConversationCreatedAt,
          updatedAt: Date.now(),
        }),
        title:
          fallbackTitle && fallbackTitle !== PENDING_CONVERSATION_TITLE
            ? fallbackTitle
            : PENDING_CONVERSATION_TITLE,
      }),
    );
  }, [
    conversationState,
    currentConversationCreatedAt,
    currentConversationId,
    currentConversationSessionId,
    historyItems,
    isSending,
    settings.selectedModel,
    displayedConversationWorkdir,
  ]);

  useEffect(() => {
    const currentItem = historyItemsRef.current.find((item) => item.id === currentConversationId);
    currentConversationHistoryUpdatedAtRef.current =
      currentItem && !currentItem.isPending ? currentItem.updatedAt : null;
  }, [currentConversationId]);

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
    void loadConversationActionRef.current(currentConversationId).catch(() => undefined);
  }, [
    currentConversationId,
    historyItems,
    hydrationFailedConversationId,
    hydratingConversationId,
    isSending,
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

  useEffect(() => {
    if (!historySwitchOverlay) {
      return;
    }

    const targetConversationId = historySwitchOverlay.conversationId;
    if (hydratingConversationId === targetConversationId) {
      return;
    }

    let firstRafId: number | null = null;
    let secondRafId: number | null = null;
    const elapsed = Date.now() - historySwitchOverlay.startedAt;
    const delayMs = Math.max(0, HISTORY_SWITCH_OVERLAY_MIN_MS - elapsed);
    const timeoutId = window.setTimeout(() => {
      firstRafId = requestAnimationFrame(() => {
        stickToBottom();
        secondRafId = requestAnimationFrame(() => {
          stickToBottom();
          setHistorySwitchOverlay((current) =>
            current?.conversationId === targetConversationId ? null : current,
          );
        });
      });
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
      if (firstRafId !== null) {
        cancelAnimationFrame(firstRafId);
      }
      if (secondRafId !== null) {
        cancelAnimationFrame(secondRafId);
      }
    };
  }, [historySwitchOverlay, hydratingConversationId, stickToBottom]);

  useEffect(() => {
    requestAutoScroll();
  }, [historyRenderItems.length, requestAutoScroll]);

  useGatewayBridgeListeners({
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    appliedHistoryTruncationsRef: appliedGatewayHistoryTruncationsRef,
    historyItemsRef,
    ensureGatewayBridgeConversationReadyRef,
    sendActionRef,
    queueGatewayBridgeEventForRequest,
    isConversationRunning,
    getConversationAbortController,
    syncVisibleConversationRuntime,
    invalidateSubagentsForConversation: (conversationId) => {
      subagentRuntimeManagerRef.current.invalidateConversation(conversationId);
    },
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
    uploadedFilesOverride?: PendingUploadedFile[];
    conversationIdOverride?: string;
    executionModeOverride?: ExecutionMode;
    workdirOverride?: string;
    selectedSystemToolIdsOverride?: SystemToolId[];
    runtimeControlsOverride?: ChatRuntimeControls;
    gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
    afterInitialHistoryPersist?: () => Promise<void>;
  }) {
    const overrideConversationId = overrides?.conversationIdOverride?.trim() ?? "";
    const conversationId = overrideConversationId || currentConversationIdRef.current;
    if (!conversationId) {
      return;
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
    const effectiveIsAgentDevExecutionMode = isAgentDevMode(effectiveExecutionMode);
    const effectiveSkillsEnabled = settings.skills.enabled && effectiveIsAgentMode;
    const hasRemoteGatewayTarget =
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() !== "" &&
      settings.remote.token.trim() !== "";
    const gatewayBridgeEvents = createGatewayBridgeEventController({
      conversationId,
      requestId: gatewayBridgeRequest?.requestId ?? `conversation-live-${conversationId}`,
      enabled: Boolean(gatewayBridgeRequest) || hasRemoteGatewayTarget,
      sendEvent: queueGatewayBridgeEventForRequest,
      resolveErrorConversationId: () =>
        gatewayBridgeRequest?.conversationId ?? currentConversationIdRef.current,
    });
    const updateGatewayBridgeToolStatus = (
      status: string | null,
      visible: boolean,
      isCompaction = false,
    ) => {
      gatewayBridgeEvents.queueToolStatus(status, isCompaction);
      updateToolStatus(status, transcriptStore, visible);
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
    if (runtimeEntry.isSending) return;
    if (isImportingPastedTextRef.current && typeof overrides?.textOverride !== "string") {
      return;
    }
    if (hydratingConversationIdRef.current === conversationId) {
      const message = "当前会话仍在补全完整历史，请稍候。";
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message, conversationId);
      return;
    }
    if (hydrationFailedConversationIdRef.current === conversationId) {
      const message = "当前会话完整历史加载失败，请重新打开该会话后再继续。";
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message, conversationId);
      return;
    }
    if (runtimeEntry.compactionStatus.phase !== "idle") {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        compactionStatus: { phase: "idle" },
      }));
    }

    let effectiveSelectedModel: EffectiveChatModelSelection;
    try {
      effectiveSelectedModel = resolveEffectiveChatModelSelection(
        settings,
        gatewayBridgeRequest?.selectedModelOverride,
      );
    } catch (error) {
      const message = asErrorMessage(error, "当前模型配置不可用，请重新选择后重试。");
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message);
      return;
    }

    const { selectedModel, provider, providerId, model } = effectiveSelectedModel;
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
    const runtimeModel = createModelFromConfig(
      providerId,
      model,
      provider.baseUrl.trim(),
      provider.requestFormat,
      providerConfig.modelConfig,
    );

    const composerDraft =
      typeof overrides?.textOverride === "string"
        ? null
        : (composerRef.current?.getDraft() ?? null);
    let text =
      typeof overrides?.textOverride === "string"
        ? overrides.textOverride.trim()
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
      typeof overrides?.textOverride !== "string"
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
        return;
      } finally {
        isImportingPastedTextRef.current = false;
        setIsImportingPastedText(false);
      }
    }

    const userMessage = createUserMessageWithUploads(text, uploadedFiles, Date.now());
    if (!userMessage) return;
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
    const conversationThrottleState = getCompactionThrottleState(conversationId);
    const isConversationVisible = () => currentConversationIdRef.current === conversationId;
    let requestController = new AbortController();
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
    const existingHistoryItem = historyItemsRef.current.find((item) => item.id === conversationId);
    const shouldCreatePendingHistoryItem = isFirstTurn && !existingHistoryItem;
    const fallbackTitle =
      existingHistoryItem &&
      (!existingHistoryItem.isPending || existingHistoryItem.title !== PENDING_CONVERSATION_TITLE)
        ? existingHistoryItem.title
        : buildFallbackConversationTitle(
            getFirstUserMessageText(buildRequestContext(baseConversationState)) || titleSourceText,
          );

    let titlePromise: Promise<string | null> | null = null;
    if (isFirstTurn) {
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
          modelConfig: titleProviderConfig.modelConfig,
        },
        signal: requestController.signal,
        conversationId,
        titleSourceText,
        content,
        setHistoryItems,
        titleJobRef,
        gatewayBridgeEvents,
      });
    }

    if (shouldCreatePendingHistoryItem) {
      setHistoryItems((prev) =>
        mergeHistoryItem(
          prev,
          createPendingHistoryItem({
            conversationId,
            providerId,
            model,
            sessionId,
            cwd: conversationCwd,
            createdAt,
          }),
        ),
      );
      setHistoryError(null);
    }

    clearAbortSnapshot(transcriptStore);

    let nextConversationState = appendMessagesToConversation(baseConversationState, [
      pendingUserMessage,
    ]);
    let conversationRunStarted = false;
    let gatewayActivityPublishChain: Promise<void> = Promise.resolve();
    function queueGatewayConversationActivity(running: boolean) {
      gatewayActivityPublishChain = gatewayActivityPublishChain.then(() =>
        publishGatewayConversationActivity(conversationId, running, conversationCwd),
      );
      void gatewayActivityPublishChain;
    }
    function markConversationRunStarted() {
      if (conversationRunStarted) {
        return;
      }
      conversationRunStarted = true;
      applyConversationState(nextConversationState);
      resetLiveTranscript(transcriptStore);
      setConversationAbortController(conversationId, requestController);
      setConversationSendingState(conversationId, true);
      gatewayBridgeEvents.queueToken("", { round: 0 });
      queueGatewayConversationActivity(true);
      if (isConversationVisible()) {
        stickToBottom();
      }
    }
    function markConversationRunStopped() {
      if (!conversationRunStarted) {
        return;
      }
      setConversationAbortController(conversationId, null);
      setConversationSendingState(conversationId, false);
      queueGatewayConversationActivity(false);
    }

    const shouldSynchronizeInitialPersistBeforeGatewayStream =
      Boolean(gatewayBridgeRequest) || hasRemoteGatewayTarget;
    // Persist the user turn immediately so WebUI/GUI sidebars can surface the
    // latest conversation before the assistant round finishes.
    const initialPersist = persistConversationWithHistorySync({
      conversationId,
      sessionId,
      providerId,
      model,
      cwd: conversationCwd,
      state: nextConversationState,
      fallbackTitle,
      createdAt,
      titlePromise,
      titleLookahead: !shouldSynchronizeInitialPersistBeforeGatewayStream,
    });
    markConversationRunStarted();
    if (overrides?.afterInitialHistoryPersist) {
      const persisted = await initialPersist;
      if (!persisted) {
        const message = "历史记录保存失败，已取消子 Agent 回滚与重发。";
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
        markConversationRunStopped();
        return;
      }
      try {
        await overrides.afterInitialHistoryPersist();
      } catch (error) {
        const message = asErrorMessage(error, "回滚子 Agent 历史失败");
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        gatewayBridgeEvents.close();
        markConversationRunStopped();
        return;
      }
    } else {
      if (shouldSynchronizeInitialPersistBeforeGatewayStream) {
        await initialPersist;
      } else {
        void initialPersist;
      }
    }
    let activeCompactionRollback: {
      state: ConversationViewState;
      composerText?: string;
      uploadedFiles?: PendingUploadedFile[];
      persistOnRollback?: boolean;
    } | null = null;
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

    function armCompactionRollback(snapshot: {
      state: ConversationViewState;
      composerText?: string;
      uploadedFiles?: PendingUploadedFile[];
      persistOnRollback?: boolean;
    }) {
      activeCompactionRollback = snapshot;
    }

    function clearCompactionRollback() {
      activeCompactionRollback = null;
    }

    async function persistCheckpointState(state: ConversationViewState) {
      await persistConversation({
        conversationId,
        sessionId,
        providerId,
        model,
        cwd: conversationCwd,
        state,
        fallbackTitle,
        createdAt,
        titlePromise,
      });
    }

    async function rollbackCompactionIfNeeded() {
      const snapshot = activeCompactionRollback;
      if (!snapshot) {
        return false;
      }

      clearCompactionRollback();
      nextConversationState = snapshot.state;
      resetLiveTranscript(transcriptStore);
      updateGatewayBridgeToolStatus(null, false);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state: snapshot.state,
        compactionStatus: { phase: "idle" },
      }));
      if (isConversationVisible() && typeof snapshot.composerText === "string") {
        composerRef.current?.setText(snapshot.composerText);
        composerRef.current?.focus();
      }
      const restoredUploads = snapshot.uploadedFiles ?? [];
      if (restoredUploads.length > 0) {
        pendingUploadsByConversationRef.current.set(conversationId, restoredUploads);
      } else {
        pendingUploadsByConversationRef.current.delete(conversationId);
      }
      if (isConversationVisible()) {
        setPendingUploadedFiles(restoredUploads);
      }
      if (snapshot.persistOnRollback) {
        abortedConversationCommitted = true;
        await persistConversationWithHistorySync({
          conversationId,
          sessionId,
          providerId,
          model,
          cwd: conversationCwd,
          state: snapshot.state,
          fallbackTitle,
          createdAt,
          titlePromise,
        });
      }
      if (isConversationVisible()) {
        requestAutoScroll();
      }
      return true;
    }

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
        markConversationRunStopped();
        return;
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

    const hookRunSequence = ++hookRunSequenceRef.current;
    const hookDispatcher = createConversationHookDispatcher({
      hooks: settings.hooks,
      workdir: effectiveWorkdir,
      onWarning: (warning) => {
        if (hookRunSequenceRef.current !== hookRunSequence) return;
        updateConversationRuntimeEntry(conversationId, (prev) => ({
          ...prev,
          hookWarning: formatHookWarningMessage(settings.locale, t, warning),
        }));
      },
    });

    const hookLifecycle = createConversationHookLifecycle((event) => {
      void hookDispatcher.dispatch(event);
    });

    let abortedConversationCommitted = false;
    const commitVisibleAbortedConversation = () => {
      if (abortedConversationCommitted) return true;

      const snapshot = getAbortSnapshot(transcriptStore);
      const partialMessages = buildPersistableMessagesFromSnapshot({
        executionMode: effectiveExecutionMode,
        model: runtimeModel,
        draftAssistantText: snapshot.draftAssistantText,
        liveRounds: snapshot.liveRounds,
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

    function renewRequestController() {
      requestController = new AbortController();
      setConversationAbortController(conversationId, requestController);
      return requestController;
    }

    async function compactDuringRun(params: {
      trigger: "mid-stream" | "post-tool";
      state: ConversationViewState;
      requestContext: Context;
      budgetContext: Context;
      statusText: string;
      tools?: Context["tools"];
      includeAbortedMessages?: boolean;
      includeUploadedFilesMetadata?: boolean;
    }) {
      let workingState = params.state;
      let prePruned: ReturnType<typeof pruneConversationState> | null = null;
      if (conversationThrottleState.recentCompactionCount >= 1) {
        prePruned = pruneConversationState(workingState);
        if (prePruned.applied) {
          workingState = prePruned.state;
        }
      }
      const workingRequestContext = prePruned?.applied
        ? buildCompactionContext(prePruned.state, params.tools, {
            includeAbortedMessages: params.includeAbortedMessages,
            includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
          })
        : params.requestContext;
      const workingBudgetContext = prePruned?.applied
        ? buildPreparedContext(prePruned.state, params.tools, {
            includeAbortedMessages: params.includeAbortedMessages,
            includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
          })
        : params.budgetContext;

      armCompactionRollback({
        state: params.state,
        persistOnRollback: true,
      });
      markCompactionRunning(conversationId, params.trigger, workingState.activeSegmentIndex);
      updateGatewayBridgeToolStatus(params.statusText, isConversationVisible(), true);

      try {
        const compacted = await runMidTurnCompaction({
          state: workingState,
          requestContext: workingRequestContext,
          budgetContext: workingBudgetContext,
          providerId,
          model,
          runtime: {
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            requestFormat: providerConfig.requestFormat,
            reasoning: providerConfig.reasoning,
            promptCachingEnabled: providerConfig.promptCachingEnabled,
            nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
            modelConfig: providerConfig.modelConfig,
          },
          signal: requestController.signal,
          debugLogger: compactionDebugLogger,
          throttleState: conversationThrottleState,
        });

        if (!compacted.applied) {
          if (compacted.decision.reason === "hard-limit") {
            markCompactionFailed(
              conversationId,
              params.trigger,
              "当前会话已连续多次压缩，建议开启新会话继续。",
            );
          } else {
            resetRunningCompaction(conversationId);
          }
          clearCompactionRollback();
          if (prePruned?.applied) {
            rebaseConversationStateDuringRun(prePruned.state);
            return buildPreparedContext(prePruned.state, params.tools, {
              includeAbortedMessages: params.includeAbortedMessages,
              includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
            });
          }
          return null;
        }

        await persistCheckpointState(compacted.state);
        clearCompactionRollback();
        rebaseConversationStateDuringRun(compacted.state);
        markCompactionCompleted(conversationId, params.trigger, compacted.state.activeSegmentIndex);
        gatewayBridgeEvents.queueCheckpoint(compacted.state);
        return buildResumeContext(compacted.state, compacted.resumeMessage, params.tools, {
          includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
        });
      } catch (error) {
        if (requestController.signal.aborted || isAbortLikeError(error)) {
          throw error;
        }

        clearCompactionRollback();
        const pruned = pruneConversationState(workingState);
        if (pruned.applied) {
          rebaseConversationStateDuringRun(pruned.state);
          markCompactionFailed(conversationId, params.trigger, "压缩失败，已回退到 prune 降级");
          updateGatewayBridgeToolStatus(
            `上下文压缩失败，已裁剪 ${pruned.prunedMessageCount} 个旧工具输出后继续...`,
            isConversationVisible(),
          );
          return buildPreparedContext(pruned.state, params.tools, {
            includeAbortedMessages: params.includeAbortedMessages,
            includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
          });
        }

        const message = error instanceof Error ? error.message : String(error);
        markCompactionFailed(conversationId, params.trigger, message || "压缩失败");
        return null;
      } finally {
        updateGatewayBridgeToolStatus(null, isConversationVisible());
      }
    }

    async function maybeApplyPreCompaction(params: {
      requestContext: Context;
      budgetContext: Context;
      tools?: Context["tools"];
      includeUploadedFilesMetadata?: boolean;
    }) {
      let workingState = baseConversationState;
      let prePruned: ReturnType<typeof pruneConversationState> | null = null;
      if (conversationThrottleState.recentCompactionCount >= 1) {
        prePruned = pruneConversationState(workingState);
        if (prePruned.applied) {
          workingState = prePruned.state;
        }
      }

      const workingRequestContext = prePruned?.applied
        ? buildCompactionContext(workingState, params.tools ?? params.requestContext.tools, {
            includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
          })
        : params.requestContext;
      const workingBudgetContext = prePruned?.applied
        ? buildPreparedContext(workingState, params.tools ?? params.budgetContext.tools, {
            includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
          })
        : params.budgetContext;
      const decision = shouldPreCompactConversation({
        providerId,
        state: workingState,
        requestContext: workingBudgetContext,
        incomingUserText: content,
        modelConfig: providerConfig.modelConfig,
        throttleState: conversationThrottleState,
        debugLogger: compactionDebugLogger,
      });
      if (!decision.shouldCompact) {
        if (decision.reason === "hard-limit") {
          markCompactionFailed(
            conversationId,
            "pre-send",
            "当前会话已连续多次压缩，建议开启新会话继续。",
          );
        }
        if (prePruned?.applied) {
          applyConversationState(
            appendMessagesToConversation(prePruned.state, [pendingUserMessage]),
          );
          return true;
        }
        return false;
      }

      armCompactionRollback({
        state: baseConversationState,
        composerText: content,
        uploadedFiles,
      });
      markCompactionRunning(conversationId, "pre-send", workingState.activeSegmentIndex);
      updateGatewayBridgeToolStatus(
        buildPreCompactionStatus(decision),
        isConversationVisible(),
        true,
      );

      try {
        const compacted = await runPreCompactConversation({
          state: workingState,
          requestContext: workingRequestContext,
          budgetContext: workingBudgetContext,
          incomingUserText: content,
          providerId,
          model,
          runtime: {
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            requestFormat: providerConfig.requestFormat,
            reasoning: providerConfig.reasoning,
            promptCachingEnabled: providerConfig.promptCachingEnabled,
            nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
            modelConfig: providerConfig.modelConfig,
          },
          signal: requestController.signal,
          debugLogger: compactionDebugLogger,
          throttleState: conversationThrottleState,
        });

        if (!compacted.applied) {
          if (compacted.decision.reason === "hard-limit") {
            markCompactionFailed(
              conversationId,
              "pre-send",
              "当前会话已连续多次压缩，建议开启新会话继续。",
            );
          } else {
            resetRunningCompaction(conversationId);
          }
          clearCompactionRollback();
          if (prePruned?.applied) {
            applyConversationState(
              appendMessagesToConversation(prePruned.state, [pendingUserMessage]),
            );
            return true;
          }
          return false;
        }

        await persistCheckpointState(compacted.state);
        clearCompactionRollback();
        applyConversationState(appendMessagesToConversation(compacted.state, [pendingUserMessage]));
        markCompactionCompleted(conversationId, "pre-send", compacted.state.activeSegmentIndex);
        gatewayBridgeEvents.queueCheckpoint(compacted.state);
        return true;
      } catch (error) {
        if (requestController.signal.aborted || isAbortLikeError(error)) {
          throw error;
        }
        clearCompactionRollback();
        const pruned = prePruned?.applied
          ? prePruned
          : pruneConversationState(baseConversationState);
        if (pruned.applied) {
          applyConversationState(appendMessagesToConversation(pruned.state, [pendingUserMessage]));
          markCompactionFailed(conversationId, "pre-send", "压缩失败，已回退到 prune 降级");
          updateGatewayBridgeToolStatus(
            `上下文压缩失败，已裁剪 ${pruned.prunedMessageCount} 个旧工具输出后继续...`,
            isConversationVisible(),
          );
          return true;
        }
        console.warn("发送前上下文压缩失败，继续使用原始上下文", error);
        markCompactionFailed(
          conversationId,
          "pre-send",
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        updateGatewayBridgeToolStatus(null, isConversationVisible());
      }
    }

    if (typeof overrides?.textOverride !== "string") {
      clearCachedComposerDraft(conversationId);
    }
    resetVisibleTransientState(conversationId);

    try {
      if (effectiveIsAgentMode) {
        await runAgentConversationTurn({
          providerId,
          model,
          runtime: {
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            requestFormat: providerConfig.requestFormat,
            reasoning: providerConfig.reasoning,
            promptCachingEnabled: providerConfig.promptCachingEnabled,
            nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
            modelConfig: providerConfig.modelConfig,
          },
          runtimeModel,
          selectedModel,
          memoryExtractionModel,
          onMemoryExtractionModelFailure: handleMemoryExtractionModelFailure,
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
          mcpSettings: settings.mcp,
          updateMcpSettings: (nextMcp) => {
            setSettings((prev) => updateMcp(prev, nextMcp));
          },
          enabledMcpServerIds,
          selectableMcpServers,
          sessionId,
          conversationId,
          conversationCwd,
          fallbackTitle,
          createdAt,
          titlePromise,
          transcriptStore,
          gatewayBridgeEvents,
          hookLifecycle,
          conversationThrottleState,
          conversationDebugLogger,
          compactionDebugLogger,
          subagentRuntimeManager: subagentRuntimeManagerRef.current,
          getNextConversationState: () => nextConversationState,
          applyConversationState,
          buildCompactionContext,
          buildPreparedContext,
          maybeApplyPreCompaction,
          compactDuringRun,
          getRequestController: () => requestController,
          renewRequestController,
          resetLiveTranscript,
          updateLiveRounds,
          batchLiveRoundsUpdate,
          updateToolStatus,
          updateGatewayBridgeToolStatus,
          isConversationVisible,
          commitVisibleAbortedConversation,
          updateConversationRuntimeEntry,
          persistConversationWithHistorySync,
        });
      } else {
        await runTextConversationTurn({
          providerId,
          model,
          runtime: {
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            requestFormat: providerConfig.requestFormat,
            reasoning: providerConfig.reasoning,
            promptCachingEnabled: providerConfig.promptCachingEnabled,
            nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
            modelConfig: providerConfig.modelConfig,
          },
          runtimeModel,
          selectedModel,
          memoryExtractionModel,
          onMemoryExtractionModelFailure: handleMemoryExtractionModelFailure,
          sessionId,
          conversationId,
          conversationCwd,
          fallbackTitle,
          createdAt,
          titlePromise,
          transcriptStore,
          gatewayBridgeEvents,
          hookLifecycle,
          conversationThrottleState,
          conversationDebugLogger,
          recoveryDebugLogger,
          compactionDebugLogger,
          getNextConversationState: () => nextConversationState,
          applyConversationState,
          buildCompactionContext,
          buildPreparedContext,
          maybeApplyPreCompaction,
          compactDuringRun,
          getRequestController: () => requestController,
          renewRequestController,
          resetLiveTranscript,
          appendDraftAssistantText,
          batchLiveRoundsUpdate,
          updateGatewayBridgeToolStatus,
          isConversationVisible,
          commitVisibleAbortedConversation,
          updateConversationRuntimeEntry,
          persistConversationWithHistorySync,
        });
      }
    } catch (err) {
      const aborted = requestController.signal.aborted || isAbortLikeError(err);
      const remoteErrorMessage = aborted
        ? "Cancelled"
        : (err instanceof Error ? err.message : String(err)) || "Request failed";
      gatewayBridgeEvents.emitError(remoteErrorMessage, conversationId);
      gatewayBridgeEvents.close();
      if (aborted) {
        const rolledBack = await rollbackCompactionIfNeeded();
        if (!rolledBack) {
          resetRunningCompaction(conversationId);
          commitVisibleAbortedConversation();
        }
      } else {
        clearCompactionRollback();
        const msg = err instanceof Error ? err.message : String(err);
        commitErroredConversation(msg || "Request failed");
      }
      if (shouldCreatePendingHistoryItem && !abortedConversationCommitted) {
        setHistoryItems((prev) => prev.filter((item) => item.id !== conversationId));
      }
      if (titleJobRef.current?.conversationId === conversationId) {
        titleJobRef.current = null;
      }
    } finally {
      clearCompactionRollback();
      hookLifecycle.endAgent();
      clearAbortSnapshot(transcriptStore);
      markConversationRunStopped();
      pruneIdleConversationCaches([conversationId]);
    }
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
    setHistorySwitchOverlay(null);
    clearCachedComposerDraft();
    startNewConversationActionRef.current({
      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    });
  }, [activeWorkspaceProjectPath, isAgentMode]);

  const handleSelectConversation = useCallback((id: string) => {
    const targetConversationId = id.trim();
    if (!targetConversationId) {
      return;
    }
    if (targetConversationId !== currentConversationIdRef.current) {
      setHistorySwitchOverlay({
        conversationId: targetConversationId,
        startedAt: Date.now(),
      });
    }
    void loadConversationActionRef.current(targetConversationId);
  }, []);

  const handleStartRenaming = useCallback((item: ChatHistorySummary) => {
    setRenamingId(item.id);
    setRenameDraft(item.title);
  }, []);

  const handleCommitRename = useCallback(() => {
    void commitRenameActionRef.current();
  }, []);

  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft("");
  }, []);

  const handleSetPinned = useCallback((id: string, isPinned: boolean) => {
    void setPinnedActionRef.current(id, isPinned);
  }, []);

  const setSharedHistoryItemsState = useCallback((items: ChatHistorySummary[]) => {
    const nextItems = sortHistoryItems(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  const handleDeleteConversation = useCallback(
    (id: string) => {
      void deleteConversationActionRef.current(id).then(() => {
        if (historyItemsRef.current.some((item) => item.id === id)) {
          return;
        }
        setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
      });
    },
    [historyItemsRef, setSharedHistoryItemsState],
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
      return sortHistoryItems(nextItems);
    })();

    sharedHistoryListRequestRef.current = request;
    try {
      return await request;
    } catch (error) {
      setHistoryError(asErrorMessage(error, "读取已分享历史列表失败"));
      return sharedHistoryItemsRef.current;
    } finally {
      if (sharedHistoryListRequestRef.current === request) {
        sharedHistoryListRequestRef.current = null;
      }
    }
  }, [setHistoryError, setSharedHistoryItemsState]);

  useEffect(() => {
    void refreshSharedHistoryItems();
  }, [refreshSharedHistoryItems]);

  const markSharedConversation = useCallback(
    (id: string, isShared: boolean, source?: ChatHistorySummary | null) => {
      setHistoryItems((current) =>
        current.map((item) => (item.id === id ? { ...item, isShared } : item)),
      );
      if (!isShared) {
        setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
        return;
      }

      const conversation =
        source ??
        historyItemsRef.current.find((item) => item.id === id) ??
        sharedHistoryItemsRef.current.find((item) => item.id === id);
      if (!conversation) {
        return;
      }
      setSharedHistoryItemsState([
        { ...conversation, isShared: true },
        ...sharedHistoryItemsRef.current.filter((item) => item.id !== id),
      ]);
    },
    [historyItemsRef, setHistoryItems, setSharedHistoryItemsState],
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
    void sendActionRef.current();
  }, []);

  const handleStopSending = useCallback(() => {
    stopSendingActionRef.current();
  }, []);

  const handleComposerBusyChange = useCallback((isBusy: boolean) => {
    composerBusyRef.current = isBusy;
  }, []);

  const hasModels = modelOptions.length > 0;

  const currentModelLabel = (() => {
    if (!settings.selectedModel) return t("chat.selectModel");
    const opt = modelOptions.find((o) => o.value === selectedValue);
    if (opt) return `${opt.providerName} / ${opt.model}`;
    return settings.selectedModel.model;
  })();

  const currentModelContextWindow = (() => {
    if (!settings.selectedModel) return undefined;
    const provider = settings.customProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
    if (!provider) return undefined;
    return findProviderModelConfig(provider, settings.selectedModel.model).contextWindow;
  })();
  const currentChatProvider = settings.selectedModel
    ? settings.customProviders.find((item) => item.id === settings.selectedModel?.customProviderId)
    : undefined;
  const chatRuntimeReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      }),
    [currentChatProvider?.requestFormat, currentChatProvider?.type],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      }),
    [currentChatProvider?.requestFormat, currentChatProvider?.type, settings.chatRuntimeControls],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(prev.chatRuntimeControls, patch, {
          providerId: currentChatProvider?.type,
          requestFormat: currentChatProvider?.requestFormat,
        }),
      }));
    },
    [currentChatProvider?.requestFormat, currentChatProvider?.type, setSettings],
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
    isAgentMode &&
    Boolean(displayedConversationWorkdir.trim()) &&
    !isSending &&
    !isComposerInputDisabled;
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
    pendingUploadsByConversationRef,
    composerRef,
    setPendingUploadedFiles,
    updateConversationRuntimeEntry,
    invalidateSubagentsForConversation: (conversationId) => {
      subagentRuntimeManagerRef.current.invalidateConversation(conversationId);
    },
    sendActionRef,
  });

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <MacOsTitleBarToggle
        sidebarOpen={sidebarOpen}
        onToggle={handleToggleSidebar}
        onOpenSettings={() => onOpenSettings()}
      />
      {/* ---- Sidebar ---- */}
      <ChatHistorySidebar
        items={historyItems}
        currentConversationId={currentConversationId}
        isBusy={isSending}
        runningConversationIds={sidebarRunningConversationIds}
        isLoading={historyLoading}
        totalItems={historyTotal}
        hasMore={historyHasMore}
        isLoadingMore={historyLoadingMore}
        errorMessage={historyError}
        renamingId={renamingId}
        renameDraft={renameDraft}
        isOpen={sidebarOpen}
        activeView={activeView}
        showProjects={isAgentMode}
        projects={workspaceProjects}
        activeProjectId={activeWorkspaceProject?.id}
        missingProjectPathKeys={missingWorkspaceProjectPathKeys}
        runningProjectPathKeys={runningProjectPathKeys}
        projectActivityUpdatedAts={projectActivityUpdatedAts}
        projectRenamingId={projectRenamingId}
        projectRenameDraft={projectRenameDraft}
        projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
        recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
        onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
        onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
        onCreateProject={handleOpenCreateWorkspaceProject}
        onSelectProject={handleSelectWorkspaceProject}
        onNewConversationForProject={handleNewConversationForProject}
        onStartRenamingProject={handleStartRenamingWorkspaceProject}
        onProjectRenameDraftChange={setProjectRenameDraft}
        onCommitProjectRename={handleCommitWorkspaceProjectRename}
        onCancelProjectRename={handleCancelWorkspaceProjectRename}
        onSetProjectPinned={handleSetWorkspaceProjectPinned}
        onRemoveProject={handleRemoveWorkspaceProject}
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
        onStartRenaming={handleStartRenaming}
        onRenameDraftChange={setRenameDraft}
        onCommitRename={handleCommitRename}
        onCancelRename={handleCancelRename}
        onSetPinned={handleSetPinned}
        canShareConversations={canShareHistory}
        sharedConversationCount={sharedHistoryItems.length}
        onShareConversation={handleOpenShareModal}
        onOpenSharedConversations={handleOpenSharedHistoryManager}
        onDeleteConversation={handleDeleteConversation}
        onLoadMore={loadMoreHistory}
        onCloseSidebar={handleCloseSidebar}
        onOpenSkillsHub={() => {
          cacheActiveComposerDraft();
          setProjectToolsPanelOpen(false);
          setActiveView("skills-hub");
        }}
        onOpenMcpHub={() => {
          cacheActiveComposerDraft();
          setProjectToolsPanelOpen(false);
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

      {/* ---- Main content ---- */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
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
            <MacOsTitleBarSpacer />
            <div className="relative z-20">
              <ChatHeader
                settings={settings}
                hasModels={hasModels}
                currentModelLabel={currentModelLabel}
                modelOptions={modelOptions}
                selectedValue={selectedValue}
                sidebarOpen={sidebarOpen}
                setSettings={setSettings}
                onOpenSettings={onOpenSettings}
                onToggleTheme={onToggleTheme}
                onOpenSidebar={handleOpenSidebar}
                trailingActions={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setProjectToolsPanelOpen((open) => !open)}
                    disabled={Boolean(terminalDisabledMessage) && !projectToolsPanelOpen}
                    aria-expanded={projectToolsPanelOpen}
                    title={
                      projectToolsPanelOpen
                        ? "Collapse project tools panel"
                        : (terminalDisabledMessage ?? "Expand project tools panel")
                    }
                    className={`relative h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95 ${
                      projectToolsPanelOpen ? "bg-muted text-foreground" : ""
                    }`}
                  >
                    {projectToolsPanelOpen ? (
                      <PanelRightClose className="h-4.5 w-4.5" />
                    ) : (
                      <PanelRightOpen className="h-4.5 w-4.5" />
                    )}
                    {projectTerminalSessions.length > 0 ? (
                      <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold leading-none text-white">
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
              scrollAreaRef={scrollAreaRef}
              bottomRef={bottomRef}
              hasModels={hasModels}
              historyItems={historyRenderItems}
              isHistorySwitching={Boolean(historySwitchOverlay)}
              isSending={isSending}
              isAgentMode={isAgentMode}
              showUsage={isAgentDevExecutionMode}
              usageContextWindow={currentModelContextWindow}
              liveTranscriptStore={liveTranscriptStore}
              isCompactionRunning={isCompactionRunning}
              copiedMessageKey={copiedMessageKey}
              setCopiedMessageKey={setCopiedMessageKey}
              onResendFromEdit={handleResendFromEdit}
              onOpenSettings={onOpenSettings}
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
              gitClient={tauriGitClient}
              onGitChanged={(gitWorkdir) =>
                window.dispatchEvent(
                  new CustomEvent("liveagent:git-changed", {
                    detail: { workdir: gitWorkdir },
                  }),
                )
              }
              onSend={handleSend}
              onStop={handleStopSending}
              onComposerBusyChange={handleComposerBusyChange}
              onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
              onPickReadableFiles={pickReadableFiles}
              onPasteFiles={importReadableFiles}
              pendingUploadedFiles={pendingUploadedFiles}
              onRemovePendingUpload={removePendingUpload}
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
                    <div className="text-[15px] font-semibold leading-tight tracking-tight text-foreground">
                      {fileDropTitle}
                    </div>
                    <div className="max-w-[280px] text-xs leading-5 text-muted-foreground">
                      {fileDropDescription}
                    </div>
                  </div>

                  <div className="h-px w-12 bg-foreground/10 dark:bg-white/10" aria-hidden="true" />

                  <div
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
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
      <ProjectToolsPanel
        isOpen={activeView === "chat" && projectToolsPanelOpen}
        collapseImmediately={activeView !== "chat"}
        projectPathKey={terminalProjectPathKey}
        cwd={terminalProjectPath}
        sessions={projectTerminalSessions}
        width={settings.customSettings.projectToolsPanel.width}
        theme={settings.theme}
        disabledMessage={terminalDisabledMessage}
        activeTab={settings.customSettings.projectToolsPanel.activeTab}
        tabOrder={getProjectToolsPanelTabOrder(settings.customSettings, terminalProjectPathKey)}
        fileTreeOpen={isProjectToolsFileTreeOpen(settings.customSettings, terminalProjectPathKey)}
        fileTreeState={getProjectToolsFileTreeProjectState(
          settings.customSettings,
          terminalProjectPathKey,
        )}
        gitReviewOpen={isProjectToolsGitReviewOpen(settings.customSettings, terminalProjectPathKey)}
        client={tauriTerminalClient}
        gitClient={tauriGitClient}
        gitWriteEnabled
        onWidthChange={(nextWidth) =>
          setSettings((prev) =>
            updateCustomSettings(prev, {
              projectToolsPanel: {
                ...prev.customSettings.projectToolsPanel,
                width: nextWidth,
              },
            }),
          )
        }
        onActiveTabChange={(activeTab) =>
          setSettings((prev) =>
            updateCustomSettings(prev, {
              projectToolsPanel: {
                ...prev.customSettings.projectToolsPanel,
                activeTab,
              },
            }),
          )
        }
        onTabOrderChange={(tabOrder) =>
          setSettings((prev) =>
            updateProjectToolsPanelTabOrder(prev, terminalProjectPathKey, tabOrder),
          )
        }
        onFileTreeOpenChange={(open) =>
          setSettings((prev) => updateProjectToolsFileTreeOpen(prev, terminalProjectPathKey, open))
        }
        onFileTreeStateChange={(patch) =>
          setSettings((prev) =>
            updateProjectToolsFileTreeProjectState(prev, terminalProjectPathKey, patch),
          )
        }
        onGitReviewOpenChange={(open) =>
          setSettings((prev) => updateProjectToolsGitReviewOpen(prev, terminalProjectPathKey, open))
        }
        onSessionsChange={setProjectTerminalSessions}
        onInsertFileMention={(path, kind) => {
          composerRef.current?.insertFileMention(path, kind);
          composerRef.current?.focus();
        }}
        onInsertCommitMention={(commit) => {
          composerRef.current?.insertCommitMention(commit);
          composerRef.current?.focus();
        }}
        onInsertGitFileMention={(file) => {
          composerRef.current?.insertGitFileMention(file);
          composerRef.current?.focus();
        }}
      />
    </div>
  );
}
