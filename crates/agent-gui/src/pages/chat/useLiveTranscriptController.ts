import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { createCompactionThrottleState } from "../../lib/chat/compaction/contextCompaction";
import {
  cloneLiveRoundSnapshots,
  type LiveRoundSnapshot,
} from "../../lib/chat/conversation/chatAbort";
import {
  createLiveTranscriptStore,
  type LiveTranscriptStore,
} from "../../lib/chat/conversation/liveTranscriptStore";
import type { LiveRound } from "../../lib/chat/messages/uiMessages";
import { resolveScrollViewport } from "./chatScrollViewport";

const AUTO_SCROLL_LOCK_THRESHOLD_PX = 2;
const SCROLL_OVERFLOW_THRESHOLD_PX = 4;
const STREAM_AUTO_SCROLL_INTERVAL_MS = 80;
const STREAM_INPUT_BUSY_INTERVAL_MS = 160;
const USER_SCROLL_INTENT_WINDOW_MS = 500;
const BOTTOM_LOCK_DURATION_MS = 700;
const VIEWPORT_ATTACH_RETRY_MS = 80;
const VIEWPORT_ATTACH_MAX_ATTEMPTS = 75;

function getViewportBottomGap(viewport: HTMLDivElement) {
  return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
}

function isViewportAtLatest(viewport: HTMLDivElement) {
  return getViewportBottomGap(viewport) <= AUTO_SCROLL_LOCK_THRESHOLD_PX;
}

