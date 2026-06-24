import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";

type BatchableGatewayBridgeEvent = {
  conversationId: string;
  round: number | null;
} & (
  | {
      type: "token" | "thinking";
      text: string;
    }
  | {
      type: "tool_call_delta";
      id: string;
      name?: string;
      arguments: unknown;
    }
);

type PendingGatewayBridgeEventBatch = BatchableGatewayBridgeEvent & {
  requestId: string;
  workerId?: string;
  rafId: number | null;
  timeoutId: number | null;
  microtaskQueued: boolean;
};

type DeferredToolCallDeltaSend = {
  requestId: string;
  batchKey: string;
  event: Record<string, unknown>;
  options?: GatewayBridgeSendOptions;
};

type GatewayBridgeSendOptions = {
  workerId?: string;
};

const GATEWAY_BRIDGE_BATCH_MAX_DELAY_MS = 32;
const GATEWAY_BRIDGE_BATCH_MAX_TEXT_LENGTH = 640;
const GATEWAY_BRIDGE_TOOL_DELTA_BATCH_MAX_DELAY_MS = 200;
const GATEWAY_BRIDGE_TOOL_DELTA_HIDDEN_BATCH_MAX_DELAY_MS = 750;

function normalizeGatewayBridgeBatchRound(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shouldFlushGatewayBridgeBatchWithoutAnimationFrame() {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState !== "visible";
}

function toBatchableGatewayBridgeEvent(
  event: Record<string, unknown>,
): BatchableGatewayBridgeEvent | null {
  const type = event.type;
  if (type === "token" || type === "thinking") {
    if (typeof event.text !== "string" || event.text.length === 0) {
      return null;
    }

    for (const key of Object.keys(event)) {
      if (key !== "type" && key !== "text" && key !== "conversation_id" && key !== "round") {
        return null;
      }
    }

    return {
      type,
      text: event.text,
      conversationId: typeof event.conversation_id === "string" ? event.conversation_id : "",
      round: normalizeGatewayBridgeBatchRound(event.round),
    };
  }

  if (type === "tool_call_delta" && typeof event.id === "string" && event.id.trim()) {
    return {
      type,
      id: event.id,
      name: typeof event.name === "string" ? event.name : undefined,
      arguments: event.arguments,
      conversationId: typeof event.conversation_id === "string" ? event.conversation_id : "",
      round: normalizeGatewayBridgeBatchRound(event.round),
    };
  }

  return null;
}

function batchableGatewayBridgeEventKey(
  requestId: string,
  event: BatchableGatewayBridgeEvent,
  workerId?: string,
) {
  if (event.type === "tool_call_delta") {
    return [
      requestId,
      workerId ?? "",
      event.type,
      event.conversationId,
      event.round ?? "",
      event.id,
    ].join("\n");
  }
  return [requestId, workerId ?? "", event.type, event.conversationId, event.round ?? ""].join(
    "\n",
  );
}

function isSameGatewayBridgeBatch(
  existing: PendingGatewayBridgeEventBatch,
  next: BatchableGatewayBridgeEvent,
  workerId?: string,
) {
  return (
    existing.type === next.type &&
    existing.conversationId === next.conversationId &&
    existing.round === next.round &&
    existing.workerId === workerId &&
    (existing.type !== "tool_call_delta" ||
      (next.type === "tool_call_delta" && existing.id === next.id))
  );
}

function batchableGatewayBridgeEventSize(event: BatchableGatewayBridgeEvent) {
  if (event.type !== "tool_call_delta") {
    return event.text.length;
  }
  return 0;
}

export function useGatewayBridgeBatcher() {
  const gatewayEventChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingGatewayBridgeEventBatchesRef = useRef(
    new Map<string, PendingGatewayBridgeEventBatch>(),
  );
  const inFlightToolCallDeltaBatchesRef = useRef(new Set<string>());
  const deferredToolCallDeltaSendsRef = useRef(new Map<string, DeferredToolCallDeltaSend>());

  const sendGatewayBridgeEventForRequest = useCallback(
    (requestId: string, event: Record<string, unknown>, options?: GatewayBridgeSendOptions) => {
      const workerId = options?.workerId?.trim() || undefined;
      const sendPromise = gatewayEventChainRef.current
        .catch(() => undefined)
        .then(() =>
          invoke("gateway_send_chat_event", {
            request_id: requestId,
            event,
            worker_id: workerId,
          } as any),
        )
        .then(() => undefined)
        .catch((error) => {
          console.warn("gateway_send_chat_event failed", error);
        });
      gatewayEventChainRef.current = sendPromise;
      return sendPromise;
    },
    [],
  );

  const sendToolCallDeltaForRequest = useCallback(
    (
      batchKey: string,
      requestId: string,
      event: Record<string, unknown>,
      options?: GatewayBridgeSendOptions,
    ) => {
      if (inFlightToolCallDeltaBatchesRef.current.has(batchKey)) {
        deferredToolCallDeltaSendsRef.current.set(batchKey, {
          requestId,
          batchKey,
          event,
          options,
        });
        return;
      }

      inFlightToolCallDeltaBatchesRef.current.add(batchKey);
      sendGatewayBridgeEventForRequest(requestId, event, options).finally(() => {
        inFlightToolCallDeltaBatchesRef.current.delete(batchKey);
        const deferred = deferredToolCallDeltaSendsRef.current.get(batchKey);
        if (!deferred) {
          return;
        }
        deferredToolCallDeltaSendsRef.current.delete(batchKey);
        sendToolCallDeltaForRequest(
          deferred.batchKey,
          deferred.requestId,
          deferred.event,
          deferred.options,
        );
      });
    },
    [sendGatewayBridgeEventForRequest],
  );

  const discardDeferredToolCallDeltasForRequest = useCallback((requestId: string) => {
    for (const [batchKey, deferred] of deferredToolCallDeltaSendsRef.current.entries()) {
      if (deferred.requestId === requestId) {
        deferredToolCallDeltaSendsRef.current.delete(batchKey);
      }
    }
  }, []);

  const flushGatewayBridgeEventBatchForRequest = useCallback(
    (batchKey: string) => {
      const pending = pendingGatewayBridgeEventBatchesRef.current.get(batchKey);
      if (!pending) {
        return;
      }

      pendingGatewayBridgeEventBatchesRef.current.delete(batchKey);
      if (pending.rafId !== null) {
        cancelAnimationFrame(pending.rafId);
      }
      if (pending.timeoutId !== null) {
        window.clearTimeout(pending.timeoutId);
      }
      pending.microtaskQueued = false;
      if (pending.type !== "tool_call_delta" && !pending.text) {
        return;
      }

      const event =
        pending.type === "tool_call_delta"
          ? {
              type: pending.type,
              id: pending.id,
              ...(pending.name ? { name: pending.name } : {}),
              arguments: pending.arguments,
              conversation_id: pending.conversationId,
              ...(pending.round !== null ? { round: pending.round } : {}),
            }
          : {
              type: pending.type,
              text: pending.text,
              conversation_id: pending.conversationId,
              ...(pending.round !== null ? { round: pending.round } : {}),
            };

      const options = {
        workerId: pending.workerId,
      };
      if (pending.type === "tool_call_delta") {
        sendToolCallDeltaForRequest(batchKey, pending.requestId, event, options);
      } else {
        sendGatewayBridgeEventForRequest(pending.requestId, event, options);
      }
    },
    [sendGatewayBridgeEventForRequest, sendToolCallDeltaForRequest],
  );

  const flushGatewayBridgeEventBatchesForRequest = useCallback(
    (requestId: string) => {
      const batchKeys = Array.from(pendingGatewayBridgeEventBatchesRef.current.entries())
        .filter(([, pending]) => pending.requestId === requestId)
        .map(([batchKey]) => batchKey);
      for (const batchKey of batchKeys) {
        flushGatewayBridgeEventBatchForRequest(batchKey);
      }
    },
    [flushGatewayBridgeEventBatchForRequest],
  );

  const scheduleGatewayBridgeEventBatchFlush = useCallback(
    (batchKey: string) => {
      const pending = pendingGatewayBridgeEventBatchesRef.current.get(batchKey);
      if (!pending) {
        return;
      }
      const isToolCallDelta = pending.type === "tool_call_delta";
      const timeoutMs =
        isToolCallDelta && shouldFlushGatewayBridgeBatchWithoutAnimationFrame()
          ? GATEWAY_BRIDGE_TOOL_DELTA_HIDDEN_BATCH_MAX_DELAY_MS
          : isToolCallDelta
            ? GATEWAY_BRIDGE_TOOL_DELTA_BATCH_MAX_DELAY_MS
            : GATEWAY_BRIDGE_BATCH_MAX_DELAY_MS;

      if (shouldFlushGatewayBridgeBatchWithoutAnimationFrame() && !isToolCallDelta) {
        if (pending.microtaskQueued) {
          return;
        }
        pending.microtaskQueued = true;
        queueMicrotask(() => {
          const currentPending = pendingGatewayBridgeEventBatchesRef.current.get(batchKey);
          if (!currentPending) {
            return;
          }
          currentPending.microtaskQueued = false;
          flushGatewayBridgeEventBatchForRequest(batchKey);
        });
        return;
      }

      if (pending.timeoutId === null) {
        pending.timeoutId = window.setTimeout(() => {
          const currentPending = pendingGatewayBridgeEventBatchesRef.current.get(batchKey);
          if (!currentPending) {
            return;
          }
          currentPending.timeoutId = null;
          flushGatewayBridgeEventBatchForRequest(batchKey);
        }, timeoutMs);
      }

      if (isToolCallDelta) {
        return;
      }

      if (pending.rafId !== null) {
        return;
      }
      pending.rafId = requestAnimationFrame(() => {
        const currentPending = pendingGatewayBridgeEventBatchesRef.current.get(batchKey);
        if (!currentPending) {
          return;
        }
        currentPending.rafId = null;
        flushGatewayBridgeEventBatchForRequest(batchKey);
      });
    },
    [flushGatewayBridgeEventBatchForRequest],
  );

  const queueGatewayBridgeEventForRequest = useCallback(
    (requestId: string, event: Record<string, unknown>, options?: GatewayBridgeSendOptions) => {
      const batchable = toBatchableGatewayBridgeEvent(event);
      if (!batchable) {
        flushGatewayBridgeEventBatchesForRequest(requestId);
        discardDeferredToolCallDeltasForRequest(requestId);
        return sendGatewayBridgeEventForRequest(requestId, event, options);
      }

      const workerId = options?.workerId?.trim() || undefined;
      const batchKey = batchableGatewayBridgeEventKey(requestId, batchable, workerId);
      const existing = pendingGatewayBridgeEventBatchesRef.current.get(batchKey);
      if (existing && isSameGatewayBridgeBatch(existing, batchable, workerId)) {
        if (existing.type === "tool_call_delta" && batchable.type === "tool_call_delta") {
          existing.name = batchable.name;
          existing.arguments = batchable.arguments;
        } else if (existing.type !== "tool_call_delta" && batchable.type !== "tool_call_delta") {
          existing.text += batchable.text;
        }
        if (batchableGatewayBridgeEventSize(existing) >= GATEWAY_BRIDGE_BATCH_MAX_TEXT_LENGTH) {
          flushGatewayBridgeEventBatchForRequest(batchKey);
          return;
        }
        scheduleGatewayBridgeEventBatchFlush(batchKey);
        return;
      }

      flushGatewayBridgeEventBatchesForRequest(requestId);
      pendingGatewayBridgeEventBatchesRef.current.set(batchKey, {
        requestId,
        workerId,
        ...batchable,
        rafId: null,
        timeoutId: null,
        microtaskQueued: false,
      });
      if (batchableGatewayBridgeEventSize(batchable) >= GATEWAY_BRIDGE_BATCH_MAX_TEXT_LENGTH) {
        flushGatewayBridgeEventBatchForRequest(batchKey);
        return;
      }
      scheduleGatewayBridgeEventBatchFlush(batchKey);
    },
    [
      discardDeferredToolCallDeltasForRequest,
      flushGatewayBridgeEventBatchesForRequest,
      flushGatewayBridgeEventBatchForRequest,
      scheduleGatewayBridgeEventBatchFlush,
      sendGatewayBridgeEventForRequest,
    ],
  );

  const flushPendingGatewayBridgeEvents = useCallback(() => {
    const batchKeys = Array.from(pendingGatewayBridgeEventBatchesRef.current.keys());
    for (const batchKey of batchKeys) {
      flushGatewayBridgeEventBatchForRequest(batchKey);
    }
  }, [flushGatewayBridgeEventBatchForRequest]);

  useEffect(
    () => () => {
      for (const pending of pendingGatewayBridgeEventBatchesRef.current.values()) {
        if (pending.rafId !== null) {
          cancelAnimationFrame(pending.rafId);
        }
        if (pending.timeoutId !== null) {
          window.clearTimeout(pending.timeoutId);
        }
        pending.microtaskQueued = false;
      }
      pendingGatewayBridgeEventBatchesRef.current.clear();
      deferredToolCallDeltaSendsRef.current.clear();
      inFlightToolCallDeltaBatchesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        flushPendingGatewayBridgeEvents();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushPendingGatewayBridgeEvents);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushPendingGatewayBridgeEvents);
    };
  }, [flushPendingGatewayBridgeEvents]);

  return {
    queueGatewayBridgeEventForRequest,
    flushPendingGatewayBridgeEvents,
  };
}
