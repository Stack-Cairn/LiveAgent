import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  type ConversationViewState,
  createConversationStateFromContext,
} from "../../../lib/chat/conversation/conversationState";
import {
  buildConversationStateFromWindow,
  CHAT_HISTORY_WINDOW_MESSAGES,
  type ChatHistorySummary,
  type ConversationPersistenceCursor,
  getChatHistoryWindow,
} from "../../../lib/chat/history/chatHistory";
import { createConversationIdentity } from "../../../lib/chat/page/chatPageHelpers";
import {
  type AppSettings,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
} from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import {
  type ConversationRuntimeEntry,
  createConversationRuntimeEntry,
  setConversationRuntimeCacheEntry,
} from "../runtime/chatPageRuntime";
import type { EnsureGatewayBridgeConversationReadyOptions } from "./gatewayBridgeTypes";

type UseGatewayBridgeReadinessParams = {
  settings: AppSettings;
  conversationState: ConversationViewState;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  conversationPersistenceCursorRef: MutableRefObject<Map<string, ConversationPersistenceCursor>>;
  syncVisibleConversationRuntime: (conversationId: string, entry: ConversationRuntimeEntry) => void;
  isConversationRunning: (conversationId: string) => boolean;
  sidebarStore: SidebarStore;
  gatewayBridgeHistorySummaryRef: MutableRefObject<Map<string, ChatHistorySummary>>;
  hydratingConversationIdRef: MutableRefObject<string | null>;
  hydrationFailedConversationIdRef: MutableRefObject<string | null>;
  setHydratingConversationId: Dispatch<SetStateAction<string | null>>;
  setHydrationFailedConversationId: Dispatch<SetStateAction<string | null>>;
};

export function useGatewayBridgeReadiness(params: UseGatewayBridgeReadinessParams) {
  const {
    settings,
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    syncVisibleConversationRuntime,
    isConversationRunning,
    sidebarStore,
    gatewayBridgeHistorySummaryRef,
    hydratingConversationIdRef,
    hydrationFailedConversationIdRef,
    setHydratingConversationId,
    setHydrationFailedConversationId,
  } = params;

  function installHistoryRuntime(params: {
    conversationId: string;
    summary: ChatHistorySummary;
    state: ConversationViewState;
    activeSegmentIndex: number;
    activeSegmentId: string;
    cached?: ConversationRuntimeEntry;
  }) {
    const { conversationId, summary, state, activeSegmentIndex, activeSegmentId, cached } = params;
    const entry = createConversationRuntimeEntry({
      state,
      sessionId: summary.sessionId ?? summary.id,
      createdAt: summary.createdAt,
      compactionStatus: cached?.compactionStatus,
      isSending: cached?.isSending,
      workdir: summary.cwd,
      selectedModel: normalizeSelectedModelForProviders(
        parseSelectedModelJson(summary.selectedModelJson),
        settings.customProviders,
      ),
    });
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, conversationId, entry);
    conversationPersistenceCursorRef.current.set(conversationId, {
      activeSegmentIndex,
      activeSegmentId,
    });
    gatewayBridgeHistorySummaryRef.current.set(conversationId, summary);
    sidebarStore.upsertLocal(summary);
    if (currentConversationIdRef.current === conversationId) {
      syncVisibleConversationRuntime(conversationId, entry);
    }
    if (hydratingConversationIdRef.current === conversationId) {
      setHydratingConversationId(null);
    }
    if (hydrationFailedConversationIdRef.current === conversationId) {
      setHydrationFailedConversationId(null);
    }
    return entry;
  }

  async function ensureGatewayBridgeConversationReady(
    targetConversationId: string,
    options?: EnsureGatewayBridgeConversationReadyOptions,
  ) {
    const id = targetConversationId.trim();
    if (!id) {
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
    if (isConversationRunning(id)) {
      throw new Error(`Conversation is already running: ${id}`);
    }
    const cached = conversationRuntimeCacheRef.current.get(id);
    const isPending = sidebarStore.peek(id)?.isPending === true;
    const forceReload = options?.rebased === true;
    if (
      cached &&
      !forceReload &&
      (conversationPersistenceCursorRef.current.has(id) || cached.isSending || isPending)
    ) {
      return id;
    }

    const record = await getChatHistoryWindow({
      id,
      maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
      includeActiveSegment: true,
    });
    if (!record.activeSegment) throw new Error("历史窗口缺少活跃分段");
    const state = buildConversationStateFromWindow(record);
    installHistoryRuntime({
      conversationId: record.conversation.id,
      summary: record.conversation,
      state,
      activeSegmentIndex: record.activeSegment.segmentIndex,
      activeSegmentId: record.activeSegment.segmentId,
      cached,
    });
    return record.conversation.id;
  }

  return { ensureGatewayBridgeConversationReady };
}
