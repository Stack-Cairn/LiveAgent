import { type Dispatch, type MutableRefObject, type SetStateAction, useRef } from "react";
import {
  type ConversationViewState,
  createConversationStateFromContext,
  normalizeConversationState,
} from "../../../lib/chat/conversation/conversationState";
import {
  getChatHistory,
  getChatHistoryActiveSegment,
  persistConversationState,
  renameChatHistory,
} from "../../../lib/chat/history/chatHistory";
import {
  createConversationIdentity,
  waitForTitleLookahead,
} from "../../../lib/chat/page/chatPageHelpers";
import type { SidebarStore } from "../../../lib/sidebar/store";
import {
  type ConversationRuntimeEntry,
  createConversationRuntimeEntry,
  pruneIdleConversationRuntimeCaches,
  setConversationRuntimeCacheEntry,
} from "../runtime/chatPageRuntime";

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type PersistConversationParams = {
  conversationId: string;
  sessionId: string;
  providerId: string;
  model: string;
  cwd?: string;
  state: ConversationViewState;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  titleLookahead?: boolean;
};

type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const FULL_HISTORY_HYDRATION_IDLE_TIMEOUT_MS = 1500;
const FULL_HISTORY_HYDRATION_FALLBACK_DELAY_MS = 250;

type UseConversationHistoryActionsParams = {
  conversationState: ConversationViewState;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  persistedConversationStateRef: MutableRefObject<Map<string, ConversationViewState>>;
  markLocalHistorySnapshotSynced: (conversationId: string, updatedAt: number) => void;
  isConversationRunning: (conversationId: string) => boolean;
  conversationLoadSequenceRef: MutableRefObject<number>;
  sidebarStore: SidebarStore;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
  t: (key: string) => string;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  syncVisibleConversationRuntime: (conversationId: string, entry: ConversationRuntimeEntry) => void;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
    fallback?: Partial<ConversationRuntimeEntry> &
      Pick<ConversationRuntimeEntry, "state" | "sessionId" | "createdAt">,
  ) => ConversationRuntimeEntry;
  cancelConversationHydration: () => void;
  resetVisibleTransientState: () => void;
  deleteConversationArtifacts: (conversationId: string) => void;
  disposeSubagentsForConversation?: (conversationId: string) => void;
  getDefaultNewConversationWorkdir?: () => string | undefined;
  setCurrentConversationId: Dispatch<SetStateAction<string>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setHydratingConversationId: Dispatch<SetStateAction<string | null>>;
  setHydrationFailedConversationId: Dispatch<SetStateAction<string | null>>;
};

function createBlankConversationEntry(params: {
  conversationState: ConversationViewState;
  sessionId: string;
  createdAt: number;
  workdir?: string;
}) {
  const { conversationState, sessionId, createdAt, workdir } = params;
  return createConversationRuntimeEntry({
    state: createConversationStateFromContext({
      tools: conversationState.meta.tools,
      messages: [],
    }),
    sessionId,
    createdAt,
    workdir,
  });
}

