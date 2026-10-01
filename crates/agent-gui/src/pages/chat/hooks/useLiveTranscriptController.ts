import { resolveStreamingRenderDelay } from "@liveagent/ui/lib/chat/streamingRenderPolicy";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createCompactionControllerRegistry } from "../../../lib/chat/compaction/controller";
import {
  cloneLiveRoundSnapshots,
  type LiveRoundSnapshot,
} from "../../../lib/chat/conversation/chatAbort";
import {
  createLiveTranscriptStore,
  type LiveTranscriptStore,
  type RetryAttemptRecord,
} from "../../../lib/chat/conversation/liveTranscriptStore";
import type { LiveRound } from "../../../lib/chat/messages/uiMessages";
import { clearDesktopLiveTrajectory } from "../../../lib/trajectory/liveTrajectory";
import { discardTrajectoryRecorder } from "../../../lib/trajectory/recorderRegistry";

const LIVE_TRANSCRIPT_RAF_FALLBACK_MS = 96;
const LIVE_TRANSCRIPT_BACKGROUND_BATCH_MS = 160;

function shouldUseLiveTranscriptAnimationFrame() {
  return (
    typeof globalThis.requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  );
}

export function scheduleLiveTranscriptFlush(callback: () => void, minimumDelayMs = 0) {
  let frameId: number | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let fallbackId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let finished = false;

  const run = () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null && typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (fallbackId !== null && typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(fallbackId);
      fallbackId = null;
    }
    callback();
  };

  const useFrame = shouldUseLiveTranscriptAnimationFrame();
  const scheduleFrame = () => {
    timeoutId = null;
    frameId = globalThis.requestAnimationFrame(run);
    if (typeof globalThis.setTimeout === "function") {
      fallbackId = globalThis.setTimeout(run, LIVE_TRANSCRIPT_RAF_FALLBACK_MS);
    }
  };

  if (useFrame && minimumDelayMs > 0 && typeof globalThis.setTimeout === "function") {
    timeoutId = globalThis.setTimeout(scheduleFrame, minimumDelayMs);
  } else if (useFrame) {
    scheduleFrame();
  } else if (typeof globalThis.setTimeout === "function") {
    timeoutId = globalThis.setTimeout(
      run,
      Math.max(LIVE_TRANSCRIPT_BACKGROUND_BATCH_MS, minimumDelayMs),
    );
  } else if (!useFrame && typeof queueMicrotask === "function") {
    queueMicrotask(run);
  }

  return () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null && typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (fallbackId !== null && typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(fallbackId);
      fallbackId = null;
    }
  };
}

type UseLiveTranscriptControllerParams = {
  currentConversationId: string;
};

type AbortSnapshot = {
  draftAssistantText: string;
  liveRounds: LiveRoundSnapshot[];
};

type LiveTranscriptArtifacts = {
  store: LiveTranscriptStore;
  pendingDraftDelta: string;
  pendingLRUpdates: Array<(prev: LiveRound[]) => LiveRound[]>;
  // Last-wins coalescing: only the newest status / retry list of a frame
  // reaches the store.
  pendingToolStatus: { value: string | null } | null;
  pendingRetryAttempts: { value: RetryAttemptRecord[] } | null;
  // One shared frame-end flush drains every pending channel and emits in the
  // same task (React batches those renders). Independent per-channel rAF
  // callbacks were separate tasks: a tool-heavy frame could run the full
  // transcript rebuild up to four times.
  flushCancel: (() => void) | null;
  renderedCharacterCount: number;
  abortSnapshot: AbortSnapshot | null;
};

function countLiveTranscriptCharacters(store: LiveTranscriptStore) {
  const snapshot = store.getSnapshot();
  let count = snapshot.draftAssistantText.length;
  for (const round of snapshot.liveRounds) {
    for (const block of round.blocks) {
      if (block.kind === "text" || block.kind === "thinking") count += block.text.length;
    }
  }
  return count;
}

function createLiveTranscriptArtifacts(): LiveTranscriptArtifacts {
  return {
    store: createLiveTranscriptStore(),
    pendingDraftDelta: "",
    pendingLRUpdates: [],
    pendingToolStatus: null,
    pendingRetryAttempts: null,
    flushCancel: null,
    renderedCharacterCount: 0,
    abortSnapshot: null,
  };
}

