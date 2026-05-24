import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  truncateConversationFromMessage,
  type ConversationViewState,
} from "../../lib/chat/conversation/conversationState";
import {
  normalizeChatRuntimeControls,
  normalizeSystemToolSelection,
} from "../../lib/settings";
import {
  createConversationRuntimeEntry,
  setConversationRuntimeCacheEntry,
  type ConversationRuntimeEntry,
} from "./chatPageRuntime";
import {
  type ActiveGatewayBridgeRequest,
  type GatewayBridgeRuntimeRefs,
  type GatewayChatCancelEvent,
  type GatewayChatRequestEvent,
  type GatewayHistoryTruncatedEvent,
  normalizeGatewayExecutionMode,
  normalizeGatewayWorkdir,
} from "./gatewayBridgeTypes";

type UseGatewayBridgeListenersParams = GatewayBridgeRuntimeRefs & {
  queueGatewayBridgeEventForRequest: (
    requestId: string,
    event: Record<string, unknown>,
  ) => void;
  isConversationRunning: (conversationId: string) => boolean;
  getConversationAbortController: (conversationId: string) => AbortController | null;
  syncVisibleConversationRuntime: (
    conversationId: string,
    entry: ConversationRuntimeEntry,
  ) => void;
  invalidateSubagentsForConversation?: (conversationId: string) => void;
};

type GatewayBridgeRequestRegistry = {
  activeRequests: Map<string, ActiveGatewayBridgeRequest>;
  pendingRequestIds: Set<string>;
  pendingClientRequestIds: Set<string>;
};

const gatewayBridgeRequestRegistry = (() => {
  const root = globalThis as typeof globalThis & {
    __LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__?: GatewayBridgeRequestRegistry;
  };
  root.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__ ??= {
    activeRequests: new Map<string, ActiveGatewayBridgeRequest>(),
    pendingRequestIds: new Set<string>(),
    pendingClientRequestIds: new Set<string>(),
  };
  return root.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__;
})();

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

