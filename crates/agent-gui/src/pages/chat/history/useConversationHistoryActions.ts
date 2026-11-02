import type { Message } from "@liveagent/app/lib/agentTypes";
import type { ConversationOpenRequest } from "@liveagent/ui/lib/sidebar/openController";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
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
  branchChatHistory,
  buildChatHistoryRevision,
  buildConversationStateFromWindow,
  CHAT_HISTORY_WINDOW_MESSAGES,
  type ChatHistoryWindowRecord,
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
import { getProviderRuntimeBackend } from "../../../lib/providers/runtime/providerRuntimeConfig";
import { type SelectedModel, serializeSelectedModelJson } from "../../../lib/settings";
import type { ConversationHydrationStore } from "../conversations/conversationHydrationStore";
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

// 成功返回盖好 revision 的持久化状态（revision 是 replace/分页的 CAS 令牌，
// 只能在写库成功后由 summary.updatedAt 重建），失败返回 null。调用方若要把
// 本次持久化的状态落进运行时缓存（压缩收尾即是），必须落这份带章状态——
// checkpoint 状态出自 appendMessagesToConversation，revision 恒为 null，照原
// 样 apply 会把缓存里的 revision 永久清空，后续 edit-resend 直接失败。
export type PersistConversationAction = (
  params: PersistConversationParams,
) => Promise<ConversationViewState | null>;

// The K-brain backend answers a stale CAS token with 409 "history revision
// conflict" and the client adds its own local-guard text. Both mean the same
// thing: the projection we hold is behind the backend, so re-request it.
export function isKBrainRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /revision conflict/i.test(error.message);
}

// After a reload the caller only knows the original message id, so resolve the
// current ref (offset + content hash) for the same message in the fresh window.
export function findReloadedMessageRef(
  state: ConversationViewState,
  messageRef: HistoryMessageRef,
): HistoryMessageRef | undefined {
  return state.transcript.items
    .flatMap((item) => (item.kind === "user" && item.messageRef ? [item.messageRef] : []))
    .find((ref) => ref.messageId === messageRef.messageId);
}

