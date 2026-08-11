import type { MutableRefObject } from "react";
import { useCallback } from "react";

import type {
  CompactionController,
  CompactionSinks,
} from "../../../lib/chat/compaction/controller";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import { createGatewayBridgeEventController } from "../../../lib/chat/conversation/run/gatewayBridgeEvents";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import { createProviderRuntimeConfig } from "../../../lib/providers/llm";
import type { AppSettings } from "../../../lib/settings";
import { createLocalGatewayChatRunId } from "../gateway/gatewayRuntimeStatusModel";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";
import { buildCompactionContext } from "./conversationContextBuilders";
import { resolveEffectiveChatModelSelection } from "./modelSelection";

/**
 * 手动压缩的装配单点：把发送链路同源的 sinks / providerConfig / gateway bridge
 * 组装为一次 CompactionController.compactManually 调用。仅空闲时执行；
 * 压缩进行状态与检查点经既有 bridge 通道镜像到 WebUI，零协议改动。
 */
export function useManualCompaction(params: {
  settings: AppSettings;
  t: (key: string) => string;
  currentConversationIdRef: MutableRefObject<string>;
  isConversationRunning: (conversationId: string) => boolean;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  getCompactionController: (conversationId: string) => CompactionController;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => void;
  liveTranscriptStore: LiveTranscriptStore;
  resetLiveTranscript: (store?: LiveTranscriptStore) => void;
  updateToolStatus: (status: string | null, store?: LiveTranscriptStore) => void;
  queueGatewayBridgeEventForRequest: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => Promise<void> | void;
  flushGatewayBridgeEventsForRequest: (requestId: string) => Promise<void>;
  persistConversation: (params: PersistConversationParams) => Promise<unknown>;
  displayedConversationWorkdir: string;
  setErrorMessage: (message: string | null) => void;
}) {
  const {
    settings,
    t,
    currentConversationIdRef,
    isConversationRunning,
    buildRuntimeEntryFromVisibleState,
    getCompactionController,
    updateConversationRuntimeEntry,
    liveTranscriptStore,
    resetLiveTranscript,
    updateToolStatus,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    persistConversation,
    displayedConversationWorkdir,
    setErrorMessage,
  } = params;

  return useCallback(async (): Promise<boolean> => {
    const conversationId = currentConversationIdRef.current;
    if (!conversationId.trim() || isConversationRunning(conversationId)) return false;
    const runtimeEntry = buildRuntimeEntryFromVisibleState();
    if (runtimeEntry.compactionStatus.phase === "running") return false;

    let effective: ReturnType<typeof resolveEffectiveChatModelSelection>;
    try {
      effective = resolveEffectiveChatModelSelection({
        settings,
        conversationSelectedModel: runtimeEntry.selectedModel,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
    const { provider, providerId, model, selectedModel } = effective;
    const runtime = createProviderRuntimeConfig(provider, model, settings.chatRuntimeControls);

    const hasRemoteGatewayTarget =
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() !== "" &&
      settings.remote.token.trim() !== "";
    const gatewayBridgeEvents = createGatewayBridgeEventController({
      conversationId,
      requestId: createLocalGatewayChatRunId(conversationId),
      workerId: "gui-live",
      enabled: hasRemoteGatewayTarget,
      sendEvent: queueGatewayBridgeEventForRequest,
      flushEvents: flushGatewayBridgeEventsForRequest,
      resolveErrorConversationId: () => currentConversationIdRef.current,
    });

    const sinks: CompactionSinks = {
      applyState: (state) =>
        updateConversationRuntimeEntry(conversationId, (prev) => ({ ...prev, state })),
      applyStateMidRun: (state) => {
        updateConversationRuntimeEntry(conversationId, (prev) => ({ ...prev, state }));
        resetLiveTranscript(liveTranscriptStore);
      },
      publishStatus: (status) =>
        updateConversationRuntimeEntry(conversationId, (prev) => ({
          ...prev,
          compactionStatus: status,
        })),
      setBridgeToolStatus: (status, isCompaction = false) => {
        gatewayBridgeEvents.queueToolStatus(status, isCompaction);
        updateToolStatus(status, liveTranscriptStore);
      },
      queueCheckpoint: (state) => gatewayBridgeEvents.queueCheckpoint(state),
      persist: (state) =>
        persistConversation({
          conversationId,
          sessionId: runtimeEntry.sessionId,
          providerId,
          model,
          selectedModel,
          cwd: displayedConversationWorkdir || undefined,
          state,
          fallbackTitle: t("chat.pendingTitle"),
          createdAt: runtimeEntry.createdAt,
          titlePromise: null,
        }),
    };

    try {
      const result = await getCompactionController(conversationId).compactManually(
        {
          providerId,
          model,
          runtime,
          cancellation: createTurnCancellation(),
          sinks,
          buildPreparedContext: (state, tools, options) =>
            buildCompactionContext(state, tools, options),
          buildResumeContext: (state, resumeMessage, tools, options) => {
            const base = buildCompactionContext(state, tools, options);
            return resumeMessage ? { ...base, messages: [...base.messages, resumeMessage] } : base;
          },
        },
        runtimeEntry.state,
      );
      return result === "compacted";
    } finally {
      await gatewayBridgeEvents.close();
    }
  }, [
    buildRuntimeEntryFromVisibleState,
    currentConversationIdRef,
    displayedConversationWorkdir,
    flushGatewayBridgeEventsForRequest,
    getCompactionController,
    isConversationRunning,
    liveTranscriptStore,
    persistConversation,
    queueGatewayBridgeEventForRequest,
    resetLiveTranscript,
    setErrorMessage,
    settings,
    t,
    updateConversationRuntimeEntry,
    updateToolStatus,
  ]);
}
