import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";
import type { CompactionStatus } from "../../lib/chat/compaction/contextCompaction";
import {
  type ConversationViewState,
  createConversationStateFromContext,
} from "../../lib/chat/conversation/conversationState";
import {
  type ConversationRuntimeEntry,
  createConversationRuntimeEntry,
  setConversationRuntimeCacheEntry,
} from "./chatPageRuntime";

type ConversationIdentity = {
  conversationId: string;
  sessionId: string;
  createdAt: number;
};

type RuntimeEntryFallback = Partial<ConversationRuntimeEntry> &
  Pick<ConversationRuntimeEntry, "state" | "sessionId" | "createdAt">;

type UseChatPageRuntimeStoreParams = {
  initialConversation: ConversationIdentity;
  initialConversationState: ConversationViewState;
  currentConversationId: string;
  conversationState: ConversationViewState;
  compactionStatus: CompactionStatus;
  isSending: boolean;
  errorMessage: string | null;
  hookWarning: string | null;
  currentConversationSessionId: string;
  currentConversationCreatedAt: number;
  setConversationState: Dispatch<SetStateAction<ConversationViewState>>;
  setCompactionStatus: Dispatch<SetStateAction<CompactionStatus>>;
  setIsSending: Dispatch<SetStateAction<boolean>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setHookWarning: Dispatch<SetStateAction<string | null>>;
  setCurrentConversationSessionId: Dispatch<SetStateAction<string>>;
  setCurrentConversationCreatedAt: Dispatch<SetStateAction<number>>;
  setRunningConversationIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
};

