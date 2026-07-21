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

const LIVE_TRANSCRIPT_RAF_FALLBACK_MS = 96;
const LIVE_TRANSCRIPT_BACKGROUND_BATCH_MS = 160;

function shouldUseLiveTranscriptAnimationFrame() {
  return (
    typeof globalThis.requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible")
  );
}

export function scheduleLiveTranscriptFlush(callback: () => void) {
  let frameId: number | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
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
    callback();
  };

  const useFrame = shouldUseLiveTranscriptAnimationFrame();
  if (useFrame) {
    frameId = globalThis.requestAnimationFrame(run);
  }

  if (typeof globalThis.setTimeout === "function") {
    timeoutId = globalThis.setTimeout(
      run,
      useFrame ? LIVE_TRANSCRIPT_RAF_FALLBACK_MS : LIVE_TRANSCRIPT_BACKGROUND_BATCH_MS,
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
  draftFlushCancel: (() => void) | null;
  pendingLRUpdates: Array<(prev: LiveRound[]) => LiveRound[]>;
  lrFlushCancel: (() => void) | null;
  // Last-wins tool-status coalescing: a burst of status changes lands as one
  // store emit per frame.
  pendingToolStatus: { value: string | null } | null;
  toolStatusFlushCancel: (() => void) | null;
  pendingRetryAttempts: { value: RetryAttemptRecord[] } | null;
  retryAttemptsFlushCancel: (() => void) | null;
  abortSnapshot: AbortSnapshot | null;
};

function createLiveTranscriptArtifacts(): LiveTranscriptArtifacts {
  return {
    store: createLiveTranscriptStore(),
    pendingDraftDelta: "",
    draftFlushCancel: null,
    pendingLRUpdates: [],
    lrFlushCancel: null,
    pendingToolStatus: null,
    toolStatusFlushCancel: null,
    pendingRetryAttempts: null,
    retryAttemptsFlushCancel: null,
    abortSnapshot: null,
  };
}

// Pure live-transcript store management: per-conversation stores plus
// rAF-coalesced delta flushing. Scroll-follow lives entirely in
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

    artifacts.draftFlushCancel?.();
    artifacts.draftFlushCancel = null;
    artifacts.pendingDraftDelta = "";

    artifacts.lrFlushCancel?.();
    artifacts.lrFlushCancel = null;
    artifacts.pendingLRUpdates.length = 0;

    artifacts.toolStatusFlushCancel?.();
    artifacts.toolStatusFlushCancel = null;
    artifacts.pendingToolStatus = null;

    artifacts.retryAttemptsFlushCancel?.();
    artifacts.retryAttemptsFlushCancel = null;
    artifacts.pendingRetryAttempts = null;
  }, []);

  const flushPendingLiveUpdates = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;

      artifacts.draftFlushCancel?.();
      artifacts.draftFlushCancel = null;
      if (artifacts.pendingDraftDelta) {
        const acc = artifacts.pendingDraftDelta;
        artifacts.pendingDraftDelta = "";
        targetStore.appendDraftAssistantText(acc);
      }

      artifacts.lrFlushCancel?.();
      artifacts.lrFlushCancel = null;
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

      artifacts.toolStatusFlushCancel?.();
      artifacts.toolStatusFlushCancel = null;
      if (artifacts.pendingToolStatus) {
        const pending = artifacts.pendingToolStatus;
        artifacts.pendingToolStatus = null;
        targetStore.setToolStatus(pending.value);
      }

      artifacts.retryAttemptsFlushCancel?.();
      artifacts.retryAttemptsFlushCancel = null;
      if (artifacts.pendingRetryAttempts) {
        const pending = artifacts.pendingRetryAttempts;
        artifacts.pendingRetryAttempts = null;
        targetStore.setRetryAttempts(pending.value);
      }
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
    },
    [flushPendingLiveUpdates, liveTranscriptStore],
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
        artifacts.draftFlushCancel === null &&
        targetStore.getSnapshot().draftAssistantText.length === 0;
      if (shouldApplyImmediately) {
        targetStore.appendDraftAssistantText(delta);
        return;
      }

      artifacts.pendingDraftDelta += delta;
      if (artifacts.draftFlushCancel !== null) return;

      artifacts.draftFlushCancel = scheduleLiveTranscriptFlush(() => {
        artifacts.draftFlushCancel = null;

        const acc = artifacts.pendingDraftDelta;
        artifacts.pendingDraftDelta = "";
        if (!acc) return;
        targetStore.appendDraftAssistantText(acc);
      });
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
        artifacts.lrFlushCancel === null &&
        (snapshot.liveRounds.length === 0 || (lastRound?.blocks.length ?? 0) === 0);
      if (shouldApplyImmediately) {
        targetStore.updateLiveRounds(updater);
        return;
      }

      artifacts.pendingLRUpdates.push(updater);
      if (artifacts.lrFlushCancel !== null) return;

      artifacts.lrFlushCancel = scheduleLiveTranscriptFlush(() => {
        artifacts.lrFlushCancel = null;

        const batch = artifacts.pendingLRUpdates.splice(0);
        if (!batch.length) return;
        targetStore.updateLiveRounds((prev) => {
          let nextRounds = prev;
          for (const update of batch) {
            nextRounds = update(nextRounds);
          }
          return nextRounds;
        });
      });
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
      if (artifacts.toolStatusFlushCancel !== null) return;

      artifacts.toolStatusFlushCancel = scheduleLiveTranscriptFlush(() => {
        artifacts.toolStatusFlushCancel = null;
        const pending = artifacts.pendingToolStatus;
        artifacts.pendingToolStatus = null;
        if (pending) {
          targetStore.setToolStatus(pending.value);
        }
      });
    },
    [liveTranscriptStore, resolveLiveTranscriptArtifacts],
  );

  const updateRetryAttempts = useCallback(
    (retryAttempts: RetryAttemptRecord[], targetStore: LiveTranscriptStore = liveTranscriptStore) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.setRetryAttempts(retryAttempts);
        return;
      }

      // Last-wins: only the newest list of a frame reaches the store. A
      // pending flush (settle, abort snapshot) delivers it early.
      artifacts.pendingRetryAttempts = { value: retryAttempts };
      if (artifacts.retryAttemptsFlushCancel !== null) return;

      artifacts.retryAttemptsFlushCancel = scheduleLiveTranscriptFlush(() => {
        artifacts.retryAttemptsFlushCancel = null;
        const pending = artifacts.pendingRetryAttempts;
        artifacts.pendingRetryAttempts = null;
        if (pending) {
          targetStore.setRetryAttempts(pending.value);
        }
      });
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
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
  };
}
