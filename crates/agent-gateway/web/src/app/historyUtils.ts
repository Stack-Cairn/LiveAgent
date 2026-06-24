import type { ChatHistorySummary } from "@/lib/chat/chatHistory";
import type { ConversationSummary } from "@/lib/gatewayTypes";
import { buildGatewaySettingsSyncPayload } from "@/lib/settings/sync";
import {
  DEFAULT_WORKSPACE_PROJECT_ID,
  resolveWorkspaceProjects,
  type AppSettings,
  type SelectedModel,
  type WorkspaceProject,
} from "@/lib/settings";
import { formatConversationTitle } from "@/lib/chatUi";
import { isLocalDraftConversationId } from "@/lib/localDraftConversation";
import {
  fallbackWorkspaceProjectName,
} from "@/lib/workspaceProjects";

import { MOBILE_SIDEBAR_MEDIA_QUERY } from "./constants";
import { normalizeOptionalStatus } from "./chatEventUtils";
import type { ConversationRuntimeEntry } from "./types";

export function formatTranslation(
  template: string,
  values: Record<string, string | number>,
) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function pickConversationSummary(
  conversations: ConversationSummary[],
  conversationId: string,
): ConversationSummary | null {
  return conversations.find((item) => item.id === conversationId) ?? null;
}

export function getDefaultWorkspaceProjectPath(system: AppSettings["system"]) {
  return (
    system.workspaceProjects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.path ||
    system.workdir
  );
}

export function createWorkspaceProjectFromPath(
  path: string,
  kind: WorkspaceProject["kind"],
) {
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

export function hasSettingsSyncChanged(prev: AppSettings, next: AppSettings) {
  return (
    JSON.stringify(buildGatewaySettingsSyncPayload(prev)) !==
    JSON.stringify(buildGatewaySettingsSyncPayload(next))
  );
}

export function resolveAppWorkspaceProjects(settings: AppSettings): AppSettings {
  return {
    ...settings,
    system: resolveWorkspaceProjects(
      settings.system,
      getDefaultWorkspaceProjectPath(settings.system),
    ),
  };
}

export function resolveConversationTitle(
  summary: ConversationSummary | null,
  fallbackConversationId: string,
) {
  return formatConversationTitle(summary, fallbackConversationId);
}

export function toChatHistorySummary(
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

export function hasLocalDraftConversation(params: {
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

export function createConversationRuntimeEntry(
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

export function resolveVisibleConversationId(
  selectedHistoryId: string,
  conversationId: string,
) {
  const selectedId = selectedHistoryId.trim();
  if (selectedId) {
    return selectedId;
  }
  return conversationId.trim();
}

export function isMobileSidebarLayout() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches;
}

export function shouldOpenSidebarByDefault() {
  return !isMobileSidebarLayout();
}

export function hasDetachedHistorySelection(
  selectedHistoryId: string,
  conversationId: string,
) {
  const selectedId = selectedHistoryId.trim();
  const activeConversationId = conversationId.trim();
  return selectedId !== "" && selectedId !== activeConversationId;
}
