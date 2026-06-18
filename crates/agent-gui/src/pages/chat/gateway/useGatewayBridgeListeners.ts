import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { normalizeChatRuntimeControls, normalizeSystemToolSelection } from "../../../lib/settings";
import {
  type ActiveGatewayBridgeRequest,
  type GatewayBridgeRuntimeRefs,
  type GatewayChatCancelEvent,
  type GatewayChatClaimedRequest,
  type GatewayChatRequestReadyEvent,
  normalizeGatewayExecutionMode,
  normalizeGatewayWorkdir,
} from "./gatewayBridgeTypes";

type UseGatewayBridgeListenersParams = GatewayBridgeRuntimeRefs & {
  queueGatewayBridgeEventForRequest: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => void;
  isConversationRunning: (conversationId: string) => boolean;
  getConversationAbortController: (conversationId: string) => AbortController | null;
};

type GatewayBridgeRequestRegistry = {
  activeRequests: Map<string, ActiveGatewayBridgeRequest>;
  pendingRequestIds: Set<string>;
  pendingClientRequestIds: Set<string>;
  pendingConversationIds: Set<string>;
};

type GatewayBridgeClaimResult =
  | "claimed"
  | "duplicate_request"
  | "duplicate_client_request"
  | "conversation_busy";

const GATEWAY_CHAT_RUNTIME_LEASE_MS = 15_000;
const GATEWAY_CHAT_RUNTIME_HEARTBEAT_MS = 2_500;
const GATEWAY_CHAT_RUNTIME_IDLE_POLL_MS = 1_000;
const GATEWAY_CHAT_RUNTIME_STATUS_HEARTBEAT_MS = 2_000;
const GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE =
  "Another remote gateway chat request is already running.";

