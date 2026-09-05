import type { ConversationOpenRequest } from "@liveagent/ui/lib/sidebar/openController";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  adoptHistoryWindowState,
  evaluateHistoryWindowResponse,
  type HistoryWindowState,
  planHistoryWindowRequest,
  readHistoryWindowCounts,
  trimLeadingHeadlessEntries,
} from "@/lib/chat/historyWindow";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import type { ChatEntry } from "@/lib/chatUi";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import type { HistoryDetail } from "@/lib/gatewayTypes";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";
import { normalizeGatewayConversationSummary } from "@/lib/sidebar/webSidebarBackend";
import { asErrorMessage } from "./chatEventUtils";
import { HISTORY_DETAIL_INITIAL_MAX_MESSAGES } from "./constants";
import { resolveVisibleConversationId } from "./historyUtils";

type RefreshHistoryWindowOptions = {
  api: GatewayWebSocketClient | null;
  conversationIdRef: MutableRefObject<string>;
  historyWindowStatesRef: MutableRefObject<Map<string, HistoryWindowState>>;
  isConversationBusy: (conversationId: string) => boolean;
  isLocalDraftConversationId: (conversationId: string) => boolean;
  selectedHistoryIdRef: MutableRefObject<string>;
  selectedHistoryRef: MutableRefObject<HistoryDetail | null>;
  setSelectedHistory: (detail: HistoryDetail) => void;
  transcriptStoreRegistry: TranscriptStoreRegistry;
};

export function createRefreshDisplayedConversationHistorySnapshot({
  api,
  conversationIdRef,
  historyWindowStatesRef,
  isConversationBusy,
  isLocalDraftConversationId,
  selectedHistoryIdRef,
  selectedHistoryRef,
  setSelectedHistory,
  transcriptStoreRegistry,
}: RefreshHistoryWindowOptions) {
  return async (
    targetConversationId: string,
    currentApi = api,
    options?: { extendMessages?: number },
  ) => {
    const conversationIdValue = targetConversationId.trim();
    if (!currentApi || !conversationIdValue || isLocalDraftConversationId(conversationIdValue)) {
      return;
    }
    const isStillDisplayedAndIdle = () =>
      resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
        conversationIdValue && !isConversationBusy(conversationIdValue);
    if (!isStillDisplayedAndIdle()) return;

    const extendMessages = options?.extendMessages;
    const windowStates = historyWindowStatesRef.current;
    let detail: HistoryDetail;
    let entries: ChatEntry[];
    try {
      const planned = planHistoryWindowRequest(windowStates.get(conversationIdValue), {
        initialWindowMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
        extendMessages,
      });
      detail = await currentApi.getHistory(
        conversationIdValue,
        planned === undefined ? undefined : { maxMessages: planned },
      );
      if (planned !== undefined && detail.has_more === true) {
        const counts = readHistoryWindowCounts(detail);
        if (!counts) {
          windowStates.delete(conversationIdValue);
          detail = await currentApi.getHistory(conversationIdValue);
        } else {
          const verdict = evaluateHistoryWindowResponse({
            previous: windowStates.get(conversationIdValue),
            counts,
            extendMessages,
          });
          if (verdict.action === "retry") {
            detail = await currentApi.getHistory(conversationIdValue, {
              maxMessages: verdict.retryMaxMessages,
            });
            const retryCounts = readHistoryWindowCounts(detail);
            const retryVerdict =
              retryCounts && detail.has_more === true
                ? evaluateHistoryWindowResponse({
                    previous: windowStates.get(conversationIdValue),
                    counts: retryCounts,
                    extendMessages,
                  })
                : null;
            if (detail.has_more === true) {
              if (!retryVerdict || retryVerdict.action === "retry") return;
              windowStates.set(conversationIdValue, retryVerdict.nextState);
            }
          } else {
            windowStates.set(conversationIdValue, verdict.nextState);
          }
        }
      }
      if (detail.has_more !== true) {
        const counts = readHistoryWindowCounts(detail);
        if (counts) {
          windowStates.set(conversationIdValue, {
            oldestOffset: 0,
            lastTotal: counts.totalMessageCount,
          });
        } else {
          windowStates.delete(conversationIdValue);
        }
      }
      const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
      entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
    } catch {
      return;
    }
    if (!isStillDisplayedAndIdle()) return;
    const detailConversationId = detail.conversation_id.trim();
    if (detailConversationId && detailConversationId !== conversationIdValue) return;
    if (selectedHistoryIdRef.current.trim() === conversationIdValue) {
      selectedHistoryRef.current = detail;
      setSelectedHistory(detail);
    }
    transcriptStoreRegistry.get(conversationIdValue).applyHistorySnapshot(entries, {
      mode: "enrich",
    });
  };
}

