import { buildGatewaySettingsSyncPayload } from "@liveagent/ui/lib/settings/sync";
import { formatConversationTitle } from "@/lib/chatUi";
import type { ConversationSummary } from "@/lib/gatewayTypes";
import { type AppSettings, resolveWorkspaceProjects } from "@/lib/settings";

function isLocalDraftConversationId(id: string) {
  return id.trim().startsWith("__local_draft__:");
}

import { getDefaultWorkspaceProjectPath } from "@liveagent/ui/lib/workspaceProjects";

import { MOBILE_SIDEBAR_MEDIA_QUERY } from "./constants";

export function formatTranslation(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
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
