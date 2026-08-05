import type { Message } from "@earendil-works/pi-ai";
import { type Dispatch, type MutableRefObject, type SetStateAction, useRef } from "react";
import {
  type ConversationViewState,
  createConversationStateFromContext,
  createTranscriptProjection,
  getActiveSegment,
  type HistoryMessageRef,
  prependTranscriptProjection,
} from "../../../lib/chat/conversation/conversationState";
import {
  buildChatHistoryRevision,
  buildConversationStateFromWindow,
  CHAT_HISTORY_WINDOW_MESSAGES,
  type ConversationPersistenceCursor,
  getChatHistoryWindow,
  persistConversationRuntime,
  renameChatHistory,
  replaceChatHistoryFromMessage,
} from "../../../lib/chat/history/chatHistory";
import {
  createConversationIdentity,
  waitForTitleLookahead,
} from "../../../lib/chat/page/chatPageHelpers";
import { type SelectedModel, serializeSelectedModelJson } from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import { disposeTodoToolState } from "../../../lib/tools/todoTools";
import {
  type ConversationRuntimeEntry,
  createConversationRuntimeEntry,
  pruneIdleConversationRuntimeCaches,
  setConversationRuntimeCacheEntry,
} from "../runtime/chatPageRuntime";
import { resolvePersistedConversationModelSelection } from "../runtime/modelSelection";

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

export type PersistConversationParams = {
  conversationId: string;
  sessionId: string;
  providerId: string;
  model: string;
  cwd?: string;
  selectedModel?: SelectedModel;
  state: ConversationViewState;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  titleLookahead?: boolean;
};