// Shared idle scheduler for phase-2 hydration: used by the conversation open
// controller (ChatPage) and available to any caller needing the same policy.
export function scheduleIdleHydration(task: () => void) {
  if (typeof window === "undefined") {
    const timeoutId = setTimeout(task, FULL_HISTORY_HYDRATION_FALLBACK_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }

  const schedulerWindow = window as IdleSchedulerWindow;
  if (schedulerWindow.requestIdleCallback && schedulerWindow.cancelIdleCallback) {
    const handle = schedulerWindow.requestIdleCallback(task, {
      timeout: FULL_HISTORY_HYDRATION_IDLE_TIMEOUT_MS,
    });
    return () => schedulerWindow.cancelIdleCallback?.(handle);
  }

  const timeoutId = window.setTimeout(task, FULL_HISTORY_HYDRATION_FALLBACK_DELAY_MS);
  return () => window.clearTimeout(timeoutId);
}

export function useConversationHistoryActions(params: UseConversationHistoryActionsParams) {
  const {
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    markLocalHistorySnapshotSynced,
    isConversationRunning,
    conversationLoadSequenceRef,
    sidebarStore,
    titleJobRef,
    t,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    cancelConversationHydration,
    resetVisibleTransientState,
    deleteConversationArtifacts,
    disposeSubagentsForConversation,
    getDefaultNewConversationWorkdir,
    setCurrentConversationId,
    setErrorMessage,
    setHydratingConversationId,
    setHydrationFailedConversationId,
  } = params;

  // The sequence claimed by the latest openInitial. hydrateFull validates
  // against this (not the live counter) so any bump in between — a new
  // conversation, another open — turns the idle hydration into a no-op.
  const openLoadSequenceRef = useRef(0);

  function pruneIdleConversationCaches(extraKeepIds: Iterable<string> = []) {
    pruneIdleConversationRuntimeCaches({
      runtimeCache: conversationRuntimeCacheRef.current,
      persistedStateCache: persistedConversationStateRef.current,
      keepConversationIds: [currentConversationIdRef.current, ...extraKeepIds],
      isConversationRunning,
      onPruneConversation: (conversationId) => {
        deleteConversationArtifacts(conversationId);
        disposeSubagentsForConversation?.(conversationId);
      },
    });
  }

  function activateConversation(params: {
    conversationId: string;
    entry: ConversationRuntimeEntry;
    persistedState?: ConversationViewState;
    clearError?: boolean;
  }) {
    const { conversationId, entry, persistedState, clearError = false } = params;
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, conversationId, entry);
    if (persistedState) {
      persistedConversationStateRef.current.set(conversationId, persistedState);
    }
    if (clearError) {
      setErrorMessage(null);
    }
    setCurrentConversationId(conversationId);
    syncVisibleConversationRuntime(conversationId, entry);
    pruneIdleConversationCaches([conversationId]);
  }

  function startNewConversation(options?: { workdir?: string }) {
    cancelConversationHydration();
    const visibleConversationId = currentConversationIdRef.current;
    setConversationRuntimeCacheEntry(
      conversationRuntimeCacheRef.current,
      visibleConversationId,
      buildRuntimeEntryFromVisibleState(),
    );
    resetVisibleTransientState();

    const nextIdentity = createConversationIdentity();
    const nextEntry = createBlankConversationEntry({
      conversationState,
      sessionId: nextIdentity.sessionId,
      createdAt: nextIdentity.createdAt,
      workdir: options?.workdir ?? getDefaultNewConversationWorkdir?.(),
    });
    activateConversation({
      conversationId: nextIdentity.conversationId,
      entry: nextEntry,
    });
  }

  async function activateFullRecord(id: string, loadSequence: number) {
    const record = await getChatHistory(id);
    if (conversationLoadSequenceRef.current !== loadSequence) {
      return;
    }
    const nextEntry = createConversationRuntimeEntry({
      state: record.state,
      sessionId: record.sessionId ?? record.id,
      createdAt: record.createdAt,
      workdir: record.cwd,
    });
    activateConversation({
      conversationId: record.id,
      entry: nextEntry,
      persistedState: record.state,
      clearError: true,
    });
  }

  // Phase 1 of the two-phase open: activate from the runtime cache
  // synchronously ("cache-hit", already complete) or fetch and paint the
  // active segment ("painted", phase 2 pending). Throws on failure after the
  // one-shot full-record fallback also fails.
  async function openInitial(id: string): Promise<"cache-hit" | "painted"> {
    const loadSequence = conversationLoadSequenceRef.current + 1;
    conversationLoadSequenceRef.current = loadSequence;
    openLoadSequenceRef.current = loadSequence;
    setHydratingConversationId(id);
    setHydrationFailedConversationId((prev) => (prev === id ? null : prev));
    setErrorMessage(null);

    const visibleConversationId = currentConversationIdRef.current;
    setConversationRuntimeCacheEntry(
      conversationRuntimeCacheRef.current,
      visibleConversationId,
      buildRuntimeEntryFromVisibleState(),
    );
    resetVisibleTransientState();

    const cached = conversationRuntimeCacheRef.current.get(id);
    if (cached) {
      const isPendingHistoryItem = sidebarStore.peek(id)?.isPending === true;
      if (
        persistedConversationStateRef.current.has(id) ||
        cached.isSending ||
        isPendingHistoryItem
      ) {
        setHydratingConversationId(null);
        activateConversation({
          conversationId: id,
          entry: cached,
          clearError: true,
        });
        return "cache-hit";
      }
      conversationRuntimeCacheRef.current.delete(id);
    }

    try {
      const activeRecord = await getChatHistoryActiveSegment(id);
      if (conversationLoadSequenceRef.current !== loadSequence) {
        return "painted";
      }

      const warmState = normalizeConversationState({
        meta: {
          systemPrompt: activeRecord.meta.systemPrompt,
          tools: activeRecord.meta.tools,
        },
        segments: [activeRecord.activeSegment],
      });
      const warmEntry = createConversationRuntimeEntry({
        state: warmState,
        sessionId: activeRecord.sessionId ?? activeRecord.id,
        createdAt: activeRecord.createdAt,
        workdir: activeRecord.cwd,
      });
      activateConversation({
        conversationId: activeRecord.id,
        entry: warmEntry,
        clearError: true,
      });
      return "painted";
    } catch (err) {
      // Keep the old fallback semantics: when the active-segment fetch fails,
      // try the full record once before surfacing the failure.
      try {
        await activateFullRecord(id, loadSequence);
        if (conversationLoadSequenceRef.current === loadSequence) {
          setHydratingConversationId((current) => (current === id ? null : current));
        }
        // Fully hydrated already — the controller skips phase 2.
        return "cache-hit";
      } catch {
        if (conversationLoadSequenceRef.current === loadSequence) {
          const msg = err instanceof Error ? err.message : String(err);
          setHydrationFailedConversationId(id);
          setErrorMessage(msg || t("chat.history.openFailed"));
          setHydratingConversationId((current) => (current === id ? null : current));
        }
        throw err;
      }
    }
  }

  // Phase 2: quiet full hydration. Valid only for the sequence opened by the
  // preceding openInitial — any other bump (new conversation, another open)
  // turns this into a no-op.
  async function hydrateFull(id: string): Promise<void> {
    const loadSequence = openLoadSequenceRef.current;
    if (conversationLoadSequenceRef.current !== loadSequence) {
      return;
    }
    try {
      await activateFullRecord(id, loadSequence);
    } catch (err) {
      if (conversationLoadSequenceRef.current !== loadSequence) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setHydrationFailedConversationId(id);
      setErrorMessage(msg || t("chat.history.openFullFailed"));
      throw err;
    } finally {
      if (conversationLoadSequenceRef.current === loadSequence) {
        setHydratingConversationId((current) => (current === id ? null : current));
      }
    }
  }

  // Post-deletion cleanup: the store already removed the row (and ran the
  // IPC delete); this evicts local caches and replaces the visible
  // conversation with a blank one when the deleted one was open.
  function cleanupDeletedConversation(id: string) {
    persistedConversationStateRef.current.delete(id);
    conversationRuntimeCacheRef.current.delete(id);
    deleteConversationArtifacts(id);
    disposeSubagentsForConversation?.(id);

    if (currentConversationIdRef.current === id) {
      cancelConversationHydration();
      resetVisibleTransientState();
      const nextIdentity = createConversationIdentity();
      const nextEntry = createBlankConversationEntry({
        conversationState,
        sessionId: nextIdentity.sessionId,
        createdAt: nextIdentity.createdAt,
        workdir: getDefaultNewConversationWorkdir?.(),
      });
      activateConversation({
        conversationId: nextIdentity.conversationId,
        entry: nextEntry,
      });
    }
  }

  async function persistConversation(params: PersistConversationParams): Promise<boolean> {
    const {
      conversationId,
      sessionId,
      providerId,
      model,
      cwd,
      state,
      fallbackTitle,
      createdAt,
      titlePromise,
      titleLookahead = true,
    } = params;

    const pendingConversationTitle = t("chat.pendingTitle");
    const currentItem = sidebarStore.peek(conversationId);
    let titleToStore =
      currentItem && (!currentItem.isPending || currentItem.title !== pendingConversationTitle)
        ? currentItem.title
        : fallbackTitle;
    if (titlePromise && titleLookahead) {
      const quickTitle = await waitForTitleLookahead(titlePromise).catch(() => null);
      if (typeof quickTitle === "string" && quickTitle.trim()) {
        titleToStore = quickTitle;
      }
    }

    const updatedAt = Date.now();
    markLocalHistorySnapshotSynced(conversationId, updatedAt);

    try {
      const summary = await persistConversationState({
        conversationId,
        providerId,
        model,
        sessionId,
        cwd,
        title: titleToStore,
        createdAt,
        updatedAt,
        state,
        previousState: persistedConversationStateRef.current.get(conversationId) ?? null,
      });
      markLocalHistorySnapshotSynced(conversationId, summary.updatedAt);
      persistedConversationStateRef.current.set(conversationId, state);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: null,
      }));
      sidebarStore.upsertLocal({ ...summary, isPending: undefined });
    } catch (err) {
      markLocalHistorySnapshotSynced(conversationId, -1);
      const msg = err instanceof Error ? err.message : String(err);
      const persistFailedMessage = t("chat.history.persistFailed").replace(
        "{message}",
        msg || String(err),
      );
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: persistFailedMessage,
      }));
      return false;
    }

    if (!titlePromise) return true;

    const initialStoredTitle = titleToStore;
    void titlePromise
      .then(async (resolvedTitle) => {
        if (!resolvedTitle || resolvedTitle === initialStoredTitle) return;

        const currentItem = sidebarStore.peek(conversationId);
        if (!currentItem || currentItem.title !== initialStoredTitle) return;

        if (currentItem.isPending) {
          sidebarStore.upsertLocal({
            ...currentItem,
            title: resolvedTitle,
            updatedAt: Date.now(),
          });
          return;
        }

        markLocalHistorySnapshotSynced(conversationId, Number.MAX_SAFE_INTEGER);
        const summary = await renameChatHistory(conversationId, resolvedTitle);
        markLocalHistorySnapshotSynced(summary.id, summary.updatedAt);
        sidebarStore.upsertLocal({ ...summary, isPending: undefined });
      })
      .catch(() => {
        markLocalHistorySnapshotSynced(conversationId, -1);
        // ignore late title failures; fallback title is already stored
      })
      .finally(() => {
        if (titleJobRef.current?.conversationId === conversationId) {
          titleJobRef.current = null;
        }
      });

    return true;
  }

  return {
    startNewConversation,
    openInitial,
    hydrateFull,
    cleanupDeletedConversation,
    persistConversation,
  };
}
