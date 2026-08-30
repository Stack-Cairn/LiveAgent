export type TerminalPaneBindingListener = () => void;

export type TerminalPaneBindingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type TerminalPaneBindingStoreOptions = {
  /** 显式传 null 时使用纯内存绑定；省略时使用 sessionStorage。 */
  storage?: TerminalPaneBindingStorage | null;
  storageKey?: string;
};

/**
 * 终端运行时绑定(Runtime Binding)层:surfaceId → sessionId。
 * 布局 JSON 只持久化 launchSpec + surfaceId,sessionId 存 sessionStorage:
 * webview reload 后 Rust 终端注册表仍活着,绑定可对账恢复;应用重启后
 * sessionStorage 清空,恰好对应终端会话已死。无 window / 存储异常时降级为纯内存。
 */
export type TerminalPaneBindingStore = {
  get(surfaceId: string): string | null;
  set(surfaceId: string, sessionId: string): void;
  delete(surfaceId: string): void;
  /** 当前全部已绑定 surfaceId;引用在绑定不变时保持稳定(恢复对账/快照订阅用)。 */
  surfaceIds(): readonly string[];
  /** 对账:只保留 sessionId 仍在 liveSessionIds 中的绑定,返回被清除的 surfaceId 列表。 */
  reconcile(liveSessionIds: ReadonlySet<string>): string[];
  subscribe(listener: TerminalPaneBindingListener): () => void;
};

export const TERMINAL_PANE_BINDING_STORAGE_KEY = "liveagent.terminalPaneBindings.v1";

function resolveDefaultStorage(): TerminalPaneBindingStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readPersistedBindings(
  storage: TerminalPaneBindingStorage | null,
  storageKey: string,
): Map<string, string> {
  const bindings = new Map<string, string>();
  if (!storage) return bindings;
  let raw: string | null = null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return bindings;
  }
  if (!raw) return bindings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 坏 JSON:忽略并从空状态重建,下次写入覆盖脏数据。
    return bindings;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return bindings;
  }
  for (const [surfaceId, sessionId] of Object.entries(parsed)) {
    const surfaceKey = surfaceId.trim();
    if (!surfaceKey || typeof sessionId !== "string" || !sessionId.trim()) continue;
    bindings.set(surfaceKey, sessionId.trim());
  }
  return bindings;
}

export function createTerminalPaneBindingStore(
  options?: TerminalPaneBindingStoreOptions,
): TerminalPaneBindingStore {
  const storageKey = options?.storageKey?.trim() || TERMINAL_PANE_BINDING_STORAGE_KEY;
  const storage =
    options && "storage" in options ? (options.storage ?? null) : resolveDefaultStorage();
  const bindings = readPersistedBindings(storage, storageKey);
  const listeners = new Set<TerminalPaneBindingListener>();
  let surfaceIdsSnapshot: readonly string[] = Array.from(bindings.keys());

  const emit = () => {
    surfaceIdsSnapshot = Array.from(bindings.keys());
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  const persist = () => {
    if (!storage) return;
    try {
      if (bindings.size === 0) {
        storage.removeItem(storageKey);
      } else {
        storage.setItem(storageKey, JSON.stringify(Object.fromEntries(bindings)));
      }
    } catch {
      // 存储写失败(配额/隐私模式)只降级为内存态,不影响调用方。
    }
  };

  return {
    get(surfaceId) {
      const key = surfaceId.trim();
      if (!key) return null;
      const hit = bindings.get(key);
      if (hit) return hit;
      // 内存 miss 时从 storage 兜底采纳:dev HMR 可能让写入方与读取方持有
      // 不同的模块实例,storage 是它们唯一的共享层。少了这一步,拖入既有
      // 会话的 Pane 会误判"无绑定"而按 launchSpec 新建一个 PTY——表现为
      // 拖入后要等 shell 冷启动(数秒),且原会话原样留在 dock。
      // 静默采纳、不通知监听者:get 被 useSyncExternalStore 当 getSnapshot
      // 在渲染期调用,首次读取即返回正确值,渲染期不得触发其他组件更新。
      const persisted = readPersistedBindings(storage, storageKey).get(key);
      if (persisted) {
        bindings.set(key, persisted);
        surfaceIdsSnapshot = Array.from(bindings.keys());
        return persisted;
      }
      return null;
    },
    set(surfaceId, sessionId) {
      const surfaceKey = surfaceId.trim();
      const sessionKey = sessionId.trim();
      if (!surfaceKey || !sessionKey) return;
      if (bindings.get(surfaceKey) === sessionKey) return;
      bindings.set(surfaceKey, sessionKey);
      persist();
      emit();
    },
    delete(surfaceId) {
      const key = surfaceId.trim();
      if (!key) return;
      if (!bindings.delete(key)) return;
      persist();
      emit();
    },
    surfaceIds() {
      return surfaceIdsSnapshot;
    },
    reconcile(liveSessionIds) {
      const removed: string[] = [];
      for (const [surfaceId, sessionId] of bindings) {
        if (!liveSessionIds.has(sessionId)) {
          bindings.delete(surfaceId);
          removed.push(surfaceId);
        }
      }
      if (removed.length > 0) {
        persist();
        emit();
      }
      return removed;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