function hasViewportOverflow(viewport: HTMLDivElement) {
  return viewport.scrollHeight - viewport.clientHeight > SCROLL_OVERFLOW_THRESHOLD_PX;
}

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isHistoryScrollKey(event: KeyboardEvent) {
  if (isEditableEventTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}

type UseLiveTranscriptControllerParams = {
  currentConversationId: string;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  composerBusyRef: MutableRefObject<boolean>;
};

type AbortSnapshot = {
  draftAssistantText: string;
  liveRounds: LiveRoundSnapshot[];
};

type LiveTranscriptArtifacts = {
  store: LiveTranscriptStore;
  pendingDraftDelta: string;
  draftRafId: number | null;
  draftShouldAutoScroll: boolean;
  pendingLRUpdates: Array<(prev: LiveRound[]) => LiveRound[]>;
  lrRafId: number | null;
  lrShouldAutoScroll: boolean;
  abortSnapshot: AbortSnapshot | null;
};

function createLiveTranscriptArtifacts(): LiveTranscriptArtifacts {
  return {
    store: createLiveTranscriptStore(),
    pendingDraftDelta: "",
    draftRafId: null,
    draftShouldAutoScroll: false,
    pendingLRUpdates: [],
    lrRafId: null,
    lrShouldAutoScroll: false,
    abortSnapshot: null,
  };
}

export function useLiveTranscriptController(params: UseLiveTranscriptControllerParams) {
  const { currentConversationId, scrollAreaRef, composerBusyRef } = params;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const bottomLockUntilRef = useRef(0);
  const liveTranscriptArtifactsRef = useRef(new Map<string, LiveTranscriptArtifacts>());
  const liveTranscriptArtifactsByStoreRef = useRef(
    new WeakMap<LiveTranscriptStore, LiveTranscriptArtifacts>(),
  );
  const compactionThrottleByConversationRef = useRef(
    new Map<string, ReturnType<typeof createCompactionThrottleState>>(),
  );
  const autoScrollRafIdRef = useRef<number | null>(null);
  const lastAutoScrollTsRef = useRef(0);

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

  const getCompactionThrottleState = useCallback((conversationId: string) => {
    const key = conversationId.trim();
    const existing = compactionThrottleByConversationRef.current.get(key);
    if (existing) return existing;
    const created = createCompactionThrottleState();
    compactionThrottleByConversationRef.current.set(key, created);
    return created;
  }, []);

  const resetCompactionThrottleState = useCallback((conversationId: string) => {
    compactionThrottleByConversationRef.current.set(
      conversationId.trim(),
      createCompactionThrottleState(),
    );
  }, []);

  const liveTranscriptStore = useMemo(
    () => getConversationLiveTranscriptStore(currentConversationId),
    [currentConversationId, getConversationLiveTranscriptStore],
  );

  const resolveLiveTranscriptArtifacts = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore) =>
      liveTranscriptArtifactsByStoreRef.current.get(targetStore) ?? null,
    [liveTranscriptStore],
  );

  const getAdaptiveStreamInterval = useCallback(
    (baseIntervalMs: number) =>
      composerBusyRef.current
        ? Math.max(baseIntervalMs, STREAM_INPUT_BUSY_INTERVAL_MS)
        : baseIntervalMs,
    [composerBusyRef],
  );

  const clearAutoScroll = useCallback(() => {
    if (autoScrollRafIdRef.current !== null) {
      cancelAnimationFrame(autoScrollRafIdRef.current);
      autoScrollRafIdRef.current = null;
    }
  }, []);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const hasRecentUserScrollIntent = useCallback(
    () => Date.now() <= userScrollIntentUntilRef.current,
    [],
  );

  const hasActiveBottomLock = useCallback(() => Date.now() <= bottomLockUntilRef.current, []);

  const attachAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = true;
  }, []);

  const detachAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = false;
    bottomLockUntilRef.current = 0;
    clearAutoScroll();
  }, [clearAutoScroll]);

  const requestAutoScroll = useCallback(() => {
    if (!shouldAutoScrollRef.current && !hasActiveBottomLock()) return;
    if (autoScrollRafIdRef.current !== null) return;

    autoScrollRafIdRef.current = requestAnimationFrame(function tick(ts) {
      if (!shouldAutoScrollRef.current && !hasActiveBottomLock()) {
        autoScrollRafIdRef.current = null;
        return;
      }

      const elapsed = ts - lastAutoScrollTsRef.current;
      if (elapsed < getAdaptiveStreamInterval(STREAM_AUTO_SCROLL_INTERVAL_MS)) {
        autoScrollRafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      autoScrollRafIdRef.current = null;
      lastAutoScrollTsRef.current = ts;

      const viewport = viewportRef.current ?? resolveScrollViewport(scrollAreaRef.current);
      if (!viewport) {
        if (hasActiveBottomLock()) {
          autoScrollRafIdRef.current = requestAnimationFrame(tick);
        }
        return;
      }
      viewport.scrollTop = viewport.scrollHeight;
      attachAutoScroll();
      if (hasActiveBottomLock()) {
        autoScrollRafIdRef.current = requestAnimationFrame(tick);
      }
    });
  }, [attachAutoScroll, getAdaptiveStreamInterval, hasActiveBottomLock, scrollAreaRef]);

  const scrollToBottomNow = useCallback(() => {
    const viewport = viewportRef.current ?? resolveScrollViewport(scrollAreaRef.current);
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [scrollAreaRef]);

  const stickToBottom = useCallback(() => {
    bottomLockUntilRef.current = Date.now() + BOTTOM_LOCK_DURATION_MS;
    attachAutoScroll();
    scrollToBottomNow();
    requestAutoScroll();
  }, [attachAutoScroll, requestAutoScroll, scrollToBottomNow]);

  useLayoutEffect(() => {
    userScrollIntentUntilRef.current = 0;
    stickToBottom();
  }, [currentConversationId, stickToBottom]);

  const cancelPendingLiveUpdates = useCallback((artifacts: LiveTranscriptArtifacts | null) => {
    if (!artifacts) return;

    if (artifacts.draftRafId !== null) {
      cancelAnimationFrame(artifacts.draftRafId);
      artifacts.draftRafId = null;
    }
    artifacts.pendingDraftDelta = "";
    artifacts.draftShouldAutoScroll = false;

    if (artifacts.lrRafId !== null) {
      cancelAnimationFrame(artifacts.lrRafId);
      artifacts.lrRafId = null;
    }
    artifacts.pendingLRUpdates.length = 0;
    artifacts.lrShouldAutoScroll = false;
  }, []);

  const flushPendingLiveUpdates = useCallback(
    (targetStore: LiveTranscriptStore = liveTranscriptStore, shouldAutoScroll = false) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) return;

      let nextShouldAutoScroll = shouldAutoScroll;

      if (artifacts.draftRafId !== null) {
        cancelAnimationFrame(artifacts.draftRafId);
        artifacts.draftRafId = null;
      }
      if (artifacts.pendingDraftDelta) {
        const acc = artifacts.pendingDraftDelta;
        artifacts.pendingDraftDelta = "";
        nextShouldAutoScroll ||= artifacts.draftShouldAutoScroll;
        artifacts.draftShouldAutoScroll = false;
        targetStore.appendDraftAssistantText(acc);
      } else {
        artifacts.draftShouldAutoScroll = false;
      }

      if (artifacts.lrRafId !== null) {
        cancelAnimationFrame(artifacts.lrRafId);
        artifacts.lrRafId = null;
      }
      if (artifacts.pendingLRUpdates.length > 0) {
        const batch = artifacts.pendingLRUpdates.splice(0);
        nextShouldAutoScroll ||= artifacts.lrShouldAutoScroll;
        artifacts.lrShouldAutoScroll = false;
        targetStore.updateLiveRounds((prev) => {
          let nextRounds = prev;
          for (const update of batch) {
            nextRounds = update(nextRounds);
          }
          return nextRounds;
        });
      } else {
        artifacts.lrShouldAutoScroll = false;
      }

      if (nextShouldAutoScroll) {
        requestAutoScroll();
      }
    },
    [liveTranscriptStore, requestAutoScroll, resolveLiveTranscriptArtifacts],
  );

  const deleteConversationArtifacts = useCallback(
    (conversationId: string) => {
      const key = conversationId.trim();
      const artifacts = liveTranscriptArtifactsRef.current.get(key);
      cancelPendingLiveUpdates(artifacts ?? null);
      liveTranscriptArtifactsRef.current.delete(key);
      compactionThrottleByConversationRef.current.delete(key);
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

  const updateLiveRounds = useCallback(
    (
      updater: (prev: LiveRound[]) => LiveRound[],
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      targetStore.updateLiveRounds(updater);
      if (shouldAutoScroll) {
        requestAutoScroll();
      }
    },
    [liveTranscriptStore, requestAutoScroll],
  );

  const appendDraftAssistantText = useCallback(
    (
      delta: string,
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.appendDraftAssistantText(delta);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      const shouldApplyImmediately =
        artifacts.pendingDraftDelta.length === 0 &&
        artifacts.draftRafId === null &&
        targetStore.getSnapshot().draftAssistantText.length === 0;
      if (shouldApplyImmediately) {
        targetStore.appendDraftAssistantText(delta);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      artifacts.pendingDraftDelta += delta;
      artifacts.draftShouldAutoScroll ||= shouldAutoScroll;
      if (artifacts.draftRafId !== null) return;

      artifacts.draftRafId = requestAnimationFrame(() => {
        artifacts.draftRafId = null;

        const acc = artifacts.pendingDraftDelta;
        const shouldScroll = artifacts.draftShouldAutoScroll;
        artifacts.pendingDraftDelta = "";
        artifacts.draftShouldAutoScroll = false;
        if (!acc) return;
        targetStore.appendDraftAssistantText(acc);
        if (shouldScroll) {
          requestAutoScroll();
        }
      });
    },
    [liveTranscriptStore, requestAutoScroll, resolveLiveTranscriptArtifacts],
  );

  const batchLiveRoundsUpdate = useCallback(
    (
      updater: (prev: LiveRound[]) => LiveRound[],
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      const artifacts = resolveLiveTranscriptArtifacts(targetStore);
      if (!artifacts) {
        targetStore.updateLiveRounds(updater);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      const snapshot = targetStore.getSnapshot();
      const lastRound = snapshot.liveRounds[snapshot.liveRounds.length - 1];
      const shouldApplyImmediately =
        artifacts.pendingLRUpdates.length === 0 &&
        artifacts.lrRafId === null &&
        (snapshot.liveRounds.length === 0 || (lastRound?.blocks.length ?? 0) === 0);
      if (shouldApplyImmediately) {
        targetStore.updateLiveRounds(updater);
        if (shouldAutoScroll) {
          requestAutoScroll();
        }
        return;
      }

      artifacts.pendingLRUpdates.push(updater);
      artifacts.lrShouldAutoScroll ||= shouldAutoScroll;
      if (artifacts.lrRafId !== null) return;

      artifacts.lrRafId = requestAnimationFrame(() => {
        artifacts.lrRafId = null;

        const batch = artifacts.pendingLRUpdates.splice(0);
        const shouldScroll = artifacts.lrShouldAutoScroll;
        artifacts.lrShouldAutoScroll = false;
        if (!batch.length) return;
        targetStore.updateLiveRounds((prev) => {
          let nextRounds = prev;
          for (const update of batch) {
            nextRounds = update(nextRounds);
          }
          return nextRounds;
        });
        if (shouldScroll) {
          requestAutoScroll();
        }
      });
    },
    [liveTranscriptStore, requestAutoScroll, resolveLiveTranscriptArtifacts],
  );

  const updateToolStatus = useCallback(
    (
      status: string | null,
      targetStore: LiveTranscriptStore = liveTranscriptStore,
      shouldAutoScroll = true,
    ) => {
      targetStore.setToolStatus(status);
      if (shouldAutoScroll) {
        requestAutoScroll();
      }
    },
    [liveTranscriptStore, requestAutoScroll],
  );

  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;

    let attachTimeoutId: number | null = null;
    let attachAttempts = 0;
    let cleanup: (() => void) | null = null;
    let mutationObserver: MutationObserver | null = null;

    const clearAttachTimeout = () => {
      if (attachTimeoutId === null) return;
      window.clearTimeout(attachTimeoutId);
      attachTimeoutId = null;
    };

    const scheduleAttachRetry = () => {
      if (attachTimeoutId !== null || cleanup !== null) return;
      if (attachAttempts >= VIEWPORT_ATTACH_MAX_ATTEMPTS) return;
      attachAttempts += 1;
      attachTimeoutId = window.setTimeout(() => {
        attachTimeoutId = null;
        attachViewport();
      }, VIEWPORT_ATTACH_RETRY_MS);
    };

    const attachViewport = () => {
      if (cleanup !== null) return;
      const viewport = resolveScrollViewport(root);
      if (!viewport) {
        scheduleAttachRetry();
        return;
      }

      clearAttachTimeout();
      mutationObserver?.disconnect();
      mutationObserver = null;
      viewportRef.current = viewport;

      const syncAutoScrollState = () => {
        if (isViewportAtLatest(viewport)) {
          attachAutoScroll();
          return;
        }
        if (hasRecentUserScrollIntent()) {
          detachAutoScroll();
        }
      };

      const handleScroll = () => {
        syncAutoScrollState();
      };

      const handleWheel = (event: WheelEvent) => {
        markUserScrollIntent();
        if (event.deltaY < 0 && hasViewportOverflow(viewport)) {
          detachAutoScroll();
        }
      };

      const handleTouchStart = (event: TouchEvent) => {
        touchYRef.current = event.touches[0]?.clientY ?? null;
        markUserScrollIntent();
      };

      const handleTouchMove = (event: TouchEvent) => {
        const nextY = event.touches[0]?.clientY ?? null;
        const previousY = touchYRef.current;
        markUserScrollIntent();
        if (
          hasViewportOverflow(viewport) &&
          (previousY === null ||
            nextY === null ||
            nextY > previousY + 1 ||
            !isViewportAtLatest(viewport))
        ) {
          detachAutoScroll();
        }
        touchYRef.current = nextY;
      };

      const handlePointerDown = () => {
        markUserScrollIntent();
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (!isHistoryScrollKey(event)) {
          return;
        }
        if (!hasViewportOverflow(viewport)) {
          return;
        }
        markUserScrollIntent();
        detachAutoScroll();
      };

      const handleContentResize = () => {
        if (shouldAutoScrollRef.current) {
          if (!isViewportAtLatest(viewport) && hasRecentUserScrollIntent()) {
            detachAutoScroll();
            return;
          }
          requestAutoScroll();
          return;
        }
        syncAutoScrollState();
      };

      syncAutoScrollState();
      viewport.addEventListener("scroll", handleScroll, { passive: true });
      viewport.addEventListener("wheel", handleWheel, { passive: true });
      viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
      viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
      viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });
      window.addEventListener("keydown", handleKeyDown, { capture: true });

      const resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleContentResize);
      resizeObserver?.observe(viewport);
      const content = viewport.firstElementChild;
      if (content instanceof Element) {
        resizeObserver?.observe(content);
      }

      cleanup = () => {
        viewport.removeEventListener("scroll", handleScroll);
        viewport.removeEventListener("wheel", handleWheel);
        viewport.removeEventListener("touchstart", handleTouchStart);
        viewport.removeEventListener("touchmove", handleTouchMove);
        viewport.removeEventListener("pointerdown", handlePointerDown);
        window.removeEventListener("keydown", handleKeyDown, { capture: true });
        resizeObserver?.disconnect();
      };
    };

    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        if (cleanup === null) {
          attachViewport();
        }
      });
      mutationObserver.observe(root, { childList: true, subtree: true });
    }
    attachViewport();

    return () => {
      clearAttachTimeout();
      mutationObserver?.disconnect();
      cleanup?.();
      viewportRef.current = null;
    };
  }, [
    attachAutoScroll,
    detachAutoScroll,
    hasRecentUserScrollIntent,
    markUserScrollIntent,
    requestAutoScroll,
    scrollAreaRef,
  ]);

  useEffect(
    () => () => {
      clearAutoScroll();
      for (const artifacts of liveTranscriptArtifactsRef.current.values()) {
        cancelPendingLiveUpdates(artifacts);
      }
    },
    [cancelPendingLiveUpdates, clearAutoScroll],
  );

  return {
    shouldAutoScrollRef,
    liveTranscriptStore,
    getConversationLiveTranscriptStore,
    getCompactionThrottleState,
    resetCompactionThrottleState,
    deleteConversationArtifacts,
    requestAutoScroll,
    clearAbortSnapshot,
    captureAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    stickToBottom,
    updateLiveRounds,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
  };
}
