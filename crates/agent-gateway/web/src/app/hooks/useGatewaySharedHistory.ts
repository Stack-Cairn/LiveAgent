import { sortSidebarConversations } from "@liveagent/ui/lib/sidebar/reconcile";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatHistorySummary } from "@/lib/chat/chatHistory";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import type { AgentStatus, HistoryShareStatus } from "@/lib/gatewayTypes";
import { normalizeGatewayConversationSummary } from "@/lib/sidebar/webSidebarBackend";

import { asErrorMessage } from "../chatEventUtils";
import { SHARED_HISTORY_LIST_PAGE_SIZE } from "../constants";

type UseGatewaySharedHistoryOptions = {
  api: GatewayWebSocketClientLike | null;
  gatewayConnectionLost: boolean;
  sidebarStore: SidebarStore;
  status: AgentStatus | null;
};

function updateIdSet(
  setter: (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
  id: string,
  enabled: boolean,
) {
  setter((current) => {
    const next = new Set(current);
    if (enabled) {
      next.add(id);
    } else {
      next.delete(id);
    }
    return next;
  });
}

export function useGatewaySharedHistory({
  api,
  gatewayConnectionLost,
  sidebarStore,
  status,
}: UseGatewaySharedHistoryOptions) {
  const [shareConversation, setShareConversation] = useState<ChatHistorySummary | null>(null);
  const [shareStatus, setShareStatus] = useState<HistoryShareStatus | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUpdating, setShareUpdating] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharedManagerOpen, setSharedManagerOpen] = useState(false);
  const [sharedManagerStatuses, setSharedManagerStatuses] = useState<
    Record<string, HistoryShareStatus | undefined>
  >({});
  const [sharedManagerLoadingIds, setSharedManagerLoadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerUpdatingIds, setSharedManagerUpdatingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerErrors, setSharedManagerErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [sharedHistoryListError, setSharedHistoryListError] = useState<string | null>(null);
  const [sharedHistoryItems, setSharedHistoryItems] = useState<ChatHistorySummary[]>([]);
  const sharedHistoryItemsRef = useRef<ChatHistorySummary[]>([]);
  const sharedHistoryListRequestRef = useRef<{
    generation: string;
    promise: Promise<ChatHistorySummary[]>;
  } | null>(null);

  const setSharedHistoryItemsState = useCallback((items: ChatHistorySummary[]) => {
    const nextItems = sortSidebarConversations(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  const setSharedManagerError = useCallback((id: string, message: string | null) => {
    setSharedManagerErrors((current) => {
      const next = { ...current };
      if (message) {
        next[id] = message;
      } else {
        delete next[id];
      }
      return next;
    });
  }, []);

  const markSharedConversation = useCallback(
    (id: string, isShared: boolean, source?: ChatHistorySummary | null) => {
      const existingRow = sidebarStore.peek(id);
      if (existingRow && existingRow.isShared !== isShared) {
        sidebarStore.upsertLocal({ ...existingRow, isShared });
      }
      if (!isShared) {
        setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
        return;
      }

      const conversation =
        source ?? existingRow ?? sharedHistoryItemsRef.current.find((item) => item.id === id);
      if (!conversation) {
        return;
      }
      setSharedHistoryItemsState([
        { ...conversation, isShared: true },
        ...sharedHistoryItemsRef.current.filter((item) => item.id !== id),
      ]);
    },
    [setSharedHistoryItemsState, sidebarStore],
  );

  const refreshSharedHistoryItems = useCallback(
    async (currentApi = api, options?: { force?: boolean; generation?: string }) => {
      if (!currentApi) {
        sharedHistoryListRequestRef.current = null;
        setSharedHistoryItemsState([]);
        setSharedHistoryListError(null);
        return [];
      }
      if (sharedHistoryListRequestRef.current && options?.force !== true) {
        return sharedHistoryListRequestRef.current.promise;
      }

      const request = (async () => {
        const byId = new Map<string, ChatHistorySummary>();
        let totalCount = 0;
        for (let pageNumber = 1; ; pageNumber += 1) {
          const response = await currentApi.listSharedHistory(
            pageNumber,
            SHARED_HISTORY_LIST_PAGE_SIZE,
          );
          totalCount = Math.max(0, response.total_count);
          for (const conversation of response.conversations) {
            const item = normalizeGatewayConversationSummary(conversation);
            byId.set(item.id, { ...item, isShared: true });
          }
          if (response.conversations.length === 0 || byId.size >= totalCount) {
            break;
          }
        }
        return sortSidebarConversations(Array.from(byId.values()));
      })();

      const requestState = {
        generation: options?.generation?.trim() || "manual",
        promise: request,
      };
      sharedHistoryListRequestRef.current = requestState;
      setSharedHistoryListError(null);
      try {
        const nextItems = await request;
        if (sharedHistoryListRequestRef.current === requestState) {
          setSharedHistoryItemsState(nextItems);
          setSharedHistoryListError(null);
          return nextItems;
        }
        return sharedHistoryItemsRef.current;
      } catch (error) {
        if (sharedHistoryListRequestRef.current === requestState) {
          setSharedHistoryListError(asErrorMessage(error, "读取已分享历史列表失败"));
        }
        return sharedHistoryItemsRef.current;
      } finally {
        if (sharedHistoryListRequestRef.current === requestState) {
          sharedHistoryListRequestRef.current = null;
        }
      }
    },
    [api, setSharedHistoryItemsState],
  );

  useEffect(() => {
    if (!api) {
      sharedHistoryListRequestRef.current = null;
      setSharedHistoryItemsState([]);
      setSharedHistoryListError(null);
      return;
    }
    if (gatewayConnectionLost || status?.online !== true) {
      return;
    }
    void refreshSharedHistoryItems(api, {
      force: true,
      generation: status.session_id?.trim() || "online",
    });
  }, [
    api,
    gatewayConnectionLost,
    refreshSharedHistoryItems,
    setSharedHistoryItemsState,
    status?.online,
    status?.session_id,
  ]);

  const handleOpenShareModal = useCallback(
    (item: ChatHistorySummary) => {
      setShareConversation(item);
      setShareStatus(null);
      setShareError(null);
      if (!api) {
        setShareError("Gateway 尚未连接，无法读取分享状态。");
        return;
      }

      setShareLoading(true);
      void api
        .getHistoryShare(item.id)
        .then((nextStatus) => {
          setShareStatus(nextStatus);
          setSharedManagerStatuses((current) => ({ ...current, [item.id]: nextStatus }));
          markSharedConversation(item.id, nextStatus.enabled === true, item);
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, "读取分享状态失败"));
        })
        .finally(() => {
          setShareLoading(false);
        });
    },
    [api, markSharedConversation],
  );

  const handleCloseShareModal = useCallback(() => {
    setShareConversation(null);
    setShareStatus(null);
    setShareError(null);
    setShareLoading(false);
    setShareUpdating(false);
  }, []);

  const handleToggleHistoryShare = useCallback(
    (enabled: boolean, options?: { redactToolContent?: boolean }) => {
      if (!api || !shareConversation) return;
      const item = shareConversation;
      setShareError(null);
      setShareUpdating(true);
      void api
        .setHistoryShare(item.id, enabled, options)
        .then((nextStatus) => {
          setShareStatus(nextStatus);
          setSharedManagerStatuses((current) => ({ ...current, [item.id]: nextStatus }));
          markSharedConversation(item.id, nextStatus.enabled === true, item);
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, enabled ? "开启分享失败" : "关闭分享失败"));
        })
        .finally(() => {
          setShareUpdating(false);
        });
    },
    [api, markSharedConversation, shareConversation],
  );

  const handleSetShareRedactToolContent = useCallback(
    (redactToolContent: boolean) => {
      if (!api || !shareConversation) return;
      const item = shareConversation;
      setShareError(null);
      setShareUpdating(true);
      void api
        .setHistoryShare(item.id, true, { redactToolContent })
        .then((nextStatus) => {
          setShareStatus(nextStatus);
          setSharedManagerStatuses((current) => ({ ...current, [item.id]: nextStatus }));
          markSharedConversation(item.id, nextStatus.enabled === true, item);
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, "更新分享脱敏设置失败"));
        })
        .finally(() => {
          setShareUpdating(false);
        });
    },
    [api, markSharedConversation, shareConversation],
  );

  const handleLoadSharedHistoryStatus = useCallback(
    (item: ChatHistorySummary) => {
      const id = item.id.trim();
      if (!id) return;
      if (!api) {
        setSharedManagerError(id, "Gateway 尚未连接，无法读取分享状态。");
        return;
      }

      setSharedManagerError(id, null);
      updateIdSet(setSharedManagerLoadingIds, id, true);
      void api
        .getHistoryShare(id)
        .then((nextStatus) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: nextStatus }));
          markSharedConversation(id, nextStatus.enabled === true, item);
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "读取分享状态失败"));
        })
        .finally(() => {
          updateIdSet(setSharedManagerLoadingIds, id, false);
        });
    },
    [api, markSharedConversation, setSharedManagerError],
  );

  const handleRefreshSharedHistoryStatuses = useCallback(() => {
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }, [handleLoadSharedHistoryStatus, refreshSharedHistoryItems]);

  const handleOpenSharedHistoryManager = useCallback(() => {
    setSharedManagerOpen(true);
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }, [handleLoadSharedHistoryStatus, refreshSharedHistoryItems]);

  const handleDisableSharedHistory = useCallback(
    (item: ChatHistorySummary) => {
      const id = item.id.trim();
      if (!id) return;
      if (!api) {
        setSharedManagerError(id, "Gateway 尚未连接，无法关闭分享。");
        return;
      }

      setSharedManagerError(id, null);
      updateIdSet(setSharedManagerUpdatingIds, id, true);
      void api
        .setHistoryShare(id, false)
        .then((nextStatus) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: nextStatus }));
          markSharedConversation(id, nextStatus.enabled === true, item);
          if (shareConversation?.id === id) {
            setShareStatus(nextStatus);
          }
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "关闭分享失败"));
        })
        .finally(() => {
          updateIdSet(setSharedManagerUpdatingIds, id, false);
        });
    },
    [api, markSharedConversation, setSharedManagerError, shareConversation?.id],
  );

  const handleSetSharedHistoryRedactToolContent = useCallback(
    (item: ChatHistorySummary, redactToolContent: boolean) => {
      const id = item.id.trim();
      if (!id) return;
      if (!api) {
        setSharedManagerError(id, "Gateway 尚未连接，无法更新分享脱敏设置。");
        return;
      }

      setSharedManagerError(id, null);
      updateIdSet(setSharedManagerUpdatingIds, id, true);
      void api
        .setHistoryShare(id, true, { redactToolContent })
        .then((nextStatus) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: nextStatus }));
          markSharedConversation(id, nextStatus.enabled === true, item);
          if (shareConversation?.id === id) {
            setShareStatus(nextStatus);
          }
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "更新分享脱敏设置失败"));
        })
        .finally(() => {
          updateIdSet(setSharedManagerUpdatingIds, id, false);
        });
    },
    [api, markSharedConversation, setSharedManagerError, shareConversation?.id],
  );

  const reset = useCallback(() => {
    sharedHistoryItemsRef.current = [];
    sharedHistoryListRequestRef.current = null;
    setSharedHistoryItems([]);
    setSharedHistoryListError(null);
    setShareConversation(null);
    setShareStatus(null);
    setShareLoading(false);
    setShareUpdating(false);
    setShareError(null);
    setSharedManagerOpen(false);
    setSharedManagerStatuses({});
    setSharedManagerLoadingIds(new Set());
    setSharedManagerUpdatingIds(new Set());
    setSharedManagerErrors({});
  }, []);

  const removeSharedHistoryItems = useCallback((ids: ReadonlySet<string>) => {
    if (ids.size === 0) return;
    const nextItems = sharedHistoryItemsRef.current.filter((item) => !ids.has(item.id));
    if (nextItems.length === sharedHistoryItemsRef.current.length) return;
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  return {
    handleCloseShareModal,
    handleDisableSharedHistory,
    handleLoadSharedHistoryStatus,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleRefreshSharedHistoryStatuses,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleToggleHistoryShare,
    removeSharedHistoryItems,
    resetSharedHistory: reset,
    setSharedManagerOpen,
    shareConversation,
    shareError,
    shareLoading,
    shareStatus,
    shareUpdating,
    sharedHistoryItems,
    sharedHistoryListError,
    sharedManagerErrors,
    sharedManagerLoadingIds,
    sharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerUpdatingIds,
  };
}
