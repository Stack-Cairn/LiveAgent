import { formatConversationTitle } from "@/lib/chatUi";
import type { ConversationSummary } from "@/lib/gatewayTypes";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  resolveWorkspaceProjects,
  type WorkspaceProject,
} from "@/lib/settings";
import { buildGatewaySettingsSyncPayload } from "@/lib/settings/sync";

function isLocalDraftConversationId(id: string) {
  return id.trim().startsWith("__local_draft__:");
}

import { fallbackWorkspaceProjectName } from "@/lib/workspaceProjects";

import { MOBILE_SIDEBAR_MEDIA_QUERY } from "./constants";

export function formatTranslation(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function getDefaultWorkspaceProjectPath(system: AppSettings["system"]) {
  return (
    system.workspaceProjects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.path ||
    system.workdir
  );
}

export function createWorkspaceProjectFromPath(path: string, kind: WorkspaceProject["kind"]) {
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

export function resolveVisibleConversationId(selectedHistoryId: string, conversationId: string) {
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
