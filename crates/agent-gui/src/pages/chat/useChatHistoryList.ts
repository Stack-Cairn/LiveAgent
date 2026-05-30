import { listen } from "@tauri-apps/api/event";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  ChatHistoryListFilter,
  ChatHistorySummary,
} from "../../lib/chat/history/chatHistory";
import { listChatHistory } from "../../lib/chat/history/chatHistory";
import {
  applyChatHistorySyncEvent,
  CHAT_HISTORY_SYNC_EVENT,
  type ChatHistorySyncEvent,
} from "../../lib/chat/history/chatHistorySync";
import {
  chatHistoryFilterKey,
  filterHistoryItemsForScope,
  historyItemMatchesFilter,
  mergeScopedHistoryPage,
  sortScopedHistoryItems,
} from "./historyListScope";

const HISTORY_LIST_RECONCILE_INTERVAL_MS = 60_000;
const HISTORY_LIST_PAGE_SIZE = 80;
const HISTORY_LIST_MIN_LOADING_MS = 260;

type HistoryItemsSetter = Dispatch<SetStateAction<ChatHistorySummary[]>>;

function applyHistoryItemsUpdate(
  current: ChatHistorySummary[],
  update: SetStateAction<ChatHistorySummary[]>,
) {
  return typeof update === "function"
    ? (update as (value: ChatHistorySummary[]) => ChatHistorySummary[])(current)
    : update;
}