export function useChatPageRuntimeStore(params: UseChatPageRuntimeStoreParams) {
  const {
    initialConversation,
    initialConversationState,
    currentConversationId,
    conversationState,
    compactionStatus,
    isSending,
    errorMessage,
    hookWarning,
    currentConversationSessionId,
    currentConversationCreatedAt,
    setConversationState,
    setCompactionStatus,
    setIsSending,
    setErrorMessage,
    setHookWarning,
    setCurrentConversationSessionId,
    setCurrentConversationCreatedAt,
    setRunningConversationIds,
  } = params;

  const currentConversationIdRef = useRef<string>(initialConversation.conversationId);
  const conversationRuntimeCacheRef = useRef(
    new Map<string, ConversationRuntimeEntry>([
      [
        initialConversation.conversationId,
        createConversationRuntimeEntry({
          state: initialConversationState,
          sessionId: initialConversation.sessionId,
          createdAt: initialConversation.createdAt,
        }),
      ],
    ]),
  );
  const persistedConversationStateRef = useRef(new Map<string, ConversationViewState>());
  const runningConversationIdsRef = useRef(new Set<string>());
  const conversationAbortControllersRef = useRef(new Map<string, AbortController>());

  const buildRuntimeEntryFromVisibleState = useCallback(
    (): ConversationRuntimeEntry =>
      createConversationRuntimeEntry({
        state: conversationState,
        compactionStatus,
        isSending,
        errorMessage,
        hookWarning,
        sessionId: currentConversationSessionId,
        createdAt: currentConversationCreatedAt,
        workdir: conversationRuntimeCacheRef.current.get(currentConversationIdRef.current)?.workdir,
      }),
    [
      compactionStatus,
      conversationState,
      currentConversationCreatedAt,
      currentConversationSessionId,
      errorMessage,
      hookWarning,
      isSending,
    ],
  );

  const syncVisibleConversationRuntime = useCallback(
    (conversationId: string, entry: ConversationRuntimeEntry) => {
      currentConversationIdRef.current = conversationId;
      setConversationState(entry.state);
      setCompactionStatus(entry.compactionStatus);
      setIsSending(entry.isSending);
      setErrorMessage(entry.errorMessage);
      setHookWarning(entry.hookWarning);
      setCurrentConversationSessionId(entry.sessionId);
      setCurrentConversationCreatedAt(entry.createdAt);
    },
    [
      setCompactionStatus,
      setConversationState,
      setCurrentConversationCreatedAt,
      setCurrentConversationSessionId,
      setErrorMessage,
      setHookWarning,
      setIsSending,
    ],
  );

  const ensureConversationRuntimeEntry = useCallback(
    (conversationId: string, fallback?: RuntimeEntryFallback) => {
      const key = conversationId.trim();
      const cached = conversationRuntimeCacheRef.current.get(key);
      if (cached) return cached;
      const next =
        fallback ??
        (key === currentConversationIdRef.current
          ? buildRuntimeEntryFromVisibleState()
          : createConversationRuntimeEntry({
              state: createConversationStateFromContext({
                tools: conversationState.meta.tools,
                messages: [],
              }),
              sessionId: key,
              createdAt: Date.now(),
            }));
      const normalized = createConversationRuntimeEntry(next);
      setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, key, normalized);
      return normalized;
    },
    [buildRuntimeEntryFromVisibleState, conversationState.meta.tools],
  );

  const updateConversationRuntimeEntry = useCallback(
    (
      conversationId: string,
      updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
      fallback?: RuntimeEntryFallback,
    ) => {
      const key = conversationId.trim();
      const next = updater(ensureConversationRuntimeEntry(key, fallback));
      setConversationRuntimeCacheEntry(conversationRuntimeCacheRef.current, key, next);
      if (currentConversationIdRef.current === key) {
        syncVisibleConversationRuntime(key, next);
      }
      return next;
    },
    [ensureConversationRuntimeEntry, syncVisibleConversationRuntime],
  );

  const isConversationRunning = useCallback((conversationId: string) => {
    return runningConversationIdsRef.current.has(conversationId.trim());
  }, []);

  const setConversationAbortController = useCallback(
    (conversationId: string, controller: AbortController | null) => {
      const key = conversationId.trim();
      if (!key) return;
      if (controller) {
        conversationAbortControllersRef.current.set(key, controller);
        return;
      }
      conversationAbortControllersRef.current.delete(key);
    },
    [],
  );

  const getConversationAbortController = useCallback((conversationId: string) => {
    return conversationAbortControllersRef.current.get(conversationId.trim()) ?? null;
  }, []);

  const setConversationSendingState = useCallback(
    (conversationId: string, value: boolean) => {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        isSending: value,
      }));
      const key = conversationId.trim();
      if (!key) return;
      if (value) {
        runningConversationIdsRef.current.add(key);
        setRunningConversationIds((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        return;
      }
      runningConversationIdsRef.current.delete(key);
      setRunningConversationIds((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [setRunningConversationIds, updateConversationRuntimeEntry],
  );

  useEffect(() => {
    setConversationRuntimeCacheEntry(
      conversationRuntimeCacheRef.current,
      currentConversationId,
      createConversationRuntimeEntry({
        state: conversationState,
        compactionStatus,
        isSending,
        errorMessage,
        hookWarning,
        sessionId: currentConversationSessionId,
        createdAt: currentConversationCreatedAt,
        workdir: conversationRuntimeCacheRef.current.get(currentConversationId)?.workdir,
      }),
    );
  }, [
    compactionStatus,
    conversationState,
    currentConversationCreatedAt,
    currentConversationId,
    currentConversationSessionId,
    errorMessage,
    hookWarning,
    isSending,
  ]);

  useEffect(
    () => () => {
      for (const controller of conversationAbortControllersRef.current.values()) {
        controller.abort();
      }
      conversationAbortControllersRef.current.clear();
    },
    [],
  );

  return {
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    persistedConversationStateRef,
    runningConversationIdsRef,
    buildRuntimeEntryFromVisibleState,
    syncVisibleConversationRuntime,
    ensureConversationRuntimeEntry,
    updateConversationRuntimeEntry,
    isConversationRunning,
    setConversationAbortController,
    getConversationAbortController,
    setConversationSendingState,
  };
}
