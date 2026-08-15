import { t as translate } from "@liveagent/ui/i18n/index";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ActivityStore } from "@/lib/chat/stream/activityStore";
import type { ChatCommandPipeline } from "@/lib/chat/stream/chatCommandPipeline";
import {
  type ConversationStreamEvent,
  type ConversationSubscribeResult,
  readEventRunId,
} from "@/lib/chat/stream/streamTypes";
import {
  type TranscriptStoreRegistry,
  useConversationChat,
} from "@/lib/chat/stream/useConversationChat";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import type { ChatEvent } from "@/lib/gatewayTypes";
import type { AppSettings } from "@/lib/settings";

import { isChatEventTitleFinal, readChatEventTitle } from "../chatEventUtils";

const MANUAL_COMPACTION_TIMEOUT_MS = 5 * 60_000;

export type ManualCompactPendingRequest = {
  conversationId: string;
  operationId: string;
  workdir: string;
  startedAt: number;
};

type UseGatewayConversationRuntimeOptions = {
  activityStore: ActivityStore;
  api: GatewayWebSocketClientLike | null;
  applyLiveConversationTitle: (conversationId: string, title: string) => void;
  chatCommandPipeline: ChatCommandPipeline;
  clearManualCompactPendingRequest: (conversationId: string, operationId: string) => boolean;
  displayedConversationBusyRef: MutableRefObject<boolean>;
  displayedConversationId: string;
  handleTunnelManagerChatEvent: (event: ChatEvent) => void;
  isLocalDraftConversationId: (conversationId: string) => boolean;
  locale: AppSettings["locale"];
  manualCompactPendingByConversation: ReadonlyMap<string, ManualCompactPendingRequest>;
  manualCompactPendingRef: MutableRefObject<ReadonlyMap<string, ManualCompactPendingRequest>>;
  pendingCommandRevision: number;
  refreshChatQueueSnapshot: (conversationId: string) => void;
  setChatError: Dispatch<SetStateAction<string | null>>;
  transcriptStoreRegistry: TranscriptStoreRegistry;
};