function persistedHistoryCount(items: ChatHistorySummary[]) {
  return items.reduce((count, item) => count + (item.isPending ? 0 : 1), 0);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function waitForMinimumLoadingDuration(startedAt: number) {
  const elapsed = Date.now() - startedAt;
  const remainingMs = Math.max(0, HISTORY_LIST_MIN_LOADING_MS - elapsed);
  if (remainingMs > 0) {
    await wait(remainingMs);
  }
}

export function useChatHistoryList(filter?: ChatHistoryListFilter) {
  const filterKey = chatHistoryFilterKey(filter);
  const filterRef = useRef<ChatHistoryListFilter | undefined>(filter);
  const filterKeyRef = useRef(filterKey);
  const [historyItems, setHistoryItemsState] = useState<ChatHistorySummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyItemsRef = useRef<ChatHistorySummary[]>([]);
  const historyTotalRef = useRef(0);
  const historyHasMoreRef = useRef(false);
  const nextHistoryPageRef = useRef(1);
  const disposedRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const loadMoreInFlightRef = useRef(false);
  const queuedRefreshRef = useRef<{ silent: boolean } | null>(null);

  useEffect(() => {
    filterRef.current = filter;
    filterKeyRef.current = filterKey;
  }, [filterKey, filter]);

  const commitHistoryItems = useCallback(
    (items: ChatHistorySummary[], total: number, nextPage: number, hasMore?: boolean) => {
      const scopedItems = filterHistoryItemsForScope(items, filterRef.current);
      const nextTotal = Math.max(0, total);
      const loadedPersistedCount = persistedHistoryCount(scopedItems);
      const nextHasMore = hasMore ?? loadedPersistedCount < nextTotal;

      historyItemsRef.current = scopedItems;
      historyTotalRef.current = nextTotal;
      historyHasMoreRef.current = nextHasMore;
      nextHistoryPageRef.current = Math.max(1, nextPage);
      setHistoryItemsState(scopedItems);
      setHistoryTotal(nextTotal);
      setHistoryHasMore(nextHasMore);
    },
    [],
  );

  const setHistoryItems = useCallback<HistoryItemsSetter>(
    (update) => {
      const current = historyItemsRef.current;
      const next = filterHistoryItemsForScope(
        applyHistoryItemsUpdate(current, update),
        filterRef.current,
      );
      const persistedDelta = persistedHistoryCount(next) - persistedHistoryCount(current);
      const nextTotal = Math.max(
        persistedHistoryCount(next),
        historyTotalRef.current + persistedDelta,
      );
      commitHistoryItems(next, nextTotal, nextHistoryPageRef.current);
    },
    [commitHistoryItems],
  );

  const refreshHistory = useCallback(
    async (options?: { silent?: boolean }) => {
      if (disposedRef.current) {
        return;
      }

      const requestedSilent = options?.silent === true;
      if (requestInFlightRef.current) {
        const queued = queuedRefreshRef.current;
        queuedRefreshRef.current = {
          silent: queued ? queued.silent && requestedSilent : requestedSilent,
        };
        return;
      }

      requestInFlightRef.current = true;
      let nextOptions: { silent: boolean } | null = { silent: requestedSilent };

      try {
        while (nextOptions && !disposedRef.current) {
          const silent = nextOptions.silent;
          queuedRefreshRef.current = null;
          let requestFilterKey = filterKeyRef.current;
          const loadingStartedAt = Date.now();
          if (!silent) {
            setHistoryLoading(true);
          }

          try {
            requestFilterKey = filterKeyRef.current;
            const page = await listChatHistory(1, HISTORY_LIST_PAGE_SIZE, filterRef.current);
            if (disposedRef.current || requestFilterKey !== filterKeyRef.current) {
              break;
            }
            const nextItems = silent
              ? mergeScopedHistoryPage(historyItemsRef.current, page.items, filterRef.current)
              : sortScopedHistoryItems(page.items, filterRef.current);
            const refreshedNextPage = page.items.length > 0 ? 2 : 1;
            const nextPage = silent
              ? Math.max(nextHistoryPageRef.current, refreshedNextPage)
              : refreshedNextPage;
            commitHistoryItems(
              nextItems,
              page.totalCount,
              nextPage,
              page.items.length > 0 && persistedHistoryCount(nextItems) < page.totalCount,
            );
            setHistoryError(null);
          } catch (err) {
            if (disposedRef.current || requestFilterKey !== filterKeyRef.current) {
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (!silent) {
              commitHistoryItems([], 0, 0);
            }
            setHistoryError(msg || "读取历史列表失败");
          } finally {
            if (!silent) {
              await waitForMinimumLoadingDuration(loadingStartedAt);
            }
            if (!silent && !disposedRef.current && requestFilterKey === filterKeyRef.current) {
              setHistoryLoading(false);
            }
          }

          nextOptions = queuedRefreshRef.current;
        }
      } finally {
        requestInFlightRef.current = false;
      }
    },
    [commitHistoryItems],
  );

  const loadMoreHistory = useCallback(async () => {
    if (
      disposedRef.current ||
      requestInFlightRef.current ||
      loadMoreInFlightRef.current ||
      !historyHasMoreRef.current
    ) {
      return;
    }

    loadMoreInFlightRef.current = true;
    setHistoryLoadingMore(true);
    try {
      const pageNumber = nextHistoryPageRef.current;
      const requestFilterKey = filterKeyRef.current;
      const page = await listChatHistory(
        pageNumber,
        HISTORY_LIST_PAGE_SIZE,
        filterRef.current,
      );
      if (disposedRef.current || requestFilterKey !== filterKeyRef.current) {
        return;
      }
      const nextItems = mergeScopedHistoryPage(
        historyItemsRef.current,
        page.items,
        filterRef.current,
      );
      const nextPage = page.items.length === 0 ? pageNumber : pageNumber + 1;
      commitHistoryItems(
        nextItems,
        page.totalCount,
        nextPage,
        page.items.length > 0 && persistedHistoryCount(nextItems) < page.totalCount,
      );
      setHistoryError(null);
    } catch (err) {
      if (disposedRef.current) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setHistoryError(msg || "读取更多历史列表失败");
    } finally {
      loadMoreInFlightRef.current = false;
      if (!disposedRef.current) {
        setHistoryLoadingMore(false);
      }
    }
  }, [commitHistoryItems]);

  useEffect(() => {
    disposedRef.current = false;
    let cancelled = false;
    commitHistoryItems([], 0, 1, false);
    setHistoryError(null);
    setHistoryLoading(true);
    const unlistenPromise = listen<ChatHistorySyncEvent>(CHAT_HISTORY_SYNC_EVENT, (event) => {
      if (disposedRef.current) {
        return;
      }

      setHistoryItems((current) => {
        if (event.payload.kind === "upsert") {
          if (!historyItemMatchesFilter(event.payload.conversation, filterRef.current)) {
            return current.filter((item) => item.id !== event.payload.conversationId);
          }
        }
        return applyChatHistorySyncEvent(current, event.payload);
      });
      setHistoryError(null);
    });

    async function runRefresh(options?: { silent?: boolean }) {
      try {
        await refreshHistory(options);
        if (cancelled) return;
      } catch (err) {
        if (cancelled) return;
      }
    }

    void runRefresh();
    const timer = window.setInterval(() => {
      void runRefresh({ silent: true });
    }, HISTORY_LIST_RECONCILE_INTERVAL_MS);

    return () => {
      cancelled = true;
      disposedRef.current = true;
      void unlistenPromise.then((unlisten) => unlisten());
      window.clearInterval(timer);
    };
  }, [commitHistoryItems, filterKey, refreshHistory, setHistoryItems]);

  return {
    historyItems,
    setHistoryItems,
    historyItemsRef,
    historyTotal,
    historyHasMore,
    historyLoading,
    historyLoadingMore,
    historyError,
    setHistoryError,
    refreshHistory,
    loadMoreHistory,
  };
}
