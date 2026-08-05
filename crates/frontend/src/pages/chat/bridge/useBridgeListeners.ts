import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { normalizeChatRuntimeControls } from "../../../lib/settings";
import { createUuid } from "../../../lib/shared/id";
import {
  type ActiveBackendBridgeRequest,
  type BackendBridgeRuntimeRefs,
  type BackendChatCancelEvent,
  type BackendChatClaimedRequest,
  type BackendChatRequestReadyEvent,
  normalizeBackendExecutionMode,
  normalizeBackendWorkdir,
} from "./bridgeTypes";

type UseBackendBridgeListenersParams = BackendBridgeRuntimeRefs & {
  queueBackendBridgeEventForRequest: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => Promise<void> | void;
  shouldQueueBackendChatRequest: (
    conversationId: string,
    queuePolicy: "auto" | "append" | "interrupt",
  ) => boolean;
  enqueueBackendChatRequest: (
    claimed: BackendChatClaimedRequest,
    conversationId: string,
  ) => Promise<boolean>;
  isConversationRunning: (conversationId: string) => boolean;
  getConversationAbortController: (conversationId: string) => AbortController | null;
  requestConversationStop: (conversationId: string) => boolean;
  requestActiveConversationStop: (conversationId: string, options: { force: boolean }) => boolean;
  consumeConversationStop: (conversationId: string, expectedVersion?: number) => boolean;
};

type BackendBridgeRequestRegistry = {
  activeRequests: Map<string, ActiveBackendBridgeRequest>;
  pendingRequestIds: Set<string>;
  pendingClientRequestIds: Set<string>;
  pendingConversationIds: Set<string>;
};

type BackendBridgeClaimResult =
  | "claimed"
  | "duplicate_request"
  | "duplicate_client_request"
  | "conversation_busy";

const BACKEND_CHAT_RUNTIME_LEASE_MS = 15_000;
const BACKEND_CHAT_RUNTIME_HEARTBEAT_MS = 2_500;
const BACKEND_CHAT_RUNTIME_IDLE_POLL_MS = 1_000;
const BACKEND_CHAT_RUNTIME_STATUS_HEARTBEAT_MS = 2_000;
const BACKEND_CHAT_CONVERSATION_BUSY_MESSAGE =
  "Another remote gateway chat request is already running.";

