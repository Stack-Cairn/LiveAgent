import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  Ban,
  ChevronDown,
  Loader2,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  Terminal,
  Upload,
  User,
} from "./components/icons";

import type { ChatHistorySummary } from "@/lib/chat/chatHistory";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles, withPastedTextDisplayMetadata } from "@/lib/chat/uploadedFiles";
import { registerLocalUploadedImagePreviews } from "@/lib/chat/uploadedImagePreview";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectToolsPanel } from "@/components/project-tools/ProjectToolsPanel";
import type { WorkspaceCodeEditorOpenRequest } from "@/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceImagePreviewOpenRequest } from "@/components/workspace-editor/WorkspaceImagePreviewOverlay";
import { isWorkspaceImagePath } from "@/components/workspace-editor/workspaceImagePreview";
import { LocaleContext, t as translate } from "@/i18n";
import type {
  MentionComposerCommitMention,
  MentionComposerDraft,
  MentionComposerGitFileMention,
  MentionComposerHandle,
  MentionComposerLargePaste,
} from "@/components/chat/MentionComposer";
import { ChatHistorySidebar } from "@/components/chat/ChatHistorySidebar";
import { SharedHistoryManagerModal } from "@/components/chat/SharedHistoryManagerModal";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatComposerBar } from "@/pages/chat/ChatComposerBar";
import { ChatHeader } from "@/pages/chat/ChatHeader";
import { SkillsHubPage } from "@/pages/skills-hub/SkillsHubPage";
import { McpHubPage } from "@/pages/mcp-hub/McpHubPage";
import type { SectionId } from "@/pages/settings/types";
import { useChatSkills } from "@/pages/chat/useChatSkills";
import { mergeAlwaysEnabledSkillNames } from "@/lib/skills";
import { buildModelOptions, sortHistoryItems } from "@/lib/chat/chatPageHelpers";
import { SettingsPage } from "@/pages/SettingsPage";
import {
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getProjectToolsFileTreeProjectState,
  getProjectToolsPanelTabOrder,
  isAgentDevMode,
  isProjectToolsFileTreeOpen,
  isProjectToolsGitReviewOpen,
  normalizeChatRuntimeControlsForProvider,
  normalizeSettings,
  removeProjectToolsProjectState,
  resolveWorkspaceProjects,
  workspaceProjectPathKey,
  updateChatRuntimeControlsForProvider,
  updateCustomSettings,
  updateProjectToolsFileTreeProjectState,
  updateProjectToolsFileTreeOpen,
  updateProjectToolsGitReviewOpen,
  updateProjectToolsPanelTabOrder,
  type AppSettings,
  type ChatRuntimeControls,
  type CustomProvider,
  type SelectedModel,
  type WorkspaceProject,
  DEFAULT_WORKSPACE_PROJECT_ID,
} from "@/lib/settings";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncPayload,
  redactSettingsForWebStorage,
  type GatewaySettingsSyncPayload,
} from "@/lib/settings/sync";
import { toModelValue } from "@/lib/providers/llm";

import { getGatewayWebSocketClient, resetGatewayWebSocketClient } from "./lib/gatewaySocket";
import { createGatewayGitClient } from "./lib/git/gatewayGitClient";
import { createGatewayTerminalClient } from "./lib/terminal/gatewayTerminalClient";
import {
  applyTerminalEventToSessions,
  replaceTerminalSessionsForProject,
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "./lib/terminal/sessionStore";
import type { TerminalSession } from "./lib/terminal/types";
import type {
  AgentStatus,
  ChatEvent,
  ConversationSummary,
  GatewayHistoryEvent,
  GatewaySelectedModel,
  HistoryDetail,
  HistoryShareStatus,
  HistoryWorkdirSummary,
} from "./lib/gatewayTypes";
import {
  filterConversationSummariesForScope,
  historyConversationMatchesFilter,
} from "./lib/chat/historyListScope";
import {
  buildOptimisticConversationTitle,
  formatConversationTitle,
  resolveConversationBrowserTitle,
  type ChatEntry,
} from "./lib/chatUi";
import { parseHistoryMessagesJsonAsync } from "./lib/historyParser";
import {
  isChatStreamNotAvailableEvent,
  isChatStreamNotAvailableMessage,
  resolveChatStreamUnavailableRecoveryAction,
} from "./lib/chatStreamRecovery";
import {
  appendCommittedLiveEntries,
  hasEquivalentTailEntries,
  mergeHistorySnapshotEntries,
} from "./lib/liveConversationCommit";
import {
  createLocalDraftConversationId,
  isLocalDraftConversationId,
} from "./lib/localDraftConversation";
import {
  createLiveConversationStreamStore,
  type LiveConversationStreamStore,
} from "./lib/liveConversationStreamStore";
import {
  lockMonacoNlsLocale,
  preparePreferredMonacoNlsLocale,
  setPreferredMonacoNlsLocale,
} from "./lib/monacoNls";
import {
  applyGatewayHistoryEvent,
  normalizeRunningConversations,
  reconcileConversationSummaries,
  upsertConversationSummary,
} from "./lib/historySync";
import { clearToken, loadToken, saveToken } from "./lib/storage";
import { loadWebSettings, persistWebSettings, type WebSettingsSaveState } from "./lib/webSettings";
import {
  clipboardHasFileSignal,
  extractClipboardFiles,
  readClipboardFiles,
} from "./lib/clipboardFiles";
import { importReadableFiles } from "./lib/uploadReadableFiles";
import { normalizeGatewayAccessToken, verifyGatewayAccessToken } from "./lib/gatewayAuth";
import { parseHistoryShareToken } from "./lib/historyShare";
import { GatewayTranscript } from "./components/GatewayTranscript";
import { HistoryShareModal } from "./components/chat/HistoryShareModal";
import { useGatewayScrollAffordance } from "./components/useGatewayScrollAffordance";
import { LoginPage } from "./pages/LoginPage";
import { SharedHistoryPage } from "./pages/SharedHistoryPage";
import { WorkdirPickerModal } from "./pages/settings/WorkdirPickerModal";
import {
  applyWorkspaceProjectConversationActivityMap,
  buildWorkspaceProjectActivityUpdatedAts,
  fallbackWorkspaceProjectName,
  findWorkspaceProject,
  mergeWorkspaceProjectActivityUpdatedAts,
  mergeWorkspaceProjectsWithHistory,
  workspaceProjectActivityUpdatedAtsEqual,
} from "./lib/workspaceProjects";

type ReloadHistoryOptions = {
  preferredConversationId?: string;
  hydrateSelection?: boolean;
  skipSelectionSync?: boolean;
  silent?: boolean;
  adoptPendingDraftConversation?: boolean;
};

type OverlayState = "closed" | "entering" | "open" | "leaving";
type LiveConversationStreamMeta = {
  hasStream: boolean;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
};
type ConversationRuntimeEntry = {
  messages: ChatEntry[];
  error: string | null;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
  isSending: boolean;
  workdir?: string;
};

type RunningConversationRuntime = {
  workdir?: string;
  updatedAt: number;
};

const WorkspaceCodeEditorOverlay = lazy(async () => {
  await preparePreferredMonacoNlsLocale();
  const module = await import("@/components/workspace-editor/WorkspaceCodeEditorOverlay");
  lockMonacoNlsLocale();
  return {
    default: module.WorkspaceCodeEditorOverlay,
  };
});

const WorkspaceImagePreviewOverlay = lazy(async () => {
  const module = await import("@/components/workspace-editor/WorkspaceImagePreviewOverlay");
  return {
    default: module.WorkspaceImagePreviewOverlay,
  };
});

const MAX_UPLOAD_FILES = 9;

function dragEventHasFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function formatTranslation(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

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

async function importPastedTextsAsFiles(params: {
  token: string;
  workdir: string;
  pastes: MentionComposerLargePaste[];
}) {
  const { token, workdir, pastes } = params;
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) {
    throw new Error("项目目录未选择，无法发送大段粘贴内容。");
  }
  if (pastes.length === 0) {
    return {
      files: [],
      fileByPasteId: new Map<string, PendingUploadedFile>(),
    };
  }

  const textFiles = pastes.map(
    (paste, index) =>
      new File([paste.text], buildPastedTextFileName(paste, index), {
        type: "text/plain",
      }),
  );
  const response = await importReadableFiles(token, normalizedWorkdir, textFiles);
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

type PendingDraftConversationMigration = {
  draftConversationId: string;
  startedAt: number;
};

type SendChatOptions = {
  conversationId?: string;
  clientRequestId?: string;
  uploadedFiles?: PendingUploadedFile[];
  runtimeControls?: ChatRuntimeControls;
  workdir?: string;
};

type SendChatFn = (message: string, options?: SendChatOptions) => Promise<void>;

const PROTECTED_DRAFT_CONVERSATION = "__protected_draft__";
const HISTORY_LIST_PAGE_SIZE = 80;
const HISTORY_LIST_MIN_LOADING_MS = 260;
const HISTORY_DETAIL_INITIAL_MAX_MESSAGES = 360;
const HISTORY_SWITCH_OVERLAY_MIN_MS = 260;
const PROJECT_HISTORY_DELETE_PAGE_SIZE = 200;
const SHARED_HISTORY_LIST_PAGE_SIZE = 200;
const HISTORY_TITLE_POSITION_LOCK_MS = 1200;
const SECONDS_TIMESTAMP_MAX = 10_000_000_000;
const DRAFT_HISTORY_ADOPTION_WINDOW_MS = 30_000;
const LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS = 30_000;
const DEFAULT_BROWSER_TITLE = "LiveAgent Gateway";
const NEW_CONVERSATION_BROWSER_TITLE = "LiveAgent";
const SHARED_HISTORY_BROWSER_TITLE = "分享会话";
const SKILLS_HUB_BROWSER_TITLE = "Skills Hub";
const MCP_HUB_BROWSER_TITLE = "MCP Hub";

function HistorySwitchLoadingOverlay(props: { locale: AppSettings["locale"] }) {
  const label = props.locale === "en-US" ? "Loading conversation..." : "正在加载对话...";

  return (
    <div
      className="gateway-history-switch-overlay"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="gateway-history-switch-overlay-card">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}

type ModelProviderSource = Pick<CustomProvider, "id" | "name" | "type" | "activeModels">;

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? "").trim();
  return text || fallback;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForMinimumHistoryListLoading(startedAt: number) {
  const elapsed = Date.now() - startedAt;
  const remainingMs = Math.max(0, HISTORY_LIST_MIN_LOADING_MS - elapsed);
  if (remainingMs > 0) {
    await wait(remainingMs);
  }
}

function normalizeOptionalStatus(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function normalizeGatewayTimestampMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value < SECONDS_TIMESTAMP_MAX ? value * 1000 : value;
}

function isAbortError(error: unknown) {
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("已取消") ||
    normalized.includes("abort") ||
    normalized.includes("aborted")
  );
}

function pickConversationSummary(
  conversations: ConversationSummary[],
  conversationId: string,
): ConversationSummary | null {
  return conversations.find((item) => item.id === conversationId) ?? null;
}

function readChatEventTitle(event: ChatEvent): string {
  if ("title" in event && typeof event.title === "string") {
    return event.title.trim();
  }
  return "";
}

function isChatEventTitleFinal(event: ChatEvent) {
  return event.type === "done" || ("titleFinal" in event && event.titleFinal === true);
}

function isTerminalChatEvent(event: ChatEvent) {
  return event.type === "done" || event.type === "error";
}

function buildGatewaySelectedModel(
  selectedModel: SelectedModel | undefined,
  providers: ModelProviderSource[],
): GatewaySelectedModel | undefined {
  if (!selectedModel) {
    return undefined;
  }

  const provider = providers.find((item) => item.id === selectedModel.customProviderId);
  if (!provider) {
    return undefined;
  }

  return {
    customProviderId: provider.id,
    model: selectedModel.model,
    providerType: provider.type,
  };
}

function buildGatewaySystemSettings(settings: AppSettings, workdirOverride?: string) {
  return {
    executionMode: settings.system.executionMode,
    workdir: workdirOverride ?? settings.system.workdir.trim(),
    selectedSystemTools: [...settings.system.selectedSystemTools],
  };
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

function hasSettingsSyncChanged(prev: AppSettings, next: AppSettings) {
  return (
    JSON.stringify(buildGatewaySettingsSyncPayload(prev)) !==
    JSON.stringify(buildGatewaySettingsSyncPayload(next))
  );
}

function hasProviderApiKeyUpdates(settings: AppSettings) {
  return settings.customProviders.some((provider) => provider.apiKey.trim().length > 0);
}

function resolveAppWorkspaceProjects(settings: AppSettings): AppSettings {
  return {
    ...settings,
    system: resolveWorkspaceProjects(
      settings.system,
      getDefaultWorkspaceProjectPath(settings.system),
    ),
  };
}

function resolveConversationTitle(
  summary: ConversationSummary | null,
  fallbackConversationId: string,
) {
  return formatConversationTitle(summary, fallbackConversationId);
}

function toChatHistorySummary(
  item: ConversationSummary,
  selectedModel?: SelectedModel | null,
): ChatHistorySummary {
  return {
    id: item.id,
    title: resolveConversationTitle(item, item.id),
    providerId: item.provider_id ?? selectedModel?.customProviderId ?? "gateway",
    model: item.model ?? selectedModel?.model ?? "gateway",
    sessionId: item.session_id || undefined,
    cwd: item.cwd || undefined,
    messageCount: item.message_count,
    createdAt: item.created_at * 1000,
    updatedAt: item.updated_at * 1000,
    isPinned: item.is_pinned === true,
    pinnedAt: item.pinned_at && item.pinned_at > 0 ? item.pinned_at * 1000 : undefined,
    isShared: item.is_shared === true,
  };
}

function hasLocalDraftConversation(params: {
  conversationId: string;
  selectedHistoryId: string;
  requestedConversationId?: string;
  chatMessageCount: number;
  pendingUploadCount: number;
  draftPinned: boolean;
}) {
  const {
    conversationId,
    selectedHistoryId,
    requestedConversationId = "",
    chatMessageCount,
    pendingUploadCount,
    draftPinned,
  } = params;

  const isDraftConversation = conversationId === "" || isLocalDraftConversationId(conversationId);
  const isDraftSelected = selectedHistoryId === "" || selectedHistoryId === conversationId;

  return (
    isDraftConversation &&
    isDraftSelected &&
    requestedConversationId === "" &&
    (draftPinned || chatMessageCount > 0 || pendingUploadCount > 0)
  );
}

function createConversationRuntimeEntry(
  input?: Partial<ConversationRuntimeEntry>,
): ConversationRuntimeEntry {
  const toolStatus = normalizeOptionalStatus(input?.toolStatus);
  return {
    messages: input?.messages ?? [],
    error: input?.error ?? null,
    toolStatus,
    toolStatusIsCompaction: toolStatus ? input?.toolStatusIsCompaction === true : false,
    isSending: input?.isSending ?? false,
    workdir: input?.workdir?.trim() || undefined,
  };
}

function historyMessageRefsEqual(a: HistoryMessageRef | undefined, b: HistoryMessageRef) {
  return a?.segmentIndex === b.segmentIndex && a?.messageIndex === b.messageIndex;
}

function truncateChatEntriesFromMessageRef(entries: ChatEntry[], messageRef: HistoryMessageRef) {
  const targetIndex = entries.findIndex(
    (entry) => entry.kind === "user" && historyMessageRefsEqual(entry.messageRef, messageRef),
  );
  if (targetIndex < 0) {
    return entries;
  }
  return entries.slice(0, targetIndex);
}

function resolveVisibleConversationId(selectedHistoryId: string, conversationId: string) {
  const selectedId = selectedHistoryId.trim();
  if (selectedId) {
    return selectedId;
  }
  return conversationId.trim();
}

const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 820px)";

function isMobileSidebarLayout() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches;
}

function shouldOpenSidebarByDefault() {
  return !isMobileSidebarLayout();
}

function hasDetachedHistorySelection(selectedHistoryId: string, conversationId: string) {
  const selectedId = selectedHistoryId.trim();
  const activeConversationId = conversationId.trim();
  return selectedId !== "" && selectedId !== activeConversationId;
}

function uploadedFilesEqual(left: PendingUploadedFile[], right: PendingUploadedFile[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((file, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      file.relativePath === other.relativePath &&
      file.fileName === other.fileName &&
      file.kind === other.kind &&
      file.sizeBytes === other.sizeBytes
    );
  });
}

function findUserMessageRefByOrdinal(
  entries: ChatEntry[],
  userOrdinal: number,
  text: string,
  uploadedFiles: PendingUploadedFile[],
) {
  if (userOrdinal < 0) {
    return null;
  }
  const userEntries = entries.filter((entry) => entry.kind === "user");
  const ordinalEntry = userEntries[userOrdinal];
  if (
    ordinalEntry?.messageRef &&
    ordinalEntry.text === text &&
    uploadedFilesEqual(ordinalEntry.attachments, uploadedFiles)
  ) {
    return ordinalEntry.messageRef;
  }

  for (let index = userEntries.length - 1; index >= 0; index -= 1) {
    const entry = userEntries[index];
    if (
      entry?.messageRef &&
      entry.text === text &&
      uploadedFilesEqual(entry.attachments, uploadedFiles)
    ) {
      return entry.messageRef;
    }
  }

  return null;
}