export async function branchConversationWithReload(
  conversationId: string,
  messageRef: HistoryMessageRef,
  reload: (
    conversationId: string,
  ) => Promise<{ state: ConversationViewState; revision: string } | null>,
) {
  try {
    return await branchChatHistory(conversationId, messageRef);
  } catch (error) {
    if (!isKBrainRevisionConflict(error)) throw error;
    const refreshed = await reload(conversationId);
    const freshRef = refreshed && findReloadedMessageRef(refreshed.state, messageRef);
    if (!freshRef || freshRef.contentHash !== messageRef.contentHash) {
      throw new Error("历史消息已发生变化，请重新选择要重试或分支的消息");
    }
    return branchChatHistory(conversationId, freshRef);
  }
}

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
  /** 空闲运行时缓存被逐出时的瞬态交互清理(挂起提问/工具审批/MCP 激活集)。
   * 与 ChatPage 自己的 prune 路径共用同一实现,两条路径的生命周期裁决必须一致。
   * 刻意不含计划审批——待决计划跨 run 存活,仅会话删除时清(见下)。 */
  cancelConversationTransientInteractions?: (conversationId: string) => void;
  /** 会话真正删除时的计划审批清理(含批准落定态)。 */
  cancelPlanDecisionsForConversation?: (conversationId: string) => void;
  getDefaultNewConversationWorkdir?: () => string | undefined;
  resolveConversationSelectedModel: (json: string | null | undefined) => SelectedModel | undefined;
  setCurrentConversationId: Dispatch<SetStateAction<string>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  /** Per-conversation hydration lifecycle buckets (replaces the page slots). */
  hydration: ConversationHydrationStore;
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
    cancelConversationTransientInteractions,
    cancelPlanDecisionsForConversation,
    getDefaultNewConversationWorkdir,
    resolveConversationSelectedModel,
    setCurrentConversationId,
    setErrorMessage,
    hydration,
  } = params;

  const earlierPageLoadsRef = useRef(new Map<string, Promise<void>>());
  const backgroundHydrationRef = useRef(new Map<string, Promise<void>>());

  function pruneIdleConversationCaches(extraKeepIds: Iterable<string> = []) {
    pruneIdleConversationRuntimeCaches({
      runtimeCache: conversationRuntimeCacheRef.current,
      persistenceCursors: conversationPersistenceCursorRef.current,
      keepConversationIds: [currentConversationIdRef.current, ...extraKeepIds],
      isConversationRunning,
      onPruneConversation: (conversationId) => {
        deleteConversationArtifacts(conversationId);
        disposeSubagentsForConversation?.(conversationId);
        cancelConversationTransientInteractions?.(conversationId);
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
    return nextIdentity.conversationId;
  }

  async function openInitial(
    id: string,
    request?: ConversationOpenRequest,
  ): Promise<"cache-hit" | "painted"> {
    const fromSearch = request?.source === "search";
    const loadSequence = conversationLoadSequenceRef.current + 1;
    conversationLoadSequenceRef.current = loadSequence;
    const isStale = () =>
      conversationLoadSequenceRef.current !== loadSequence || request?.isCurrent() === false;
    // Bucketed per conversation: hydrating replaces this id's stale fail mark
    // and never touches another conversation's phase.
    hydration.markHydrating(id);
    setErrorMessage(null);

    const backgroundHydration = backgroundHydrationRef.current.get(id);
    if (backgroundHydration) {
      try {
        await backgroundHydration;
      } catch {
        hydration.markHydrating(id);
      }
      if (isStale()) {
        return "painted";
      }
    }

    const visibleConversationId = currentConversationIdRef.current;
    setConversationRuntimeCacheEntry(
      conversationRuntimeCacheRef.current,
      visibleConversationId,
      buildRuntimeEntryFromVisibleState(),
    );
    if (!fromSearch) resetVisibleTransientState();

    const prefetched = backgroundHydrationRef.current.get(id);
    if (prefetched) {
      try {
        await prefetched;
      } catch {
        hydration.markHydrating(id);
      }
      if (isStale()) {
        hydration.clearHydrating(id);
        return "painted";
      }
    }

    const cached = conversationRuntimeCacheRef.current.get(id);
    if (cached && !fromSearch) {
      const historyItem = sidebarStore.peek(id);
      const isPendingHistoryItem = historyItem?.isPending === true;
      // A conversation the sidebar store has never seen is an unpersisted
      // draft (e.g. the workbench refocusing a draft pane): nothing exists on
      // disk, so the cache entry is authoritative — loading would only fail.
      const isUnpersistedDraft = historyItem === undefined;
      if (
        conversationPersistenceCursorRef.current.has(id) ||
        cached.isSending ||
        isPendingHistoryItem ||
        isUnpersistedDraft
      ) {
        hydration.clearHydrating(id);
        activateConversation({
          conversationId: id,
          entry: cached,
          clearError: true,
        });
        // Cache-hit is a real commit: afterCommit must fire here too, or
        // callers that defer work to the commit point (e.g. workspace
        // activation for #787) silently skip on the warm path.
        request?.afterCommit?.();
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
      if (isStale()) {
        hydration.clearHydrating(id);
        return "painted";
      }

      if (!record.activeSegment) throw new Error("历史窗口缺少活跃分段");
      const state = buildConversationStateFromWindow(record);
      const selectedModel = resolveConversationSelectedModel(record.conversation.selectedModelJson);
      // Runtime may have advanced while metadata was loading (including streaming turns).
      const latestCached = fromSearch ? conversationRuntimeCacheRef.current.get(id) : undefined;
      const reuseCached =
        latestCached &&
        (latestCached.isSending || conversationPersistenceCursorRef.current.has(id));
      const entry = reuseCached
        ? { ...latestCached, workdir: record.conversation.cwd }
        : createConversationRuntimeEntry({
            state,
            sessionId: record.conversation.sessionId ?? record.conversation.id,
            createdAt: record.conversation.createdAt,
            workdir: record.conversation.cwd,
            selectedModel,
          });
      if (fromSearch) {
        request?.beforeCommit?.(record.conversation);
        resetVisibleTransientState();
      }
      activateConversation({
        conversationId: record.conversation.id,
        entry,
        persistenceCursor: reuseCached
          ? conversationPersistenceCursorRef.current.get(id)
          : {
              activeSegmentIndex: record.activeSegment.segmentIndex,
              activeSegmentId: record.activeSegment.segmentId,
            },
        clearError: true,
      });
      hydration.clearHydrating(id);
      request?.afterCommit?.();
      return "painted";
    } catch (err) {
      if (!isStale()) {
        const msg = err instanceof Error ? err.message : String(err);
        // Failure is scoped to this conversation: another pane's concurrent
        // success or failure cannot clear or overwrite it.
        hydration.markFailed(id);
        setErrorMessage(msg || t("chat.history.openFailed"));
      }
      throw err;
    }
  }

  function hydrateInBackground(conversationId: string): Promise<void> {
    const id = conversationId.trim();
    if (!id) return Promise.resolve();

    const existing = backgroundHydrationRef.current.get(id);
    if (existing) return existing;

    const cached = conversationRuntimeCacheRef.current.get(id);
    const historyItem = sidebarStore.peek(id);
    if (
      cached &&
      (conversationPersistenceCursorRef.current.has(id) ||
        cached.isSending ||
        historyItem?.isPending === true ||
        historyItem === undefined)
    ) {
      hydration.clearHydrating(id);
      return Promise.resolve();
    }

    hydration.markHydrating(id);
    const task = (async () => {
      try {
        const record = await getChatHistoryWindow({
          id,
          maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
          includeActiveSegment: true,
        });
        if (!record.activeSegment) throw new Error("历史窗口缺少活跃分段");
        const selectedModel = resolveConversationSelectedModel(
          record.conversation.selectedModelJson,
        );
        const entry = createConversationRuntimeEntry({
          state: buildConversationStateFromWindow(record),
          sessionId: record.conversation.sessionId ?? record.conversation.id,
          createdAt: record.conversation.createdAt,
          workdir: record.conversation.cwd,
          selectedModel,
        });
        setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, id, entry);
        conversationPersistenceCursorRef.current.set(id, {
          activeSegmentIndex: record.activeSegment.segmentIndex,
          activeSegmentId: record.activeSegment.segmentId,
        });
        hydration.clearHydrating(id);
      } catch (error) {
        hydration.markFailed(id);
        throw error;
      }
    })().finally(() => {
      backgroundHydrationRef.current.delete(id);
    });
    backgroundHydrationRef.current.set(id, task);
    return task;
  }

  function loadEarlier(conversationId: string) {
    const id = conversationId.trim();
    if (!id) return Promise.resolve();
    const existing = earlierPageLoadsRef.current.get(id);
    if (existing) return existing;

    async function attempt(): Promise<void> {
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
    }

    const task = (async () => {
      try {
        await attempt();
      } catch (error) {
        if (!isKBrainRevisionConflict(error)) throw error;
        // Re-request the newest window without the stale token and adopt its
        // revision. Raw offsets only ever grow, so the already-paged rows and
        // the paging cursor stay valid.
        const fresh = await getChatHistoryWindow({
          id,
          maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
          includeActiveSegment: false,
        });
        updateConversationRuntimeEntry(id, (current) => ({
          ...current,
          state: {
            ...current.state,
            transcript: { ...current.state.transcript, revision: fresh.revision },
          },
        }));
        await attempt();
      }
    })().finally(() => {
      earlierPageLoadsRef.current.delete(id);
    });
    earlierPageLoadsRef.current.set(id, task);
    return task;
  }

  // Re-request the authoritative window after a revision conflict and commit it
  // into the runtime caches (plus the visible pane when it is the open one).
  // The fresh revision is returned alongside the state: it is the CAS token for
  // the retry, while the projection's own field stays nullable.
  async function reloadConversation(
    conversationId: string,
  ): Promise<{ state: ConversationViewState; revision: string } | null> {
    const id = conversationId.trim();
    if (!id) return null;
    const record = await getChatHistoryWindow({
      id,
      maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
      includeActiveSegment: true,
    });
    if (!record.activeSegment) return null;
    const state = buildConversationStateFromWindow(record);
    const previous = conversationRuntimeCacheRef.current.get(id);
    const entry = previous
      ? { ...previous, state, errorMessage: null }
      : createConversationRuntimeEntry({
          state,
          sessionId: record.conversation.sessionId ?? record.conversation.id,
          createdAt: record.conversation.createdAt,
          workdir: record.conversation.cwd,
          selectedModel: resolveConversationSelectedModel(record.conversation.selectedModelJson),
        });
    setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, id, entry);
    conversationPersistenceCursorRef.current.set(id, {
      activeSegmentIndex: record.activeSegment.segmentIndex,
      activeSegmentId: record.activeSegment.segmentId,
    });
    if (currentConversationIdRef.current === id) {
      setErrorMessage(null);
      syncVisibleConversationRuntime(id, entry);
    }
    markLocalHistorySnapshotSynced(id, record.updatedAt);
    sidebarStore.upsertLocal({ ...record.conversation, isPending: undefined });
    return { state, revision: record.revision };
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

    let replaced: ChatHistoryWindowRecord;
    try {
      replaced = await replaceChatHistoryFromMessage({
        id,
        baseMessageRef: messageRef,
        replacementMessage,
        maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
        expectedRevision,
      });
    } catch (error) {
      if (!isKBrainRevisionConflict(error)) throw error;

      // A concurrent run may have advanced the history after the view rendered.
      // Reload the authoritative window before retrying so both the CAS token
      // and the message projection are current.
      const refreshed = await reloadConversation(id);
      if (!refreshed) throw new Error("重新加载会话后缺少活跃分段");
      const refreshedRef = findReloadedMessageRef(refreshed.state, messageRef);
      if (!refreshedRef || refreshedRef.contentHash !== messageRef.contentHash) {
        throw new Error("历史消息已发生变化，请重新选择要编辑的消息");
      }
      replaced = await replaceChatHistoryFromMessage({
        id,
        baseMessageRef: refreshedRef,
        replacementMessage,
        maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
        expectedRevision: refreshed.revision,
      });
    }
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
    cancelConversationTransientInteractions?.(id);
    // 会话已不存在,计划审批(含批准落定态)才随之销毁——空闲 prune 不走这里。
    cancelPlanDecisionsForConversation?.(id);

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

  const persistConversation: PersistConversationAction = async (params) => {
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

    let stampedState: ConversationViewState;
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
      // The write landed, so the durable row now matches `state` exactly —
      // stamp the CAS revision the backend will derive for it. Callers that
      // apply the persisted state afterwards (compaction finalize) must apply
      // this stamped copy: the checkpoint state itself carries revision:null
      // and would leave edit-resend/paging without a token.
      const revision = buildChatHistoryRevision({
        conversationId,
        updatedAt: summary.updatedAt,
        activeSegmentIndex: state.meta.activeSegmentIndex,
        totalSegmentCount: state.meta.totalSegmentCount,
        totalMessageCount: state.meta.totalMessageCount,
      });
      stampedState = {
        ...state,
        transcript: { ...state.transcript, revision },
      };
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
                  revision,
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
      return null;
    }

    if (!titlePromise) return stampedState;

    const initialStoredTitle = titleToStore;
    void titlePromise
      .then(async (resolvedTitle) => {
        if (!resolvedTitle) return;
        // K-brain persists messages itself; the local summary has not saved the title.
        if (resolvedTitle === initialStoredTitle && getProviderRuntimeBackend() !== "kbrain") {
          return;
        }

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

    return stampedState;
  };

  return {
    startNewConversation,
    openInitial,
    hydrateInBackground,
    loadEarlier,
    replaceConversationAtMessage,
    reloadConversation,
    cleanupDeletedConversation,
    persistConversation,
  };
}