const backendBridgeRequestRegistry = (() => {
  const root = globalThis as typeof globalThis & {
    __LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__?: BackendBridgeRequestRegistry;
  };
  root.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__ ??= {
    activeRequests: new Map<string, ActiveBackendBridgeRequest>(),
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

function normalizeQueuePolicy(value: string | null | undefined): "auto" | "append" | "interrupt" {
  switch (value?.trim()) {
    case "append":
      return "append";
    case "interrupt":
      return "interrupt";
    default:
      return "auto";
  }
}

function normalizeBackendBaseMessageRef(value: unknown): HistoryMessageRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as {
    segmentIndex?: unknown;
    messageIndex?: unknown;
    segmentId?: unknown;
    messageId?: unknown;
    role?: unknown;
    contentHash?: unknown;
  };
  const segmentIndex =
    typeof candidate.segmentIndex === "number" && Number.isFinite(candidate.segmentIndex)
      ? Math.trunc(candidate.segmentIndex)
      : -1;
  const messageIndex =
    typeof candidate.messageIndex === "number" && Number.isFinite(candidate.messageIndex)
      ? Math.trunc(candidate.messageIndex)
      : -1;
  const segmentId = typeof candidate.segmentId === "string" ? candidate.segmentId.trim() : "";
  const messageId = typeof candidate.messageId === "string" ? candidate.messageId.trim() : "";
  const role = typeof candidate.role === "string" ? candidate.role.trim() : "";
  const contentHash = typeof candidate.contentHash === "string" ? candidate.contentHash.trim() : "";
  if (
    segmentIndex < 0 ||
    messageIndex < 0 ||
    !segmentId ||
    !messageId ||
    role !== "user" ||
    !contentHash
  ) {
    return undefined;
  }
  return {
    segmentIndex,
    messageIndex,
    segmentId,
    messageId,
    role,
    contentHash,
  };
}

export function useBackendBridgeListeners(params: UseBackendBridgeListenersParams) {
  const latestParamsRef = useRef(params);
  latestParamsRef.current = params;
  const workerIdRef = useRef("");
  if (!workerIdRef.current) {
    workerIdRef.current = `gateway-chat-runtime-${createUuid()}`;
  }

  useEffect(() => {
    let disposed = false;
    let unlistenChatRequestReady: (() => void) | null = null;
    let unlistenChatRuntimeWake: (() => void) | null = null;
    let unlistenChatCancel: (() => void) | null = null;
    let unlistenBackendStatus: (() => void) | null = null;
    let drainInFlight = false;
    const workerId = workerIdRef.current;
    const heartbeatTimers = new Map<string, number>();

    const activeRuntimeRequestCount = () =>
      backendBridgeRequestRegistry.activeRequests.size +
      backendBridgeRequestRegistry.pendingRequestIds.size;

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

    const setActiveBackendBridgeRequest = (request: ActiveBackendBridgeRequest) => {
      backendBridgeRequestRegistry.pendingRequestIds.delete(request.requestId);
      if (request.clientRequestId) {
        backendBridgeRequestRegistry.pendingClientRequestIds.delete(request.clientRequestId);
      }
      backendBridgeRequestRegistry.pendingConversationIds.delete(request.conversationId);
      backendBridgeRequestRegistry.activeRequests.set(request.requestId, request);
      publishRuntimeHeartbeat("busy");
      return request;
    };

    const clearActiveBackendBridgeRequest = (requestId: string) => {
      backendBridgeRequestRegistry.activeRequests.delete(requestId.trim());
      publishRuntimeHeartbeat();
    };

    const getActiveBackendBridgeRequestByRequestId = (requestId: string) => {
      return backendBridgeRequestRegistry.activeRequests.get(requestId.trim()) ?? null;
    };

    const getActiveBackendBridgeRequestByConversationId = (conversationId: string) => {
      const targetConversationId = conversationId.trim();
      if (!targetConversationId) {
        return null;
      }

      for (const request of backendBridgeRequestRegistry.activeRequests.values()) {
        if (request.conversationId === targetConversationId) {
          return request;
        }
      }
      return null;
    };

    const getActiveBackendBridgeRequestByClientRequestId = (clientRequestId: string) => {
      const targetClientRequestId = clientRequestId.trim();
      if (!targetClientRequestId) {
        return null;
      }

      for (const request of backendBridgeRequestRegistry.activeRequests.values()) {
        if (request.clientRequestId === targetClientRequestId) {
          return request;
        }
      }
      return null;
    };

    const claimBackendBridgeRequest = (
      requestId: string,
      clientRequestId: string,
      conversationId: string,
    ): BackendBridgeClaimResult => {
      const targetConversationId = conversationId.trim();
      if (
        backendBridgeRequestRegistry.pendingRequestIds.has(requestId) ||
        backendBridgeRequestRegistry.activeRequests.has(requestId)
      ) {
        return "duplicate_request";
      }
      if (
        clientRequestId &&
        (backendBridgeRequestRegistry.pendingClientRequestIds.has(clientRequestId) ||
          getActiveBackendBridgeRequestByClientRequestId(clientRequestId))
      ) {
        return "duplicate_client_request";
      }
      if (
        targetConversationId &&
        (backendBridgeRequestRegistry.pendingConversationIds.has(targetConversationId) ||
          getActiveBackendBridgeRequestByConversationId(targetConversationId))
      ) {
        return "conversation_busy";
      }
      backendBridgeRequestRegistry.pendingRequestIds.add(requestId);
      if (clientRequestId) {
        backendBridgeRequestRegistry.pendingClientRequestIds.add(clientRequestId);
      }
      if (targetConversationId) {
        backendBridgeRequestRegistry.pendingConversationIds.add(targetConversationId);
      }
      publishRuntimeHeartbeat("busy");
      return "claimed";
    };

    const releaseBackendBridgeRequestClaim = (
      requestId: string,
      clientRequestId: string,
      conversationId: string,
      request: ActiveBackendBridgeRequest | null,
    ) => {
      backendBridgeRequestRegistry.pendingRequestIds.delete(requestId);
      if (clientRequestId) {
        backendBridgeRequestRegistry.pendingClientRequestIds.delete(clientRequestId);
      }
      if (conversationId) {
        backendBridgeRequestRegistry.pendingConversationIds.delete(conversationId);
      }
      if (request) {
        clearActiveBackendBridgeRequest(request.requestId);
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
        }, BACKEND_CHAT_RUNTIME_HEARTBEAT_MS),
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

    const markQueuedInGui = async (claimed: BackendChatClaimedRequest, conversationId: string) => {
      const requestId = claimed.requestId.trim();
      if (!requestId) return false;
      const queued = await latestParamsRef.current.enqueueBackendChatRequest(
        claimed,
        conversationId,
      );
      if (!queued) return false;
      await invoke("gateway_chat_mark_queued_in_gui", {
        request_id: requestId,
        conversation_id: conversationId,
        worker_id: workerId,
      } as any);
      stopHeartbeat(requestId);
      return true;
    };

    const handleBackendChatRequest = async (claimed: BackendChatClaimedRequest) => {
      const payload = claimed.request;
      const requestId = payload.requestId.trim();
      const clientRequestId = payload.clientRequestId?.trim() ?? "";
      const message = payload.message.trim();
      const uploadedFiles = Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles : [];
      const targetConversationId = payload.conversationId.trim();
      const queuePolicy = normalizeQueuePolicy(payload.queuePolicy);
      let resolvedConversationId = targetConversationId;
      let backendBridgeRequest: ActiveBackendBridgeRequest | null = null;
      let claimedRequest = false;

      if (!requestId) {
        return;
      }
      startHeartbeat(requestId);
      if (!message && uploadedFiles.length === 0) {
        failClaimedRequest(
          requestId,
          targetConversationId,
          "empty_remote_message",
          "Remote chat message cannot be empty.",
        );
        stopHeartbeat(requestId);
        return;
      }
      const claimResult = claimBackendBridgeRequest(
        requestId,
        clientRequestId,
        targetConversationId,
      );
      if (claimResult !== "claimed") {
        if (claimResult === "conversation_busy") {
          if (targetConversationId) {
            try {
              if (await markQueuedInGui(claimed, targetConversationId)) {
                return;
              }
            } catch (error) {
              console.warn("queue remote gateway chat request failed", error);
            }
          }
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
          getActiveBackendBridgeRequestByRequestId(requestId) ||
          (clientRequestId
            ? getActiveBackendBridgeRequestByClientRequestId(clientRequestId)
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
        const baseMessageRef =
          payload.rebased === true
            ? normalizeBackendBaseMessageRef(payload.baseMessageRef)
            : undefined;
        if (payload.rebased === true && !baseMessageRef) {
          const message = "Remote edit_resend command is missing base_message_ref.";
          failClaimedRequest(requestId, targetConversationId, "invalid_chat_command", message);
          return;
        }

        if (
          targetConversationId &&
          payload.rebased !== true &&
          (latestParamsRef.current.shouldQueueBackendChatRequest(
            targetConversationId,
            queuePolicy,
          ) ||
            latestParamsRef.current.isConversationRunning(targetConversationId) ||
            latestParamsRef.current.getConversationAbortController(targetConversationId))
        ) {
          if (await markQueuedInGui(claimed, targetConversationId)) {
            return;
          }
          return;
        }

        resolvedConversationId =
          await latestParamsRef.current.ensureBackendBridgeConversationReadyRef.current(
            targetConversationId,
            {
              rebased: payload.rebased === true,
            },
          );

        const runningRequest =
          getActiveBackendBridgeRequestByConversationId(resolvedConversationId) ||
          (clientRequestId
            ? getActiveBackendBridgeRequestByClientRequestId(clientRequestId)
            : null);
        if (
          latestParamsRef.current.shouldQueueBackendChatRequest(
            resolvedConversationId,
            queuePolicy,
          ) ||
          runningRequest ||
          latestParamsRef.current.isConversationRunning(resolvedConversationId) ||
          latestParamsRef.current.getConversationAbortController(resolvedConversationId)
        ) {
          if (
            await markQueuedInGui(claimed, runningRequest?.conversationId || resolvedConversationId)
          ) {
            return;
          }
          return;
        }

        backendBridgeRequest = setActiveBackendBridgeRequest({
          requestId,
          conversationId: resolvedConversationId,
          clientRequestId: clientRequestId || undefined,
          workerId,
          startedAt: Date.now(),
          selectedModelOverride: payload.selectedModel,
          runtimeControlsOverride: payload.runtimeControls
            ? normalizeChatRuntimeControls(payload.runtimeControls)
            : undefined,
          executionModeOverride: normalizeBackendExecutionMode(payload.executionMode),
          workdirOverride: normalizeBackendWorkdir(payload.workdir),
        });
        const markRuntimeStarted = async () => {
          await invoke("gateway_chat_mark_started", {
            request_id: requestId,
            conversation_id: resolvedConversationId,
            worker_id: workerId,
          } as any);
        };
        const accepted = await latestParamsRef.current.sendActionRef.current({
          textOverride: message,
          uploadedFilesOverride: uploadedFiles,
          conversationIdOverride: resolvedConversationId,
          executionModeOverride: backendBridgeRequest.executionModeOverride,
          workdirOverride: backendBridgeRequest.workdirOverride,
          runtimeControlsOverride: backendBridgeRequest.runtimeControlsOverride,
          backendBridgeRequestOverride: backendBridgeRequest,
          editResendBaseMessageRef: baseMessageRef,
          beforeRuntimeStart: markRuntimeStarted,
          afterInitialHistoryPersist: markRuntimeStarted,
        });
        if (!accepted) {
          failClaimedRequest(
            requestId,
            resolvedConversationId,
            "desktop_runtime_rejected",
            "Desktop app rejected the remote gateway chat request.",
          );
          return;
        }
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
        const message = conversationBusy ? BACKEND_CHAT_CONVERSATION_BUSY_MESSAGE : rawMessage;
        failClaimedRequest(
          requestId,
          resolvedConversationId ||
            targetConversationId ||
            latestParamsRef.current.currentConversationIdRef.current,
          conversationBusy ? "conversation_busy" : "desktop_runtime_error",
          message,
        );
      } finally {
        stopHeartbeat(requestId);
        if (claimedRequest) {
          releaseBackendBridgeRequestClaim(
            requestId,
            clientRequestId,
            resolvedConversationId || targetConversationId,
            backendBridgeRequest,
          );
        }
      }
    };

    const drainBackendChatInbox = async () => {
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
          const claimed = await invoke<BackendChatClaimedRequest | null>(
            "gateway_chat_claim_next",
            {
              worker_id: workerId,
              lease_ms: BACKEND_CHAT_RUNTIME_LEASE_MS,
            } as any,
          );
          if (!claimed || disposed) {
            return;
          }
          void handleBackendChatRequest(claimed);
        }
      } catch (error) {
        console.warn("gateway_chat_claim_next failed", error);
      } finally {
        drainInFlight = false;
        publishRuntimeHeartbeat();
      }
    };

    const handleRuntimeWake = () => {
      publishRuntimeHeartbeat("draining");
      void drainBackendChatInbox();
    };

    const nudgeBackendConnection = (reason: string, forceReconnect = false) => {
      void invoke("gateway_nudge_connection", {
        reason,
        force_reconnect: forceReconnect,
      }).catch((error) => {
        console.warn("gateway_nudge_connection failed", error);
      });
    };

    const handleNetworkOnline = () => {
      // Not forced: browsers fire spurious `online` events (VPN toggle,
      // interface re-priority) while the WebSocket stream is healthy and possibly
      // mid-run — force-aborting the runner would discard every queued
      // outbound envelope. If the network really dropped, the offline/stale-
      // heartbeat check inside the nudge (or the transport keepalive)
      // restarts the runner anyway.
      nudgeBackendConnection("network_online");
      handleRuntimeWake();
    };

    const handleLifecycleWake = () => {
      nudgeBackendConnection("webview_wake");
      handleRuntimeWake();
    };

    const handleVisibilityWake = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      handleLifecycleWake();
    };

    void listen<BackendChatRequestReadyEvent>("gateway:chat-request-ready", handleRuntimeWake).then(
      (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlistenChatRequestReady = dispose;
        publishRuntimeHeartbeat("ready");
        void drainBackendChatInbox();
      },
    );

    void listen<Record<string, unknown>>("gateway:chat-runtime-wake", handleRuntimeWake).then(
      (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlistenChatRuntimeWake = dispose;
      },
    );

    // Listener registration is asynchronous. Drain immediately as well so a
    // request queued during startup/remount cannot wait for the listen promise.
    publishRuntimeHeartbeat("draining");
    void drainBackendChatInbox();

    const idlePollId = window.setInterval(() => {
      publishRuntimeHeartbeat();
      void drainBackendChatInbox();
    }, BACKEND_CHAT_RUNTIME_IDLE_POLL_MS);

    const runtimeHeartbeatId = window.setInterval(() => {
      publishRuntimeHeartbeat();
    }, BACKEND_CHAT_RUNTIME_STATUS_HEARTBEAT_MS);

    window.addEventListener("online", handleNetworkOnline);
    window.addEventListener("focus", handleLifecycleWake);
    window.addEventListener("pageshow", handleLifecycleWake);
    document.addEventListener("visibilitychange", handleVisibilityWake);
    document.addEventListener("resume", handleLifecycleWake);

    void listen<Record<string, unknown>>("gateway:status", (event) => {
      if (event.payload?.online === true) {
        handleRuntimeWake();
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenBackendStatus = dispose;
    });

    void listen<BackendChatCancelEvent>("gateway:chat-cancel", (event) => {
      const requestId = event.payload.requestId.trim();
      const explicitConversationId = event.payload.conversationId.trim();
      const activeRequest = getActiveBackendBridgeRequestByRequestId(requestId);
      const conversationId = activeRequest?.conversationId ?? explicitConversationId;
      if (!conversationId) {
        return;
      }
      latestParamsRef.current.requestConversationStop(conversationId);
      const handled = latestParamsRef.current.requestActiveConversationStop(conversationId, {
        force: false,
      });
      const controller = latestParamsRef.current.getConversationAbortController(conversationId);
      controller?.abort();
      // A cancel that found nothing to stop (no bridge request in flight, no
      // handler, no controller, not running) must not leave the persistent
      // stop intent behind — it would silently swallow the next send().
      if (
        !activeRequest &&
        !handled &&
        !controller &&
        !latestParamsRef.current.isConversationRunning(conversationId)
      ) {
        latestParamsRef.current.consumeConversationStop(conversationId);
      }
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
      window.removeEventListener("online", handleNetworkOnline);
      window.removeEventListener("focus", handleLifecycleWake);
      window.removeEventListener("pageshow", handleLifecycleWake);
      document.removeEventListener("visibilitychange", handleVisibilityWake);
      document.removeEventListener("resume", handleLifecycleWake);
      publishRuntimeHeartbeat("suspended");
      for (const requestId of heartbeatTimers.keys()) {
        stopHeartbeat(requestId);
      }
      unlistenChatRequestReady?.();
      unlistenChatRuntimeWake?.();
      unlistenChatCancel?.();
      unlistenBackendStatus?.();
    };
  }, []);
}
