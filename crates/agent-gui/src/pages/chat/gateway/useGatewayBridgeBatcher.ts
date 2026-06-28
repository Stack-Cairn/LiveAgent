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
const GATEWAY_BRIDGE_SEND_RETRY_DELAYS_MS = [100, 300, 750];

function normalizeGatewayBridgeBatchRound(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shouldFlushGatewayBridgeBatchWithoutAnimationFrame() {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState !== "visible";
}

function isTerminalGatewayBridgeEvent(event: Record<string, unknown>) {
  return event.type === "done" || event.type === "error";
}

function delayGatewayBridgeSendRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

async function invokeGatewaySendChatEventWithRetry(
  requestId: string,
  event: Record<string, unknown>,
  workerId?: string,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await invoke("gateway_send_chat_event", {
        request_id: requestId,
        event,
        worker_id: workerId,
      } as any);
      return;
    } catch (error) {
      const retryDelayMs = GATEWAY_BRIDGE_SEND_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined) {
        throw error;
      }
      await delayGatewayBridgeSendRetry(retryDelayMs);
    }
  }
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
  const gatewayEventSendsByRequestRef = useRef(new Map<string, Set<Promise<void>>>());
  const gatewayEventBarriersByRequestRef = useRef(new Map<string, Set<Promise<void>>>());
  const gatewayEventBarrierChainByRequestRef = useRef(new Map<string, Promise<void>>());
  const pendingGatewayBridgeEventBatchesRef = useRef(
    new Map<string, PendingGatewayBridgeEventBatch>(),
  );
  const inFlightToolCallDeltaBatchesRef = useRef(new Set<string>());
  const deferredToolCallDeltaSendsRef = useRef(new Map<string, DeferredToolCallDeltaSend>());

  const trackGatewayBridgeEventSend = useCallback(
    (requestId: string, sendPromise: Promise<void>) => {
      const normalizedRequestId = requestId.trim();
      if (!normalizedRequestId) {
        return;
      }
      let sends = gatewayEventSendsByRequestRef.current.get(normalizedRequestId);
      if (!sends) {
        sends = new Set();
        gatewayEventSendsByRequestRef.current.set(normalizedRequestId, sends);
      }
      sends.add(sendPromise);
      const removeSend = () => {
        const currentSends = gatewayEventSendsByRequestRef.current.get(normalizedRequestId);
        if (!currentSends) {
          return;
        }
        currentSends.delete(sendPromise);
        if (currentSends.size === 0) {
          gatewayEventSendsByRequestRef.current.delete(normalizedRequestId);
        }
      };
      sendPromise.then(removeSend, removeSend);
    },
    [],
  );

  const trackGatewayBridgeEventBarrier = useCallback(
    (requestId: string, barrierPromise: Promise<void>) => {
      const normalizedRequestId = requestId.trim();
      if (!normalizedRequestId) {
        return;
      }
      let barriers = gatewayEventBarriersByRequestRef.current.get(normalizedRequestId);
      if (!barriers) {
        barriers = new Set();
        gatewayEventBarriersByRequestRef.current.set(normalizedRequestId, barriers);
      }
      barriers.add(barrierPromise);
      const removeBarrier = () => {
        const currentBarriers =
          gatewayEventBarriersByRequestRef.current.get(normalizedRequestId);
        if (!currentBarriers) {
          return;
        }
        currentBarriers.delete(barrierPromise);
        if (currentBarriers.size === 0) {
          gatewayEventBarriersByRequestRef.current.delete(normalizedRequestId);
        }
      };
      barrierPromise.then(removeBarrier, removeBarrier);
    },
    [],
  );

  const sendGatewayBridgeEventForRequest = useCallback(
    (requestId: string, event: Record<string, unknown>, options?: GatewayBridgeSendOptions) => {
      const workerId = options?.workerId?.trim() || undefined;
      const sendPromise = gatewayEventChainRef.current
        .catch(() => undefined)
        .then(() => invokeGatewaySendChatEventWithRetry(requestId, event, workerId));
      gatewayEventChainRef.current = sendPromise.catch(() => undefined);
      trackGatewayBridgeEventSend(requestId, sendPromise);
      sendPromise.catch((error) => {
        if (!isTerminalGatewayBridgeEvent(event)) {
          console.warn("gateway_send_chat_event failed", error);
        }
      });
      return sendPromise;
    },
    [trackGatewayBridgeEventSend],
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
      const sendPromise = sendGatewayBridgeEventForRequest(requestId, event, options);
      const finishSend = () => {
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
      };
      sendPromise.then(finishSend, finishSend);
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

  const hasPendingGatewayBridgeEventBatchesForRequest = useCallback((requestId: string) => {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      return false;
    }
    for (const pending of pendingGatewayBridgeEventBatchesRef.current.values()) {
      if (pending.requestId === normalizedRequestId) {
        return true;
      }
    }
    return false;
  }, []);

  const hasDeferredToolCallDeltasForRequest = useCallback((requestId: string) => {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      return false;
    }
    for (const deferred of deferredToolCallDeltaSendsRef.current.values()) {
      if (deferred.requestId === normalizedRequestId) {
        return true;
      }
    }
    return false;
  }, []);

  const hasGatewayBridgeEventSendsForRequest = useCallback((requestId: string) => {
    const sends = gatewayEventSendsByRequestRef.current.get(requestId.trim());
    return Boolean(sends && sends.size > 0);
  }, []);

  const hasGatewayBridgeEventBarriersForRequest = useCallback((requestId: string) => {
    const barriers = gatewayEventBarriersByRequestRef.current.get(requestId.trim());
    return Boolean(barriers && barriers.size > 0);
  }, []);

  const waitForGatewayBridgeEventSendsForRequest = useCallback(async (requestId: string) => {
    const sends = gatewayEventSendsByRequestRef.current.get(requestId.trim());
    if (!sends || sends.size === 0) {
      return;
    }
    const results = await Promise.allSettled(Array.from(sends));
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) {
      throw rejected.reason;
    }
  }, []);

  const waitForGatewayBridgeEventBarriersForRequest = useCallback(async (requestId: string) => {
    const barriers = gatewayEventBarriersByRequestRef.current.get(requestId.trim());
    if (!barriers || barriers.size === 0) {
      return;
    }
    const results = await Promise.allSettled(Array.from(barriers));
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) {
      throw rejected.reason;
    }
  }, []);

  const drainGatewayBridgeEventsForRequest = useCallback(
    async (requestId: string) => {
      const normalizedRequestId = requestId.trim();
      if (!normalizedRequestId) {
        return;
      }
      for (;;) {
        flushGatewayBridgeEventBatchesForRequest(normalizedRequestId);
        await waitForGatewayBridgeEventSendsForRequest(normalizedRequestId);
        await Promise.resolve();
        if (
          !hasPendingGatewayBridgeEventBatchesForRequest(normalizedRequestId) &&
          !hasDeferredToolCallDeltasForRequest(normalizedRequestId) &&
          !hasGatewayBridgeEventSendsForRequest(normalizedRequestId)
        ) {
          return;
        }
      }
    },
    [
      flushGatewayBridgeEventBatchesForRequest,
      hasDeferredToolCallDeltasForRequest,
      hasGatewayBridgeEventSendsForRequest,
      hasPendingGatewayBridgeEventBatchesForRequest,
      waitForGatewayBridgeEventSendsForRequest,
    ],
  );

  const queueTerminalGatewayBridgeEventForRequest = useCallback(
    (requestId: string, event: Record<string, unknown>, options?: GatewayBridgeSendOptions) => {
      const normalizedRequestId = requestId.trim();
      if (!normalizedRequestId) {
        return sendGatewayBridgeEventForRequest(requestId, event, options);
      }
      const previousBarrier =
        gatewayEventBarrierChainByRequestRef.current.get(normalizedRequestId) ??
        Promise.resolve();
      const barrierPromise = previousBarrier
        .catch(() => undefined)
        .then(async () => {
          await drainGatewayBridgeEventsForRequest(normalizedRequestId);
          await sendGatewayBridgeEventForRequest(normalizedRequestId, event, options);
        });
      const barrierChain = barrierPromise.catch(() => undefined);
      gatewayEventBarrierChainByRequestRef.current.set(normalizedRequestId, barrierChain);
      barrierChain.then(() => {
        if (gatewayEventBarrierChainByRequestRef.current.get(normalizedRequestId) === barrierChain) {
          gatewayEventBarrierChainByRequestRef.current.delete(normalizedRequestId);
        }
      });
      trackGatewayBridgeEventBarrier(normalizedRequestId, barrierPromise);
      barrierPromise.catch((error) => {
        console.warn("gateway terminal chat event failed", error);
      });
      return barrierPromise;
    },
    [
      drainGatewayBridgeEventsForRequest,
      sendGatewayBridgeEventForRequest,
      trackGatewayBridgeEventBarrier,
    ],
  );

  const flushGatewayBridgeEventsForRequest = useCallback(
    async (requestId: string) => {
      const normalizedRequestId = requestId.trim();
      if (!normalizedRequestId) {
        return;
      }
      for (;;) {
        await drainGatewayBridgeEventsForRequest(normalizedRequestId);
        await waitForGatewayBridgeEventBarriersForRequest(normalizedRequestId);
        await Promise.resolve();
        if (
          !hasPendingGatewayBridgeEventBatchesForRequest(normalizedRequestId) &&
          !hasDeferredToolCallDeltasForRequest(normalizedRequestId) &&
          !hasGatewayBridgeEventSendsForRequest(normalizedRequestId) &&
          !hasGatewayBridgeEventBarriersForRequest(normalizedRequestId)
        ) {
          return;
        }
      }
    },
    [
      drainGatewayBridgeEventsForRequest,
      hasDeferredToolCallDeltasForRequest,
      hasGatewayBridgeEventBarriersForRequest,
      hasGatewayBridgeEventSendsForRequest,
      hasPendingGatewayBridgeEventBatchesForRequest,
      waitForGatewayBridgeEventBarriersForRequest,
    ],
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
        if (isTerminalGatewayBridgeEvent(event)) {
          return queueTerminalGatewayBridgeEventForRequest(requestId, event, options);
        }
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
      queueTerminalGatewayBridgeEventForRequest,
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
      gatewayEventSendsByRequestRef.current.clear();
      gatewayEventBarriersByRequestRef.current.clear();
      gatewayEventBarrierChainByRequestRef.current.clear();
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
    flushGatewayBridgeEventsForRequest,
  };
}