// Applies every pending channel in one task; the resulting store emits land
// in a single React render pass instead of one render per channel.
function drainPendingLiveUpdates(artifacts: LiveTranscriptArtifacts) {
  const targetStore = artifacts.store;
  if (artifacts.pendingDraftDelta) {
    const acc = artifacts.pendingDraftDelta;
    artifacts.pendingDraftDelta = "";
    targetStore.appendDraftAssistantText(acc);
  }
  if (artifacts.pendingLRUpdates.length > 0) {
    const batch = artifacts.pendingLRUpdates.splice(0);
    targetStore.updateLiveRounds((prev) => {
      let nextRounds = prev;
      for (const update of batch) {
        nextRounds = update(nextRounds);
      }
      return nextRounds;
    });
  }
  if (artifacts.pendingToolStatus) {
    const pending = artifacts.pendingToolStatus;
    artifacts.pendingToolStatus = null;
    targetStore.setToolStatus(pending.value);
  }
  if (artifacts.pendingRetryAttempts) {
    const pending = artifacts.pendingRetryAttempts;
    artifacts.pendingRetryAttempts = null;
    targetStore.setRetryAttempts(pending.value);
  }
  artifacts.renderedCharacterCount = countLiveTranscriptCharacters(targetStore);
}

// First requester wins: a scheduled flush drains every channel, so joining an
// existing schedule never loses data. Light channels (status/retry) request
// delay 0 and may deliver a pending heavy flush one frame early, which only
// happens at tool boundaries.
function requestLiveFlush(artifacts: LiveTranscriptArtifacts, minimumDelayMs: number) {
  if (artifacts.flushCancel !== null) return;
  artifacts.flushCancel = scheduleLiveTranscriptFlush(() => {
    artifacts.flushCancel = null;
    drainPendingLiveUpdates(artifacts);
  }, minimumDelayMs);
}