export function useGatewayBridgeListeners(params: UseGatewayBridgeListenersParams) {
  const {
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    appliedHistoryTruncationsRef,
    historyItemsRef,
    ensureGatewayBridgeConversationReadyRef,
    sendActionRef,
    queueGatewayBridgeEventForRequest,
    isConversationRunning,
    getConversationAbortController,
    syncVisibleConversationRuntime,
    invalidateSubagentsForConversation,
  } = params;

  useEffect(() => {
    let disposed = false;
    let unlistenChatRequest: (() => void) | null = null;
    let unlistenChatCancel: (() => void) | null = null;
    let unlistenHistoryTruncate: (() => void) | null = null;

    const setActiveGatewayBridgeRequest = (request: ActiveGatewayBridgeRequest) => {
      gatewayBridgeRequestRegistry.pendingRequestIds.delete(request.requestId);
      if (request.clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.delete(request.clientRequestId);
      }
      gatewayBridgeRequestRegistry.activeRequests.set(request.requestId, request);
      return request;
    };

    const clearActiveGatewayBridgeRequest = (requestId: string) => {
      gatewayBridgeRequestRegistry.activeRequests.delete(requestId.trim());
    };

    const getActiveGatewayBridgeRequestByRequestId = (requestId: string) => {
      return gatewayBridgeRequestRegistry.activeRequests.get(requestId.trim()) ?? null;
    };

    const getActiveGatewayBridgeRequestByConversationId = (conversationId: string) => {
      const targetConversationId = conversationId.trim();
      if (!targetConversationId) {
        return null;
      }

      for (const request of gatewayBridgeRequestRegistry.activeRequests.values()) {
        if (request.conversationId === targetConversationId) {
          return request;
        }
      }
      return null;
    };

    const getActiveGatewayBridgeRequestByClientRequestId = (clientRequestId: string) => {
      const targetClientRequestId = clientRequestId.trim();
      if (!targetClientRequestId) {
        return null;
      }

      for (const request of gatewayBridgeRequestRegistry.activeRequests.values()) {
        if (request.clientRequestId === targetClientRequestId) {
          return request;
        }
      }
      return null;
    };

    const claimGatewayBridgeRequest = (requestId: string, clientRequestId: string) => {
      if (
        gatewayBridgeRequestRegistry.pendingRequestIds.has(requestId) ||
        gatewayBridgeRequestRegistry.activeRequests.has(requestId)
      ) {
        return false;
      }
      if (
        clientRequestId &&
        (gatewayBridgeRequestRegistry.pendingClientRequestIds.has(clientRequestId) ||
          getActiveGatewayBridgeRequestByClientRequestId(clientRequestId))
      ) {
        return false;
      }
      gatewayBridgeRequestRegistry.pendingRequestIds.add(requestId);
      if (clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.add(clientRequestId);
      }
      return true;
    };

    const releaseGatewayBridgeRequestClaim = (
      requestId: string,
      clientRequestId: string,
      request: ActiveGatewayBridgeRequest | null,
    ) => {
      gatewayBridgeRequestRegistry.pendingRequestIds.delete(requestId);
      if (clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.delete(clientRequestId);
      }
      if (request) {
        clearActiveGatewayBridgeRequest(request.requestId);
      }
    };

    void listen<GatewayChatRequestEvent>("gateway:chat-request", (event) => {
      void (async () => {
        const requestId = event.payload.requestId.trim();
        const clientRequestId = event.payload.clientRequestId?.trim() ?? "";
        const message = event.payload.message.trim();
        const uploadedFiles = Array.isArray(event.payload.uploadedFiles)
          ? event.payload.uploadedFiles
          : [];
        const targetConversationId = event.payload.conversationId.trim();
        let resolvedConversationId = targetConversationId;
        let gatewayBridgeRequest: ActiveGatewayBridgeRequest | null = null;
        let claimedRequest = false;

        if (!requestId) {
          return;
        }
        if (!message && uploadedFiles.length === 0) {
          queueGatewayBridgeEventForRequest(requestId, {
            type: "error",
            message: "Remote chat message cannot be empty.",
            conversation_id: targetConversationId,
          });
          return;
        }
        if (!claimGatewayBridgeRequest(requestId, clientRequestId)) {
          return;
        }
        claimedRequest = true;

        try {
          resolvedConversationId =
            await ensureGatewayBridgeConversationReadyRef.current(targetConversationId, {
              forceHydrate: event.payload.forceHydrate === true,
              historyTruncationKey: event.payload.historyTruncationKey,
            });

          const runningRequest =
            getActiveGatewayBridgeRequestByConversationId(resolvedConversationId) ||
            (clientRequestId
              ? getActiveGatewayBridgeRequestByClientRequestId(clientRequestId)
              : null);
          if (
            runningRequest ||
            isConversationRunning(resolvedConversationId) ||
            getConversationAbortController(resolvedConversationId)
          ) {
            queueGatewayBridgeEventForRequest(requestId, {
              type: "error",
              message: "Another remote gateway chat request is already running.",
              conversation_id: runningRequest?.conversationId || resolvedConversationId,
            });
            return;
          }

          gatewayBridgeRequest = setActiveGatewayBridgeRequest({
            requestId,
            conversationId: resolvedConversationId,
            clientRequestId: clientRequestId || undefined,
            startedAt: Date.now(),
            selectedModelOverride: event.payload.selectedModel,
            runtimeControlsOverride: event.payload.runtimeControls
              ? normalizeChatRuntimeControls(event.payload.runtimeControls)
              : undefined,
            executionModeOverride: normalizeGatewayExecutionMode(event.payload.executionMode),
            workdirOverride: normalizeGatewayWorkdir(event.payload.workdir),
            selectedSystemToolIdsOverride: normalizeSystemToolSelection(
              event.payload.selectedSystemTools,
            ),
          });
          await sendActionRef.current({
            textOverride: message,
            uploadedFilesOverride: uploadedFiles,
            conversationIdOverride: resolvedConversationId,
            executionModeOverride: gatewayBridgeRequest.executionModeOverride,
            workdirOverride: gatewayBridgeRequest.workdirOverride,
            selectedSystemToolIdsOverride:
              gatewayBridgeRequest.selectedSystemToolIdsOverride,
            runtimeControlsOverride: gatewayBridgeRequest.runtimeControlsOverride,
            gatewayBridgeRequestOverride: gatewayBridgeRequest,
          });
        } catch (error) {
          queueGatewayBridgeEventForRequest(requestId, {
            type: "error",
            message: asErrorMessage(error, "Failed to execute the remote gateway chat request."),
            conversation_id:
              resolvedConversationId || targetConversationId || currentConversationIdRef.current,
          });
        } finally {
          if (claimedRequest) {
            releaseGatewayBridgeRequestClaim(
              requestId,
              clientRequestId,
              gatewayBridgeRequest,
            );
          }
        }
      })();
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenChatRequest = dispose;
    });

    void listen<GatewayChatCancelEvent>("gateway:chat-cancel", (event) => {
      const requestId = event.payload.requestId.trim();
      const explicitConversationId = event.payload.conversationId.trim();
      const conversationId =
        getActiveGatewayBridgeRequestByRequestId(requestId)?.conversationId ??
        explicitConversationId;
      if (!conversationId) {
        return;
      }
      const controller = getConversationAbortController(conversationId);
      controller?.abort();
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenChatCancel = dispose;
    });

    void listen<GatewayHistoryTruncatedEvent>("chat-history:truncated", (event) => {
      const conversationId = event.payload.conversationId?.trim?.() ?? "";
      const segmentIndex = Math.max(0, Math.floor(event.payload.segmentIndex ?? 0));
      const messageIndex = Math.max(0, Math.floor(event.payload.messageIndex ?? 0));
      if (!conversationId) {
        return;
      }

      persistedConversationStateRef.current.delete(conversationId);
      invalidateSubagentsForConversation?.(conversationId);

      const cached = conversationRuntimeCacheRef.current.get(conversationId);
      if (
        !cached ||
        cached.isSending ||
        isConversationRunning(conversationId) ||
        getConversationAbortController(conversationId)
      ) {
        return;
      }

      const nextState: ConversationViewState = truncateConversationFromMessage(cached.state, {
        segmentIndex,
        messageIndex,
      });

      if (nextState.meta.totalMessageCount >= cached.state.meta.totalMessageCount) {
        return;
      }

      const nextEntry = createConversationRuntimeEntry({
        state: nextState,
        sessionId: cached.sessionId,
        createdAt: cached.createdAt,
        compactionStatus: { phase: "idle" },
        isSending: false,
        errorMessage: null,
        hookWarning: null,
      });

      setConversationRuntimeCacheEntry(
        conversationRuntimeCacheRef.current,
        conversationId,
        nextEntry,
      );
      persistedConversationStateRef.current.set(conversationId, nextState);
      appliedHistoryTruncationsRef.current.set(
        conversationId,
        `${segmentIndex}:${messageIndex}`,
      );

      if (currentConversationIdRef.current === conversationId) {
        syncVisibleConversationRuntime(conversationId, nextEntry);
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenHistoryTruncate = dispose;
    });

    return () => {
      disposed = true;
      unlistenChatRequest?.();
      unlistenChatCancel?.();
      unlistenHistoryTruncate?.();
    };
  }, [
    conversationRuntimeCacheRef,
    currentConversationIdRef,
    appliedHistoryTruncationsRef,
    ensureGatewayBridgeConversationReadyRef,
    getConversationAbortController,
    historyItemsRef,
    invalidateSubagentsForConversation,
    isConversationRunning,
    persistedConversationStateRef,
    queueGatewayBridgeEventForRequest,
    sendActionRef,
    syncVisibleConversationRuntime,
  ]);
}