type OpenConversationInitialOptions = {
  api: GatewayWebSocketClient | null;
  conversationIdRef: MutableRefObject<string>;
  conversationWorkdirsRef: MutableRefObject<Map<string, string>>;
  getDisplayedConversationId: () => string;
  historyLoadSequenceRef: MutableRefObject<number>;
  historyWindowStatesRef: MutableRefObject<Map<string, HistoryWindowState>>;
  invalidateHistoryLoad: () => number;
  localeErrorMessage: string;
  markVisibleConversationRevision: () => number;
  pendingDisplayedConversationAutoBottomRef: MutableRefObject<string | null>;
  protectedConversationRef: MutableRefObject<string>;
  selectedHistoryIdRef: MutableRefObject<string>;
  setChatError: Dispatch<SetStateAction<string | null>>;
  setConversationId: Dispatch<SetStateAction<string>>;
  setSelectedHistory: Dispatch<SetStateAction<HistoryDetail | null>>;
  setSelectedHistoryId: Dispatch<SetStateAction<string>>;
  transcriptStoreRegistry: TranscriptStoreRegistry;
  visibleConversationRevisionRef: MutableRefObject<number>;
};

export function createOpenConversationInitial(options: OpenConversationInitialOptions) {
  return async (
    conversationId: string,
    request?: ConversationOpenRequest,
  ): Promise<"cache-hit" | "painted"> => {
    const fromSearch = request?.source === "search";
    const currentApi = options.api;
    if (!currentApi) throw new Error("Gateway client is not ready.");
    const loadSequence = options.invalidateHistoryLoad();
    const selectionRevision = options.markVisibleConversationRevision();
    const isStale = () =>
      options.historyLoadSequenceRef.current !== loadSequence ||
      options.visibleConversationRevisionRef.current !== selectionRevision ||
      request?.isCurrent() === false;
    const previousId = options.getDisplayedConversationId();
    const isChanging = previousId !== conversationId;
    const selectConversation = () => {
      options.pendingDisplayedConversationAutoBottomRef.current = conversationId;
      if (isChanging && previousId) {
        options.transcriptStoreRegistry.peek(previousId)?.foldSettledTurns();
      }
      options.protectedConversationRef.current = conversationId;
      options.conversationIdRef.current = conversationId;
      options.selectedHistoryIdRef.current = conversationId;
      options.setConversationId(conversationId);
      options.setSelectedHistoryId(conversationId);
      if (isChanging) {
        options.setChatError(null);
        options.setSelectedHistory(null);
      }
    };
    if (!fromSearch) selectConversation();
    try {
      const planned = planHistoryWindowRequest(
        options.historyWindowStatesRef.current.get(conversationId),
        { initialWindowMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES },
      );
      const detail = await currentApi.getHistory(
        conversationId,
        planned === undefined ? undefined : { maxMessages: planned },
      );
      if (isStale()) return "painted";
      const counts = readHistoryWindowCounts(detail);
      if (counts) {
        options.historyWindowStatesRef.current.set(conversationId, adoptHistoryWindowState(counts));
      } else {
        options.historyWindowStatesRef.current.delete(conversationId);
      }
      const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
      const entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
      if (isStale()) return "painted";
      if (fromSearch) {
        if (!detail.conversation || detail.conversation.id !== conversationId) {
          throw new Error("History response is missing the requested conversation.");
        }
        request?.beforeCommit?.(normalizeGatewayConversationSummary(detail.conversation));
        selectConversation();
      }
      options.setSelectedHistory(detail);
      options.transcriptStoreRegistry
        .get(conversationId)
        .applyHistorySnapshot(entries, { mode: "replace" });
      const detailWorkdir = detail.conversation?.cwd?.trim();
      options.conversationWorkdirsRef.current.set(conversationId, detailWorkdir ?? "");
      request?.afterCommit?.();
      return "painted";
    } catch (error) {
      if (!isStale()) {
        const message = asErrorMessage(error, options.localeErrorMessage);
        if (!fromSearch)
          options.setSelectedHistory({
            conversation_id: conversationId,
            messages_json: message,
            has_more: false,
          });
        options.setChatError(message);
      }
      throw error;
    }
  };
}