export default function App() {
  const historyShareToken = useMemo(() => parseHistoryShareToken(), []);
  const initialStoredTokenRef = useRef(historyShareToken ? "" : loadToken());
  const [token, setToken] = useState("");
  const [loginToken, setLoginToken] = useState(initialStoredTokenRef.current);
  const [authSubmitting, setAuthSubmitting] = useState(
    () => normalizeGatewayAccessToken(initialStoredTokenRef.current) !== "",
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const api = useMemo(() => (token ? getGatewayWebSocketClient(token) : null), [token]);
  const terminalClient = useMemo(() => (api ? createGatewayTerminalClient(api) : null), [api]);
  const gitClient = useMemo(() => (api ? createGatewayGitClient(api) : null), [api]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatToolStatus, setChatToolStatus] = useState<string | null>(null);
  const [chatToolStatusIsCompaction, setChatToolStatusIsCompaction] = useState(false);
  const [historyListLoading, setHistoryListLoading] = useState(false);
  const [historyListLoadingMore, setHistoryListLoadingMore] = useState(false);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyMutating, setHistoryMutating] = useState(false);
  const [historyItems, setHistoryItems] = useState<ConversationSummary[]>([]);
  const [historyWorkdirs, setHistoryWorkdirs] = useState<HistoryWorkdirSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [localRunningConversationIds, setLocalRunningConversationIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [remoteRunningConversationIds, setRemoteRunningConversationIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [remoteRunningConversationRuntime, setRemoteRunningConversationRuntime] = useState<
    ReadonlyMap<string, RunningConversationRuntime>
  >(() => new Map());
  const [projectActivityUpdatedAtOverrides, setProjectActivityUpdatedAtOverrides] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [liveConversationStreamMeta, setLiveConversationStreamMetaState] = useState<
    Record<string, LiveConversationStreamMeta>
  >({});
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(null);
  const [selectedHistoryEntries, setSelectedHistoryEntries] = useState<ChatEntry[]>([]);
  const [historySwitchOverlay, setHistorySwitchOverlay] = useState<{
    conversationId: string;
    startedAt: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [overlay, setOverlay] = useState<OverlayState>("closed");
  const [settings, setSettingsState] = useState<AppSettings>(() => loadWebSettings(loadToken()));
  // Monaco reads NLS globals while the lazy editor module imports monaco-editor.
  setPreferredMonacoNlsLocale(settings.locale);
  const [settingsSyncReady, setSettingsSyncReady] = useState(() => token.trim() === "");
  const [settingsSyncError, setSettingsSyncError] = useState<string | null>(null);
  const [settingsSaveState, setSettingsSaveState] = useState<WebSettingsSaveState>({
    status: "saved",
  });
  const isAgentMode = settings.system.executionMode !== "text";
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
        : { cwdEmpty: true },
    [activeWorkspaceProjectPath, isAgentMode],
  );
  const historyScopeKey = isAgentMode
    ? `cwd:${activeWorkspaceProjectPath || "__liveagent_no_project__"}`
    : "cwd-empty";
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
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
  const [sharedHistoryItems, setSharedHistoryItems] = useState<ChatHistorySummary[]>([]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [pendingUploadedFiles, setPendingUploadedFiles] = useState<PendingUploadedFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const [activeView, setActiveView] = useState<"chat" | "skills-hub" | "mcp-hub">("chat");
  const [projectToolsPanelOpen, setProjectToolsPanelOpen] = useState(false);
  const previousProjectToolsFileTreeOpenRef = useRef(false);
  const [workspaceEditorMounted, setWorkspaceEditorMounted] = useState(false);
  const [workspaceEditorOpen, setWorkspaceEditorOpen] = useState(false);
  const [workspaceEditorCleanupPending, setWorkspaceEditorCleanupPending] = useState(false);
  const [workspaceEditorOpenRequest, setWorkspaceEditorOpenRequest] =
    useState<WorkspaceCodeEditorOpenRequest | null>(null);
  const [workspaceEditorCloseRequestId, setWorkspaceEditorCloseRequestId] = useState(0);
  const workspaceEditorRequestIdRef = useRef(0);
  const [workspaceImagePreviewMounted, setWorkspaceImagePreviewMounted] = useState(false);
  const [workspaceImagePreviewOpen, setWorkspaceImagePreviewOpen] = useState(false);
  const [workspaceImagePreviewOpenRequest, setWorkspaceImagePreviewOpenRequest] =
    useState<WorkspaceImagePreviewOpenRequest | null>(null);
  const workspaceImagePreviewRequestIdRef = useRef(0);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();
  const terminalSessionsVersionRef = useRef(0);
  const terminalStatusSessionIdRef = useRef("");
  const {
    scrollAreaRef: transcriptScrollAreaRef,
    showJumpToBottom: showTranscriptJumpToBottom,
    jumpToBottom: jumpTranscriptToBottom,
    stickToBottom: stickTranscriptToBottom,
    isAtBottom: isTranscriptAtBottom,
    syncAutoScroll: syncTranscriptAutoScroll,
    refreshScrollState: refreshTranscriptScrollState,
    preserveScrollPosition: preserveTranscriptScrollPosition,
  } = useGatewayScrollAffordance();
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const conversationIdRef = useRef(conversationId);
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  const chatBusyRef = useRef(chatBusy);
  const chatMessagesRef = useRef(chatMessages);
  const chatErrorRef = useRef(chatError);
  const chatToolStatusRef = useRef(chatToolStatus);
  const chatToolStatusIsCompactionRef = useRef(chatToolStatusIsCompaction);
  const selectedHistoryRef = useRef(selectedHistory);
  const historyItemsRef = useRef(historyItems);
  const historyTotalRef = useRef(historyTotal);
  const historyHasMoreRef = useRef(historyHasMore);
  const historyListFilterRef = useRef(historyListFilter);
  const historyScopeKeyRef = useRef(historyScopeKey);
  const nextHistoryPageRef = useRef(1);
  const historyListPageLoadingRef = useRef(false);
  const sharedHistoryItemsRef = useRef<ChatHistorySummary[]>([]);
  const sharedHistoryListRequestRef = useRef<Promise<ChatHistorySummary[]> | null>(null);
  const pendingUploadedFilesRef = useRef(pendingUploadedFiles);
  const isUploadingFilesRef = useRef(isUploadingFiles);
  const uploadDragDepthRef = useRef(0);
  const localRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());
  const remoteRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());
  const remoteRunningConversationRuntimeRef = useRef<
    ReadonlyMap<string, RunningConversationRuntime>
  >(new Map());
  const liveConversationStreamStoresRef = useRef<Map<string, LiveConversationStreamStore>>(
    new Map(),
  );
  const liveConversationStreamMetaRef = useRef<Record<string, LiveConversationStreamMeta>>({});
  const conversationRuntimeCacheRef = useRef<Map<string, ConversationRuntimeEntry>>(new Map());
  const displayedConversationWorkdirRef = useRef("");
  const conversationAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const attachedConversationControllersRef = useRef<Map<string, AbortController>>(new Map());
  const completedLiveStreamConversationAtRef = useRef<Map<string, number>>(new Map());
  const completedLiveStreamCleanupTimersRef = useRef<Map<string, number>>(new Map());
  const pendingHistoryRefreshAfterLiveCompletionRef = useRef<Set<string>>(new Set());
  const optimisticTitleConversationIdsRef = useRef<Set<string>>(new Set());
  const titlePositionLockedConversationIdsRef = useRef<Set<string>>(new Set());
  const titlePositionLockTimeoutsRef = useRef<Map<string, number>>(new Map());
  const blockedHistoryHydrationConversationIdsRef = useRef<Set<string>>(new Set());
  const visibleHistorySnapshotRefreshSeqRef = useRef<Map<string, number>>(new Map());
  const historyLoadSequenceRef = useRef(0);
  const visibleConversationRevisionRef = useRef(0);
  const previousDisplayedConversationIdRef = useRef("");
  const pendingDisplayedConversationAutoBottomRef = useRef<string | null>(null);
  const draftConversationPinnedRef = useRef(false);
  const protectedConversationRef = useRef("");
  const chatStartLocksRef = useRef<Set<string>>(new Set());
  const submitInFlightRef = useRef(false);
  const pendingDraftConversationMigrationRef = useRef<PendingDraftConversationMigration | null>(
    null,
  );
  const sendChatRef = useRef<SendChatFn | null>(null);
  const settingsSaveSequenceRef = useRef(0);
  const settingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const isImportingPastedTextRef = useRef(false);
  const persistProjectConversationActivityRef = useRef(
    (_activity: ReadonlyMap<string, number>) => undefined as void,
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
      setProjectActivityUpdatedAtOverrides((current) => {
        if ((current.get(pathKey) ?? 0) >= nextUpdatedAt) {
          return current;
        }
        return mergeWorkspaceProjectActivityUpdatedAts(
          current,
          new Map([[pathKey, nextUpdatedAt]]),
        );
      });
      persistProjectConversationActivityRef.current(new Map([[pathKey, nextUpdatedAt]]));
    },
    [],
  );

  useEffect(() => {
    const historyActivity = buildWorkspaceProjectActivityUpdatedAts(historyWorkdirs);
    if (historyActivity.size === 0) {
      return;
    }
    setProjectActivityUpdatedAtOverrides((current) => {
      const next = mergeWorkspaceProjectActivityUpdatedAts(current, historyActivity);
      return workspaceProjectActivityUpdatedAtsEqual(current, next) ? current : next;
    });
    persistProjectConversationActivityRef.current(historyActivity);
  }, [historyWorkdirs]);

  function getVisibleComposerConversationId() {
    return resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current);
  }

  function cacheVisibleComposerDraft(conversationId = getVisibleComposerConversationId()) {
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

  function clearCachedComposerDraft(conversationId = getVisibleComposerConversationId()) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    composerDraftCacheRef.current.delete(targetConversationId);
  }

  const commitHistoryListState = useCallback(
    (conversations: ConversationSummary[], total: number, nextPage: number, hasMore?: boolean) => {
      const scopedConversations = filterConversationSummariesForScope(
        conversations,
        historyListFilterRef.current,
      );
      const nextTotal = Math.max(0, total);
      const nextHasMore = hasMore ?? scopedConversations.length < nextTotal;

      historyItemsRef.current = scopedConversations;
      historyTotalRef.current = nextTotal;
      historyHasMoreRef.current = nextHasMore;
      nextHistoryPageRef.current = Math.max(1, nextPage);
      setHistoryItems(scopedConversations);
      setHistoryTotal(nextTotal);
      setHistoryHasMore(nextHasMore);
    },
    [],
  );

  const updateHistoryItems = useCallback(
    (updater: (current: ConversationSummary[]) => ConversationSummary[]) => {
      const current = historyItemsRef.current;
      const next = filterConversationSummariesForScope(
        updater(current),
        historyListFilterRef.current,
      );
      const delta = next.length - current.length;
      commitHistoryListState(
        next,
        Math.max(next.length, historyTotalRef.current + delta),
        nextHistoryPageRef.current,
      );
    },
    [commitHistoryListState],
  );

  const unlockHistoryTitlePosition = useCallback((conversationIdValue: string) => {
    const conversationId = conversationIdValue.trim();
    if (!conversationId) {
      return;
    }
    const timeoutId = titlePositionLockTimeoutsRef.current.get(conversationId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      titlePositionLockTimeoutsRef.current.delete(conversationId);
    }
    titlePositionLockedConversationIdsRef.current.delete(conversationId);
  }, []);

  const lockHistoryTitlePosition = useCallback((conversationIdValue: string) => {
    const conversationId = conversationIdValue.trim();
    if (!conversationId) {
      return;
    }

    const existingTimeoutId = titlePositionLockTimeoutsRef.current.get(conversationId);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    titlePositionLockedConversationIdsRef.current.add(conversationId);
    const timeoutId = window.setTimeout(() => {
      titlePositionLockTimeoutsRef.current.delete(conversationId);
      titlePositionLockedConversationIdsRef.current.delete(conversationId);
    }, HISTORY_TITLE_POSITION_LOCK_MS);
    titlePositionLockTimeoutsRef.current.set(conversationId, timeoutId);
  }, []);

  const getHistoryPositionLockedConversationIds = useCallback(() => {
    const conversationIds = new Set<string>();
    const appendConversationIds = (ids: Iterable<string>) => {
      for (const id of ids) {
        const conversationId = id.trim();
        if (conversationId) {
          conversationIds.add(conversationId);
        }
      }
    };

    appendConversationIds(optimisticTitleConversationIdsRef.current);
    appendConversationIds(titlePositionLockedConversationIdsRef.current);
    appendConversationIds(blockedHistoryHydrationConversationIdsRef.current);
    return conversationIds;
  }, []);

  const clearHistoryTitlePositionLocks = useCallback(() => {
    for (const timeoutId of titlePositionLockTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    titlePositionLockTimeoutsRef.current.clear();
    titlePositionLockedConversationIdsRef.current.clear();
  }, []);

  useEffect(() => clearHistoryTitlePositionLocks, [clearHistoryTitlePositionLocks]);

  useEffect(() => {
    const storedToken = normalizeGatewayAccessToken(initialStoredTokenRef.current);
    if (!storedToken) {
      return;
    }

    let cancelled = false;
    setAuthError(null);
    resetGatewayWebSocketClient();

    void verifyGatewayAccessToken(storedToken)
      .then((verifiedToken) => {
        if (cancelled) {
          return;
        }
        initialStoredTokenRef.current = verifiedToken;
        saveToken(verifiedToken);
        setLoginToken(verifiedToken);
        setSettingsSyncReady(false);
        setSettingsSyncError(null);
        setToken(verifiedToken);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        initialStoredTokenRef.current = "";
        clearToken();
        resetGatewayWebSocketClient();
        setToken("");
        setAuthError(asErrorMessage(error, "Access Token 验证失败。"));
        setLoginToken(storedToken);
      })
      .finally(() => {
        if (!cancelled) {
          setAuthSubmitting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    selectedHistoryIdRef.current = selectedHistoryId;
  }, [selectedHistoryId]);

  useEffect(() => {
    chatBusyRef.current = chatBusy;
  }, [chatBusy]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    chatErrorRef.current = chatError;
  }, [chatError]);

  useEffect(() => {
    chatToolStatusRef.current = chatToolStatus;
  }, [chatToolStatus]);

  useEffect(() => {
    chatToolStatusIsCompactionRef.current = chatToolStatusIsCompaction;
  }, [chatToolStatusIsCompaction]);

  useEffect(() => {
    selectedHistoryRef.current = selectedHistory;
  }, [selectedHistory]);

  useEffect(() => {
    historyItemsRef.current = historyItems;
  }, [historyItems]);

  useEffect(() => {
    historyTotalRef.current = historyTotal;
  }, [historyTotal]);

  useEffect(() => {
    historyHasMoreRef.current = historyHasMore;
  }, [historyHasMore]);

  useEffect(() => {
    historyListFilterRef.current = historyListFilter;
    if (historyScopeKeyRef.current === historyScopeKey) {
      return;
    }
    historyScopeKeyRef.current = historyScopeKey;
    historyListPageLoadingRef.current = false;
    commitHistoryListState([], 0, 1, false);
    setHistoryError(null);
    setHistoryListLoading(true);
  }, [commitHistoryListState, historyListFilter, historyScopeKey]);

  useEffect(() => {
    pendingUploadedFilesRef.current = pendingUploadedFiles;
  }, [pendingUploadedFiles]);

  useEffect(() => {
    isUploadingFilesRef.current = isUploadingFiles;
  }, [isUploadingFiles]);

  useEffect(() => {
    localRunningConversationIdsRef.current = localRunningConversationIds;
  }, [localRunningConversationIds]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", settings.theme === "dark");
  }, [settings.theme]);

  const applyLiveConversationTitle = useCallback(
    (
      targetConversationId: string,
      nextTitle: string,
      options?: {
        isFinal?: boolean;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      const title = nextTitle.trim();
      if (!conversationIdValue || !title) {
        return;
      }

      const updatedAt = Date.now();
      lockHistoryTitlePosition(conversationIdValue);
      if (options?.isFinal) {
        optimisticTitleConversationIdsRef.current.delete(conversationIdValue);
      }
      updateHistoryItems((current) => {
        const existing = pickConversationSummary(current, conversationIdValue);
        return upsertConversationSummary(
          current,
          {
            id: conversationIdValue,
            title,
            created_at: existing?.created_at ?? updatedAt,
            updated_at: existing?.updated_at ?? updatedAt,
            message_count: existing?.message_count ?? 1,
          },
          { preserveExistingUpdatedAt: existing !== null },
        );
      });
    },
    [lockHistoryTitlePosition, updateHistoryItems],
  );

  const applyChatToolStatus = useCallback(
    (nextStatus: string | null | undefined, isCompaction = false) => {
      const status = typeof nextStatus === "string" ? nextStatus.trim() : "";
      setChatToolStatus(status || null);
      setChatToolStatusIsCompaction(Boolean(status) && isCompaction);
    },
    [],
  );

  const getConversationLiveStreamStore = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return null;
    }
    const existing = liveConversationStreamStoresRef.current.get(conversationIdValue);
    if (existing) {
      return existing;
    }
    const created = createLiveConversationStreamStore();
    liveConversationStreamStoresRef.current.set(conversationIdValue, created);
    return created;
  }, []);

  const updateLiveConversationStreamMeta = useCallback(
    (
      targetConversationId: string,
      updater: (previous: LiveConversationStreamMeta) => LiveConversationStreamMeta,
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }
      const previous = liveConversationStreamMetaRef.current[conversationIdValue] ?? {
        hasStream: false,
        toolStatus: null,
        toolStatusIsCompaction: false,
      };
      const next = updater(previous);
      if (
        previous.hasStream === next.hasStream &&
        previous.toolStatus === next.toolStatus &&
        previous.toolStatusIsCompaction === next.toolStatusIsCompaction
      ) {
        return;
      }
      const nextRecord = {
        ...liveConversationStreamMetaRef.current,
        [conversationIdValue]: next,
      };
      liveConversationStreamMetaRef.current = nextRecord;
      setLiveConversationStreamMetaState(nextRecord);
    },
    [],
  );

  const markLiveConversationStreamActive = useCallback(
    (targetConversationId: string) => {
      updateLiveConversationStreamMeta(targetConversationId, (previous) =>
        previous.hasStream ? previous : { ...previous, hasStream: true },
      );
    },
    [updateLiveConversationStreamMeta],
  );

  const setLiveConversationStreamStatus = useCallback(
    (targetConversationId: string, nextStatus: string | null | undefined, isCompaction = false) => {
      const status = normalizeOptionalStatus(nextStatus);
      updateLiveConversationStreamMeta(targetConversationId, (previous) => ({
        ...previous,
        toolStatus: status,
        toolStatusIsCompaction: Boolean(status) && isCompaction,
      }));
    },
    [updateLiveConversationStreamMeta],
  );

  const clearLiveConversationStreamMeta = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue || !liveConversationStreamMetaRef.current[conversationIdValue]) {
      return;
    }
    const nextRecord = { ...liveConversationStreamMetaRef.current };
    delete nextRecord[conversationIdValue];
    liveConversationStreamMetaRef.current = nextRecord;
    setLiveConversationStreamMetaState(nextRecord);
  }, []);

  const buildVisibleRuntimeEntry = useCallback(
    () =>
      createConversationRuntimeEntry({
        messages: chatMessagesRef.current,
        error: chatErrorRef.current,
        toolStatus: chatToolStatusRef.current,
        toolStatusIsCompaction: chatToolStatusIsCompactionRef.current,
        isSending: chatBusyRef.current,
        workdir: conversationRuntimeCacheRef.current.get(conversationIdRef.current.trim())?.workdir,
      }),
    [],
  );

  const syncVisibleConversationRuntime = useCallback(
    (targetConversationId: string, entry: ConversationRuntimeEntry) => {
      conversationIdRef.current = targetConversationId;
      selectedHistoryIdRef.current = targetConversationId;
      chatMessagesRef.current = entry.messages;
      chatErrorRef.current = entry.error;
      chatToolStatusRef.current = entry.toolStatus;
      chatToolStatusIsCompactionRef.current = entry.toolStatusIsCompaction;
      chatBusyRef.current = entry.isSending;
      setConversationId(targetConversationId);
      setSelectedHistoryId(targetConversationId);
      setChatMessages(entry.messages);
      setChatError(entry.error);
      applyChatToolStatus(entry.toolStatus, entry.toolStatusIsCompaction);
      setChatBusy(entry.isSending);
    },
    [applyChatToolStatus],
  );

  const cacheVisibleConversationRuntime = useCallback(
    (targetConversationId?: string) => {
      const conversationIdValue = (targetConversationId ?? conversationIdRef.current).trim();
      if (!conversationIdValue) {
        return;
      }
      conversationRuntimeCacheRef.current.set(conversationIdValue, buildVisibleRuntimeEntry());
    },
    [buildVisibleRuntimeEntry],
  );

  const updateConversationRuntimeEntry = useCallback(
    (
      targetConversationId: string,
      updater: (previous: ConversationRuntimeEntry) => ConversationRuntimeEntry,
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return createConversationRuntimeEntry();
      }

      const previous =
        conversationIdRef.current === conversationIdValue &&
        (selectedHistoryIdRef.current === "" ||
          selectedHistoryIdRef.current === conversationIdValue)
          ? buildVisibleRuntimeEntry()
          : (conversationRuntimeCacheRef.current.get(conversationIdValue) ??
            createConversationRuntimeEntry());
      const next = createConversationRuntimeEntry(updater(previous));
      conversationRuntimeCacheRef.current.set(conversationIdValue, next);

      if (
        conversationIdRef.current === conversationIdValue &&
        (selectedHistoryIdRef.current === "" ||
          selectedHistoryIdRef.current === conversationIdValue)
      ) {
        chatMessagesRef.current = next.messages;
        chatErrorRef.current = next.error;
        chatToolStatusRef.current = next.toolStatus;
        chatToolStatusIsCompactionRef.current = next.toolStatusIsCompaction;
        chatBusyRef.current = next.isSending;
        setChatMessages(next.messages);
        setChatError(next.error);
        applyChatToolStatus(next.toolStatus, next.toolStatusIsCompaction);
        setChatBusy(next.isSending);
      }

      return next;
    },
    [applyChatToolStatus, buildVisibleRuntimeEntry],
  );

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
    if (
      chatBusyRef.current ||
      localRunningConversationIdsRef.current.has(conversationIdValue) ||
      remoteRunningConversationIdsRef.current.has(conversationIdValue)
    ) {
      return;
    }
    if (chatMessagesRef.current.length > 0 || pendingUploadedFilesRef.current.length > 0) {
      return;
    }
    const currentWorkdir =
      conversationRuntimeCacheRef.current.get(conversationIdValue)?.workdir?.trim() || "";
    if (currentWorkdir === nextWorkdir) {
      return;
    }
    updateConversationRuntimeEntry(conversationIdValue, (current) => ({
      ...current,
      workdir: nextWorkdir,
    }));
  }, [activeWorkspaceProjectPath, isAgentMode, updateConversationRuntimeEntry]);

  const setConversationRunningState = useCallback(
    (targetConversationId: string, isRunning: boolean) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }

      const runtimeWorkdir =
        conversationRuntimeCacheRef.current.get(conversationIdValue)?.workdir?.trim() || "";
      const persistedWorkdir =
        historyItemsRef.current.find((item) => item.id === conversationIdValue)?.cwd?.trim() || "";
      recordProjectActivity(runtimeWorkdir || persistedWorkdir, Date.now());

      updateConversationRuntimeEntry(conversationIdValue, (previous) => ({
        ...previous,
        isSending: isRunning,
      }));
      setLocalRunningConversationIds((current) => {
        const hasConversation = current.has(conversationIdValue);
        if ((isRunning && hasConversation) || (!isRunning && !hasConversation)) {
          return current;
        }
        const next = new Set(current);
        if (isRunning) {
          next.add(conversationIdValue);
        } else {
          next.delete(conversationIdValue);
        }
        localRunningConversationIdsRef.current = next;
        return next;
      });
    },
    [recordProjectActivity, updateConversationRuntimeEntry],
  );

  const setConversationAbortController = useCallback(
    (targetConversationId: string, controller: AbortController | null) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }
      if (controller) {
        conversationAbortControllersRef.current.set(conversationIdValue, controller);
        return;
      }
      conversationAbortControllersRef.current.delete(conversationIdValue);
    },
    [],
  );

  const getConversationAbortController = useCallback((targetConversationId: string) => {
    return conversationAbortControllersRef.current.get(targetConversationId.trim()) ?? null;
  }, []);

  const clearConversationLiveStream = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }
      liveConversationStreamStoresRef.current.get(conversationIdValue)?.reset();
      liveConversationStreamStoresRef.current.delete(conversationIdValue);
      pendingHistoryRefreshAfterLiveCompletionRef.current.delete(conversationIdValue);
      clearLiveConversationStreamMeta(conversationIdValue);
    },
    [clearLiveConversationStreamMeta],
  );

  const clearAllConversationLiveStreams = useCallback(() => {
    liveConversationStreamStoresRef.current.forEach((store) => store.reset());
    liveConversationStreamStoresRef.current.clear();
    pendingHistoryRefreshAfterLiveCompletionRef.current.clear();
    liveConversationStreamMetaRef.current = {};
    setLiveConversationStreamMetaState({});
  }, []);

  const hasRetainedConversationLiveStream = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return false;
    }
    const store = liveConversationStreamStoresRef.current.get(conversationIdValue);
    return (
      liveConversationStreamMetaRef.current[conversationIdValue]?.hasStream === true ||
      (store?.getSnapshot().entries.length ?? 0) > 0
    );
  }, []);

  const commitConversationLiveStreamToRuntime = useCallback(
    (
      targetConversationId: string,
      options?: {
        clearLiveStream?: boolean;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return false;
      }

      const liveStore = liveConversationStreamStoresRef.current.get(conversationIdValue);
      liveStore?.flush();
      const liveEntries = liveStore?.getSnapshot().entries ?? [];
      if (liveEntries.length === 0) {
        if (options?.clearLiveStream) {
          clearConversationLiveStream(conversationIdValue);
        }
        return false;
      }

      updateConversationRuntimeEntry(conversationIdValue, (current) => {
        const nextMessages = appendCommittedLiveEntries(current.messages, liveEntries);
        if (nextMessages === current.messages) {
          return current;
        }
        return {
          ...current,
          messages: nextMessages,
        };
      });

      const selectedConversationId = selectedHistoryIdRef.current.trim();
      const visibleConversationId = conversationIdRef.current.trim();
      if (
        selectedConversationId === conversationIdValue &&
        visibleConversationId !== conversationIdValue
      ) {
        setSelectedHistoryEntries((current) => appendCommittedLiveEntries(current, liveEntries));
      }

      if (options?.clearLiveStream) {
        clearConversationLiveStream(conversationIdValue);
      }
      return true;
    },
    [clearConversationLiveStream, updateConversationRuntimeEntry],
  );

  const refreshVisibleConversationHistorySnapshot = useCallback(
    async (targetConversationId: string, currentApi = api, options?: { allowIdle?: boolean }) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }

      const isStillVisible = () =>
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
        conversationIdValue;

      if (
        !isStillVisible() ||
        getConversationAbortController(conversationIdValue) !== null ||
        localRunningConversationIdsRef.current.has(conversationIdValue)
      ) {
        return;
      }

      const refreshSeq =
        (visibleHistorySnapshotRefreshSeqRef.current.get(conversationIdValue) ?? 0) + 1;
      visibleHistorySnapshotRefreshSeqRef.current.set(conversationIdValue, refreshSeq);

      let detail: HistoryDetail;
      let entries: ChatEntry[];
      try {
        detail = await currentApi.getHistory(conversationIdValue, {
          maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
        });
        entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
      } catch {
        return;
      }

      if (
        visibleHistorySnapshotRefreshSeqRef.current.get(conversationIdValue) !== refreshSeq ||
        !isStillVisible() ||
        getConversationAbortController(conversationIdValue) !== null ||
        localRunningConversationIdsRef.current.has(conversationIdValue) ||
        (options?.allowIdle !== true &&
          !remoteRunningConversationIdsRef.current.has(conversationIdValue) &&
          !hasRetainedConversationLiveStream(conversationIdValue))
      ) {
        return;
      }

      const detailConversationId = detail.conversation_id.trim();
      if (detailConversationId !== "" && detailConversationId !== conversationIdValue) {
        return;
      }

      // `has_more === false` tells us the server returned the full
      // conversation — any local entries that don't reconcile with it (e.g.
      // a peer truncated the conversation and resent) must yield to the
      // server, otherwise the stale tail collides with the new live stream
      // and produces duplicate assistant content in the transcript.
      const isFullSnapshot = detail.has_more === false;
      const mergeOptions = { isFullSnapshot };
      const liveStore = liveConversationStreamStoresRef.current.get(conversationIdValue);
      const liveSnapshotEntries = liveStore?.getSnapshot().entries ?? [];
      // Only treat a non-matching live snapshot as stale when it's the
      // post-`done` retention from a previously completed stream on THIS
      // client. For a second webui that's catching up to a peer's in-flight
      // stream via attachChat, the live snapshot legitimately holds events
      // the server has not persisted yet — wiping it here would destroy the
      // in-flight content and leave the joiner staring at a blank transcript
      // until the stream ends.
      //
      // Inlined instead of calling `hasRecentlyCompletedLiveStream` because
      // that helper is declared later in this component (TDZ); the marker
      // ref it reads has its own setTimeout-based expiry so we don't need
      // the helper's lazy-cleanup side effect here.
      const liveStreamCompletedAt =
        completedLiveStreamConversationAtRef.current.get(conversationIdValue);
      const liveSnapshotIsCompletedRetention =
        typeof liveStreamCompletedAt === "number" &&
        Date.now() - liveStreamCompletedAt <= LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS;
      const liveStreamConflictsWithSnapshot =
        isFullSnapshot &&
        liveSnapshotEntries.length > 0 &&
        liveSnapshotIsCompletedRetention &&
        !hasEquivalentTailEntries(entries, liveSnapshotEntries);

      if (selectedHistoryIdRef.current.trim() === conversationIdValue) {
        selectedHistoryRef.current = detail;
        setSelectedHistory(detail);
        setSelectedHistoryEntries((current) =>
          mergeHistorySnapshotEntries(current, entries, mergeOptions),
        );
      }

      updateConversationRuntimeEntry(conversationIdValue, (current) => {
        const nextMessages = mergeHistorySnapshotEntries(current.messages, entries, mergeOptions);
        if (nextMessages === current.messages) {
          return current;
        }
        return {
          ...current,
          messages: nextMessages,
        };
      });

      // Once we've replaced the runtime from an authoritative full snapshot,
      // discard any retained live snapshot that no longer fits the new
      // server-side timeline. Without this the post-`done` retention from the
      // previous turn lives on alongside the freshly fetched history, which
      // is exactly what produces the duplicated assistant bubble after a
      // peer's edit-and-resend.
      if (liveStreamConflictsWithSnapshot) {
        clearConversationLiveStream(conversationIdValue);
      }
    },
    [
      api,
      clearConversationLiveStream,
      getConversationAbortController,
      hasRetainedConversationLiveStream,
      updateConversationRuntimeEntry,
    ],
  );

  const migrateConversationLiveStream = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      const previousStore = liveConversationStreamStoresRef.current.get(previousId);
      if (previousStore) {
        liveConversationStreamStoresRef.current.delete(previousId);
        liveConversationStreamStoresRef.current.set(nextId, previousStore);
      }

      const previousMeta = liveConversationStreamMetaRef.current[previousId];
      if (!previousMeta) {
        return;
      }
      const nextRecord = { ...liveConversationStreamMetaRef.current };
      delete nextRecord[previousId];
      nextRecord[nextId] = previousMeta;
      liveConversationStreamMetaRef.current = nextRecord;
      setLiveConversationStreamMetaState(nextRecord);
    },
    [],
  );

  const markVisibleConversationRevision = useCallback(() => {
    visibleConversationRevisionRef.current += 1;
    return visibleConversationRevisionRef.current;
  }, []);

  const invalidateHistoryLoad = useCallback(() => {
    historyLoadSequenceRef.current += 1;
    return historyLoadSequenceRef.current;
  }, []);

  const migrateConversationRuntime = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      const previousRuntime =
        conversationRuntimeCacheRef.current.get(previousId) ??
        (conversationIdRef.current === previousId ? buildVisibleRuntimeEntry() : null);
      if (previousRuntime) {
        conversationRuntimeCacheRef.current.set(nextId, previousRuntime);
      }
      conversationRuntimeCacheRef.current.delete(previousId);

      const controller = conversationAbortControllersRef.current.get(previousId);
      if (controller) {
        conversationAbortControllersRef.current.delete(previousId);
        conversationAbortControllersRef.current.set(nextId, controller);
      }

      setLocalRunningConversationIds((current) => {
        if (!current.has(previousId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(previousId);
        next.add(nextId);
        localRunningConversationIdsRef.current = next;
        return next;
      });

      migrateConversationLiveStream(previousId, nextId);

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
      if (blockedHistoryHydrationConversationIdsRef.current.delete(previousId)) {
        blockedHistoryHydrationConversationIdsRef.current.add(nextId);
      }
    },
    [buildVisibleRuntimeEntry, migrateConversationLiveStream],
  );

  const migrateConversationSummary = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      const shouldPreserveOptimisticTitle =
        optimisticTitleConversationIdsRef.current.delete(previousId);
      if (shouldPreserveOptimisticTitle) {
        optimisticTitleConversationIdsRef.current.add(nextId);
      }
      if (titlePositionLockedConversationIdsRef.current.has(previousId)) {
        unlockHistoryTitlePosition(previousId);
        lockHistoryTitlePosition(nextId);
      }

      updateHistoryItems((current) => {
        const previousSummary = pickConversationSummary(current, previousId);
        if (!previousSummary) {
          return current;
        }

        const nextSummary = pickConversationSummary(current, nextId);
        const mergedSummary = {
          ...previousSummary,
          ...(nextSummary ?? {}),
          id: nextId,
          title: shouldPreserveOptimisticTitle
            ? previousSummary.title
            : nextSummary?.title?.trim() || previousSummary.title,
          provider_id: nextSummary?.provider_id || previousSummary.provider_id,
          model: nextSummary?.model || previousSummary.model,
          session_id: nextSummary?.session_id || previousSummary.session_id,
          cwd: nextSummary?.cwd || previousSummary.cwd,
          is_pinned: nextSummary?.is_pinned ?? previousSummary.is_pinned,
          pinned_at:
            "pinned_at" in (nextSummary ?? {}) ? nextSummary?.pinned_at : previousSummary.pinned_at,
          is_shared: nextSummary?.is_shared ?? previousSummary.is_shared,
        };
        const withoutMigratedRows = current.filter(
          (item) => item.id !== previousId && item.id !== nextId,
        );
        return upsertConversationSummary(withoutMigratedRows, mergedSummary, {
          preserveExistingTitle: shouldPreserveOptimisticTitle,
        });
      });
    },
    [lockHistoryTitlePosition, unlockHistoryTitlePosition, updateHistoryItems],
  );

  const getActivePendingDraftMigration = useCallback(() => {
    const pending = pendingDraftConversationMigrationRef.current;
    if (!pending) {
      return null;
    }

    const draftId = pending.draftConversationId.trim();
    if (
      !draftId ||
      !isLocalDraftConversationId(draftId) ||
      conversationIdRef.current.trim() !== draftId ||
      selectedHistoryIdRef.current.trim() !== draftId ||
      protectedConversationRef.current.trim() !== draftId
    ) {
      return null;
    }

    const isDraftInFlight =
      localRunningConversationIdsRef.current.has(draftId) ||
      getConversationAbortController(draftId) !== null ||
      blockedHistoryHydrationConversationIdsRef.current.has(draftId);
    if (!isDraftInFlight) {
      return null;
    }

    return pending;
  }, [getConversationAbortController]);

  const isRecentPendingDraftConversation = useCallback(
    (
      conversation: Pick<ConversationSummary, "created_at" | "updated_at"> | undefined,
      pending: PendingDraftConversationMigration,
    ) => {
      const createdAt = normalizeGatewayTimestampMs(conversation?.created_at);
      const updatedAt = normalizeGatewayTimestampMs(conversation?.updated_at);
      const conversationTimestamp = createdAt || updatedAt;
      return (
        conversationTimestamp <= 0 ||
        conversationTimestamp >= pending.startedAt - DRAFT_HISTORY_ADOPTION_WINDOW_MS
      );
    },
    [],
  );

  const shouldSuppressPendingDraftBroadcast = useCallback(
    (targetConversationId: string) => {
      const targetId = targetConversationId.trim();
      const pending = getActivePendingDraftMigration();
      if (!pending || !targetId || isLocalDraftConversationId(targetId)) {
        return false;
      }
      if (targetId === pending.draftConversationId.trim()) {
        return false;
      }

      const existing = pickConversationSummary(historyItemsRef.current, targetId);
      if (existing && !isRecentPendingDraftConversation(existing, pending)) {
        return false;
      }

      return true;
    },
    [getActivePendingDraftMigration, isRecentPendingDraftConversation],
  );

  const maybeAdoptActiveDraftConversation = useCallback(
    (conversation: ConversationSummary | undefined) => {
      const nextId = conversation?.id?.trim() ?? "";
      const pending = getActivePendingDraftMigration();
      if (!pending || !nextId || isLocalDraftConversationId(nextId)) {
        return false;
      }

      const draftId = pending.draftConversationId.trim();
      if (!draftId || draftId === nextId) {
        return false;
      }

      if (!isRecentPendingDraftConversation(conversation, pending)) {
        return false;
      }

      pendingDraftConversationMigrationRef.current = null;
      migrateConversationRuntime(draftId, nextId);
      migrateConversationSummary(draftId, nextId);
      return true;
    },
    [
      getActivePendingDraftMigration,
      isRecentPendingDraftConversation,
      migrateConversationRuntime,
      migrateConversationSummary,
    ],
  );

  const adoptPendingDraftConversationFromHistoryList = useCallback(
    (conversations: ConversationSummary[]) => {
      for (const conversation of conversations) {
        if (maybeAdoptActiveDraftConversation(conversation)) {
          return conversation.id.trim();
        }
      }
      return "";
    },
    [maybeAdoptActiveDraftConversation],
  );

  useEffect(() => {
    setSettingsState((prev) =>
      resolveAppWorkspaceProjects(
        normalizeSettings({
          ...prev,
          remote: {
            ...prev.remote,
            gatewayUrl: window.location.origin,
            token: token.trim(),
            enabled: token.trim() !== "" || prev.remote.enabled,
          },
        }),
      ),
    );
  }, [token]);

  const queueSettingsSave = useCallback(
    (next: AppSettings, fallback: string, syncGateway: boolean) => {
      const saveSequence = ++settingsSaveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });
      const redactedNext = redactSettingsForWebStorage(next);

      settingsSaveChainRef.current = settingsSaveChainRef.current
        .catch(() => undefined)
        .then(() => {
          persistWebSettings(redactedNext);
        })
        .then(async () => {
          if (syncGateway && api) {
            await api.updateSettings(
              buildGatewaySettingsSyncPayload(next, {
                includeProviderApiKeyUpdates: true,
              }),
            );
          }
        })
        .then(() => {
          if (settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({ status: "saved" });
          }
        })
        .catch((error) => {
          if (settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({
              status: "error",
              message: asErrorMessage(error, fallback),
            });
          }
        });
    },
    [api],
  );

  const applyGatewaySettings = useCallback(
    (payload: GatewaySettingsSyncPayload) => {
      setSettingsState((prev) => {
        const rawNext = resolveAppWorkspaceProjects(applyGatewaySettingsSyncPayload(prev, payload));
        const next = redactSettingsForWebStorage(rawNext);
        if (!hasSettingsSyncChanged(prev, next)) {
          return prev;
        }
        queueSettingsSave(next, "同步桌面端设置失败。", false);
        return next;
      });
    },
    [queueSettingsSave],
  );

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      setSettingsState((prev) => {
        const rawNext = resolveAppWorkspaceProjects(normalizeSettings(updater(prev)));
        const next = redactSettingsForWebStorage(rawNext);
        queueSettingsSave(
          rawNext,
          "保存 WebUI 设置失败。",
          hasSettingsSyncChanged(prev, next) || hasProviderApiKeyUpdates(rawNext),
        );
        return next;
      });
    },
    [queueSettingsSave],
  );

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
  persistProjectConversationActivityRef.current = persistProjectConversationActivity;

  const refreshHistoryWorkdirs = useCallback(
    async (currentApi = api) => {
      if (!currentApi) {
        setHistoryWorkdirs([]);
        return;
      }
      try {
        const response = await currentApi.listHistoryWorkdirs();
        setHistoryWorkdirs(response.workdirs);
      } catch (error) {
        console.warn("Failed to load chat history workdirs", error);
      }
    },
    [api],
  );

  useEffect(() => {
    void refreshHistoryWorkdirs(api);
  }, [api, refreshHistoryWorkdirs]);

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
        startNewConversation({ workdir: targetProject.path });
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
      setProjectToolsPanelOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) =>
        updateProjectToolsFileTreeOpen(
          updateCustomSettings(prev, {
            projectToolsPanel: {
              ...prev.customSettings.projectToolsPanel,
              activeTab: "fileTree",
            },
          }),
          pathKey,
          true,
        ),
      );
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSettings],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  const handleWorkdirPickerSelect = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(normalizedPath, "managed"));
      void refreshHistoryWorkdirs(api);
    },
    [activateWorkspaceProject, api, refreshHistoryWorkdirs],
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
      return;
    }

    const unsubscribe = api.subscribeStatus((nextStatus, error) => {
      setStatus(nextStatus);
      setStatusError(error);
    });
    return () => {
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!api) {
      setSettingsSyncReady(token.trim() === "");
      setSettingsSyncError(null);
      return;
    }

    let cancelled = false;
    setSettingsSyncReady(false);
    setSettingsSyncError(null);
    const unsubscribe = api.subscribeSettings((payload) => {
      if (cancelled) {
        return;
      }
      applyGatewaySettings(payload);
      setSettingsSyncError(null);
    });

    void api
      .getSettings()
      .then((payload) => {
        if (!cancelled) {
          applyGatewaySettings(payload);
          setSettingsSyncReady(true);
          setSettingsSyncError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsSyncError(asErrorMessage(error, "同步桌面端设置失败"));
          setSettingsSyncReady(true);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, applyGatewaySettings, token]);

  useEffect(() => {
    remoteRunningConversationIdsRef.current = remoteRunningConversationIds;
  }, [remoteRunningConversationIds]);

  useEffect(() => {
    remoteRunningConversationRuntimeRef.current = remoteRunningConversationRuntime;
  }, [remoteRunningConversationRuntime]);

  const setRemoteConversationRunningState = useCallback(
    (
      targetConversationId: string,
      isRunning: boolean,
      runtime?: { workdir?: string; updatedAt?: number },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }
      const current = remoteRunningConversationIdsRef.current;
      const hasConversation = current.has(conversationIdValue);
      const existingRuntime = remoteRunningConversationRuntimeRef.current.get(conversationIdValue);
      const runtimeWorkdir = runtime?.workdir?.trim() || existingRuntime?.workdir || "";
      const runtimeUpdatedAt =
        typeof runtime?.updatedAt === "number" &&
        Number.isFinite(runtime.updatedAt) &&
        runtime.updatedAt > 0
          ? runtime.updatedAt
          : existingRuntime?.updatedAt || Date.now();
      recordProjectActivity(runtimeWorkdir, runtimeUpdatedAt);
      if (!isRunning && !hasConversation && !existingRuntime) {
        return;
      }
      if (!isRunning || !hasConversation) {
        const next = new Set(current);
        if (isRunning) {
          next.add(conversationIdValue);
        } else {
          next.delete(conversationIdValue);
        }
        remoteRunningConversationIdsRef.current = next;
        setRemoteRunningConversationIds(next);
      }

      setRemoteRunningConversationRuntime((currentRuntime) => {
        const existing = currentRuntime.get(conversationIdValue);
        if (!isRunning) {
          if (!existing) {
            return currentRuntime;
          }
          const nextRuntime = new Map(currentRuntime);
          nextRuntime.delete(conversationIdValue);
          remoteRunningConversationRuntimeRef.current = nextRuntime;
          return nextRuntime;
        }

        const nextRuntimeEntry: RunningConversationRuntime = {
          workdir: runtimeWorkdir || undefined,
          updatedAt: Math.max(existing?.updatedAt ?? 0, runtimeUpdatedAt),
        };
        if (
          existing?.workdir === nextRuntimeEntry.workdir &&
          existing?.updatedAt === nextRuntimeEntry.updatedAt
        ) {
          return currentRuntime;
        }
        const nextRuntime = new Map(currentRuntime);
        nextRuntime.set(conversationIdValue, nextRuntimeEntry);
        remoteRunningConversationRuntimeRef.current = nextRuntime;
        return nextRuntime;
      });
    },
    [recordProjectActivity],
  );

  const isConversationLiveStreamAttached = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    return (
      conversationIdValue !== "" &&
      attachedConversationControllersRef.current.has(conversationIdValue)
    );
  }, []);

  const stopAttachedConversationLiveStream = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return;
    }
    const controller = attachedConversationControllersRef.current.get(conversationIdValue);
    if (!controller) {
      return;
    }
    attachedConversationControllersRef.current.delete(conversationIdValue);
    controller.abort();
  }, []);

  const stopAllAttachedConversationLiveStreams = useCallback(() => {
    const controllers = [...attachedConversationControllersRef.current.values()];
    attachedConversationControllersRef.current.clear();
    for (const controller of controllers) {
      controller.abort();
    }
  }, []);

  const clearCompletedLiveStreamMarker = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return;
    }
    completedLiveStreamConversationAtRef.current.delete(conversationIdValue);
    const timeoutId = completedLiveStreamCleanupTimersRef.current.get(conversationIdValue);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      completedLiveStreamCleanupTimersRef.current.delete(conversationIdValue);
    }
  }, []);

  const clearAllCompletedLiveStreamMarkers = useCallback(() => {
    for (const timeoutId of completedLiveStreamCleanupTimersRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    completedLiveStreamCleanupTimersRef.current.clear();
    completedLiveStreamConversationAtRef.current.clear();
  }, []);

  const markCompletedLiveStream = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return;
    }
    const existingTimeoutId = completedLiveStreamCleanupTimersRef.current.get(conversationIdValue);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }
    completedLiveStreamConversationAtRef.current.set(conversationIdValue, Date.now());
    const timeoutId = window.setTimeout(() => {
      completedLiveStreamConversationAtRef.current.delete(conversationIdValue);
      completedLiveStreamCleanupTimersRef.current.delete(conversationIdValue);
    }, LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS);
    completedLiveStreamCleanupTimersRef.current.set(conversationIdValue, timeoutId);
  }, []);

  const hasRecentlyCompletedLiveStream = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return false;
      }
      const completedAt = completedLiveStreamConversationAtRef.current.get(conversationIdValue);
      if (typeof completedAt !== "number") {
        return false;
      }
      if (Date.now() - completedAt > LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS) {
        clearCompletedLiveStreamMarker(conversationIdValue);
        return false;
      }
      return true;
    },
    [clearCompletedLiveStreamMarker],
  );

  const clearConversationStreamingState = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }

      liveConversationStreamStoresRef.current
        .get(conversationIdValue)
        ?.setToolStatus(null, false, { flush: true });
      setLiveConversationStreamStatus(conversationIdValue, null);
      setRemoteConversationRunningState(conversationIdValue, false);
      setConversationAbortController(conversationIdValue, null);
      setConversationRunningState(conversationIdValue, false);
      updateConversationRuntimeEntry(conversationIdValue, (current) => {
        if (!current.isSending && current.toolStatus === null && !current.toolStatusIsCompaction) {
          return current;
        }
        return {
          ...current,
          isSending: false,
          toolStatus: null,
          toolStatusIsCompaction: false,
        };
      });
    },
    [
      setConversationAbortController,
      setConversationRunningState,
      setLiveConversationStreamStatus,
      setRemoteConversationRunningState,
      updateConversationRuntimeEntry,
    ],
  );

  const commitTerminalConversationLiveStream = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }

      const isVisibleConversation =
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
        conversationIdValue;
      const shouldKeepBottom = isVisibleConversation && isTranscriptAtBottom();

      if (!isVisibleConversation) {
        // Background broadcasts do not include the persisted user turn. Let
        // history.get be the source of truth when the user opens this chat.
        flushSync(() => {
          clearConversationLiveStream(conversationIdValue);
          clearConversationStreamingState(conversationIdValue);
        });
        return;
      }

      preserveTranscriptScrollPosition(
        () => {
          flushSync(() => {
            commitConversationLiveStreamToRuntime(conversationIdValue, {
              clearLiveStream: false,
            });
            clearConversationStreamingState(conversationIdValue);
          });
        },
        { stickToBottom: shouldKeepBottom },
      );

      if (shouldKeepBottom) {
        stickTranscriptToBottom();
      } else {
        refreshTranscriptScrollState();
      }
    },
    [
      clearConversationLiveStream,
      clearConversationStreamingState,
      commitConversationLiveStreamToRuntime,
      isTranscriptAtBottom,
      preserveTranscriptScrollPosition,
      refreshTranscriptScrollState,
      stickTranscriptToBottom,
    ],
  );

  const refreshHistoryAfterCompletedLiveStream = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return false;
      }
      if (!pendingHistoryRefreshAfterLiveCompletionRef.current.has(conversationIdValue)) {
        return false;
      }

      pendingHistoryRefreshAfterLiveCompletionRef.current.delete(conversationIdValue);
      void refreshVisibleConversationHistorySnapshot(conversationIdValue, currentApi, {
        allowIdle: true,
      });
      return true;
    },
    [api, refreshVisibleConversationHistorySnapshot],
  );

  const recoverUnavailableConversationStream = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }

      clearConversationLiveStream(conversationIdValue);
      clearConversationStreamingState(conversationIdValue);
      void refreshVisibleConversationHistorySnapshot(conversationIdValue, currentApi, {
        allowIdle: true,
      });
    },
    [
      api,
      clearConversationLiveStream,
      clearConversationStreamingState,
      refreshVisibleConversationHistorySnapshot,
    ],
  );

  const attachVisibleConversationLiveStream = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }
      if (isLocalDraftConversationId(conversationIdValue)) {
        return;
      }
      if (attachedConversationControllersRef.current.has(conversationIdValue)) {
        return;
      }
      if (!remoteRunningConversationIdsRef.current.has(conversationIdValue)) {
        return;
      }
      if (
        localRunningConversationIdsRef.current.has(conversationIdValue) ||
        getConversationAbortController(conversationIdValue) !== null
      ) {
        return;
      }
      if (
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) !==
        conversationIdValue
      ) {
        return;
      }

      const controller = new AbortController();
      attachedConversationControllersRef.current.set(conversationIdValue, controller);
      clearCompletedLiveStreamMarker(conversationIdValue);
      clearConversationLiveStream(conversationIdValue);
      void refreshVisibleConversationHistorySnapshot(conversationIdValue, currentApi);
      const liveStore = getConversationLiveStreamStore(conversationIdValue);
      if (!liveStore) {
        attachedConversationControllersRef.current.delete(conversationIdValue);
        return;
      }

      void (async () => {
        let terminalEventSeen = false;
        try {
          for await (const event of currentApi.attachChat(conversationIdValue, {
            afterSeq: 0,
            signal: controller.signal,
          })) {
            if (controller.signal.aborted) {
              return;
            }

            const eventConversationId = event.conversation_id?.trim() || conversationIdValue;
            const liveTitle = readChatEventTitle(event);
            if (liveTitle && isChatEventTitleFinal(event)) {
              applyLiveConversationTitle(eventConversationId, liveTitle, {
                isFinal: true,
              });
            }

            if (event.type === "tool_status") {
              const normalizedStatus = normalizeOptionalStatus(event.status);
              const isCompaction = normalizedStatus !== null && event.isCompaction === true;
              liveStore.setToolStatus(normalizedStatus, isCompaction);
              setLiveConversationStreamStatus(conversationIdValue, normalizedStatus, isCompaction);
              continue;
            }

            if (isChatStreamNotAvailableEvent(event)) {
              terminalEventSeen = true;
              recoverUnavailableConversationStream(conversationIdValue, currentApi);
              return;
            }

            liveStore.appendEvent(event, {
              flush: event.type === "done" || event.type === "error",
            });

            if (event.type === "done" || event.type === "error") {
              terminalEventSeen = true;
              markCompletedLiveStream(conversationIdValue);
              commitTerminalConversationLiveStream(conversationIdValue);
              refreshHistoryAfterCompletedLiveStream(conversationIdValue, currentApi);
              return;
            }

            markLiveConversationStreamActive(conversationIdValue);
          }
        } catch (error) {
          if (!isAbortError(error)) {
            const message = asErrorMessage(error, "chat attach failed");
            if (isChatStreamNotAvailableMessage(message)) {
              terminalEventSeen = true;
              recoverUnavailableConversationStream(conversationIdValue, currentApi);
              return;
            }
            liveStore.appendEvent(
              {
                type: "error",
                message,
                conversation_id: conversationIdValue,
              },
              { flush: true },
            );
            terminalEventSeen = true;
            markCompletedLiveStream(conversationIdValue);
            commitTerminalConversationLiveStream(conversationIdValue);
            refreshHistoryAfterCompletedLiveStream(conversationIdValue, currentApi);
          }
        } finally {
          if (attachedConversationControllersRef.current.get(conversationIdValue) === controller) {
            attachedConversationControllersRef.current.delete(conversationIdValue);
          }
          if (!terminalEventSeen && controller.signal.aborted) {
            liveStore.flush();
          }
          if (!terminalEventSeen && !controller.signal.aborted) {
            liveStore.flush();
            clearConversationStreamingState(conversationIdValue);
            setLiveConversationStreamStatus(conversationIdValue, null);
          }
        }
      })();
    },
    [
      api,
      applyLiveConversationTitle,
      clearCompletedLiveStreamMarker,
      clearConversationLiveStream,
      clearConversationStreamingState,
      commitTerminalConversationLiveStream,
      getConversationAbortController,
      getConversationLiveStreamStore,
      markCompletedLiveStream,
      markLiveConversationStreamActive,
      recoverUnavailableConversationStream,
      refreshHistoryAfterCompletedLiveStream,
      refreshVisibleConversationHistorySnapshot,
      setLiveConversationStreamStatus,
    ],
  );

  useEffect(() => {
    if (!api) {
      remoteRunningConversationIdsRef.current = new Set();
      setRemoteRunningConversationIds(new Set());
      remoteRunningConversationRuntimeRef.current = new Map();
      setRemoteRunningConversationRuntime(new Map());
      stopAllAttachedConversationLiveStreams();
      clearAllCompletedLiveStreamMarkers();
      clearAllConversationLiveStreams();
      return;
    }

    const unsubscribe = api.subscribeHistory((event: GatewayHistoryEvent) => {
      const targetConversationId = event.conversation_id.trim();
      if (!targetConversationId) {
        return;
      }

      if (
        (event.kind === "running" || event.kind === "idle") &&
        shouldSuppressPendingDraftBroadcast(targetConversationId)
      ) {
        return;
      }

      if (event.kind === "running" || event.kind === "idle") {
        setRemoteConversationRunningState(targetConversationId, event.kind === "running", {
          workdir: event.conversation?.cwd,
          updatedAt: event.conversation?.updated_at,
        });
        if (event.kind === "running") {
          if (!isConversationLiveStreamAttached(targetConversationId)) {
            clearConversationLiveStream(targetConversationId);
          }
          attachVisibleConversationLiveStream(targetConversationId, api);
          return;
        }

        void refreshHistoryWorkdirs(api);

        if (hasRecentlyCompletedLiveStream(targetConversationId)) {
          return;
        }

        const visibleConversationId = resolveVisibleConversationId(
          selectedHistoryIdRef.current,
          conversationIdRef.current,
        );
        const isHistoryHydrationBlocked =
          blockedHistoryHydrationConversationIdsRef.current.has(targetConversationId) ||
          getConversationAbortController(targetConversationId) !== null;
        const hasLocalDraft =
          pendingUploadedFilesRef.current.length > 0 ||
          (composerRef.current?.hasContent() ?? false);
        const hasRetainedLiveTranscript = hasRetainedConversationLiveStream(targetConversationId);
        if (
          visibleConversationId === targetConversationId &&
          !isHistoryHydrationBlocked &&
          !chatBusyRef.current &&
          !hasLocalDraft &&
          !hasRetainedLiveTranscript
        ) {
          void refreshVisibleConversationHistorySnapshot(targetConversationId, api, {
            allowIdle: true,
          });
        } else if (!hasRetainedLiveTranscript) {
          clearConversationLiveStream(targetConversationId);
        }
        return;
      }

      if (event.kind === "upsert") {
        recordProjectActivity(event.conversation.cwd, event.conversation.updated_at);
        maybeAdoptActiveDraftConversation(event.conversation);
      }

      const matchesCurrentHistoryScope =
        event.kind !== "upsert" ||
        historyConversationMatchesFilter(event.conversation, historyListFilterRef.current);
      updateHistoryItems((current) => {
        if (event.kind === "upsert" && !matchesCurrentHistoryScope) {
          return current.filter((item) => item.id !== targetConversationId);
        }
        return applyGatewayHistoryEvent(current, event, {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
        });
      });
      if (event.kind === "upsert" || event.kind === "delete" || event.kind === "idle") {
        void refreshHistoryWorkdirs(api);
      }
      setHistoryError(null);
      setRemoteRunningConversationIds((current) => {
        if (event.kind !== "delete" || !current.has(targetConversationId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(targetConversationId);
        remoteRunningConversationIdsRef.current = next;
        return next;
      });
      if (event.kind === "delete") {
        setRemoteRunningConversationRuntime((current) => {
          if (!current.has(targetConversationId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(targetConversationId);
          remoteRunningConversationRuntimeRef.current = next;
          return next;
        });
      }

      // Keep the current draft/selection stable: remote changes only refresh
      // the recent-conversations list unless they target the active row.
      if (event.kind === "delete") {
        optimisticTitleConversationIdsRef.current.delete(targetConversationId);
        unlockHistoryTitlePosition(targetConversationId);
        stopAttachedConversationLiveStream(targetConversationId);
        clearCompletedLiveStreamMarker(targetConversationId);
        clearConversationLiveStream(targetConversationId);
        if (
          conversationIdRef.current === targetConversationId ||
          selectedHistoryIdRef.current === targetConversationId
        ) {
          startNewConversation({
            workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
          });
        }
        return;
      }

      const visibleConversationId = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      );
      const isRemoteConversationRunning =
        remoteRunningConversationIdsRef.current.has(targetConversationId);
      const isHistoryHydrationBlocked =
        blockedHistoryHydrationConversationIdsRef.current.has(targetConversationId) ||
        getConversationAbortController(targetConversationId) !== null;
      const hasLocalDraft =
        pendingUploadedFilesRef.current.length > 0 || (composerRef.current?.hasContent() ?? false);
      if (
        event.kind === "upsert" &&
        visibleConversationId === targetConversationId &&
        !isRemoteConversationRunning &&
        hasRecentlyCompletedLiveStream(targetConversationId)
      ) {
        pendingHistoryRefreshAfterLiveCompletionRef.current.delete(targetConversationId);
        // The visible transcript already contains the committed live stream;
        // refresh the persisted snapshot so remote observers also receive the
        // user turn that is not part of chat stream events.
        void refreshVisibleConversationHistorySnapshot(targetConversationId, api, {
          allowIdle: true,
        });
        return;
      }
      if (
        event.kind === "upsert" &&
        visibleConversationId === targetConversationId &&
        isRemoteConversationRunning &&
        !isHistoryHydrationBlocked &&
        !localRunningConversationIdsRef.current.has(targetConversationId)
      ) {
        pendingHistoryRefreshAfterLiveCompletionRef.current.add(targetConversationId);
        attachVisibleConversationLiveStream(targetConversationId, api);
        void refreshVisibleConversationHistorySnapshot(targetConversationId, api);
      }
      if (
        event.kind === "upsert" &&
        visibleConversationId === targetConversationId &&
        !isRemoteConversationRunning &&
        !isHistoryHydrationBlocked &&
        !chatBusyRef.current &&
        !hasLocalDraft &&
        !hasRetainedConversationLiveStream(targetConversationId)
      ) {
        void refreshVisibleConversationHistorySnapshot(targetConversationId, api, {
          allowIdle: true,
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    api,
    activeWorkspaceProjectPath,
    attachVisibleConversationLiveStream,
    clearAllCompletedLiveStreamMarkers,
    clearAllConversationLiveStreams,
    clearCompletedLiveStreamMarker,
    clearConversationLiveStream,
    getConversationAbortController,
    getHistoryPositionLockedConversationIds,
    hasRecentlyCompletedLiveStream,
    hasRetainedConversationLiveStream,
    isAgentMode,
    isConversationLiveStreamAttached,
    maybeAdoptActiveDraftConversation,
    recordProjectActivity,
    refreshVisibleConversationHistorySnapshot,
    refreshHistoryWorkdirs,
    setRemoteConversationRunningState,
    shouldSuppressPendingDraftBroadcast,
    stopAllAttachedConversationLiveStreams,
    stopAttachedConversationLiveStream,
    unlockHistoryTitlePosition,
    updateHistoryItems,
  ]);

  useEffect(() => {
    if (!api) {
      clearAllConversationLiveStreams();
      return;
    }

    const unsubscribe = api.subscribeConversation((event) => {
      const targetConversationId = event.conversation_id?.trim() ?? "";
      if (!targetConversationId) {
        return;
      }

      if (shouldSuppressPendingDraftBroadcast(targetConversationId)) {
        return;
      }

      const isTerminalEvent = isTerminalChatEvent(event);
      if (!isTerminalEvent && !isChatStreamNotAvailableEvent(event)) {
        setRemoteConversationRunningState(targetConversationId, true, {
          workdir: event.workdir,
        });
        if (
          resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
            targetConversationId &&
          !isConversationLiveStreamAttached(targetConversationId)
        ) {
          attachVisibleConversationLiveStream(targetConversationId, api);
        }
      }

      if (isConversationLiveStreamAttached(targetConversationId)) {
        return;
      }

      const liveTitle = readChatEventTitle(event);
      if (liveTitle && isChatEventTitleFinal(event)) {
        applyLiveConversationTitle(targetConversationId, liveTitle, {
          isFinal: true,
        });
      }

      // Local sends already consume the request-scoped stream. Do not also
      // hydrate the same conversation from broadcast conversation events.
      const isLocallySendingConversation =
        getConversationAbortController(targetConversationId) !== null ||
        localRunningConversationIdsRef.current.has(targetConversationId);
      if (isLocallySendingConversation) {
        return;
      }

      const liveStore = getConversationLiveStreamStore(targetConversationId);
      if (!liveStore) {
        return;
      }

      if (isChatStreamNotAvailableEvent(event)) {
        recoverUnavailableConversationStream(targetConversationId, api);
        return;
      }

      if (event.type === "tool_status") {
        const normalizedStatus = normalizeOptionalStatus(event.status);
        const isCompaction = normalizedStatus !== null && event.isCompaction === true;
        liveStore.setToolStatus(normalizedStatus, isCompaction);
        setLiveConversationStreamStatus(targetConversationId, normalizedStatus, isCompaction);
        return;
      }

      liveStore.appendEvent(event, {
        flush: isTerminalEvent,
      });
      if (isTerminalEvent) {
        markCompletedLiveStream(targetConversationId);
        commitTerminalConversationLiveStream(targetConversationId);
        refreshHistoryAfterCompletedLiveStream(targetConversationId, api);
      } else {
        markLiveConversationStreamActive(targetConversationId);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    api,
    applyLiveConversationTitle,
    attachVisibleConversationLiveStream,
    clearAllConversationLiveStreams,
    commitTerminalConversationLiveStream,
    getConversationAbortController,
    getConversationLiveStreamStore,
    isConversationLiveStreamAttached,
    markCompletedLiveStream,
    markLiveConversationStreamActive,
    recoverUnavailableConversationStream,
    refreshHistoryAfterCompletedLiveStream,
    setRemoteConversationRunningState,
    setLiveConversationStreamStatus,
    shouldSuppressPendingDraftBroadcast,
  ]);

  useEffect(() => {
    if (status?.online) {
      return;
    }
    setRemoteRunningConversationIds((current) => {
      if (current.size === 0) {
        remoteRunningConversationIdsRef.current = current;
        return current;
      }
      const next = new Set<string>();
      remoteRunningConversationIdsRef.current = next;
      return next;
    });
    setRemoteRunningConversationRuntime((current) => {
      if (current.size === 0) {
        remoteRunningConversationRuntimeRef.current = current;
        return current;
      }
      const next = new Map<string, RunningConversationRuntime>();
      remoteRunningConversationRuntimeRef.current = next;
      return next;
    });
  }, [status?.online]);

  async function selectHistory(
    conversationIdValue: string,
    currentApi = api,
    options?: {
      syncChat?: boolean;
      resetLiveStream?: boolean;
      clearLiveStream?: boolean;
      fullHistory?: boolean;
      scrollToBottom?: boolean;
    },
  ) {
    if (!currentApi) {
      return;
    }

    const loadSequence = invalidateHistoryLoad();
    const selectionRevision = markVisibleConversationRevision();
    const currentVisibleConversationId = conversationIdRef.current.trim();
    const previousSelectedHistoryId = selectedHistoryIdRef.current.trim();
    const isChangingSelectedHistory = previousSelectedHistoryId !== conversationIdValue;
    const isSwitchingVisibleConversation =
      currentVisibleConversationId !== "" && currentVisibleConversationId !== conversationIdValue;
    if (options?.scrollToBottom) {
      pendingDisplayedConversationAutoBottomRef.current = conversationIdValue;
    }
    if (options?.syncChat && isSwitchingVisibleConversation) {
      cacheVisibleConversationRuntime(currentVisibleConversationId);
    }

    draftConversationPinnedRef.current = false;
    protectedConversationRef.current = conversationIdValue;
    selectedHistoryIdRef.current = conversationIdValue;
    setSelectedHistoryId(conversationIdValue);
    if (isChangingSelectedHistory) {
      setSelectedHistory(null);
      setSelectedHistoryEntries([]);
    }

    if (options?.resetLiveStream) {
      clearConversationLiveStream(conversationIdValue);
    }

    setHistoryDetailLoading(true);
    try {
      const detail = await currentApi.getHistory(
        conversationIdValue,
        options?.fullHistory ? undefined : { maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES },
      );
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      const entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      setSelectedHistory(detail);
      setSelectedHistoryEntries(entries);
      if (options?.syncChat) {
        const shouldPreserveLiveRuntime =
          blockedHistoryHydrationConversationIdsRef.current.has(detail.conversation_id) ||
          getConversationAbortController(detail.conversation_id) !== null;
        if (shouldPreserveLiveRuntime) {
          return;
        }
        if (options.clearLiveStream) {
          clearConversationLiveStream(conversationIdValue);
        }
        const currentRuntime =
          conversationIdRef.current.trim() === detail.conversation_id &&
          (selectedHistoryIdRef.current.trim() === "" ||
            selectedHistoryIdRef.current.trim() === detail.conversation_id)
            ? buildVisibleRuntimeEntry()
            : (conversationRuntimeCacheRef.current.get(detail.conversation_id) ??
              createConversationRuntimeEntry());
        const nextMessages = mergeHistorySnapshotEntries(currentRuntime.messages, entries, {
          isFullSnapshot: detail.has_more === false,
        });
        const nextRuntime = createConversationRuntimeEntry({
          messages: nextMessages,
          error: null,
          toolStatus: null,
          isSending: localRunningConversationIdsRef.current.has(detail.conversation_id),
          workdir: detail.conversation?.cwd,
        });
        conversationRuntimeCacheRef.current.set(detail.conversation_id, nextRuntime);
        const shouldSyncRuntime =
          conversationIdRef.current.trim() !== detail.conversation_id ||
          selectedHistoryIdRef.current.trim() !== detail.conversation_id ||
          nextRuntime.messages !== currentRuntime.messages ||
          nextRuntime.error !== currentRuntime.error ||
          nextRuntime.toolStatus !== currentRuntime.toolStatus ||
          nextRuntime.toolStatusIsCompaction !== currentRuntime.toolStatusIsCompaction ||
          nextRuntime.isSending !== currentRuntime.isSending ||
          nextRuntime.workdir !== currentRuntime.workdir;
        if (!shouldSyncRuntime) {
          return;
        }
        syncVisibleConversationRuntime(detail.conversation_id, nextRuntime);
      }
    } catch (error) {
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      const message = asErrorMessage(error, "history detail request failed");
      const fallbackDetail = {
        conversation_id: conversationIdValue,
        messages_json: message,
        has_more: false,
      } satisfies HistoryDetail;
      const fallbackEntries: ChatEntry[] = [
        {
          id: `history-error-${conversationIdValue}`,
          kind: "error",
          text: message,
        },
      ];
      setSelectedHistory(fallbackDetail);
      setSelectedHistoryEntries(fallbackEntries);
      if (options?.syncChat) {
        const shouldPreserveLiveRuntime =
          blockedHistoryHydrationConversationIdsRef.current.has(conversationIdValue) ||
          getConversationAbortController(conversationIdValue) !== null;
        if (shouldPreserveLiveRuntime) {
          return;
        }
        if (options.clearLiveStream) {
          clearConversationLiveStream(conversationIdValue);
        }
        const nextRuntime = createConversationRuntimeEntry({
          messages: fallbackEntries,
          error: message,
          toolStatus: null,
          isSending: localRunningConversationIdsRef.current.has(conversationIdValue),
          workdir: conversationRuntimeCacheRef.current.get(conversationIdValue)?.workdir,
        });
        conversationRuntimeCacheRef.current.set(conversationIdValue, nextRuntime);
        syncVisibleConversationRuntime(conversationIdValue, nextRuntime);
      }
    } finally {
      if (
        historyLoadSequenceRef.current === loadSequence &&
        visibleConversationRevisionRef.current === selectionRevision
      ) {
        setHistoryDetailLoading(false);
      }
    }
  }

  async function reloadHistory(currentApi = api, options?: ReloadHistoryOptions) {
    if (!currentApi) {
      return;
    }

    const silent = options?.silent === true;
    const loadingStartedAt = Date.now();
    if (!silent) {
      setHistoryListLoading(true);
      setHistoryError(null);
    }
    const requestScopeKey = historyScopeKeyRef.current;
    const requestFilter = historyListFilterRef.current;
    try {
      const response = await currentApi.listHistory(1, HISTORY_LIST_PAGE_SIZE, requestFilter);
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const runningConversations = normalizeRunningConversations(
        response.running_conversations,
        response.running_conversation_ids,
      );
      for (const runningConversation of runningConversations) {
        setRemoteConversationRunningState(runningConversation.conversation_id, true, {
          workdir: runningConversation.cwd,
          updatedAt: runningConversation.updated_at,
        });
      }
      const runningConversationIds = runningConversations.map((item) => item.conversation_id);
      const retainedConversationIds = new Set<string>();
      for (const id of blockedHistoryHydrationConversationIdsRef.current) {
        retainedConversationIds.add(id);
      }
      for (const id of localRunningConversationIdsRef.current) {
        retainedConversationIds.add(id);
      }
      for (const id of remoteRunningConversationIdsRef.current) {
        retainedConversationIds.add(id);
      }
      for (const id of runningConversationIds) {
        retainedConversationIds.add(id);
      }
      for (const [id, store] of liveConversationStreamStoresRef.current) {
        if (store.getSnapshot().entries.length > 0) {
          retainedConversationIds.add(id);
        }
      }
      if (silent) {
        for (const item of historyItemsRef.current) {
          retainedConversationIds.add(item.id);
        }
      }
      const conversations = reconcileConversationSummaries(
        historyItemsRef.current,
        response.conversations,
        {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
          retainConversationIds: retainedConversationIds,
        },
      );
      const refreshedNextPage = response.conversations.length > 0 ? 2 : 1;
      const nextPage = silent
        ? Math.max(nextHistoryPageRef.current, refreshedNextPage)
        : refreshedNextPage;
      commitHistoryListState(conversations, response.total_count, nextPage);

      const adoptedPendingDraftConversationId =
        options?.adoptPendingDraftConversation === true
          ? adoptPendingDraftConversationFromHistoryList(conversations)
          : "";
      if (
        options?.adoptPendingDraftConversation === true &&
        adoptedPendingDraftConversationId !== ""
      ) {
        // `chat stream not available` recovery clears the draft's running state
        // before reloading history. If the draft is then adopted into a real
        // conversation, only the temporary hydration block survives migration;
        // release it here so this same reload/select cycle can hydrate the
        // recovered history snapshot immediately.
        blockedHistoryHydrationConversationIdsRef.current.delete(adoptedPendingDraftConversationId);
      }

      if (options?.skipSelectionSync) {
        return;
      }

      const currentConversationId = conversationIdRef.current;
      const currentSelectedHistoryId = selectedHistoryIdRef.current;
      const currentChatMessages = chatMessagesRef.current;
      const currentSelectedHistory = selectedHistoryRef.current;
      const requestedPreferredConversationId = options?.preferredConversationId?.trim() ?? "";
      const requestedConversationId =
        requestedPreferredConversationId !== "" &&
        !isLocalDraftConversationId(requestedPreferredConversationId)
          ? requestedPreferredConversationId
          : adoptedPendingDraftConversationId || requestedPreferredConversationId;
      const protectedConversationId = protectedConversationRef.current.trim();
      const isProtectedDraftConversation = protectedConversationId === PROTECTED_DRAFT_CONVERSATION;
      const hadCurrentConversationInHistory =
        pickConversationSummary(historyItemsRef.current, currentConversationId) !== null;

      const currentSummary = pickConversationSummary(conversations, currentConversationId);
      const protectedConversationSummary =
        protectedConversationId && !isProtectedDraftConversation
          ? pickConversationSummary(conversations, protectedConversationId)
          : null;

      if (
        currentConversationId &&
        !isLocalDraftConversationId(currentConversationId) &&
        hadCurrentConversationInHistory &&
        currentSummary === null
      ) {
        startNewConversation({
          workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
        });
        return;
      }

      if (isProtectedDraftConversation) {
        return;
      }

      if (
        protectedConversationId &&
        protectedConversationSummary === null &&
        (requestedConversationId === "" || requestedConversationId === protectedConversationId) &&
        (currentConversationId === protectedConversationId ||
          currentSelectedHistoryId === protectedConversationId)
      ) {
        return;
      }

      const requestedConversationSummary =
        requestedConversationId !== ""
          ? pickConversationSummary(conversations, requestedConversationId)
          : null;
      const shouldKeepCurrentConversation =
        requestedConversationId !== "" &&
        requestedConversationSummary === null &&
        currentConversationId === requestedConversationId &&
        currentChatMessages.length > 0;

      if (shouldKeepCurrentConversation) {
        return;
      }

      const shouldKeepDraftConversation = hasLocalDraftConversation({
        conversationId: currentConversationId,
        selectedHistoryId: currentSelectedHistoryId,
        requestedConversationId,
        chatMessageCount: currentChatMessages.length,
        pendingUploadCount: pendingUploadedFilesRef.current.length,
        draftPinned: draftConversationPinnedRef.current,
      });
      if (shouldKeepDraftConversation) {
        return;
      }

      const isCurrentConversationRunning =
        currentConversationId !== "" &&
        localRunningConversationIdsRef.current.has(currentConversationId) &&
        (currentSelectedHistoryId === "" || currentSelectedHistoryId === currentConversationId) &&
        requestedConversationId === "";
      if (isCurrentConversationRunning) {
        return;
      }

      const preferredConversationId =
        requestedConversationSummary?.id ??
        protectedConversationSummary?.id ??
        (pickConversationSummary(conversations, currentSelectedHistoryId)
          ? currentSelectedHistoryId
          : pickConversationSummary(conversations, currentConversationId)
            ? currentConversationId
            : currentConversationId && currentChatMessages.length > 0
              ? ""
              : (conversations[0]?.id ?? ""));

      if (!preferredConversationId) {
        if (!currentConversationId) {
          setSelectedHistoryId("");
          setSelectedHistory(null);
          setSelectedHistoryEntries([]);
        }
        return;
      }

      setSelectedHistoryId(preferredConversationId);
      protectedConversationRef.current = preferredConversationId;

      const shouldSyncChat =
        options?.hydrateSelection === true ||
        ((currentConversationId === "" || isLocalDraftConversationId(currentConversationId)) &&
          currentChatMessages.length === 0);
      const shouldHydrateSelection =
        shouldSyncChat || currentSelectedHistory?.conversation_id !== preferredConversationId;

      if (shouldHydrateSelection) {
        await selectHistory(preferredConversationId, currentApi, {
          syncChat: shouldSyncChat,
          resetLiveStream:
            shouldSyncChat && remoteRunningConversationIdsRef.current.has(preferredConversationId),
          scrollToBottom: shouldSyncChat,
        });
      }
    } catch (error) {
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const message = asErrorMessage(error, "history request failed");
      setHistoryError(message);
      if (silent) {
        return;
      }
      setSelectedHistory({
        conversation_id: "",
        messages_json: message,
      });
      setSelectedHistoryEntries([
        {
          id: "history-list-error",
          kind: "error",
          text: message,
        },
      ]);
    } finally {
      if (!silent && requestScopeKey === historyScopeKeyRef.current) {
        await waitForMinimumHistoryListLoading(loadingStartedAt);
        setHistoryListLoading(false);
      }
    }
  }

  const loadMoreHistory = useCallback(async () => {
    if (!api || historyListPageLoadingRef.current || !historyHasMoreRef.current) {
      return;
    }

    historyListPageLoadingRef.current = true;
    setHistoryListLoadingMore(true);
    const requestScopeKey = historyScopeKeyRef.current;
    const requestFilter = historyListFilterRef.current;
    try {
      const pageNumber = nextHistoryPageRef.current;
      const response = await api.listHistory(pageNumber, HISTORY_LIST_PAGE_SIZE, requestFilter);
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const runningConversations = normalizeRunningConversations(
        response.running_conversations,
        response.running_conversation_ids,
      );
      for (const runningConversation of runningConversations) {
        setRemoteConversationRunningState(runningConversation.conversation_id, true, {
          workdir: runningConversation.cwd,
          updatedAt: runningConversation.updated_at,
        });
      }
      const retainConversationIds = new Set(historyItemsRef.current.map((item) => item.id));
      const conversations = reconcileConversationSummaries(
        historyItemsRef.current,
        response.conversations,
        {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
          retainConversationIds,
        },
      );
      const nextPage = response.conversations.length === 0 ? pageNumber : pageNumber + 1;
      commitHistoryListState(conversations, response.total_count, nextPage);
      setHistoryError(null);
    } catch (error) {
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      setHistoryError(asErrorMessage(error, "读取更多历史列表失败"));
    } finally {
      if (requestScopeKey === historyScopeKeyRef.current) {
        historyListPageLoadingRef.current = false;
        setHistoryListLoadingMore(false);
      }
    }
  }, [
    api,
    commitHistoryListState,
    getHistoryPositionLockedConversationIds,
    setRemoteConversationRunningState,
  ]);

  const recoverUnavailableActiveConversationStream = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const targetId = targetConversationId.trim();
      if (!currentApi || !targetId) {
        return;
      }

      const visibleConversationId = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      const effectiveConversationId =
        !isLocalDraftConversationId(targetId) && targetId !== ""
          ? targetId
          : visibleConversationId !== "" && !isLocalDraftConversationId(visibleConversationId)
            ? visibleConversationId
            : targetId;

      clearConversationLiveStream(targetId);
      clearConversationStreamingState(targetId);
      if (effectiveConversationId !== targetId) {
        clearConversationLiveStream(effectiveConversationId);
        clearConversationStreamingState(effectiveConversationId);
      }

      if (
        resolveChatStreamUnavailableRecoveryAction(effectiveConversationId) ===
        "refresh-history-snapshot"
      ) {
        recoverUnavailableConversationStream(effectiveConversationId, currentApi);
        return;
      }

      void reloadHistory(currentApi, {
        hydrateSelection: true,
        silent: true,
        adoptPendingDraftConversation: true,
      });
    },
    [
      api,
      clearConversationLiveStream,
      clearConversationStreamingState,
      recoverUnavailableConversationStream,
      reloadHistory,
    ],
  );

  useEffect(() => {
    if (!api || !status?.online) {
      return;
    }

    const currentConversationId = conversationIdRef.current.trim();
    const shouldKeepNewConversation =
      chatMessagesRef.current.length === 0 &&
      selectedHistoryIdRef.current.trim() === "" &&
      (currentConversationId === "" || isLocalDraftConversationId(currentConversationId));

    void reloadHistory(api, {
      skipSelectionSync: shouldKeepNewConversation,
      hydrateSelection:
        !shouldKeepNewConversation &&
        chatMessagesRef.current.length === 0 &&
        (currentConversationId === "" || isLocalDraftConversationId(currentConversationId)),
    });
  }, [api, historyScopeKey, status?.online]);

  async function sendChat(message: string, options?: SendChatOptions) {
    if (!api || chatBusyRef.current) {
      return;
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
    if (
      chatStartLocksRef.current.has(activeConversationId) ||
      getConversationAbortController(activeConversationId) !== null ||
      localRunningConversationIdsRef.current.has(activeConversationId)
    ) {
      return;
    }
    clearCachedComposerDraft(activeConversationId);
    const lockedConversationIds = new Set<string>([activeConversationId]);
    chatStartLocksRef.current.add(activeConversationId);

    commitConversationLiveStreamToRuntime(activeConversationId, {
      clearLiveStream: true,
    });
    getConversationLiveStreamStore(activeConversationId);
    const controller = new AbortController();
    setConversationAbortController(activeConversationId, controller);
    const startedAsDraftConversation = isLocalDraftConversationId(activeConversationId);
    const clientRequestId =
      options?.clientRequestId?.trim() ||
      `webui-chat-${activeConversationId}-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const persistedConversationWorkdir =
      pickConversationSummary(historyItemsRef.current, activeConversationId)?.cwd?.trim() || "";
    const runtimeConversationWorkdir =
      conversationRuntimeCacheRef.current.get(activeConversationId)?.workdir?.trim() || "";
    const effectiveWorkdir = isAgentMode
      ? options?.workdir?.trim() ||
        persistedConversationWorkdir ||
        runtimeConversationWorkdir ||
        activeWorkspaceProjectPath ||
        settings.system.workdir.trim()
      : "";
    const optimisticDraftTitle = buildOptimisticConversationTitle(message);
    draftConversationPinnedRef.current = false;
    pendingDraftConversationMigrationRef.current = startedAsDraftConversation
      ? {
          draftConversationId: activeConversationId,
          startedAt,
        }
      : null;
    protectedConversationRef.current = activeConversationId;
    blockedHistoryHydrationConversationIdsRef.current.add(activeConversationId);
    setConversationRunningState(activeConversationId, true);
    if (
      resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
      activeConversationId
    ) {
      stickTranscriptToBottom();
    }
    updateConversationRuntimeEntry(activeConversationId, (current) => ({
      ...current,
      error: null,
      toolStatus: null,
      workdir: effectiveWorkdir || undefined,
      messages: [
        ...current.messages,
        {
          id: `user-${crypto.randomUUID()}`,
          kind: "user",
          text: message,
          attachments: uploadedFiles,
        },
      ],
    }));
    if (startedAsDraftConversation) {
      optimisticTitleConversationIdsRef.current.add(activeConversationId);
      updateHistoryItems((current) =>
        upsertConversationSummary(
          current,
          {
            id: activeConversationId,
            title: optimisticDraftTitle,
            created_at: startedAt,
            updated_at: startedAt,
            message_count: 1,
            provider_id: settings.selectedModel?.customProviderId ?? "gateway",
            model: settings.selectedModel?.model ?? "gateway",
            cwd: effectiveWorkdir || undefined,
          },
          { preserveExistingTitle: true },
        ),
      );
    }

    let terminalEventSeen = false;
    const runtimeControls = normalizeChatRuntimeControlsForProvider(
      options?.runtimeControls ?? settings.chatRuntimeControls,
      {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      },
    );
    try {
      for await (const event of api.chat(
        message,
        isLocalDraftConversationId(activeConversationId) ? undefined : activeConversationId,
        buildGatewaySelectedModel(settings.selectedModel, activeProviders),
        buildGatewaySystemSettings(settings, effectiveWorkdir),
        controller.signal,
        uploadedFiles,
        clientRequestId,
        runtimeControls,
      )) {
        if (event.conversation_id && event.conversation_id !== "") {
          const nextConversationId = event.conversation_id.trim();
          if (nextConversationId !== activeConversationId) {
            const previousConversationId = activeConversationId;
            if (
              pendingDraftConversationMigrationRef.current?.draftConversationId ===
              previousConversationId
            ) {
              pendingDraftConversationMigrationRef.current = null;
            }
            migrateConversationRuntime(previousConversationId, nextConversationId);
            migrateConversationSummary(previousConversationId, nextConversationId);
            activeConversationId = nextConversationId;
            lockedConversationIds.add(activeConversationId);
          }
          const summary = pickConversationSummary(historyItemsRef.current, activeConversationId);
          if (!summary && startedAsDraftConversation) {
            optimisticTitleConversationIdsRef.current.add(activeConversationId);
            updateHistoryItems((current) => {
              const existing = pickConversationSummary(current, activeConversationId);
              if (existing) {
                return current;
              }
              return upsertConversationSummary(
                current,
                {
                  id: activeConversationId,
                  title: optimisticDraftTitle,
                  created_at: startedAt,
                  updated_at: startedAt,
                  message_count: 1,
                  cwd: effectiveWorkdir || undefined,
                },
                { preserveExistingTitle: true },
              );
            });
          }
        }
        if (isChatStreamNotAvailableEvent(event)) {
          terminalEventSeen = true;
          recoverUnavailableActiveConversationStream(activeConversationId, api);
          return;
        }
        if (event.type === "tool_status") {
          const normalizedStatus = normalizeOptionalStatus(event.status);
          const isCompaction = normalizedStatus !== null && event.isCompaction === true;
          getConversationLiveStreamStore(activeConversationId)?.setToolStatus(
            normalizedStatus,
            isCompaction,
          );
          setLiveConversationStreamStatus(activeConversationId, normalizedStatus, isCompaction);
          updateConversationRuntimeEntry(activeConversationId, (current) => ({
            ...current,
            toolStatus: normalizedStatus,
            toolStatusIsCompaction: isCompaction,
          }));
        } else {
          getConversationLiveStreamStore(activeConversationId)?.appendEvent(event, {
            flush: event.type === "done" || event.type === "error",
          });
          if (event.type === "done" || event.type === "error") {
            terminalEventSeen = true;
            markCompletedLiveStream(activeConversationId);
            commitTerminalConversationLiveStream(activeConversationId);
            refreshHistoryAfterCompletedLiveStream(activeConversationId, api);
          } else {
            markLiveConversationStreamActive(activeConversationId);
          }
        }
        const liveTitle = readChatEventTitle(event);
        if (liveTitle && isChatEventTitleFinal(event)) {
          applyLiveConversationTitle(
            event.conversation_id?.trim() || activeConversationId,
            liveTitle,
            { isFinal: true },
          );
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        const message = asErrorMessage(error, "chat request failed");
        if (isChatStreamNotAvailableMessage(message)) {
          terminalEventSeen = true;
          recoverUnavailableActiveConversationStream(activeConversationId, api);
        } else {
          updateConversationRuntimeEntry(activeConversationId, (current) => ({
            ...current,
            error: message,
          }));
        }
      }
    } finally {
      clearConversationStreamingState(activeConversationId);
      if (status?.online && !terminalEventSeen) {
        await reloadHistory(api, {
          preferredConversationId: activeConversationId,
          skipSelectionSync: true,
          silent: true,
        });
      }
      blockedHistoryHydrationConversationIdsRef.current.delete(activeConversationId);
      if (
        pendingDraftConversationMigrationRef.current?.draftConversationId === activeConversationId
      ) {
        pendingDraftConversationMigrationRef.current = null;
      }
      for (const conversationIdValue of lockedConversationIds) {
        chatStartLocksRef.current.delete(conversationIdValue);
      }
    }
  }

  // Edit-resend is memoized across settings sync; always call the latest sender
  // so model and execution-mode overrides stay aligned with the visible WebUI state.
  sendChatRef.current = sendChat;

  async function cancelChat(targetConversationId?: string) {
    const activeConversationId = targetConversationId?.trim() || conversationIdRef.current.trim();
    if (!activeConversationId) {
      return;
    }
    const controller = getConversationAbortController(activeConversationId);
    const isVisibleConversation =
      resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
      activeConversationId;
    const shouldKeepBottom = isVisibleConversation && isTranscriptAtBottom();
    const cancelRequest =
      !controller &&
      api &&
      activeConversationId !== "" &&
      !isLocalDraftConversationId(activeConversationId)
        ? api.cancelChat(activeConversationId).catch((error) => {
            if (!isAbortError(error)) {
              updateConversationRuntimeEntry(activeConversationId, (current) => ({
                ...current,
                error: asErrorMessage(error, "cancel chat request failed"),
              }));
            }
          })
        : null;
    controller?.abort();
    stopAttachedConversationLiveStream(activeConversationId);
    if (isVisibleConversation) {
      preserveTranscriptScrollPosition(
        () => {
          flushSync(() => {
            commitConversationLiveStreamToRuntime(activeConversationId, {
              clearLiveStream: false,
            });
            clearConversationStreamingState(activeConversationId);
          });
        },
        { stickToBottom: shouldKeepBottom },
      );
      if (shouldKeepBottom) {
        stickTranscriptToBottom();
      } else {
        refreshTranscriptScrollState();
      }
    } else {
      clearConversationStreamingState(activeConversationId);
    }
    if (cancelRequest) {
      await cancelRequest;
    }
  }

  function startNewConversation(options?: { workdir?: string }) {
    const currentConversationId = conversationIdRef.current.trim();
    if (currentConversationId) {
      cacheVisibleConversationRuntime(currentConversationId);
      optimisticTitleConversationIdsRef.current.delete(currentConversationId);
      stopAttachedConversationLiveStream(currentConversationId);
      clearCachedComposerDraft(currentConversationId);
    }
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    setHistorySwitchOverlay(null);
    setHistoryDetailLoading(false);
    const nextConversationId = createLocalDraftConversationId();
    draftConversationPinnedRef.current = true;
    protectedConversationRef.current = PROTECTED_DRAFT_CONVERSATION;
    chatStartLocksRef.current.clear();
    submitInFlightRef.current = false;
    pendingDraftConversationMigrationRef.current = null;
    composerRef.current?.clear();
    const nextRuntime = createConversationRuntimeEntry({
      workdir: options?.workdir?.trim() || undefined,
    });
    conversationRuntimeCacheRef.current.set(nextConversationId, nextRuntime);
    syncVisibleConversationRuntime(nextConversationId, nextRuntime);
    setSelectedHistory(null);
    setSelectedHistoryEntries([]);
    setPendingUploadedFiles([]);
  }

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
        const currentApi = api;
        if (!currentApi) {
          setHistoryError("Gateway 未连接，暂时不能删除项目会话。");
          return;
        }

        const path = project.path.trim();
        const pathKey = workspaceProjectPathKey(path);
        const runningMessage = "项目中仍有后台任务运行，暂时不能删除该项目。";
        const projectHasRunningConversation = () => {
          if (!pathKey) return false;
          const runningIds = new Set<string>();
          for (const id of localRunningConversationIdsRef.current) {
            const conversationId = id.trim();
            if (conversationId) runningIds.add(conversationId);
          }
          for (const id of remoteRunningConversationIdsRef.current) {
            const conversationId = id.trim();
            if (conversationId) runningIds.add(conversationId);
          }

          for (const conversationId of runningIds) {
            const runtimeWorkdir =
              conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
            const persistedWorkdir =
              historyItemsRef.current.find((item) => item.id === conversationId)?.cwd?.trim() || "";
            if (workspaceProjectPathKey(runtimeWorkdir || persistedWorkdir) === pathKey) {
              return true;
            }
          }
          return false;
        };

        if (projectHasRunningConversation()) {
          setHistoryError(runningMessage);
          return;
        }

        setHistoryError(null);
        setHistoryMutating(true);
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

          const runningConversationIdsInProject = conversationIds.filter(
            (id) =>
              localRunningConversationIdsRef.current.has(id) ||
              remoteRunningConversationIdsRef.current.has(id),
          );
          if (runningConversationIdsInProject.length > 0 || projectHasRunningConversation()) {
            setHistoryError(runningMessage);
            return;
          }

          let terminalSessionsToClose: TerminalSession[] = [];
          const pruneProjectTerminalSessions = () => {
            terminalSessionsVersionRef.current += 1;
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          };
          if (terminalClient && settings.remote.enableWebTerminal && pathKey) {
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
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
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
            conversationRuntimeCacheRef.current.get(visibleConversationId)?.workdir?.trim() || "";
          const visiblePersistedWorkdir =
            historyItemsRef.current
              .find((item) => item.id === visibleConversationId)
              ?.cwd?.trim() || "";
          const visibleWorkdir =
            visiblePersistedWorkdir ||
            visibleRuntimeWorkdir ||
            (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");

          for (const conversationId of conversationIds) {
            await currentApi.deleteHistory(conversationId);
          }

          const deletedConversationIds = new Set(conversationIds);
          if (deletedConversationIds.size > 0) {
            updateHistoryItems((current) =>
              current.filter((item) => !deletedConversationIds.has(item.id)),
            );
            const nextSharedItems = sharedHistoryItemsRef.current.filter(
              (item) => !deletedConversationIds.has(item.id),
            );
            sharedHistoryItemsRef.current = nextSharedItems;
            setSharedHistoryItems(nextSharedItems);

            for (const conversationId of deletedConversationIds) {
              optimisticTitleConversationIdsRef.current.delete(conversationId);
              unlockHistoryTitlePosition(conversationId);
              conversationRuntimeCacheRef.current.delete(conversationId);
              conversationAbortControllersRef.current.delete(conversationId);
              blockedHistoryHydrationConversationIdsRef.current.delete(conversationId);
              clearConversationLiveStream(conversationId);
              clearCachedComposerDraft(conversationId);
            }
          }
          if (terminalSessionsToClose.length > 0 && terminalClient) {
            await terminalClient.closeProject(pathKey);
            pruneProjectTerminalSessions();
          }
          if (pathKey && workspaceProjectPathKey(activeWorkspaceProjectPath) === pathKey) {
            setProjectToolsPanelOpen(false);
            if (terminalSessionsToClose.length === 0) {
              pruneProjectTerminalSessions();
            }
          }

          const shouldResetVisibleConversation =
            Boolean(visibleConversationId && deletedConversationIds.has(visibleConversationId)) ||
            Boolean(pathKey && workspaceProjectPathKey(visibleWorkdir) === pathKey);

          removeWorkspaceProjectFromSettings(project);
          if (shouldResetVisibleConversation) {
            startNewConversation({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
          void refreshHistoryWorkdirs(currentApi);
        } catch (error) {
          setHistoryError(asErrorMessage(error, "删除项目失败"));
        } finally {
          setHistoryMutating(false);
        }
      })();
    },
    [
      activeWorkspaceProjectPath,
      api,
      clearCachedComposerDraft,
      clearConversationLiveStream,
      isAgentMode,
      refreshHistoryWorkdirs,
      removeWorkspaceProjectFromSettings,
      requestConfirmDialog,
      settings.remote.enableWebTerminal,
      settings.locale,
      settings.system,
      startNewConversation,
      terminalClient,
      unlockHistoryTitlePosition,
      updateHistoryItems,
    ],
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
    setHistorySwitchOverlay({
      conversationId: targetConversationId,
      startedAt: Date.now(),
    });

    const currentConversationId = conversationIdRef.current.trim();
    if (currentConversationId && currentConversationId !== targetConversationId) {
      cacheVisibleConversationRuntime(currentConversationId);
    }

    pendingDisplayedConversationAutoBottomRef.current = targetConversationId;

    const cachedRuntime = conversationRuntimeCacheRef.current.get(targetConversationId);
    if (cachedRuntime) {
      protectedConversationRef.current = targetConversationId;
      syncVisibleConversationRuntime(targetConversationId, cachedRuntime);
    }
    if (
      cachedRuntime &&
      (cachedRuntime.isSending || localRunningConversationIdsRef.current.has(targetConversationId))
    ) {
      invalidateHistoryLoad();
      markVisibleConversationRevision();
      setHistoryDetailLoading(false);
      setSelectedHistory(null);
      setSelectedHistoryEntries([]);
      return;
    }

    const isRemoteRunning = remoteRunningConversationIdsRef.current.has(targetConversationId);
    void selectHistory(targetConversationId, api, {
      syncChat: true,
      resetLiveStream: isRemoteRunning,
      clearLiveStream: !isRemoteRunning,
      scrollToBottom: true,
    });
  }

  function handleSidebarOpenSkillsHub() {
    setProjectToolsPanelOpen(false);
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    cacheVisibleComposerDraft();
    setActiveView("skills-hub");
  }

  function handleSidebarOpenMcpHub() {
    setProjectToolsPanelOpen(false);
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
    const nextItems = sortHistoryItems(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  const refreshSharedHistoryItems = useCallback(
    async (currentApi = api) => {
      if (!currentApi) {
        setSharedHistoryItemsState([]);
        return [];
      }
      if (sharedHistoryListRequestRef.current) {
        return sharedHistoryListRequestRef.current;
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
            const item = toChatHistorySummary(conversation, settings.selectedModel);
            byId.set(item.id, { ...item, isShared: true });
          }
          if (response.conversations.length === 0 || byId.size >= totalCount) {
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
    },
    [api, settings.selectedModel, setSharedHistoryItemsState],
  );

  useEffect(() => {
    if (!api) {
      setSharedHistoryItemsState([]);
      return;
    }
    void refreshSharedHistoryItems(api);
  }, [api, refreshSharedHistoryItems, setSharedHistoryItemsState]);

  function markSharedConversation(
    id: string,
    isShared: boolean,
    source?: ChatHistorySummary | null,
  ) {
    updateHistoryItems((current) =>
      current.map((conversation) =>
        conversation.id === id ? { ...conversation, is_shared: isShared } : conversation,
      ),
    );
    if (!isShared) {
      setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
      return;
    }

    const sourceSummary = historyItemsRef.current.find((item) => item.id === id);
    const conversation =
      source ??
      (sourceSummary ? toChatHistorySummary(sourceSummary, settings.selectedModel) : null) ??
      sharedHistoryItemsRef.current.find((item) => item.id === id);
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

  const resolveUserMessageRef = useCallback(
    async (userOrdinal: number, text: string, uploadedFiles: PendingUploadedFile[]) => {
      const activeConversationId = conversationIdRef.current.trim();
      if (
        !api ||
        !activeConversationId ||
        isLocalDraftConversationId(activeConversationId) ||
        hasDetachedHistorySelection(selectedHistoryIdRef.current, activeConversationId)
      ) {
        return null;
      }

      const detail = await api.getHistory(activeConversationId);
      const entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
      return findUserMessageRefByOrdinal(entries, userOrdinal, text, uploadedFiles);
    },
    [api],
  );

  const handleResendFromEdit = useCallback(
    async (messageRef: HistoryMessageRef, text: string, uploadedFiles: PendingUploadedFile[]) => {
      const activeConversationId = conversationIdRef.current.trim();
      if (
        !api ||
        chatBusyRef.current ||
        !activeConversationId ||
        isLocalDraftConversationId(activeConversationId)
      ) {
        return;
      }
      const normalized = text.trim();
      if (!normalized && uploadedFiles.length === 0) {
        return;
      }

      setHistoryError(null);
      setChatError(null);
      composerRef.current?.clear();
      setPendingUploadedFiles([]);
      blockedHistoryHydrationConversationIdsRef.current.add(activeConversationId);
      invalidateHistoryLoad();
      markVisibleConversationRevision();

      try {
        const currentRuntime =
          conversationIdRef.current.trim() === activeConversationId &&
          (selectedHistoryIdRef.current.trim() === "" ||
            selectedHistoryIdRef.current.trim() === activeConversationId)
            ? buildVisibleRuntimeEntry()
            : (conversationRuntimeCacheRef.current.get(activeConversationId) ??
              buildVisibleRuntimeEntry());
        const locallyTruncatedEntries = truncateChatEntriesFromMessageRef(
          currentRuntime.messages,
          messageRef,
        );
        const canUseLocalTruncate = locallyTruncatedEntries !== currentRuntime.messages;
        const detail = await api.truncateHistory(activeConversationId, messageRef, {
          omitMessagesJson: canUseLocalTruncate,
        });
        const entries = canUseLocalTruncate
          ? locallyTruncatedEntries
          : await parseHistoryMessagesJsonAsync(detail.messages_json);
        const nextRuntime = createConversationRuntimeEntry({
          messages: entries,
          error: null,
          toolStatus: null,
          toolStatusIsCompaction: false,
          isSending: false,
        });

        clearConversationLiveStream(activeConversationId);
        setSelectedHistory(detail);
        setSelectedHistoryEntries(entries);
        conversationRuntimeCacheRef.current.set(activeConversationId, nextRuntime);
        syncVisibleConversationRuntime(activeConversationId, nextRuntime);

        const truncatedConversation = detail.conversation;
        if (truncatedConversation) {
          updateHistoryItems((current) =>
            upsertConversationSummary(current, truncatedConversation),
          );
        }

        const resendPromise =
          sendChatRef.current?.(normalized, {
            conversationId: activeConversationId,
            uploadedFiles,
          }) ?? Promise.resolve();
        blockedHistoryHydrationConversationIdsRef.current.delete(activeConversationId);
        await resendPromise;
      } catch (error) {
        setChatError(asErrorMessage(error, "回溯历史消息失败"));
      } finally {
        blockedHistoryHydrationConversationIdsRef.current.delete(activeConversationId);
      }
    },
    [
      api,
      buildVisibleRuntimeEntry,
      clearConversationLiveStream,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      syncVisibleConversationRuntime,
      updateHistoryItems,
    ],
  );

  const handleImportReadableFiles = useCallback(
    async (filesToImport: File[]) => {
      if (filesToImport.length === 0) {
        return;
      }
      if (chatBusyRef.current) {
        setChatError(translate("chat.upload.busyGenerating", settings.locale));
        return;
      }
      if (isUploadingFilesRef.current) {
        setChatError(translate("chat.upload.uploading", settings.locale));
        return;
      }
      if (settings.system.executionMode === "text") {
        setChatError(translate("chat.upload.onlyInTools", settings.locale));
        return;
      }
      const workdir = displayedConversationWorkdirRef.current.trim();
      if (!workdir) {
        setChatError(translate("chat.upload.requireWorkdir", settings.locale));
        return;
      }

      const remainingFileSlots = Math.max(
        0,
        MAX_UPLOAD_FILES - pendingUploadedFilesRef.current.length,
      );
      if (remainingFileSlots === 0) {
        setChatError(
          formatTranslation(translate("chat.upload.maxFilesIgnored", settings.locale), {
            max: MAX_UPLOAD_FILES,
            count: filesToImport.length,
          }),
        );
        return;
      }

      const importBatch = filesToImport.slice(0, remainingFileSlots);
      const ignoredForLimit = filesToImport.length - importBatch.length;
      setChatError(null);
      isUploadingFilesRef.current = true;
      setIsUploadingFiles(true);
      try {
        const result = await importReadableFiles(token, workdir, importBatch);
        registerLocalUploadedImagePreviews({
          workspaceRoot: workdir,
          uploadedFiles: result.files,
          sourceFiles: importBatch,
        });

        if (result.files.length > 0) {
          setPendingUploadedFiles((current) => {
            const next = mergePendingUploadedFiles(current, result.files).slice(
              0,
              MAX_UPLOAD_FILES,
            );
            pendingUploadedFilesRef.current = next;
            return next;
          });
          composerRef.current?.focus();
        }

        const warnings: string[] = [];
        if (result.files.length === 0 && result.skipped.length > 0) {
          warnings.push(`所选文件均无法导入：\n${result.skipped.join("\n")}`);
        } else if (result.skipped.length > 0) {
          warnings.push(`以下文件已跳过：\n${result.skipped.join("\n")}`);
        }
        if (ignoredForLimit > 0) {
          warnings.push(
            formatTranslation(translate("chat.upload.maxFilesIgnored", settings.locale), {
              max: MAX_UPLOAD_FILES,
              count: ignoredForLimit,
            }),
          );
        }
        if (warnings.length > 0) {
          setChatError(warnings.join("\n"));
        }
      } catch (error) {
        setChatError(asErrorMessage(error, "导入文件失败"));
      } finally {
        isUploadingFilesRef.current = false;
        setIsUploadingFiles(false);
      }
    },
    [settings.locale, settings.system.executionMode, token],
  );

  useEffect(() => {
    if (
      !token ||
      historyShareToken ||
      !settingsSyncReady ||
      settingsOpen ||
      activeView !== "chat"
    ) {
      return;
    }

    const handleDocumentPaste = (event: globalThis.ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const clipboardFiles = extractClipboardFiles(event.clipboardData);
      if (clipboardFiles.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        void handleImportReadableFiles(clipboardFiles);
        return;
      }
      if (!clipboardHasFileSignal(event.clipboardData)) return;

      event.preventDefault();
      event.stopPropagation();
      void readClipboardFiles()
        .then((files) => {
          if (files.length === 0) {
            setChatError("无法读取剪贴板中的文件，请尝试拖拽或点击上传。");
            return;
          }
          return handleImportReadableFiles(files);
        })
        .catch((error) => {
          setChatError(asErrorMessage(error, "读取剪贴板文件失败"));
        });
    };

    document.addEventListener("paste", handleDocumentPaste, true);
    return () => {
      document.removeEventListener("paste", handleDocumentPaste, true);
    };
  }, [
    activeView,
    handleImportReadableFiles,
    historyShareToken,
    settingsOpen,
    settingsSyncReady,
    token,
  ]);

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

  const handleLoginSubmit = useCallback(async () => {
    const draftToken = loginToken;
    const normalizedToken = normalizeGatewayAccessToken(draftToken);
    if (!normalizedToken) {
      setAuthError("请输入 Access Token。");
      return;
    }

    setAuthSubmitting(true);
    setAuthError(null);
    resetGatewayWebSocketClient();

    try {
      const verifiedToken = await verifyGatewayAccessToken(draftToken);
      initialStoredTokenRef.current = verifiedToken;
      saveToken(verifiedToken);
      setLoginToken(verifiedToken);
      setSettingsSyncReady(false);
      setSettingsSyncError(null);
      setToken(verifiedToken);
    } catch (error) {
      initialStoredTokenRef.current = "";
      clearToken();
      resetGatewayWebSocketClient();
      setToken("");
      setAuthError(asErrorMessage(error, "Access Token 验证失败。"));
    } finally {
      setAuthSubmitting(false);
    }
  }, [loginToken]);

  function openSettings(section: SectionId = "system") {
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
    clearToken();
    resetGatewayWebSocketClient();
    for (const controller of conversationAbortControllersRef.current.values()) {
      controller.abort();
    }
    conversationAbortControllersRef.current.clear();
    stopAllAttachedConversationLiveStreams();
    clearAllCompletedLiveStreamMarkers();
    blockedHistoryHydrationConversationIdsRef.current.clear();
    conversationRuntimeCacheRef.current.clear();
    localRunningConversationIdsRef.current = new Set();
    remoteRunningConversationIdsRef.current = new Set();
    remoteRunningConversationRuntimeRef.current = new Map();
    composerDraftCacheRef.current.clear();
    composerRef.current?.clear();
    conversationIdRef.current = "";
    selectedHistoryIdRef.current = "";
    chatMessagesRef.current = [];
    chatBusyRef.current = false;
    chatErrorRef.current = null;
    chatToolStatusRef.current = null;
    chatToolStatusIsCompactionRef.current = false;
    selectedHistoryRef.current = null;
    historyItemsRef.current = [];
    historyTotalRef.current = 0;
    historyHasMoreRef.current = false;
    nextHistoryPageRef.current = 1;
    historyListPageLoadingRef.current = false;
    sharedHistoryItemsRef.current = [];
    sharedHistoryListRequestRef.current = null;
    pendingUploadedFilesRef.current = [];
    draftConversationPinnedRef.current = false;
    protectedConversationRef.current = "";
    chatStartLocksRef.current.clear();
    submitInFlightRef.current = false;
    pendingDraftConversationMigrationRef.current = null;
    setUserMenuOpen(false);
    setSettingsOpen(false);
    setOverlay("closed");
    setHistorySwitchOverlay(null);
    initialStoredTokenRef.current = "";
    setAuthSubmitting(false);
    setAuthError(null);
    setLoginToken("");
    setToken("");
    setStatus(null);
    setStatusError(null);
    setConversationId("");
    setChatBusy(false);
    setChatMessages([]);
    setChatError(null);
    applyChatToolStatus(null);
    optimisticTitleConversationIdsRef.current.clear();
    clearHistoryTitlePositionLocks();
    historyItemsRef.current = [];
    setHistoryItems([]);
    setSharedHistoryItems([]);
    setHistoryTotal(0);
    setHistoryHasMore(false);
    setHistoryError(null);
    setHistoryListLoading(false);
    setHistoryListLoadingMore(false);
    setHistoryDetailLoading(false);
    setHistoryMutating(false);
    setLocalRunningConversationIds(new Set());
    setRemoteRunningConversationIds(new Set());
    setRemoteRunningConversationRuntime(new Map());
    setProjectActivityUpdatedAtOverrides(new Map());
    setTerminalSessions([]);
    terminalSessionsVersionRef.current += 1;
    terminalStatusSessionIdRef.current = "";
    clearAllConversationLiveStreams();
    setSelectedHistoryId("");
    setSelectedHistory(null);
    setSelectedHistoryEntries([]);
    setPendingUploadedFiles([]);
    setRenamingId(null);
    setRenameDraft("");
  }, [
    applyChatToolStatus,
    clearAllConversationLiveStreams,
    clearAllCompletedLiveStreamMarkers,
    clearHistoryTitlePositionLocks,
    invalidateHistoryLoad,
    markVisibleConversationRevision,
    stopAllAttachedConversationLiveStreams,
  ]);

  const userMenuLabel = (status?.agent_id || "当前用户").trim() || "当前用户";
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();

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
    if (!settings.selectedModel) {
      return "选择模型";
    }
    const provider = activeProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
    return provider
      ? `${provider.name} / ${settings.selectedModel.model}`
      : settings.selectedModel.model;
  }, [activeProviders, settings.selectedModel]);
  const currentModelContextWindow = useMemo(() => {
    if (!settings.selectedModel) {
      return undefined;
    }
    const provider = settings.customProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
    if (!provider) {
      return undefined;
    }
    return findProviderModelConfig(provider, settings.selectedModel.model).contextWindow;
  }, [settings.customProviders, settings.selectedModel]);
  const currentChatProvider = useMemo(() => {
    if (!settings.selectedModel) {
      return undefined;
    }
    return settings.customProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
  }, [settings.customProviders, settings.selectedModel]);
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
  const isAgentDevExecutionMode = isAgentDevMode(settings.system.executionMode);

  const modelOptions = useMemo(() => buildModelOptions(settings), [settings]);
  const selectedValue = settings.selectedModel
    ? toModelValue(settings.selectedModel.customProviderId, settings.selectedModel.model)
    : undefined;

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

  const sidebarItems = useMemo<ChatHistorySummary[]>(
    () => historyItems.map((item) => toChatHistorySummary(item, settings.selectedModel)),
    [historyItems, settings.selectedModel],
  );
  const canShareHistory = Boolean(
    api &&
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() &&
      settings.remote.token.trim(),
  );
  const sidebarRunningConversationIds = useMemo(() => {
    const next = new Set(remoteRunningConversationIds);
    for (const conversationIdValue of localRunningConversationIds) {
      next.add(conversationIdValue);
    }
    return next;
  }, [localRunningConversationIds, remoteRunningConversationIds]);
  const runningProjectPathKeys = useMemo(() => {
    const next = new Set<string>();
    for (const conversationIdValue of sidebarRunningConversationIds) {
      const conversationId = conversationIdValue.trim();
      if (!conversationId) {
        continue;
      }

      const runtimeWorkdir =
        conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
      const remoteWorkdir =
        remoteRunningConversationRuntime.get(conversationId)?.workdir?.trim() || "";
      const persistedWorkdir =
        historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
      const resolvedWorkdir = runtimeWorkdir || remoteWorkdir || persistedWorkdir;
      if (resolvedWorkdir) {
        next.add(workspaceProjectPathKey(resolvedWorkdir));
      }
    }
    return next;
  }, [historyItems, remoteRunningConversationRuntime, sidebarRunningConversationIds]);
  const projectActivityUpdatedAts = useMemo(() => {
    const updatedAts = buildWorkspaceProjectActivityUpdatedAts([
      ...historyWorkdirs,
      ...Array.from(localRunningConversationIds).map((conversationId) => {
        const runtimeWorkdir =
          conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
        const persistedWorkdir =
          historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
        return {
          cwd: runtimeWorkdir || persistedWorkdir,
          updatedAt: Date.now(),
        };
      }),
      ...Array.from(remoteRunningConversationRuntime.values()).map((item) => ({
        cwd: item.workdir,
        updatedAt: item.updatedAt,
      })),
    ]);
    for (const [pathKey, updatedAt] of projectActivityUpdatedAtOverrides) {
      if (updatedAt > (updatedAts.get(pathKey) ?? 0)) {
        updatedAts.set(pathKey, updatedAt);
      }
    }
    return updatedAts;
  }, [
    historyItems,
    historyWorkdirs,
    localRunningConversationIds,
    projectActivityUpdatedAtOverrides,
    remoteRunningConversationRuntime,
  ]);
  const displayedConversationId = resolveVisibleConversationId(selectedHistoryId, conversationId);
  const currentConversationPersistedCwd =
    historyItems.find((item) => item.id === displayedConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationRuntimeCacheRef.current.get(displayedConversationId)?.workdir?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");
  displayedConversationWorkdirRef.current = displayedConversationWorkdir;
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  const projectToolsFileTreeOpen = isProjectToolsFileTreeOpen(
    settings.customSettings,
    terminalProjectPathKey,
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
  const gitDisabledMessage = !settings.remote.enableWebGit
    ? "WebUI Git is disabled in desktop Remote settings."
    : undefined;
  const handleOpenWorkspaceFile = useCallback(
    (path: string) => {
      if (!terminalProjectPath || !terminalProjectPathKey) return;
      if (isWorkspaceImagePath(path)) {
        workspaceImagePreviewRequestIdRef.current += 1;
        setWorkspaceImagePreviewMounted(true);
        setWorkspaceImagePreviewOpen(true);
        setWorkspaceImagePreviewOpenRequest({
          id: workspaceImagePreviewRequestIdRef.current,
          projectPathKey: terminalProjectPathKey,
          workdir: terminalProjectPath,
          path,
        });
        return;
      }
      setWorkspaceImagePreviewOpen(false);
      workspaceEditorRequestIdRef.current += 1;
      setWorkspaceEditorCleanupPending(false);
      setWorkspaceEditorMounted(true);
      setWorkspaceEditorOpen(true);
      setWorkspaceEditorOpenRequest({
        id: workspaceEditorRequestIdRef.current,
        projectPathKey: terminalProjectPathKey,
        workdir: terminalProjectPath,
        path,
      });
    },
    [terminalProjectPath, terminalProjectPathKey],
  );
  const requestWorkspaceEditorClose = useCallback(() => {
    setWorkspaceEditorCloseRequestId((current) => current + 1);
  }, []);
  const requestWorkspaceImagePreviewClose = useCallback(() => {
    setWorkspaceImagePreviewOpen(false);
  }, []);
  const handleWorkspaceImagePreviewClosed = useCallback(() => {
    setWorkspaceImagePreviewOpen(false);
    setWorkspaceImagePreviewMounted(false);
    setWorkspaceImagePreviewOpenRequest(null);
  }, []);
  useEffect(() => {
    const previousOpen = previousProjectToolsFileTreeOpenRef.current;
    previousProjectToolsFileTreeOpenRef.current = projectToolsFileTreeOpen;
    if (projectToolsFileTreeOpen && workspaceEditorCleanupPending) {
      setWorkspaceEditorCleanupPending(false);
    }
    if (previousOpen && !projectToolsFileTreeOpen && workspaceEditorMounted) {
      setWorkspaceEditorCleanupPending(true);
      setWorkspaceEditorOpen(true);
      requestWorkspaceEditorClose();
    }
    if (previousOpen && !projectToolsFileTreeOpen && workspaceImagePreviewMounted) {
      requestWorkspaceImagePreviewClose();
    }
  }, [
    projectToolsFileTreeOpen,
    requestWorkspaceEditorClose,
    requestWorkspaceImagePreviewClose,
    workspaceEditorCleanupPending,
    workspaceEditorMounted,
    workspaceImagePreviewMounted,
  ]);
  const projectTerminalSessions = useMemo(
    () =>
      terminalProjectPathKey
        ? terminalSessions.filter((session) =>
            terminalSessionBelongsToProject(session, terminalProjectPathKey),
          )
        : [],
    [terminalProjectPathKey, terminalSessions],
  );
  const handleProjectTerminalSessionsChange = useCallback(
    (sessions: TerminalSession[]) => {
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions((current) =>
        replaceTerminalSessionsForProject(current, terminalProjectPathKey, sessions),
      );
    },
    [terminalProjectPathKey],
  );

  useEffect(() => {
    if (!terminalClient) {
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions([]);
      return;
    }
    if (!settingsSyncReady) {
      return;
    }
    if (!isAgentMode || !settings.remote.enableWebTerminal || status?.online === false) {
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions([]);
      return;
    }
    if (status?.online !== true) {
      return;
    }
    const statusSessionId = status?.session_id?.trim() ?? "";
    if (statusSessionId && terminalStatusSessionIdRef.current !== statusSessionId) {
      const hadPreviousSession = terminalStatusSessionIdRef.current !== "";
      terminalStatusSessionIdRef.current = statusSessionId;
      if (hadPreviousSession) {
        terminalSessionsVersionRef.current += 1;
        setTerminalSessions([]);
      }
    }
    let cancelled = false;
    const requestVersion = terminalSessionsVersionRef.current;
    void terminalClient
      .list()
      .then((sessions) => {
        if (!cancelled && terminalSessionsVersionRef.current === requestVersion) {
          setTerminalSessions(sortTerminalSessions(sessions));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    isAgentMode,
    settings.remote.enableWebTerminal,
    settingsSyncReady,
    status?.online,
    status?.session_id,
    terminalClient,
  ]);

  useEffect(() => {
    if (!terminalClient) return;
    return terminalClient.subscribe((event) => {
      if (event.kind === "output") return;
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions((current) => applyTerminalEventToSessions(current, event));
    });
  }, [terminalClient]);

  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = displayedConversationId.trim();
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
  }, [activeView, displayedConversationId]);

  const displayedConversationSummary = useMemo(() => {
    const displayedId = displayedConversationId.trim();
    if (!displayedId || isLocalDraftConversationId(displayedId)) {
      return null;
    }
    return pickConversationSummary(historyItems, displayedId);
  }, [displayedConversationId, historyItems]);
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
  const hasDetachedSelection = hasDetachedHistorySelection(selectedHistoryId, conversationId);
  const visibleTranscriptEntries = hasDetachedSelection ? selectedHistoryEntries : chatMessages;
  const historyDetailLoadingTitle = useMemo(() => {
    const selectedId = selectedHistoryId.trim();
    if (!selectedId) {
      return "";
    }
    const item = historyItems.find((candidate) => candidate.id === selectedId);
    return item ? resolveConversationTitle(item, item.id) : "";
  }, [historyItems, selectedHistoryId]);
  const transcriptHistoryLoading =
    historyDetailLoading && hasDetachedSelection && selectedHistoryEntries.length === 0;
  const selectedHistoryHasMore =
    selectedHistory?.conversation_id === displayedConversationId &&
    selectedHistory.has_more === true;
  const loadingOlderHistory =
    historyDetailLoading &&
    selectedHistory?.conversation_id === displayedConversationId &&
    selectedHistoryEntries.length > 0;
  const handleLoadFullHistory = useCallback(() => {
    if (!api || !displayedConversationId) {
      return;
    }
    void selectHistory(displayedConversationId, api, {
      syncChat: !hasDetachedSelection,
      fullHistory: true,
    });
  }, [api, displayedConversationId, hasDetachedSelection]);
  const liveTranscriptStore =
    displayedConversationId !== "" ? getConversationLiveStreamStore(displayedConversationId) : null;
  const liveTranscriptMeta =
    displayedConversationId !== ""
      ? liveConversationStreamMeta[displayedConversationId]
      : undefined;
  const isLocallyStreamingDisplayedConversation =
    chatBusy && conversationId.trim() !== "" && displayedConversationId === conversationId.trim();
  const isObservingRemoteLiveConversation = Boolean(
    !isLocallyStreamingDisplayedConversation &&
      displayedConversationId !== "" &&
      remoteRunningConversationIds.has(displayedConversationId),
  );
  useEffect(() => {
    const nextDisplayedConversationId = displayedConversationId.trim();
    for (const conversationIdValue of [...attachedConversationControllersRef.current.keys()]) {
      if (conversationIdValue !== nextDisplayedConversationId) {
        stopAttachedConversationLiveStream(conversationIdValue);
      }
    }
    for (const conversationIdValue of [...liveConversationStreamStoresRef.current.keys()]) {
      if (
        conversationIdValue !== nextDisplayedConversationId &&
        !remoteRunningConversationIdsRef.current.has(conversationIdValue) &&
        !localRunningConversationIdsRef.current.has(conversationIdValue)
      ) {
        clearConversationLiveStream(conversationIdValue);
      }
    }

    if (api && isObservingRemoteLiveConversation && nextDisplayedConversationId !== "") {
      attachVisibleConversationLiveStream(nextDisplayedConversationId, api);
    }
  }, [
    api,
    attachVisibleConversationLiveStream,
    clearConversationLiveStream,
    displayedConversationId,
    isObservingRemoteLiveConversation,
    stopAttachedConversationLiveStream,
  ]);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.title = browserTitle;
  }, [browserTitle]);
  const transcriptToolStatus = isObservingRemoteLiveConversation
    ? (liveTranscriptMeta?.toolStatus ?? null)
    : hasDetachedSelection
      ? null
      : chatToolStatus;
  const transcriptToolStatusIsCompaction = isObservingRemoteLiveConversation
    ? (liveTranscriptMeta?.toolStatusIsCompaction ?? false)
    : hasDetachedSelection
      ? false
      : chatToolStatusIsCompaction;
  const transcriptBusy = (!hasDetachedSelection && chatBusy) || isObservingRemoteLiveConversation;
  const composerIsSending = chatBusy || isObservingRemoteLiveConversation;
  const transcriptError = hasDetachedSelection || chatMessages.length === 0 ? null : chatError;
  const composerCompactionBlocked = transcriptToolStatusIsCompaction;
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
    !composerIsSending &&
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

  const handleFileDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    uploadDragDepthRef.current += 1;
    setIsFileDropActive(true);
  }, []);

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = canDropUpload ? "copy" : "none";
      setIsFileDropActive(true);
    },
    [canDropUpload],
  );

  const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);
    if (uploadDragDepthRef.current === 0) {
      setIsFileDropActive(false);
    }
  }, []);

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      uploadDragDepthRef.current = 0;
      setIsFileDropActive(false);

      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) return;
      if (!canDropUpload) {
        setChatError(fileDropTitle);
        return;
      }
      void handleImportReadableFiles(files);
    },
    [canDropUpload, fileDropTitle, handleImportReadableFiles],
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
    pendingDisplayedConversationAutoBottomRef.current = nextDisplayedConversationId;
  }, [displayedConversationId]);

  useLayoutEffect(() => {
    const targetConversationId = pendingDisplayedConversationAutoBottomRef.current?.trim() ?? "";
    if (
      !targetConversationId ||
      historyDetailLoading ||
      displayedConversationId.trim() !== targetConversationId ||
      (visibleTranscriptEntries.length === 0 && liveTranscriptMeta?.hasStream !== true)
    ) {
      return;
    }

    stickTranscriptToBottom();
    refreshTranscriptScrollState();
    pendingDisplayedConversationAutoBottomRef.current = null;
  }, [
    displayedConversationId,
    historyDetailLoading,
    liveTranscriptMeta?.hasStream,
    refreshTranscriptScrollState,
    stickTranscriptToBottom,
    visibleTranscriptEntries.length,
  ]);

  useEffect(() => {
    if (!historySwitchOverlay) {
      return;
    }

    const targetConversationId = historySwitchOverlay.conversationId;
    const currentDisplayedConversationId = displayedConversationId.trim();
    const currentSelectedHistoryId = selectedHistoryId.trim();
    const isTargetVisible = currentDisplayedConversationId === targetConversationId;
    const isTargetSelected = isTargetVisible || currentSelectedHistoryId === targetConversationId;

    if (historyDetailLoading && isTargetSelected) {
      return;
    }

    let firstRafId: number | null = null;
    let secondRafId: number | null = null;
    const elapsed = Date.now() - historySwitchOverlay.startedAt;
    const delayMs = Math.max(0, HISTORY_SWITCH_OVERLAY_MIN_MS - elapsed);
    const timeoutId = window.setTimeout(() => {
      firstRafId = requestAnimationFrame(() => {
        if (isTargetVisible) {
          stickTranscriptToBottom();
        }
        secondRafId = requestAnimationFrame(() => {
          if (isTargetVisible) {
            stickTranscriptToBottom();
            refreshTranscriptScrollState();
          }
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
  }, [
    displayedConversationId,
    historyDetailLoading,
    historySwitchOverlay,
    refreshTranscriptScrollState,
    selectedHistoryId,
    stickTranscriptToBottom,
  ]);

  useLayoutEffect(() => {
    if (transcriptBusy || liveTranscriptMeta?.hasStream === true) {
      syncTranscriptAutoScroll();
    }
    refreshTranscriptScrollState();
  }, [
    chatError,
    liveTranscriptMeta?.hasStream,
    refreshTranscriptScrollState,
    syncTranscriptAutoScroll,
    transcriptBusy,
    visibleTranscriptEntries,
    transcriptToolStatus,
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
              <div className="text-sm text-muted-foreground">正在同步桌面端设置...</div>
            </div>
          </main>
        </div>
      </LocaleContext.Provider>
    );
  }

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <div className="gateway-shell">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="gateway-hidden-file-input"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            void handleImportReadableFiles(files);
            event.currentTarget.value = "";
          }}
        />

        <div className="gateway-editor-host">
          <ChatHistorySidebar
            items={sidebarItems}
            currentConversationId={displayedConversationId}
            isBusy={historyDetailLoading || historyMutating}
            runningConversationIds={sidebarRunningConversationIds}
            isLoading={historyListLoading && sidebarItems.length === 0}
            totalItems={historyTotal}
            hasMore={historyHasMore}
            isLoadingMore={historyListLoadingMore}
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
            onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
            onStartRenamingProject={handleStartRenamingWorkspaceProject}
            onProjectRenameDraftChange={setProjectRenameDraft}
            onCommitProjectRename={handleCommitWorkspaceProjectRename}
            onCancelProjectRename={handleCancelWorkspaceProjectRename}
            onSetProjectPinned={handleSetWorkspaceProjectPinned}
            onRemoveProject={handleRemoveWorkspaceProject}
            onNewConversation={handleSidebarNewConversation}
            onSelectConversation={handleSidebarSelectConversation}
            onStartRenaming={(item) => {
              setRenamingId(item.id);
              setRenameDraft(item.title);
            }}
            onRenameDraftChange={setRenameDraft}
            onCommitRename={() => {
              if (!renamingId) {
                return;
              }
              const conversationIdValue = renamingId;
              const title = renameDraft.trim();
              setHistoryError(null);
              void (async () => {
                if (!title) {
                  setRenamingId(null);
                  setRenameDraft("");
                  return;
                }
                setHistoryMutating(true);
                try {
                  const summary = await api.renameHistory(conversationIdValue, title);
                  optimisticTitleConversationIdsRef.current.delete(conversationIdValue);
                  unlockHistoryTitlePosition(conversationIdValue);
                  updateHistoryItems((current) => upsertConversationSummary(current, summary));
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "修改历史对话标题失败"));
                } finally {
                  setHistoryMutating(false);
                  setRenamingId(null);
                  setRenameDraft("");
                }
              })();
            }}
            onCancelRename={() => {
              setRenamingId(null);
              setRenameDraft("");
            }}
            onSetPinned={(id, isPinned) => {
              setHistoryError(null);
              void (async () => {
                setHistoryMutating(true);
                try {
                  const summary = await api.pinHistory(id, isPinned);
                  updateHistoryItems((current) => upsertConversationSummary(current, summary));
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "更新历史对话置顶状态失败"));
                } finally {
                  setHistoryMutating(false);
                }
              })();
            }}
            canShareConversations={canShareHistory}
            sharedConversationCount={sharedHistoryItems.length}
            onShareConversation={handleOpenShareModal}
            onOpenSharedConversations={handleOpenSharedHistoryManager}
            onDeleteConversation={(id) => {
              setHistoryError(null);
              if (sidebarRunningConversationIds.has(id)) {
                setHistoryError("后台任务仍在运行，暂时不能删除该对话。");
                return;
              }
              void (async () => {
                setHistoryMutating(true);
                try {
                  await api.deleteHistory(id);
                  optimisticTitleConversationIdsRef.current.delete(id);
                  unlockHistoryTitlePosition(id);
                  updateHistoryItems((current) => current.filter((item) => item.id !== id));
                  setSharedHistoryItemsState(
                    sharedHistoryItemsRef.current.filter((item) => item.id !== id),
                  );
                  if (conversationIdRef.current === id || selectedHistoryIdRef.current === id) {
                    startNewConversation({
                      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
                    });
                  }
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "删除历史对话失败"));
                } finally {
                  setHistoryMutating(false);
                }
              })();
            }}
            onLoadMore={loadMoreHistory}
            onCloseSidebar={() => setSidebarOpen(false)}
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
                className="gateway-chat-frame"
                onDragEnter={handleFileDragEnter}
                onDragOver={handleFileDragOver}
                onDragLeave={handleFileDragLeave}
                onDrop={handleFileDrop}
              >
                <ChatHeader
                  settings={settings}
                  hasModels={modelOptions.length > 0}
                  currentModelLabel={currentModelLabel}
                  modelOptions={modelOptions}
                  selectedValue={selectedValue}
                  sidebarOpen={sidebarOpen}
                  setSettings={setSettings}
                  onOpenSettings={openSettings}
                  onToggleTheme={() =>
                    setSettings((prev) => ({
                      ...prev,
                      theme: prev.theme === "dark" ? "light" : "dark",
                    }))
                  }
                  onOpenSidebar={() => setSidebarOpen(true)}
                  preThemeActions={
                    <span
                      className={`gateway-online-pill${status?.online ? " gateway-online-pill-active" : ""}`}
                      title={status?.online ? "Online" : "Offline"}
                      aria-label={status?.online ? "Online" : "Offline"}
                    >
                      {status?.online ? "Online" : "Offline"}
                    </span>
                  }
                  trailingActions={
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setProjectToolsPanelOpen((open) => !open)}
                        disabled={Boolean(projectToolsDisabledMessage) && !projectToolsPanelOpen}
                        aria-expanded={projectToolsPanelOpen}
                        title={
                          projectToolsPanelOpen
                            ? "Collapse project tools panel"
                            : (projectToolsDisabledMessage ?? "Expand project tools panel")
                        }
                        className={`gateway-project-tools-panel-toggle relative h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95 ${
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
                      <DropdownMenu open={userMenuOpen} onOpenChange={setUserMenuOpen}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            className="h-8 gap-1 rounded-full border border-border/60 bg-background/70 px-1.5 text-foreground shadow-sm hover:bg-muted/70"
                            title="用户菜单"
                          >
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/90 to-sky-500/90 text-[11px] font-semibold text-white">
                              {userAvatarLabel || <User className="h-3.5 w-3.5" />}
                            </span>
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          sideOffset={8}
                          className="min-w-[12rem] rounded-xl border-border/70 bg-popover/95 backdrop-blur supports-[backdrop-filter]:bg-popover/90"
                        >
                          <DropdownMenuLabel className="px-3 py-2">
                            <div className="text-sm font-medium text-foreground">
                              {userMenuLabel}
                            </div>
                            <div className="mt-0.5 text-xs font-normal text-muted-foreground">
                              Session {status?.session_id || "N/A"}
                            </div>
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={handleLogout}
                            className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                          >
                            <LogOut className="h-3.5 w-3.5" />
                            退出登录
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  }
                />

                {statusError ? <div className="gateway-banner-error">{statusError}</div> : null}
                {settingsSyncError ? (
                  <div className="gateway-banner-error">{settingsSyncError}</div>
                ) : null}
                {chatError && chatMessages.length === 0 && !hasDetachedSelection ? (
                  <div className="gateway-banner-error">{chatError}</div>
                ) : null}

                <section className="gateway-transcript-stage">
                  <div className="gateway-transcript-scroll-shell">
                    <ScrollArea ref={transcriptScrollAreaRef} className="gateway-transcript-scroll">
                      <GatewayTranscript
                        conversationId={displayedConversationId}
                        entries={visibleTranscriptEntries}
                        liveStore={liveTranscriptStore}
                        hasLiveStream={liveTranscriptMeta?.hasStream === true}
                        error={transcriptError}
                        toolStatus={transcriptToolStatus}
                        toolStatusIsCompaction={transcriptToolStatusIsCompaction}
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
                        onResendFromEdit={hasDetachedSelection ? undefined : handleResendFromEdit}
                        onResolveUserMessageRef={
                          hasDetachedSelection ? undefined : resolveUserMessageRef
                        }
                      />
                    </ScrollArea>
                    {historySwitchOverlay ? (
                      <HistorySwitchLoadingOverlay locale={settings.locale} />
                    ) : null}
                  </div>
                  {showTranscriptJumpToBottom ? (
                    <button
                      type="button"
                      className="gateway-scroll-to-bottom"
                      onClick={jumpTranscriptToBottom}
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
                    gitClient={gitClient}
                    gitWriteEnabled={settings.remote.enableWebGit}
                    gitDisabledMessage={gitDisabledMessage}
                    onGitChanged={(gitWorkdir) =>
                      window.dispatchEvent(
                        new CustomEvent("liveagent:git-changed", {
                          detail: { workdir: gitWorkdir },
                        }),
                      )
                    }
                    onSend={() => {
                      if (
                        submitInFlightRef.current ||
                        chatBusyRef.current ||
                        isObservingRemoteLiveConversation ||
                        isUploadingFiles ||
                        isImportingPastedTextRef.current ||
                        composerInputDisabled
                      ) {
                        return;
                      }
                      submitInFlightRef.current = true;
                      void (async () => {
                        try {
                          const draft = composerRef.current?.getDraft() ?? null;
                          let text = draft
                            ? (isAgentMode && draft.largePastes.length > 0
                                ? draft.textWithoutLargePastes
                                : buildTextFromComposerDraft(draft)
                              ).trim()
                            : "";
                          let files = pendingUploadedFiles;

                          if (isAgentMode && draft && draft.largePastes.length > 0) {
                            setChatError(null);
                            isImportingPastedTextRef.current = true;
                            setIsUploadingFiles(true);
                            try {
                              const imported = await importPastedTextsAsFiles({
                                token,
                                workdir: displayedConversationWorkdir,
                                pastes: draft.largePastes,
                              });
                              text = buildTextFromComposerDraft(
                                draft,
                                imported.fileByPasteId,
                              ).trim();
                              files = mergePendingUploadedFiles(files, imported.files);
                            } catch (error) {
                              setChatError(asErrorMessage(error, "大段粘贴内容导入失败"));
                              return;
                            } finally {
                              isImportingPastedTextRef.current = false;
                              setIsUploadingFiles(false);
                            }
                          }

                          if (!text && files.length === 0) {
                            return;
                          }
                          composerRef.current?.clear();
                          setPendingUploadedFiles([]);
                          void sendChat(text, {
                            uploadedFiles: files,
                            runtimeControls: chatRuntimeControlsForCurrentProvider,
                          }).catch(() => {
                            setPendingUploadedFiles((current) =>
                              mergePendingUploadedFiles(current, files),
                            );
                          });
                        } finally {
                          submitInFlightRef.current = false;
                        }
                      })();
                    }}
                    onStop={() => {
                      void cancelChat(
                        isObservingRemoteLiveConversation ? displayedConversationId : undefined,
                      );
                    }}
                    onComposerBusyChange={handleComposerBusyChange}
                    onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                    onPickReadableFiles={() => fileInputRef.current?.click()}
                    onPasteFiles={handleImportReadableFiles}
                    pendingUploadedFiles={pendingUploadedFiles}
                    onRemovePendingUpload={(relativePath) => {
                      setPendingUploadedFiles((current) =>
                        current.filter((file) => file.relativePath !== relativePath),
                      );
                    }}
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

                        <div
                          className="h-px w-12 bg-foreground/10 dark:bg-white/10"
                          aria-hidden="true"
                        />

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
                              canDropUpload
                                ? "bg-foreground/35 dark:bg-white/50"
                                : "bg-destructive/55"
                            }`}
                          />
                          {fileDropLimitHint}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </section>
              </div>
            )}
          </main>
          {workspaceEditorMounted ? (
            <Suspense
              fallback={
                <div className="workspace-code-editor-overlay absolute inset-0 z-40 flex items-center justify-center border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
                  {translate("workspaceEditor.loading", settings.locale)}
                </div>
              }
            >
              <WorkspaceCodeEditorOverlay
                openRequest={workspaceEditorOpenRequest}
                closeRequestId={workspaceEditorCloseRequestId}
                isOpen={workspaceEditorOpen}
                finalCloseRequested={workspaceEditorCleanupPending}
                theme={settings.theme}
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
          {workspaceImagePreviewMounted ? (
            <Suspense
              fallback={
                <div className="workspace-image-preview-overlay absolute inset-0 z-40 flex items-center justify-center border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
                  {translate("workspaceImagePreview.loading", settings.locale)}
                </div>
              }
            >
              <WorkspaceImagePreviewOverlay
                openRequest={workspaceImagePreviewOpenRequest}
                isOpen={workspaceImagePreviewOpen}
                onRequestClose={requestWorkspaceImagePreviewClose}
                onClose={handleWorkspaceImagePreviewClosed}
              />
            </Suspense>
          ) : null}
        </div>

        {terminalClient ? (
          <ProjectToolsPanel
            isOpen={activeView === "chat" && projectToolsPanelOpen}
            collapseImmediately={activeView !== "chat"}
            projectPathKey={terminalProjectPathKey}
            cwd={terminalProjectPath}
            sessions={projectTerminalSessions}
            width={settings.customSettings.projectToolsPanel.width}
            theme={settings.theme}
            disabledMessage={projectToolsDisabledMessage}
            terminalDisabledMessage={terminalDisabledMessage}
            activeTab={settings.customSettings.projectToolsPanel.activeTab}
            tabOrder={getProjectToolsPanelTabOrder(settings.customSettings, terminalProjectPathKey)}
            fileTreeOpen={projectToolsFileTreeOpen}
            fileTreeState={getProjectToolsFileTreeProjectState(
              settings.customSettings,
              terminalProjectPathKey,
            )}
            gitReviewOpen={isProjectToolsGitReviewOpen(
              settings.customSettings,
              terminalProjectPathKey,
            )}
            client={terminalClient}
            gitClient={gitClient}
            gitWriteEnabled={settings.remote.enableWebGit}
            gitDisabledMessage={gitDisabledMessage}
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
            onFileTreeOpenChange={(open) => {
              setSettings((prev) =>
                updateProjectToolsFileTreeOpen(prev, terminalProjectPathKey, open),
              );
            }}
            onFileTreeStateChange={(patch) =>
              setSettings((prev) =>
                updateProjectToolsFileTreeProjectState(prev, terminalProjectPathKey, patch),
              )
            }
            onGitReviewOpenChange={(open) =>
              setSettings((prev) =>
                updateProjectToolsGitReviewOpen(prev, terminalProjectPathKey, open),
              )
            }
            onSessionsChange={handleProjectTerminalSessionsChange}
            onInsertFileMention={(path, kind) => {
              composerRef.current?.insertFileMention(path, kind);
              composerRef.current?.focus();
            }}
            onOpenFile={handleOpenWorkspaceFile}
            onInsertCommitMention={(commit) => {
              composerRef.current?.insertCommitMention(commit);
              composerRef.current?.focus();
            }}
            onInsertGitFileMention={(file) => {
              composerRef.current?.insertGitFileMention(file);
              composerRef.current?.focus();
            }}
            onClose={() => setProjectToolsPanelOpen(false)}
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
            />
          </div>
        ) : null}
      </div>
    </LocaleContext.Provider>
  );
}