// Pure live-transcript store management: per-conversation stores plus
// frame-aligned, cost-aware delta flushing. Scroll-follow lives entirely in
// useScrollFollow (owned by ChatTranscript); store mutations reach the
// viewport through React commit → layout → ResizeObserver, so nothing here
// needs to ask for a scroll.
export function useLiveTranscriptController(params: UseLiveTranscriptControllerParams) {
  const { currentConversationId } = params;
  const liveTranscriptArtifactsRef = useRef(new Map<string, LiveTranscriptArtifacts>());
  const liveTranscriptArtifactsByStoreRef = useRef(
    new WeakMap<LiveTranscriptStore, LiveTranscriptArtifacts>(),
  );
  const compactionControllersRef = useRef(createCompactionControllerRegistry());

  const ensureConversationLiveTranscriptArtifacts = useCallback((conversationId: string) => {
    const key = conversationId.trim();
    const existing = liveTranscriptArtifactsRef.current.get(key);
    if (existing) return existing;
    const created = createLiveTranscriptArtifacts();
    liveTranscriptArtifactsRef.current.set(key, created);
    liveTranscriptArtifactsByStoreRef.current.set(created.store, created);
    return created;
  }, []);

  const getConversationLiveTranscriptStore = useCallback(
    (conversationId: string) => ensureConversationLiveTranscriptArtifacts(conversationId).store,
    [ensureConversationLiveTranscriptArtifacts],
  );

  const getCompactionController = useCallback(
    (conversationId: string) => compactionControllersRef.current.get(conversationId),
    [],
  );

  const liveTranscriptStore = useMemo(
    () => getConversationLiveTranscriptStore(currentConversationId),
    [currentConversationId, getConversationLiveTranscriptStore],
  );

  const resolveLiveTranscriptArtifacts = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) =>
      liveTranscriptArtifactsByStoreRef.current.get(targetStore) ?? null,
    [liveTranscriptStore],
  );

  const cancelPendingLiveUpdates = useCallback((artifacts: LiveTranscriptArtifacts | null) => {
    if (!artifacts) return;

    artifacts.flushCancel?.();
    artifacts.flushCancel = null;
    artifacts.pendingDraftDelta = "";
    artifacts.pendingLRUpdates.length = 0;
    artifacts.pendingToolStatus = null;
    artifacts.pendingRetryAttempts = null;
  }, []);

  const flushPendingLiveUpdates = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;

      artifacts.flushCancel?.();
      artifacts.flushCancel = null;
      drainPendingLiveUpdates(artifacts);
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const deleteConversationArtifacts = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      const artifacts = liveTranscriptArtifactsRef.current.get(key);
      cancelPendingLiveUpdates(artifacts ?? null);
      liveTranscriptArtifactsRef.current.delete(key);
      compactionControllersRef.current.dispose(key);
      discardTrajectoryRecorder(key);
      clearDesktopLiveTrajectory(key);
    },
    [cancelPendingLiveUpdates],
  );

  const clearAbortSnapshot = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;
      artifacts.abortSnapshot = null;
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const captureAbortSnapshot = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      flushPendingLiveUpdates(targetStore);
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;
      const liveState = targetStore.getSnapshot();
      artifacts.abortSnapshot = {
        draftAssistantText: liveState.draftAssistantText,
        liveRounds: cloneLiveRoundSnapshots(liveState.liveRounds),
      };
    },
    [flushPendingLiveUpdates, liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const getAbortSnapshot = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      flushPendingLiveUpdates(targetStore);
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      const liveState = targetStore.getSnapshot();
      return (
        artifacts?.abortSnapshot ?? {
          draftAssistantText: liveState.draftAssistantText,
          liveRounds: cloneLiveRoundSnapshots(liveState.liveRounds),
        }
      );
    },
    [flushPendingLiveUpdates, liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const resetLiveTranscript = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      flushPendingLiveUpdates(targetStore);
      targetStore.reset();
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (artifacts) artifacts.renderedCharacterCount = 0;
    },
    [flushPendingLiveUpdates, liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const settleLiveTranscript = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      flushPendingLiveUpdates(targetStore);
      targetStore.settle();
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (artifacts) artifacts.renderedCharacterCount = 0;
    },
    [flushPendingLiveUpdates, liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const appendDraftAssistantText = useCallback(
    (delta: string, targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.appendDraftAssistantText(delta);
        return;
      }

      const shouldApplyImmediately =
        artifacts.pendingDraftDelta.length === 0 &&
        artifacts.flushCancel === null &&
        targetStore.getSnapshot().draftAssistantText.length === 0;
      if (shouldApplyImmediately) {
        targetStore.appendDraftAssistantText(delta);
        artifacts.renderedCharacterCount = countLiveTranscriptCharacters(targetStore);
        return;
      }

      artifacts.pendingDraftDelta += delta;
      requestLiveFlush(
        artifacts,
        resolveStreamingRenderDelay(
          artifacts.renderedCharacterCount + artifacts.pendingDraftDelta.length,
        ),
      );
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const batchLiveRoundsUpdate = useCallback(
    (
      updater: (prev: LiveRound[]) => LiveRound[],
      targetStore: LiveTranscriptStore = liveTranscriptStore,
    ) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.updateLiveRounds(updater);
        return;
      }

      const snapshot = targetStore.getSnapshot();
      const lastRound = snapshot.liveRounds[snapshot.liveRounds.length - 1];
      const shouldApplyImmediately =
        artifacts.pendingLRUpdates.length === 0 &&
        artifacts.flushCancel === null &&
        (snapshot.liveRounds.length === 0 || (lastRound?.blocks.length ?? 0) === 0);
      if (shouldApplyImmediately) {
        targetStore.updateLiveRounds(updater);
        artifacts.renderedCharacterCount = countLiveTranscriptCharacters(targetStore);
        return;
      }

      artifacts.pendingLRUpdates.push(updater);
      requestLiveFlush(artifacts, resolveStreamingRenderDelay(artifacts.renderedCharacterCount));
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const updateToolStatus = useCallback(
    (status: string | null, targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.setToolStatus(status);
        return;
      }

      // Last-wins: only the newest status of a frame reaches the store. A
      // pending flush (settle, abort snapshot) delivers it early.
      artifacts.pendingToolStatus = { value: status };
      requestLiveFlush(artifacts, 0);
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const updateRetryAttempts = useCallback(
    (
      retryAttempts: RetryAttemptRecord[],
      targetStore: LiveTranscriptStore = liveTranscriptStore,
    ) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.setRetryAttempts(retryAttempts);
        return;
      }

      // Last-wins: only the newest list of a frame reaches the store. A
      // pending flush (settle, abort snapshot) delivers it early.
      artifacts.pendingRetryAttempts = { value: retryAttempts };
      requestLiveFlush(artifacts, 0);
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  useEffect(
    () => () => {
      for (const artifacts of liveTranscriptArtifactsRef.current.values()) {
        cancelPendingLiveUpdates(artifacts);
      }
    },
    [cancelPendingLiveUpdates],
  );

  return {
    liveTranscriptStore,
    getConversationLiveTranscriptStore,
    getCompactionController,
    deleteConversationArtifacts,
    clearAbortSnapshot,
    captureAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    settleLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
  };
}
