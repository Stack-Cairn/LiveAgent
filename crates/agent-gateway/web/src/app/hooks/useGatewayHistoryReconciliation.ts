import { type MutableRefObject, useEffect, useRef } from "react";

import { type HistoryWindowState, noteHistoryWindowTotal } from "@/lib/chat/historyWindow";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";

import { resolveVisibleConversationId } from "../historyUtils";

const STALE_HISTORY_RETRY_INITIAL_DELAY_MS = 1_000;
const STALE_HISTORY_RETRY_MAX_DELAY_MS = 30_000;

type RefreshDisplayedConversationHistorySnapshot = (
  targetConversationId: string,
  currentApi?: GatewayWebSocketClient | null,
  options?: { extendMessages?: number },
) => Promise<void>;

type UseGatewayHistoryReconciliationOptions = {
  api: GatewayWebSocketClient | null;
  conversationIdRef: MutableRefObject<string>;
  displayedConversationBusy: boolean;
  displayedConversationId: string;
  historyWindowStatesRef: MutableRefObject<Map<string, HistoryWindowState>>;
  isConversationBusy: (conversationId: string) => boolean;
  needsHistoryRefresh: boolean;
  refreshDisplayedConversationHistorySnapshot: RefreshDisplayedConversationHistorySnapshot;
  selectedHistoryIdRef: MutableRefObject<string>;
  transcriptStoreRegistry: TranscriptStoreRegistry;
};

export function useGatewayHistoryReconciliation({
  api,
  conversationIdRef,
  displayedConversationBusy,
  displayedConversationId,
  historyWindowStatesRef,
  isConversationBusy,
  needsHistoryRefresh,
  refreshDisplayedConversationHistorySnapshot,
  selectedHistoryIdRef,
  transcriptStoreRegistry,
}: UseGatewayHistoryReconciliationOptions) {
  const previousDisplayedBusyRef = useRef({ id: "", busy: false });

  useEffect(() => {
    const previous = previousDisplayedBusyRef.current;
    previousDisplayedBusyRef.current = {
      id: displayedConversationId,
      busy: displayedConversationBusy,
    };
    if (
      previous.id === displayedConversationId &&
      previous.busy &&
      !displayedConversationBusy &&
      displayedConversationId
    ) {
      void refreshDisplayedConversationHistorySnapshot(displayedConversationId, api);
    }
  }, [
    api,
    displayedConversationBusy,
    displayedConversationId,
    refreshDisplayedConversationHistorySnapshot,
  ]);

  useEffect(() => {
    const conversationId = displayedConversationId.trim();
    if (!api || !conversationId || displayedConversationBusy || !needsHistoryRefresh) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let retryDelayMs = STALE_HISTORY_RETRY_INITIAL_DELAY_MS;
    const retry = async () => {
      await refreshDisplayedConversationHistorySnapshot(conversationId, api);
      if (cancelled) return;
      const stillStale =
        transcriptStoreRegistry.peek(conversationId)?.getSnapshot().needsHistoryRefresh === true;
      if (!stillStale || isConversationBusy(conversationId)) return;
      retryDelayMs = Math.min(retryDelayMs * 2, STALE_HISTORY_RETRY_MAX_DELAY_MS);
      timerId = window.setTimeout(() => {
        void retry();
      }, retryDelayMs);
    };

    timerId = window.setTimeout(() => {
      void retry();
    }, retryDelayMs);
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [
    api,
    displayedConversationBusy,
    displayedConversationId,
    isConversationBusy,
    needsHistoryRefresh,
    refreshDisplayedConversationHistorySnapshot,
    transcriptStoreRegistry,
  ]);

  useEffect(() => {
    if (!api) return;
    return api.subscribeHistory((event) => {
      if (event.kind !== "upsert") return;
      const conversationId = event.conversation_id.trim();
      if (!conversationId) return;
      const windowStates = historyWindowStatesRef.current;
      const windowState = windowStates.get(conversationId);
      if (windowState && event.conversation) {
        const noted = noteHistoryWindowTotal(windowState, event.conversation.message_count);
        if (noted !== windowState) windowStates.set(conversationId, noted);
      }
      if (
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) !==
        conversationId
      ) {
        return;
      }
      void refreshDisplayedConversationHistorySnapshot(conversationId, api);
    });
  }, [
    api,
    conversationIdRef,
    historyWindowStatesRef,
    refreshDisplayedConversationHistorySnapshot,
    selectedHistoryIdRef,
  ]);
}