export function useGatewayConversationRuntime({
  activityStore,
  api,
  applyLiveConversationTitle,
  chatCommandPipeline,
  clearManualCompactPendingRequest,
  displayedConversationBusyRef,
  displayedConversationId,
  handleTunnelManagerChatEvent,
  isLocalDraftConversationId,
  locale,
  manualCompactPendingByConversation,
  manualCompactPendingRef,
  pendingCommandRevision,
  refreshChatQueueSnapshot,
  setChatError,
  transcriptStoreRegistry,
}: UseGatewayConversationRuntimeOptions) {
  const settleManualCompactionResult = useCallback(
    (
      targetConversationId: string,
      result: {
        operationId: string;
        status: "compacted" | "failed" | "busy" | "skipped";
        message?: string;
      },
    ) => {
      const pending = manualCompactPendingRef.current.get(targetConversationId);
      if (!pending || pending.operationId !== result.operationId) return;
      if (!clearManualCompactPendingRequest(targetConversationId, result.operationId)) return;
      if (result.status === "compacted") return;
      const fallbackKey =
        result.status === "skipped"
          ? "chat.manualCompactBelowThreshold"
          : result.status === "failed"
            ? "chat.manualCompactFailed"
            : "chat.manualCompactRejected";
      setChatError(result.message || translate(fallbackKey, locale));
    },
    [clearManualCompactPendingRequest, locale, manualCompactPendingRef, setChatError],
  );

  const observeConversationStreamEvent = useCallback(
    (
      targetConversationId: string,
      event: ConversationStreamEvent,
      options?: { replay?: boolean },
    ) => {
      const isReplay = options?.replay === true;
      const eventClientRequestId =
        typeof (event as { client_request_id?: unknown }).client_request_id === "string"
          ? ((event as { client_request_id: string }).client_request_id ?? "").trim()
          : "";
      switch (event.type) {
        case "manual_compaction_result":
          settleManualCompactionResult(targetConversationId, event);
          return;
        case "run_started":
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          return;
        case "run_finished": {
          const runId = readEventRunId(event);
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            runId,
            eventClientRequestId || undefined,
          );
          activityStore.settleRun(targetConversationId, runId);
          const finishedTitle =
            typeof (event as { title?: unknown }).title === "string"
              ? ((event as { title: string }).title ?? "").trim()
              : "";
          if (finishedTitle) applyLiveConversationTitle(targetConversationId, finishedTitle);
          return;
        }
        case "run_queued":
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          if (!isReplay) refreshChatQueueSnapshot(targetConversationId);
          return;
        default: {
          const chatEvent = event as ChatEvent;
          const liveTitle = readChatEventTitle(chatEvent);
          if (liveTitle && isChatEventTitleFinal(chatEvent)) {
            applyLiveConversationTitle(targetConversationId, liveTitle);
          }
          if (!isReplay) handleTunnelManagerChatEvent(chatEvent);
        }
      }
    },
    [
      activityStore,
      applyLiveConversationTitle,
      chatCommandPipeline,
      handleTunnelManagerChatEvent,
      refreshChatQueueSnapshot,
      settleManualCompactionResult,
    ],
  );

  const handleConversationStreamSync = useCallback(
    (targetConversationId: string, result: ConversationSubscribeResult) => {
      if (result.activity) {
        chatCommandPipeline.handleRunSignal(
          targetConversationId,
          result.activity.runId,
          result.activity.clientRequestId,
        );
      } else if (!chatCommandPipeline.hasPending(targetConversationId)) {
        const currentActivity = activityStore.get(targetConversationId);
        if (currentActivity) {
          activityStore.settleRun(targetConversationId, currentActivity.runId);
        }
      }
      for (const event of result.events) {
        observeConversationStreamEvent(targetConversationId, event, { replay: true });
      }
    },
    [activityStore, chatCommandPipeline, observeConversationStreamEvent],
  );
  const handleConversationStreamEvent = useCallback(
    (targetConversationId: string, event: ConversationStreamEvent) => {
      observeConversationStreamEvent(targetConversationId, event);
    },
    [observeConversationStreamEvent],
  );
  const hasPendingChatCommand = useCallback(
    (targetConversationId: string) => chatCommandPipeline.hasPending(targetConversationId),
    [chatCommandPipeline],
  );

  const { transcript: displayedTranscript, busy: displayedConversationBusy } = useConversationChat({
    api,
    conversationId: displayedConversationId || null,
    registry: transcriptStoreRegistry,
    activityStore,
    isLocalDraft: isLocalDraftConversationId,
    onStreamEvent: handleConversationStreamEvent,
    onStreamSync: handleConversationStreamSync,
    hasPendingCommand: hasPendingChatCommand,
    pendingRevision: pendingCommandRevision,
  });
  displayedConversationBusyRef.current = displayedConversationBusy;

  const handleConversationStreamEventRef = useRef(handleConversationStreamEvent);
  handleConversationStreamEventRef.current = handleConversationStreamEvent;
  const handleConversationStreamSyncRef = useRef(handleConversationStreamSync);
  handleConversationStreamSyncRef.current = handleConversationStreamSync;

  useEffect(() => {
    if (manualCompactPendingByConversation.size === 0) return;
    const cleanups: Array<() => void> = [];
    for (const pending of manualCompactPendingByConversation.values()) {
      const store = transcriptStoreRegistry.get(pending.conversationId);
      const settleFromStore = () => {
        const result = store.getSnapshot().manualCompactionResult;
        if (result?.operationId === pending.operationId) {
          settleManualCompactionResult(pending.conversationId, result);
        }
      };
      settleFromStore();
      cleanups.push(store.subscribe(settleFromStore));
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [manualCompactPendingByConversation, settleManualCompactionResult, transcriptStoreRegistry]);

  useEffect(() => {
    if (manualCompactPendingByConversation.size === 0) return;
    const timeoutIds: number[] = [];
    for (const pending of manualCompactPendingByConversation.values()) {
      const remaining = Math.max(0, pending.startedAt + MANUAL_COMPACTION_TIMEOUT_MS - Date.now());
      timeoutIds.push(
        window.setTimeout(() => {
          if (clearManualCompactPendingRequest(pending.conversationId, pending.operationId)) {
            setChatError(translate("chat.manualCompactTimedOut", locale));
          }
        }, remaining),
      );
    }
    return () => {
      for (const id of timeoutIds) window.clearTimeout(id);
    };
  }, [clearManualCompactPendingRequest, locale, manualCompactPendingByConversation, setChatError]);

  useEffect(() => {
    if (!api || manualCompactPendingByConversation.size === 0) return;
    const cleanups: Array<() => void> = [];
    for (const pending of manualCompactPendingByConversation.values()) {
      if (pending.conversationId === displayedConversationId) continue;
      const store = transcriptStoreRegistry.get(pending.conversationId);
      cleanups.push(
        api.subscribeConversationStream(pending.conversationId, {
          onSync: (result) => {
            store.applySync(result);
            handleConversationStreamSyncRef.current(pending.conversationId, result);
          },
          onEvent: (event) => {
            store.applyEvent(event);
            handleConversationStreamEventRef.current(pending.conversationId, event);
          },
        }),
      );
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [api, displayedConversationId, manualCompactPendingByConversation, transcriptStoreRegistry]);

  return {
    displayedConversationBusy,
    displayedTranscript,
    manualCompactPending: manualCompactPendingByConversation.has(displayedConversationId),
    manualCompactTransientConversations: useMemo(
      () => Array.from(manualCompactPendingByConversation.values()),
      [manualCompactPendingByConversation],
    ),
  };
}
