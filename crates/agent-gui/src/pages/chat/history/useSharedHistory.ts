import { sortSidebarConversations } from "@liveagent/ui/lib/sidebar/reconcile";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ChatHistoryShareStatus,
  type ChatHistorySummary,
  getChatHistoryShare,
  listSharedChatHistory,
  setChatHistoryShare,
} from "../../../lib/chat/history/chatHistory";
import type { AppSettings } from "../../../lib/settings";
import { invoke } from "../../../lib/tauriBridge";
import { asErrorMessage } from "../chatPageUtils";
import type { GatewayRuntimeStatus } from "../gateway/gatewayRuntimeStatusModel";

const SHARED_HISTORY_LIST_PAGE_SIZE = 200;

type UseSharedHistoryParams = {
  remoteSettings: AppSettings["remote"];
  remoteRuntimeStatus: GatewayRuntimeStatus;
  setRemoteRuntimeStatus: Dispatch<SetStateAction<GatewayRuntimeStatus>>;
  sidebarStore: SidebarStore;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
};

/**
 * Conversation-share domain: the per-conversation share modal, the shared
 * history manager modal, and the shared-history list mirrored into the
 * sidebar (isShared flags).
 */
export function useSharedHistory(params: UseSharedHistoryParams) {
  const {
    remoteSettings,
    remoteRuntimeStatus,
    setRemoteRuntimeStatus,
    sidebarStore,
    setErrorMessage,
  } = params;

  const [shareConversation, setShareConversation] = useState<ChatHistorySummary | null>(null);
  const [shareStatus, setShareStatus] = useState<ChatHistoryShareStatus | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUpdating, setShareUpdating] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharedManagerOpen, setSharedManagerOpen] = useState(false);
  const [sharedManagerStatuses, setSharedManagerStatuses] = useState<
    Record<string, ChatHistoryShareStatus | undefined>
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
  const [sharedManagerGatewayUrl, setSharedManagerGatewayUrl] = useState("");
  const [sharedManagerGatewayUrlLoading, setSharedManagerGatewayUrlLoading] = useState(false);
  const [sharedHistoryItems, setSharedHistoryItems] = useState<ChatHistorySummary[]>([]);
  const sharedHistoryItemsRef = useRef<ChatHistorySummary[]>([]);
  const sharedHistoryListRequestRef = useRef<Promise<ChatHistorySummary[]> | null>(null);
  const sharedManagerShareOrigin = useMemo(() => {
    const statusGatewayUrl = remoteRuntimeStatus.gatewayUrl?.trim() ?? "";
    const runtimeGatewayUrl = sharedManagerGatewayUrl.trim();
    return statusGatewayUrl || runtimeGatewayUrl || remoteSettings.gatewayUrl;
  }, [remoteRuntimeStatus.gatewayUrl, remoteSettings.gatewayUrl, sharedManagerGatewayUrl]);
  const canShareHistory =
    remoteRuntimeStatus.online === true &&
    remoteRuntimeStatus.enabled === true &&
    remoteRuntimeStatus.configured === true;

  const setSharedHistoryItemsState = useCallback((items: ChatHistorySummary[]) => {
    const nextItems = sortSidebarConversations(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  /** Drops rows from the shared-history list without touching share state. */
  const removeSharedHistoryItems = useCallback(
    (ids: Iterable<string>) => {
      const removed = new Set(ids);
      if (removed.size === 0) {
        return;
      }
      setSharedHistoryItemsState(
        sharedHistoryItemsRef.current.filter((item) => !removed.has(item.id)),
      );
    },
    [setSharedHistoryItemsState],
  );

  const updateSharedManagerIdSet = useCallback(
    (
      setter: (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
      id: string,
      enabled: boolean,
    ) => {
      setter((current) => {
        const next = new Set(current);
        if (enabled) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    },
    [],
  );

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

  const refreshSharedHistoryItems = useCallback(async () => {
    if (sharedHistoryListRequestRef.current) {
      return sharedHistoryListRequestRef.current;
    }

    const request = (async () => {
      const byId = new Map<string, ChatHistorySummary>();
      let totalCount = 0;
      for (let pageNumber = 1; ; pageNumber += 1) {
        const page = await listSharedChatHistory(pageNumber, SHARED_HISTORY_LIST_PAGE_SIZE);
        totalCount = Math.max(0, page.totalCount);
        for (const item of page.items) {
          byId.set(item.id, { ...item, isShared: true });
        }
        if (page.items.length === 0 || byId.size >= totalCount) {
          break;
        }
      }

      const nextItems = Array.from(byId.values());
      setSharedHistoryItemsState(nextItems);
      return sortSidebarConversations(nextItems);
    })();

    sharedHistoryListRequestRef.current = request;
    try {
      return await request;
    } catch (error) {
      setErrorMessage(asErrorMessage(error, "读取已分享历史列表失败"));
      return sharedHistoryItemsRef.current;
    } finally {
      if (sharedHistoryListRequestRef.current === request) {
        sharedHistoryListRequestRef.current = null;
      }
    }
  }, [setSharedHistoryItemsState, setErrorMessage]);

  useEffect(() => {
    void refreshSharedHistoryItems();
  }, [refreshSharedHistoryItems]);

  const markSharedConversation = useCallback(
    (id: string, isShared: boolean, source?: ChatHistorySummary | null) => {
      const existing = sidebarStore.peek(id);
      if (existing && existing.isShared !== isShared) {
        sidebarStore.upsertLocal({ ...existing, isShared });
      }
      if (!isShared) {
        setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
        return;
      }

      const conversation =
        source ??
        sidebarStore.peek(id) ??
        sharedHistoryItemsRef.current.find((item) => item.id === id);
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

  const handleLoadSharedHistoryStatus = useCallback(
    (conversation: ChatHistorySummary) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }
      setSharedManagerError(id, null);
      updateSharedManagerIdSet(setSharedManagerLoadingIds, id, true);
      void getChatHistoryShare(id)
        .then((status) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, conversation);
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "读取分享状态失败"));
        })
        .finally(() => {
          updateSharedManagerIdSet(setSharedManagerLoadingIds, id, false);
        });
    },
    [markSharedConversation, setSharedManagerError, updateSharedManagerIdSet],
  );

  const refreshSharedManagerGatewayUrl = useCallback(() => {
    setSharedManagerGatewayUrlLoading(true);
    void invoke<GatewayRuntimeStatus>("gateway_status")
      .then((status) => {
        setRemoteRuntimeStatus(status);
        setSharedManagerGatewayUrl(status.gatewayUrl?.trim() ?? "");
      })
      .catch(() => {
        setSharedManagerGatewayUrl("");
      })
      .finally(() => {
        setSharedManagerGatewayUrlLoading(false);
      });
  }, [setRemoteRuntimeStatus]);

  const handleOpenShareModal = useCallback(
    (conversation: ChatHistorySummary) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }

      setShareConversation(conversation);
      setShareStatus(null);
      setShareError(null);
      setShareLoading(false);
      setShareUpdating(false);
      setSharedManagerGatewayUrl(
        remoteRuntimeStatus.gatewayUrl?.trim() || remoteSettings.gatewayUrl.trim(),
      );
      refreshSharedManagerGatewayUrl();

      if (!canShareHistory) {
        setShareError("Remote 尚未配置并连接成功，暂时不能分享会话。");
        return;
      }

      setShareLoading(true);
      void getChatHistoryShare(id)
        .then((status) => {
          setShareStatus(status);
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          setSharedManagerError(id, null);
          markSharedConversation(id, status.enabled === true, conversation);
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, "读取分享状态失败"));
        })
        .finally(() => {
          setShareLoading(false);
        });
    },
    [
      canShareHistory,
      markSharedConversation,
      refreshSharedManagerGatewayUrl,
      remoteRuntimeStatus.gatewayUrl,
      setSharedManagerError,
      remoteSettings.gatewayUrl,
    ],
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
      const id = shareConversation?.id.trim() ?? "";
      if (!id) {
        return;
      }
      if (enabled && !canShareHistory) {
        setShareError("Remote 尚未配置并连接成功，暂时不能开启分享。");
        return;
      }

      setShareError(null);
      setSharedManagerError(id, null);
      setShareUpdating(true);
      if (enabled) {
        refreshSharedManagerGatewayUrl();
      }

      void setChatHistoryShare(id, enabled, options)
        .then((status) => {
          setShareStatus(status);
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, shareConversation);
          setShareConversation((current) =>
            current?.id === id ? { ...current, isShared: status.enabled === true } : current,
          );
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, enabled ? "开启分享失败" : "关闭分享失败"));
        })
        .finally(() => {
          setShareUpdating(false);
        });
    },
    [
      canShareHistory,
      markSharedConversation,
      refreshSharedManagerGatewayUrl,
      setSharedManagerError,
      shareConversation,
    ],
  );

  const handleSetShareRedactToolContent = useCallback(
    (redactToolContent: boolean) => {
      const id = shareConversation?.id.trim() ?? "";
      if (!id) {
        return;
      }

      setShareError(null);
      setSharedManagerError(id, null);
      setShareUpdating(true);

      void setChatHistoryShare(id, true, { redactToolContent })
        .then((status) => {
          setShareStatus(status);
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, shareConversation);
        })
        .catch((error) => {
          setShareError(asErrorMessage(error, "更新分享脱敏设置失败"));
        })
        .finally(() => {
          setShareUpdating(false);
        });
    },
    [markSharedConversation, setSharedManagerError, shareConversation],
  );

  const handleRefreshSharedHistoryStatuses = useCallback(() => {
    refreshSharedManagerGatewayUrl();
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }, [handleLoadSharedHistoryStatus, refreshSharedHistoryItems, refreshSharedManagerGatewayUrl]);

  const handleOpenSharedHistoryManager = useCallback(() => {
    setSharedManagerGatewayUrl(remoteSettings.gatewayUrl.trim());
    refreshSharedManagerGatewayUrl();
    setSharedManagerOpen(true);
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }, [
    handleLoadSharedHistoryStatus,
    refreshSharedHistoryItems,
    refreshSharedManagerGatewayUrl,
    remoteSettings.gatewayUrl,
  ]);

  const handleDisableSharedHistory = useCallback(
    (conversation: ChatHistorySummary) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }
      setSharedManagerError(id, null);
      updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
      void setChatHistoryShare(id, false)
        .then((status) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, conversation);
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "关闭分享失败"));
        })
        .finally(() => {
          updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
        });
    },
    [markSharedConversation, setSharedManagerError, updateSharedManagerIdSet],
  );

  const handleSetSharedHistoryRedactToolContent = useCallback(
    (conversation: ChatHistorySummary, redactToolContent: boolean) => {
      const id = conversation.id.trim();
      if (!id) {
        return;
      }

      setSharedManagerError(id, null);
      updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
      void setChatHistoryShare(id, true, { redactToolContent })
        .then((status) => {
          setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
          markSharedConversation(id, status.enabled === true, conversation);
          if (shareConversation?.id === id) {
            setShareStatus(status);
          }
        })
        .catch((error) => {
          setSharedManagerError(id, asErrorMessage(error, "更新分享脱敏设置失败"));
        })
        .finally(() => {
          updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
        });
    },
    [
      markSharedConversation,
      setSharedManagerError,
      shareConversation?.id,
      updateSharedManagerIdSet,
    ],
  );

  return {
    canShareHistory,
    shareConversation,
    shareStatus,
    shareLoading,
    shareUpdating,
    shareError,
    sharedManagerOpen,
    setSharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerLoadingIds,
    sharedManagerUpdatingIds,
    sharedManagerErrors,
    sharedManagerGatewayUrlLoading,
    sharedManagerShareOrigin,
    sharedHistoryItems,
    removeSharedHistoryItems,
    markSharedConversation,
    handleLoadSharedHistoryStatus,
    handleOpenShareModal,
    handleCloseShareModal,
    handleToggleHistoryShare,
    handleSetShareRedactToolContent,
    handleRefreshSharedHistoryStatuses,
    handleOpenSharedHistoryManager,
    handleDisableSharedHistory,
    handleSetSharedHistoryRedactToolContent,
  };
}
