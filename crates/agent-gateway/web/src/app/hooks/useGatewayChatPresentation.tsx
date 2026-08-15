import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import { ToolApprovalBar } from "@liveagent/ui/components/chat/ToolApprovalBar";
import { t as translate } from "@liveagent/ui/i18n/index";
import { deriveContextUsageTokens } from "@liveagent/ui/lib/chat/contextUsage";
import { selectLatestTaskProgress } from "@liveagent/ui/lib/chat/taskProgress";
import {
  readToolApprovalDeadlineAt,
  readToolApprovalPending,
  readToolApprovalSummary,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";
import { buildFloorEntries } from "@liveagent/ui/lib/chat-floor-nav/floorModel";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import type { ContextUsageTokensSource } from "@liveagent/ui/pages/chat/ChatComposerBar";
import type { DragEvent, MutableRefObject } from "react";
import { useCallback, useEffect, useMemo } from "react";
import { isChatRuntimeProtocolIncompatible } from "@/lib/chat/runtimeCompatibility";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { submitToolApprovalDecision } from "@/lib/chat/toolApprovalBridge";
import type { TranscriptSnapshot } from "@/lib/chat/transcript/transcriptStore";
import { resolveConversationBrowserTitle } from "@/lib/chatUi";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import type { AgentStatus, HistoryDetail } from "@/lib/gatewayTypes";
import type { AppSettings, WorkspaceProject } from "@/lib/settings";

import { asErrorMessage } from "../chatEventUtils";
import {
  CHAT_RUNTIME_PREPARING_STATUS,
  DEFAULT_BROWSER_TITLE,
  HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES,
  MAX_UPLOAD_FILES,
  MCP_HUB_BROWSER_TITLE,
  NEW_CONVERSATION_BROWSER_TITLE,
  SHARED_HISTORY_BROWSER_TITLE,
  SKILLS_HUB_BROWSER_TITLE,
} from "../constants";
import { formatTranslation } from "../historyUtils";
import { shouldDisableGatewaySidebarSections } from "../sidebar/gatewaySidebarAvailability";
import type { ManualCompactPendingRequest } from "./useGatewayConversationRuntime";

type UseGatewayChatPresentationOptions = {
  activeView: ApplicationViewId;
  activeWorkspaceProject: WorkspaceProject | undefined;
  api: GatewayWebSocketClient | null;
  chatCommandHasPending: (conversationId: string) => boolean;
  chatError: string | null;
  clearManualCompactPendingRequest: (conversationId: string, operationId: string) => boolean;
  displayedConversationBusy: boolean;
  displayedConversationId: string;
  displayedConversationWorkdir: string;
  displayedTranscript: TranscriptSnapshot;
  enabledComposerSkills: readonly unknown[];
  fullHistoryLoading: boolean;
  gatewayConnectionLost: boolean;
  handlePendingFileDragOver: (event: DragEvent<HTMLDivElement>, canDropUpload: boolean) => void;
  handlePendingFileDrop: (
    event: DragEvent<HTMLDivElement>,
    options: { canDropUpload: boolean; disabledMessage: string },
  ) => void;
  historyDetailLoading: boolean;
  historyShareToken: string | null;
  isAgentMode: boolean;
  isDisplayedConversation: (conversationId: string) => boolean;
  isLocalDraftConversationId: (conversationId: string) => boolean;
  isUploadingFiles: boolean;
  manualCompactPendingRef: MutableRefObject<ReadonlyMap<string, ManualCompactPendingRequest>>;
  refreshDisplayedConversationHistorySnapshot: (
    conversationId: string,
    api: GatewayWebSocketClient,
    options?: { extendMessages?: number },
  ) => Promise<void>;
  selectedHistory: HistoryDetail | null;
  selectedHistoryId: string;
  setChatError: (message: string | null) => void;
  setFullHistoryLoading: (loading: boolean) => void;
  setManualCompactPendingRequest: (request: ManualCompactPendingRequest) => void;
  settings: AppSettings;
  sidebarAgentStatusFresh: boolean;
  sidebarConversationsById: ReadonlyMap<string, SidebarConversation>;
  status: AgentStatus | null;
  token: string;
  transcriptStoreRegistry: TranscriptStoreRegistry;
};

export function useGatewayChatPresentation({
  activeView,
  activeWorkspaceProject,
  api,
  chatCommandHasPending,
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
}: UseGatewayChatPresentationOptions) {
  const displayedConversationSummary = useMemo(() => {
    const displayedId = displayedConversationId.trim();
    if (!displayedId || isLocalDraftConversationId(displayedId)) return null;
    return sidebarConversationsById.get(displayedId) ?? null;
  }, [displayedConversationId, isLocalDraftConversationId, sidebarConversationsById]);
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
    [
      activeProjectBrowserTitle,
      displayedConversationId,
      displayedConversationSummary,
      isLocalDraftConversationId,
    ],
  );
  const browserTitle = useMemo(() => {
    if (historyShareToken) return SHARED_HISTORY_BROWSER_TITLE;
    if (!token.trim()) return DEFAULT_BROWSER_TITLE;
    if (activeView === "skills-hub") return SKILLS_HUB_BROWSER_TITLE;
    if (activeView === "mcp-hub") return MCP_HUB_BROWSER_TITLE;
    if (activeView === "plugin-hub") return "LiveAgent Plugins";
    return displayedConversationTitle || DEFAULT_BROWSER_TITLE;
  }, [activeView, displayedConversationTitle, historyShareToken, token]);
  useEffect(() => {
    if (typeof document !== "undefined") document.title = browserTitle;
  }, [browserTitle]);
  const historyDetailLoadingTitle = useMemo(() => {
    const selectedId = selectedHistoryId.trim();
    return selectedId ? (sidebarConversationsById.get(selectedId)?.title ?? "") : "";
  }, [selectedHistoryId, sidebarConversationsById]);

  const transcriptRows = displayedTranscript.rows;
  const taskProgressSnapshot = useMemo(
    () => selectLatestTaskProgress(transcriptRows),
    [transcriptRows],
  );
  const contextUsageTokensSource = useMemo<ContextUsageTokensSource>(() => {
    const store = displayedConversationId
      ? transcriptStoreRegistry.get(displayedConversationId)
      : null;
    if (!store) return { subscribe: () => () => {}, getContextUsageTokens: () => undefined };
    let cache: { revision: number; value: number | undefined } | null = null;
    return {
      subscribe: store.subscribe,
      getContextUsageTokens: () => {
        const snapshot = store.getSnapshot();
        if (cache && cache.revision === snapshot.revision) return cache.value;
        const value = deriveContextUsageTokens(snapshot.rows);
        cache = { revision: snapshot.revision, value };
        return value;
      },
    };
  }, [displayedConversationId, transcriptStoreRegistry]);
  const pendingToolApprovals = useMemo(() => {
    const result: {
      toolCallId: string;
      toolName: string;
      summary?: string;
      deadlineAt?: number;
    }[] = [];
    for (const row of transcriptRows) {
      if (row.kind !== "assistant") continue;
      for (const round of row.rounds) {
        for (const block of round.blocks) {
          if (block.kind !== "tool") continue;
          const { toolCall, toolResult } = block.item;
          if (toolResult || !readToolApprovalPending(toolCall.arguments)) continue;
          result.push({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            summary: readToolApprovalSummary(toolCall.arguments),
            deadlineAt: readToolApprovalDeadlineAt(toolCall.arguments) ?? undefined,
          });
        }
      }
    }
    return result;
  }, [transcriptRows]);
  const approvalBar =
    pendingToolApprovals.length > 0 ? (
      <ToolApprovalBar
        pending={pendingToolApprovals}
        onDecide={(toolCallId, decision) => submitToolApprovalDecision(toolCallId, decision)}
        onDecideAll={async (decision) => {
          for (const item of pendingToolApprovals) {
            await submitToolApprovalDecision(item.toolCallId, decision);
          }
        }}
      />
    ) : null;
  const transcriptFloors = useMemo(() => buildFloorEntries(transcriptRows), [transcriptRows]);
  const displayedTranscriptRowCount = transcriptRows.length;
  const transcriptHistoryLoading = historyDetailLoading && displayedTranscriptRowCount === 0;
  const selectedHistoryHasMore =
    selectedHistory?.conversation_id === displayedConversationId &&
    selectedHistory.has_more === true;
  const loadingOlderHistory = fullHistoryLoading && displayedTranscriptRowCount > 0;
  const handleLoadEarlierHistory = useCallback(() => {
    if (!api || !displayedConversationId) return;
    setFullHistoryLoading(true);
    void refreshDisplayedConversationHistorySnapshot(displayedConversationId, api, {
      extendMessages: HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES,
    }).finally(() => setFullHistoryLoading(false));
  }, [
    api,
    displayedConversationId,
    refreshDisplayedConversationHistorySnapshot,
    setFullHistoryLoading,
  ]);

  const transcriptToolStatus =
    displayedTranscript.toolStatus ??
    (displayedConversationId && chatCommandHasPending(displayedConversationId)
      ? CHAT_RUNTIME_PREPARING_STATUS
      : null);
  const transcriptToolStatusIsCompaction = displayedTranscript.toolStatusIsCompaction;
  const handleManualCompact = useCallback(async () => {
    const conversationId = displayedConversationId.trim();
    if (!api || !conversationId || manualCompactPendingRef.current.has(conversationId)) return;
    const operationId = createUuid();
    setManualCompactPendingRequest({
      conversationId,
      operationId,
      workdir: displayedConversationWorkdir,
      startedAt: Date.now(),
    });
    try {
      const response = await api.chatQueueCompactNow(conversationId, operationId);
      if (
        !response.accepted &&
        clearManualCompactPendingRequest(conversationId, operationId) &&
        isDisplayedConversation(conversationId)
      ) {
        setChatError(response.message || translate("chat.manualCompactRejected", settings.locale));
      }
    } catch (error) {
      if (
        clearManualCompactPendingRequest(conversationId, operationId) &&
        isDisplayedConversation(conversationId)
      ) {
        setChatError(
          asErrorMessage(error, translate("chat.manualCompactRejected", settings.locale)),
        );
      }
    }
  }, [
    api,
    clearManualCompactPendingRequest,
    displayedConversationId,
    displayedConversationWorkdir,
    isDisplayedConversation,
    manualCompactPendingRef,
    setChatError,
    setManualCompactPendingRequest,
    settings.locale,
  ]);
  const chatProtocolIncompatible = isChatRuntimeProtocolIncompatible(status);
  const chatProtocolIncompatibleMessage = chatProtocolIncompatible
    ? translate("chat.runtime.protocolIncompatible", settings.locale)
    : null;
  const sidebarSectionsDisabled = shouldDisableGatewaySidebarSections({
    connectionLost: gatewayConnectionLost,
    agentStatusFresh: sidebarAgentStatusFresh,
    agentOnline: status?.online,
  });
  const composerCompactionBlocked = transcriptToolStatusIsCompaction;
  const composerInputDisabled =
    !status?.online ||
    chatProtocolIncompatible ||
    historyDetailLoading ||
    composerCompactionBlocked;
  const composerPlaceholder = chatProtocolIncompatible
    ? translate("chat.runtime.protocolIncompatiblePlaceholder", settings.locale)
    : composerCompactionBlocked
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
  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => handlePendingFileDragOver(event, canDropUpload),
    [canDropUpload, handlePendingFileDragOver],
  );
  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) =>
      handlePendingFileDrop(event, { canDropUpload, disabledMessage: fileDropTitle }),
    [canDropUpload, fileDropTitle, handlePendingFileDrop],
  );

  return {
    approvalBar,
    canDropUpload,
    chatProtocolIncompatibleMessage,
    composerCompactionBlocked,
    composerInputDisabled,
    composerIsSending: displayedConversationBusy,
    composerPlaceholder,
    contextUsageTokensSource,
    displayedTranscriptRowCount,
    fileDropDescription: canDropUpload
      ? translate("chat.upload.dropHint", settings.locale)
      : translate("chat.upload.dropDisabledHint", settings.locale),
    fileDropLimitHint: formatTranslation(translate("chat.upload.dropLimit", settings.locale), {
      max: MAX_UPLOAD_FILES,
    }),
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
    transcriptBusy: displayedConversationBusy,
    transcriptError: displayedTranscriptRowCount === 0 ? null : chatError,
    transcriptFloors,
    transcriptHistoryLoading,
    transcriptLiveStartIndex: displayedTranscript.liveStartIndex,
    transcriptRows,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
  };
}
