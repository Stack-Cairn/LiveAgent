import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  type ConversationViewState,
  createConversationStateFromContext,
  normalizeConversationState,
} from "../../lib/chat/conversation/conversationState";
import {
  type ChatHistorySummary,
  deleteChatHistory,
  getChatHistory,
  getChatHistoryActiveSegment,
  persistConversationState,
  renameChatHistory,
  setChatHistoryPinned,
} from "../../lib/chat/history/chatHistory";
import {
  createConversationIdentity,
  mergeHistoryItem,
  normalizeConversationTitle,
  PENDING_CONVERSATION_TITLE,
  waitForTitleLookahead,
} from "../../lib/chat/page/chatPageHelpers";
import {
  type ConversationRuntimeEntry,
  createConversationRuntimeEntry,
  pruneIdleConversationRuntimeCaches,
  setConversationRuntimeCacheEntry,
} from "./chatPageRuntime";

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
  historyItemsRef: MutableRefObject<ChatHistorySummary[]>;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
  renamingId: string | null;
  renameDraft: string;
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
  setHistoryItems: Dispatch<SetStateAction<ChatHistorySummary[]>>;
  setHistoryError: Dispatch<SetStateAction<string | null>>;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
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

function scheduleIdleHydration(task: () => void) {
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
    historyItemsRef,
    titleJobRef,
    renamingId,
    renameDraft,
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
    setHistoryItems,
    setHistoryError,
    setRenamingId,
    setRenameDraft,
  } = params;

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

  async function loadConversationFromHistory(id: string) {
    const loadSequence = conversationLoadSequenceRef.current + 1;
    conversationLoadSequenceRef.current = loadSequence;
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
      const isPendingHistoryItem = historyItemsRef.current.some(
        (item) => item.id === id && item.isPending,
      );
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
        return;
      }
      conversationRuntimeCacheRef.current.delete(id);
    }

    const activateFullRecord = async () => {
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
    };

    try {
      const activeRecord = await getChatHistoryActiveSegment(id);
      if (conversationLoadSequenceRef.current !== loadSequence) {
        return;
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

      await new Promise<void>((resolve) => {
        scheduleIdleHydration(() => {
          if (conversationLoadSequenceRef.current !== loadSequence) {
            resolve();
            return;
          }
          void activateFullRecord()
            .catch((err) => {
              if (conversationLoadSequenceRef.current !== loadSequence) {
                return;
              }
              const msg = err instanceof Error ? err.message : String(err);
              setHydrationFailedConversationId(id);
              setErrorMessage(msg || "读取完整历史对话失败");
            })
            .finally(resolve);
        });
      });
    } catch (err) {
      try {
        await activateFullRecord();
        return;
      } catch {
        if (conversationLoadSequenceRef.current !== loadSequence) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setHydrationFailedConversationId(id);
        setErrorMessage(msg || "读取历史对话失败");
      }
    } finally {
      if (conversationLoadSequenceRef.current === loadSequence) {
        setHydratingConversationId((current) => (current === id ? null : current));
      }
    }
  }

  async function commitRename() {
    if (!renamingId) return;
    if (isConversationRunning(renamingId)) {
      setErrorMessage("后台任务仍在运行，暂时不能修改该对话标题。");
      setRenamingId(null);
      setRenameDraft("");
      return;
    }

    const title = normalizeConversationTitle(renameDraft);
    const currentItem = historyItemsRef.current.find((item) => item.id === renamingId);
    if (!title || !currentItem) {
      setRenamingId(null);
      setRenameDraft("");
      return;
    }

    if (title === currentItem.title) {
      setRenamingId(null);
      setRenameDraft("");
      return;
    }

    try {
      markLocalHistorySnapshotSynced(renamingId, Number.MAX_SAFE_INTEGER);
      const summary = await renameChatHistory(renamingId, title);
      markLocalHistorySnapshotSynced(summary.id, summary.updatedAt);
      setHistoryItems((prev) => mergeHistoryItem(prev, summary));
    } catch (err) {
      markLocalHistorySnapshotSynced(renamingId, -1);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg || "修改历史对话标题失败");
    } finally {
      setRenamingId(null);
      setRenameDraft("");
    }
  }

  async function requestDeleteConversation(id: string) {
    if (isConversationRunning(id)) {
      setErrorMessage("后台任务仍在运行，暂时不能删除该对话。");
      return;
    }

    try {
      await deleteChatHistory(id);
      setHistoryItems((prev) => prev.filter((item) => item.id !== id));
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg || "删除历史对话失败");
    }
  }

  async function setConversationPinned(id: string, isPinned: boolean) {
    try {
      const summary = await setChatHistoryPinned(id, isPinned);
      setHistoryItems((prev) => mergeHistoryItem(prev, summary));
      setHistoryError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setHistoryError(msg || "更新历史对话置顶状态失败");
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

    const currentItem = historyItemsRef.current.find((item) => item.id === conversationId);
    let titleToStore =
      currentItem && (!currentItem.isPending || currentItem.title !== PENDING_CONVERSATION_TITLE)
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
      setHistoryItems((prev) =>
        mergeHistoryItem(prev, {
          ...summary,
          isPending: false,
        }),
      );
      setHistoryError(null);
    } catch (err) {
      markLocalHistorySnapshotSynced(conversationId, -1);
      const msg = err instanceof Error ? err.message : String(err);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: `历史记录保存失败：${msg || "未知错误"}`,
      }));
      return false;
    }

    if (!titlePromise) return true;

    const initialStoredTitle = titleToStore;
    void titlePromise
      .then(async (resolvedTitle) => {
        if (!resolvedTitle || resolvedTitle === initialStoredTitle) return;

        const currentItem = historyItemsRef.current.find((item) => item.id === conversationId);
        if (!currentItem || currentItem.title !== initialStoredTitle) return;

        if (currentItem.isPending) {
          setHistoryItems((prev) =>
            mergeHistoryItem(prev, {
              ...currentItem,
              title: resolvedTitle,
              updatedAt: Date.now(),
            }),
          );
          return;
        }

        markLocalHistorySnapshotSynced(conversationId, Number.MAX_SAFE_INTEGER);
        const summary = await renameChatHistory(conversationId, resolvedTitle);
        markLocalHistorySnapshotSynced(summary.id, summary.updatedAt);
        setHistoryItems((prev) =>
          mergeHistoryItem(prev, {
            ...summary,
            isPending: false,
          }),
        );
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
    loadConversationFromHistory,
    commitRename,
    setConversationPinned,
    requestDeleteConversation,
    persistConversation,
  };
}