const gatewayBridgeRequestRegistry = (() => {
  const root = globalThis as typeof globalThis & {
    __LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__?: GatewayBridgeRequestRegistry;
  };
  root.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__ ??= {
    activeRequests: new Map<string, ActiveGatewayBridgeRequest>(),
    pendingRequestIds: new Set<string>(),
    pendingClientRequestIds: new Set<string>(),
    pendingConversationIds: new Set<string>(),
  };
  root.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__.pendingConversationIds ??= new Set<string>();
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

function isConversationAlreadyRunningError(message: string) {
  return message.trim().startsWith("Conversation is already running:");
}

function normalizeGatewayBaseMessageRef(value: unknown): HistoryMessageRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as { segmentIndex?: unknown; messageIndex?: unknown };
  const segmentIndex =
    typeof candidate.segmentIndex === "number" && Number.isFinite(candidate.segmentIndex)
      ? Math.trunc(candidate.segmentIndex)
      : -1;
  const messageIndex =
    typeof candidate.messageIndex === "number" && Number.isFinite(candidate.messageIndex)
      ? Math.trunc(candidate.messageIndex)
      : -1;
  if (segmentIndex < 0 || messageIndex < 0) {
    return undefined;
  }
  return { segmentIndex, messageIndex };
}

export function useGatewayBridgeListeners(params: UseGatewayBridgeListenersParams) {
  const {
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    historyItemsRef,
    ensureGatewayBridgeConversationReadyRef,
    sendActionRef,
    queueGatewayBridgeEventForRequest,
    isConversationRunning,
    getConversationAbortController,
  } = params;

  useEffect(() => {
    let disposed = false;
    let unlistenChatRequestReady: (() => void) | null = null;
    let unlistenChatCancel: (() => void) | null = null;
    let unlistenGatewayStatus: (() => void) | null = null;
    let drainInFlight = false;
    const workerId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? `gateway-chat-runtime-${crypto.randomUUID()}`
        : `gateway-chat-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const heartbeatTimers = new Map<string, number>();

    const activeRuntimeRequestCount = () =>
      gatewayBridgeRequestRegistry.activeRequests.size +
      gatewayBridgeRequestRegistry.pendingRequestIds.size;

    const runtimeVisible = () =>
      typeof document === "undefined" ? true : document.visibilityState !== "hidden";

    const publishRuntimeHeartbeat = (state?: "ready" | "draining" | "busy" | "suspended") => {
      const activeRunCount = activeRuntimeRequestCount();
      const nextState = state ?? (activeRunCount > 0 ? "busy" : "ready");
      void invoke("gateway_chat_runtime_heartbeat", {
        worker_id: workerId,
        state: nextState,
        visible: runtimeVisible(),
        active_run_count: activeRunCount,
      } as any).catch((error) => {
        console.warn("gateway_chat_runtime_heartbeat failed", error);
      });
    };

    const setActiveGatewayBridgeRequest = (request: ActiveGatewayBridgeRequest) => {
      gatewayBridgeRequestRegistry.pendingRequestIds.delete(request.requestId);
      if (request.clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.delete(request.clientRequestId);
      }
      gatewayBridgeRequestRegistry.pendingConversationIds.delete(request.conversationId);
      gatewayBridgeRequestRegistry.activeRequests.set(request.requestId, request);
      publishRuntimeHeartbeat("busy");
      return request;
    };

    const clearActiveGatewayBridgeRequest = (requestId: string) => {
      gatewayBridgeRequestRegistry.activeRequests.delete(requestId.trim());
      publishRuntimeHeartbeat();
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

    const claimGatewayBridgeRequest = (
      requestId: string,
      clientRequestId: string,
      conversationId: string,
    ): GatewayBridgeClaimResult => {
      const targetConversationId = conversationId.trim();
      if (
        gatewayBridgeRequestRegistry.pendingRequestIds.has(requestId) ||
        gatewayBridgeRequestRegistry.activeRequests.has(requestId)
      ) {
        return "duplicate_request";
      }
      if (
        clientRequestId &&
        (gatewayBridgeRequestRegistry.pendingClientRequestIds.has(clientRequestId) ||
          getActiveGatewayBridgeRequestByClientRequestId(clientRequestId))
      ) {
        return "duplicate_client_request";
      }
      if (
        targetConversationId &&
        (gatewayBridgeRequestRegistry.pendingConversationIds.has(targetConversationId) ||
          getActiveGatewayBridgeRequestByConversationId(targetConversationId))
      ) {
        return "conversation_busy";
      }
      gatewayBridgeRequestRegistry.pendingRequestIds.add(requestId);
      if (clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.add(clientRequestId);
      }
      if (targetConversationId) {
        gatewayBridgeRequestRegistry.pendingConversationIds.add(targetConversationId);
      }
      publishRuntimeHeartbeat("busy");
      return "claimed";
    };

    const releaseGatewayBridgeRequestClaim = (
      requestId: string,
      clientRequestId: string,
      conversationId: string,
      request: ActiveGatewayBridgeRequest | null,
    ) => {
      gatewayBridgeRequestRegistry.pendingRequestIds.delete(requestId);
      if (clientRequestId) {
        gatewayBridgeRequestRegistry.pendingClientRequestIds.delete(clientRequestId);
      }
      if (conversationId) {
        gatewayBridgeRequestRegistry.pendingConversationIds.delete(conversationId);
      }
      if (request) {
        clearActiveGatewayBridgeRequest(request.requestId);
      }
      publishRuntimeHeartbeat();
    };

    const stopHeartbeat = (requestId: string) => {
      const timer = heartbeatTimers.get(requestId);
      if (timer !== undefined) {
        window.clearInterval(timer);
        heartbeatTimers.delete(requestId);
      }
    };

    const startHeartbeat = (requestId: string) => {
      stopHeartbeat(requestId);
      publishRuntimeHeartbeat("busy");
      void invoke("gateway_chat_heartbeat", {
        request_id: requestId,
        worker_id: workerId,
      } as any).catch((error) => {
        console.warn("gateway_chat_heartbeat failed", error);
      });
      heartbeatTimers.set(
        requestId,
        window.setInterval(() => {
          void invoke("gateway_chat_heartbeat", {
            request_id: requestId,
            worker_id: workerId,
          } as any).catch((error) => {
            console.warn("gateway_chat_heartbeat failed", error);
          });
        }, GATEWAY_CHAT_RUNTIME_HEARTBEAT_MS),
      );
    };

    const failClaimedRequest = (
      requestId: string,
      conversationId: string,
      errorCode: string,
      message: string,
    ) => {
      void invoke("gateway_chat_fail", {
        request_id: requestId,
        conversation_id: conversationId || undefined,
        error_code: errorCode,
        message,
        terminal: true,
        worker_id: workerId,
      } as any).catch((error) => {
        console.warn("gateway_chat_fail failed", error);
      });
    };

    const handleGatewayChatRequest = async (claimed: GatewayChatClaimedRequest) => {
      const payload = claimed.request;
      const requestId = payload.requestId.trim();
      const clientRequestId = payload.clientRequestId?.trim() ?? "";
      const message = payload.message.trim();
      const uploadedFiles = Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles : [];
      const targetConversationId = payload.conversationId.trim();
      let resolvedConversationId = targetConversationId;
      let gatewayBridgeRequest: ActiveGatewayBridgeRequest | null = null;
      let claimedRequest = false;

      if (!requestId) {
        return;
      }
      startHeartbeat(requestId);
      if (!message && uploadedFiles.length === 0) {
        queueGatewayBridgeEventForRequest(
          requestId,
          {
            type: "error",
            message: "Remote chat message cannot be empty.",
            conversation_id: targetConversationId,
          },
          {
            workerId,
          },
        );
        failClaimedRequest(
          requestId,
          targetConversationId,
          "empty_remote_message",
          "Remote chat message cannot be empty.",
        );
        stopHeartbeat(requestId);
        return;
      }
      const claimResult = claimGatewayBridgeRequest(
        requestId,
        clientRequestId,
        targetConversationId,
      );
      if (claimResult !== "claimed") {
        if (claimResult === "conversation_busy") {
          queueGatewayBridgeEventForRequest(
            requestId,
            {
              type: "error",
              message: GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
              conversation_id: targetConversationId,
            },
            {
              workerId,
            },
          );
          failClaimedRequest(
            requestId,
            targetConversationId,
            "conversation_busy",
            GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
          );
          stopHeartbeat(requestId);
          return;
        }
        void invoke("gateway_chat_release_lease", {
          request_id: requestId,
          worker_id: workerId,
        } as any).catch((error) => {
          console.warn("gateway_chat_release_lease failed", error);
        });
        stopHeartbeat(requestId);
        return;
      }
      claimedRequest = true;

      try {
        const duplicateRequest =
          getActiveGatewayBridgeRequestByRequestId(requestId) ||
          (clientRequestId
            ? getActiveGatewayBridgeRequestByClientRequestId(clientRequestId)
            : null);
        if (duplicateRequest) {
          void invoke("gateway_chat_release_lease", {
            request_id: requestId,
            worker_id: workerId,
          } as any).catch((error) => {
            console.warn("gateway_chat_release_lease failed", error);
          });
          return;
        }
        if (
          targetConversationId &&
          (isConversationRunning(targetConversationId) ||
            getConversationAbortController(targetConversationId))
        ) {
          queueGatewayBridgeEventForRequest(
            requestId,
            {
              type: "error",
              message: GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
              conversation_id: targetConversationId,
            },
            {
              workerId,
            },
          );
          failClaimedRequest(
            requestId,
            targetConversationId,
            "conversation_busy",
            GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
          );
          return;
        }

        const baseMessageRef =
          payload.rebased === true
            ? normalizeGatewayBaseMessageRef(payload.baseMessageRef)
            : undefined;
        if (payload.rebased === true && !baseMessageRef) {
          const message = "Remote edit_resend command is missing base_message_ref.";
          queueGatewayBridgeEventForRequest(
            requestId,
            {
              type: "error",
              message,
              conversation_id: targetConversationId,
            },
            {
              workerId,
            },
          );
          failClaimedRequest(requestId, targetConversationId, "invalid_chat_command", message);
          return;
        }

        resolvedConversationId = await ensureGatewayBridgeConversationReadyRef.current(
          targetConversationId,
          {
            rebased: payload.rebased === true,
            baseMessageRef,
          },
        );

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
          queueGatewayBridgeEventForRequest(
            requestId,
            {
              type: "error",
              message: GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
              conversation_id: runningRequest?.conversationId || resolvedConversationId,
            },
            {
              workerId,
            },
          );
          failClaimedRequest(
            requestId,
            runningRequest?.conversationId || resolvedConversationId,
            "conversation_busy",
            GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE,
          );
          return;
        }

        gatewayBridgeRequest = setActiveGatewayBridgeRequest({
          requestId,
          conversationId: resolvedConversationId,
          clientRequestId: clientRequestId || undefined,
          workerId,
          startedAt: Date.now(),
          selectedModelOverride: payload.selectedModel,
          runtimeControlsOverride: payload.runtimeControls
            ? normalizeChatRuntimeControls(payload.runtimeControls)
            : undefined,
          executionModeOverride: normalizeGatewayExecutionMode(payload.executionMode),
          workdirOverride: normalizeGatewayWorkdir(payload.workdir),
          selectedSystemToolIdsOverride: normalizeSystemToolSelection(payload.selectedSystemTools),
        });
        const markRuntimeStarted = async () => {
          await invoke("gateway_chat_mark_started", {
            request_id: requestId,
            conversation_id: resolvedConversationId,
            worker_id: workerId,
          } as any);
        };
        await sendActionRef.current({
          textOverride: message,
          uploadedFilesOverride: uploadedFiles,
          conversationIdOverride: resolvedConversationId,
          executionModeOverride: gatewayBridgeRequest.executionModeOverride,
          workdirOverride: gatewayBridgeRequest.workdirOverride,
          selectedSystemToolIdsOverride: gatewayBridgeRequest.selectedSystemToolIdsOverride,
          runtimeControlsOverride: gatewayBridgeRequest.runtimeControlsOverride,
          gatewayBridgeRequestOverride: gatewayBridgeRequest,
          beforeRuntimeStart: markRuntimeStarted,
          afterInitialHistoryPersist: markRuntimeStarted,
        });
        await invoke("gateway_chat_complete", {
          request_id: requestId,
          conversation_id: resolvedConversationId,
          worker_id: workerId,
        } as any);
      } catch (error) {
        const rawMessage = asErrorMessage(
          error,
          "Failed to execute the remote gateway chat request.",
        );
        const conversationBusy = isConversationAlreadyRunningError(rawMessage);
        const message = conversationBusy ? GATEWAY_CHAT_CONVERSATION_BUSY_MESSAGE : rawMessage;
        queueGatewayBridgeEventForRequest(
          requestId,
          {
            type: "error",
            message,
            conversation_id:
              resolvedConversationId || targetConversationId || currentConversationIdRef.current,
          },
          {
            workerId,
          },
        );
        failClaimedRequest(
          requestId,
          resolvedConversationId || targetConversationId || currentConversationIdRef.current,
          conversationBusy ? "conversation_busy" : "desktop_runtime_error",
          message,
        );
      } finally {
        stopHeartbeat(requestId);
        if (claimedRequest) {
          releaseGatewayBridgeRequestClaim(
            requestId,
            clientRequestId,
            resolvedConversationId || targetConversationId,
            gatewayBridgeRequest,
          );
        }
      }
    };

    const drainGatewayChatInbox = async () => {
      if (drainInFlight || disposed) {
        return;
      }
      drainInFlight = true;
      publishRuntimeHeartbeat("draining");
      try {
        for (;;) {
          if (disposed) {
            return;
          }
          const claimed = await invoke<GatewayChatClaimedRequest | null>(
            "gateway_chat_claim_next",
            {
              worker_id: workerId,
              lease_ms: GATEWAY_CHAT_RUNTIME_LEASE_MS,
            } as any,
          );
          if (!claimed || disposed) {
            return;
          }
          void handleGatewayChatRequest(claimed);
        }
      } catch (error) {
        console.warn("gateway_chat_claim_next failed", error);
      } finally {
        drainInFlight = false;
        publishRuntimeHeartbeat();
      }
    };

    void listen<GatewayChatRequestReadyEvent>("gateway:chat-request-ready", () => {
      publishRuntimeHeartbeat("draining");
      void drainGatewayChatInbox();
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenChatRequestReady = dispose;
      publishRuntimeHeartbeat("ready");
      void drainGatewayChatInbox();
    });

    const idlePollId = window.setInterval(() => {
      publishRuntimeHeartbeat();
      void drainGatewayChatInbox();
    }, GATEWAY_CHAT_RUNTIME_IDLE_POLL_MS);

    const runtimeHeartbeatId = window.setInterval(() => {
      publishRuntimeHeartbeat();
    }, GATEWAY_CHAT_RUNTIME_STATUS_HEARTBEAT_MS);

    const handleRuntimeWake = () => {
      publishRuntimeHeartbeat("draining");
      void drainGatewayChatInbox();
    };

    window.addEventListener("online", handleRuntimeWake);
    window.addEventListener("focus", handleRuntimeWake);
    window.addEventListener("pageshow", handleRuntimeWake);
    document.addEventListener("visibilitychange", handleRuntimeWake);
    document.addEventListener("resume", handleRuntimeWake);

    void listen<Record<string, unknown>>("gateway:status", (event) => {
      if (event.payload?.online === true) {
        handleRuntimeWake();
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenGatewayStatus = dispose;
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

    return () => {
      disposed = true;
      window.clearInterval(idlePollId);
      window.clearInterval(runtimeHeartbeatId);
      window.removeEventListener("online", handleRuntimeWake);
      window.removeEventListener("focus", handleRuntimeWake);
      window.removeEventListener("pageshow", handleRuntimeWake);
      document.removeEventListener("visibilitychange", handleRuntimeWake);
      document.removeEventListener("resume", handleRuntimeWake);
      publishRuntimeHeartbeat("suspended");
      for (const requestId of heartbeatTimers.keys()) {
        stopHeartbeat(requestId);
      }
      unlistenChatRequestReady?.();
      unlistenChatCancel?.();
      unlistenGatewayStatus?.();
    };
  }, [
    conversationRuntimeCacheRef,
    currentConversationIdRef,
    ensureGatewayBridgeConversationReadyRef,
    getConversationAbortController,
    historyItemsRef,
    isConversationRunning,
    queueGatewayBridgeEventForRequest,
    sendActionRef,
  ]);
}