type UseConversationHistoryActionsParams = {
  conversationState: ConversationViewState;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  conversationPersistenceCursorRef: MutableRefObject<Map<string, ConversationPersistenceCursor>>;
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
  cancelConversationLoad: () => void;
  resetVisibleTransientState: () => void;
  deleteConversationArtifacts: (conversationId: string) => void;
  disposeSubagentsForConversation?: (conversationId: string) => void;
  getDefaultNewConversationWorkdir?: () => string | undefined;
  resolveConversationSelectedModel: (json: string | null | undefined) => SelectedModel | undefined;
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

export function useConversationHistoryActions(params: UseConversationHistoryActionsParams) {
  const {
    conversationState,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    markLocalHistorySnapshotSynced,
    isConversationRunning,
    conversationLoadSequenceRef,
    sidebarStore,
    titleJobRef,
    t,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    updateConversationRuntimeEntry,
    cancelConversationLoad,
    resetVisibleTransientState,
    deleteConversationArtifacts,
    disposeSubagentsForConversation,
    getDefaultNewConversationWorkdir,
    resolveConversationSelectedModel,
    setCurrentConversationId,
    setErrorMessage,
    setHydratingConversationId,
    setHydrationFailedConversationId,
  } = params;

  const earlierPageLoadsRef = useRef(new Map<string, Promise<void>>());

  function pruneIdleConversationCaches(extraKeepIds: Iterable<string> = []) {
    pruneIdleConversationRuntimeCaches({
      runtimeCache: conversationRuntimeCacheRef.current,
      persistenceCursors: conversationPersistenceCursorRef.current,
      keepConversationIds: [currentConversationIdRef.current, ...extraKeepIds],
      isConversationRunning,
      onPruneConversation: (conversationId) => {
        deleteConversationArtifacts(conversationId);
        disposeSubagentsForConversation?.(conversationId);
        disposeTodoToolState(conversationId);
      },
    });
  }

  function activateConversation(params: {
    conversationId: string;
    entry: ConversationRuntimeEntry;
    persistenceCursor?: ConversationPersistenceCursor;
    clearError?: boolean;
  }) {
    const { conversationId, entry, persistenceCursor, clearError = false } = params;
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, conversationId, entry);
    if (persistenceCursor) {
      conversationPersistenceCursorRef.current.set(conversationId, persistenceCursor);
    }
    if (clearError) {
      setErrorMessage(null);
    }
    setCurrentConversationId(conversationId);
    syncVisibleConversationRuntime(conversationId, entry);
    pruneIdleConversationCaches([conversationId]);
  }

  function startNewConversation(options?: { workdir?: string }) {
    cancelConversationLoad();
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

  async function openInitial(id: string): Promise<"cache-hit" | "painted"> {
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
      const isPendingHistoryItem = sidebarStore.peek(id)?.isPending === true;
      if (
        conversationPersistenceCursorRef.current.has(id) ||
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
      const record = await getChatHistoryWindow({
        id,
        maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
        includeActiveSegment: true,
      });
      if (conversationLoadSequenceRef.current !== loadSequence) {
        return "painted";
      }

      if (!record.activeSegment) throw new Error("历史窗口缺少活跃分段");
      const state = buildConversationStateFromWindow(record);
      const entry = createConversationRuntimeEntry({
        state,
        sessionId: record.conversation.sessionId ?? record.conversation.id,
        createdAt: record.conversation.createdAt,
        workdir: record.conversation.cwd,
        selectedModel: resolveConversationSelectedModel(record.conversation.selectedModelJson),
      });
      activateConversation({
        conversationId: record.conversation.id,
        entry,
        persistenceCursor: {
          activeSegmentIndex: record.activeSegment.segmentIndex,
          activeSegmentId: record.activeSegment.segmentId,
        },
        clearError: true,
      });
      setHydratingConversationId((current) => (current === id ? null : current));
      return "painted";
    } catch (err) {
      if (conversationLoadSequenceRef.current === loadSequence) {
        const msg = err instanceof Error ? err.message : String(err);
        setHydrationFailedConversationId(id);
        setErrorMessage(msg || t("chat.history.openFailed"));
        setHydratingConversationId((current) => (current === id ? null : current));
      }
      throw err;
    }
  }

  function loadEarlier(conversationId: string) {
    const id = conversationId.trim();
    if (!id) return Promise.resolve();
    const existing = earlierPageLoadsRef.current.get(id);
    if (existing) return existing;

    const task = (async () => {
      const entry = conversationRuntimeCacheRef.current.get(id);
      const transcript = entry?.state.transcript;
      if (!entry || !transcript?.hasMoreBefore || !transcript.revision) return;
      const page = await getChatHistoryWindow({
        id,
        maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
        beforeOffset: transcript.oldestMessageOffset,
        expectedRevision: transcript.revision,
        includeActiveSegment: false,
      });
      if (page.oldestOffset >= transcript.oldestMessageOffset) {
        throw new Error("历史分页游标未向前推进");
      }
      const projection = createTranscriptProjection({
        segments: page.segments,
        activeSegmentIndex: page.meta.activeSegmentIndex,
        oldestMessageOffset: page.oldestOffset,
        hasMoreBefore: page.hasMoreBefore,
        revision: page.revision,
      });
      updateConversationRuntimeEntry(id, (current) => {
        if (
          current.state.transcript.oldestMessageOffset !== transcript.oldestMessageOffset ||
          current.state.transcript.revision !== transcript.revision
        ) {
          return current;
        }
        return {
          ...current,
          state: prependTranscriptProjection(current.state, projection),
        };
      });
    })().finally(() => {
      earlierPageLoadsRef.current.delete(id);
    });
    earlierPageLoadsRef.current.set(id, task);
    return task;
  }

  async function replaceConversationAtMessage(
    conversationId: string,
    messageRef: HistoryMessageRef,
    replacementMessage: Message,
  ) {
    const id = conversationId.trim();
    const current = conversationRuntimeCacheRef.current.get(id);
    if (!id || !current) {
      throw new Error("无法替换未加载的历史会话");
    }
    const expectedRevision = current.state.transcript.revision;
    if (!expectedRevision) {
      throw new Error("历史会话缺少 revision，无法安全替换消息");
    }

    const replaced = await replaceChatHistoryFromMessage({
      id,
      baseMessageRef: messageRef,
      replacementMessage,
      maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
      expectedRevision,
    });
    if (!replaced.activeSegment) throw new Error("历史替换结果缺少活跃分段");
    const state = buildConversationStateFromWindow(replaced);
    const entry = {
      ...current,
      state,
      errorMessage: null,
    };
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, id, entry);
    conversationPersistenceCursorRef.current.set(id, {
      activeSegmentIndex: replaced.activeSegment.segmentIndex,
      activeSegmentId: replaced.activeSegment.segmentId,
    });
    if (currentConversationIdRef.current === id) {
      setErrorMessage(null);
      syncVisibleConversationRuntime(id, entry);
    }
    pruneIdleConversationCaches([id]);
    markLocalHistorySnapshotSynced(id, replaced.updatedAt);
    sidebarStore.upsertLocal({ ...replaced.conversation, isPending: undefined });
    return state;
  }

  // Post-deletion cleanup: the store already removed the row (and ran the
  // IPC delete); this evicts local caches and replaces the visible
  // conversation with a blank one when the deleted one was open.
  function cleanupDeletedConversation(id: string) {
    conversationPersistenceCursorRef.current.delete(id);
    conversationRuntimeCacheRef.current.delete(id);
    deleteConversationArtifacts(id);
    disposeSubagentsForConversation?.(id);

    if (currentConversationIdRef.current === id) {
      cancelConversationLoad();
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
      selectedModel,
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
    const selectedModelToPersist = resolvePersistedConversationModelSelection({
      runtimeSelectedModel: conversationRuntimeCacheRef.current.get(conversationId)?.selectedModel,
      turnSelectedModel: selectedModel,
    });

    try {
      const summary = await persistConversationRuntime({
        conversationId,
        providerId,
        model,
        sessionId,
        cwd,
        selectedModelJson: serializeSelectedModelJson(selectedModelToPersist),
        title: titleToStore,
        createdAt,
        updatedAt,
        state,
        getPersistenceCursor: () =>
          conversationPersistenceCursorRef.current.get(conversationId) ?? null,
        commitPersistenceCursor: (cursor) =>
          conversationPersistenceCursorRef.current.set(conversationId, cursor),
      });
      markLocalHistorySnapshotSynced(conversationId, summary.updatedAt);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state:
          getActiveSegment(prev.state) === getActiveSegment(state) &&
          prev.state.meta.activeSegmentIndex === state.meta.activeSegmentIndex &&
          prev.state.meta.totalSegmentCount === state.meta.totalSegmentCount &&
          prev.state.meta.totalMessageCount === state.meta.totalMessageCount
            ? {
                ...prev.state,
                transcript: {
                  ...prev.state.transcript,
                  revision: buildChatHistoryRevision({
                    conversationId,
                    updatedAt: summary.updatedAt,
                    activeSegmentIndex: state.meta.activeSegmentIndex,
                    totalSegmentCount: state.meta.totalSegmentCount,
                    totalMessageCount: state.meta.totalMessageCount,
                  }),
                },
              }
            : prev.state,
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
    loadEarlier,
    replaceConversationAtMessage,
    cleanupDeletedConversation,
    persistConversation,
  };
}
