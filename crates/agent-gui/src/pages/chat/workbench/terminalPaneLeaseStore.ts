export type TerminalPaneLeaseListener = () => void;

/**
 * 终端视图租约(View Lease)层:一个终端 sessionId 在画板中至多被一个 pane 持有。
 * Pane 持有租约期间,Right Dock 等其他宿主不得再挂载该会话的 XTermViewport,
 * 否则输出流会被双消费、输入会被双写。租约纯内存,不持久化。
 */
export type TerminalPaneLeaseStore = {
  /**
   * 获取租约并返回 release 函数。sessionId 已被其他 pane 持有时抛错
   * (调用方必须先用 paneIdFor 查询);同一 pane 对同一 session 重复
   * acquire 幂等返回既有 release。release 幂等,且不会误释放后建租约。
   */
  acquire(sessionId: string, paneId: string): () => void;
  paneIdFor(sessionId: string): string | null;
  sessionIdFor(paneId: string): string | null;
  /** 当前被 pane 持有的全部 sessionId;引用在租约不变时保持稳定(useSyncExternalStore 快照)。 */
  leasedSessionIds(): readonly string[];
  subscribe(listener: TerminalPaneLeaseListener): () => void;
};

type LeaseRecord = {
  sessionId: string;
  paneId: string;
  release: () => void;
};

export function createTerminalPaneLeaseStore(): TerminalPaneLeaseStore {
  const leasesBySessionId = new Map<string, LeaseRecord>();
  const leasesByPaneId = new Map<string, LeaseRecord>();
  const listeners = new Set<TerminalPaneLeaseListener>();
  let leasedSessionIdsSnapshot: readonly string[] = [];

  const emit = () => {
    leasedSessionIdsSnapshot = Array.from(leasesBySessionId.keys());
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  const drop = (record: LeaseRecord) => {
    // 只清除仍指向该 record 的索引,防止陈旧 release 误删后建租约。
    if (leasesBySessionId.get(record.sessionId) === record) {
      leasesBySessionId.delete(record.sessionId);
    }
    if (leasesByPaneId.get(record.paneId) === record) {
      leasesByPaneId.delete(record.paneId);
    }
  };

  return {
    acquire(sessionId, paneId) {
      const sessionKey = sessionId.trim();
      const paneKey = paneId.trim();
      if (!sessionKey || !paneKey) {
        throw new Error("Terminal pane lease requires a sessionId and a paneId.");
      }
      const existing = leasesBySessionId.get(sessionKey);
      if (existing) {
        if (existing.paneId !== paneKey) {
          throw new Error(
            `Terminal session '${sessionKey}' is already leased by pane '${existing.paneId}'.`,
          );
        }
        return existing.release;
      }
      // 同一 pane 换绑新会话(重建终端)时,先释放它持有的旧租约,
      // 维持 “一个 pane 至多一个终端视图” 的双向不变量。
      const previous = leasesByPaneId.get(paneKey);
      if (previous) {
        drop(previous);
      }
      let released = false;
      const record: LeaseRecord = {
        sessionId: sessionKey,
        paneId: paneKey,
        release: () => {
          if (released) return;
          released = true;
          drop(record);
          emit();
        },
      };
      leasesBySessionId.set(sessionKey, record);
      leasesByPaneId.set(paneKey, record);
      emit();
      return record.release;
    },
    paneIdFor(sessionId) {
      const key = sessionId.trim();
      if (!key) return null;
      return leasesBySessionId.get(key)?.paneId ?? null;
    },
    sessionIdFor(paneId) {
      const key = paneId.trim();
      if (!key) return null;
      return leasesByPaneId.get(key)?.sessionId ?? null;
    },
    leasedSessionIds() {
      return leasedSessionIdsSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
