export type TerminalPaneBindingListener = () => void;

export type TerminalPaneBindingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type TerminalPaneBindingStoreOptions = {
  storage?: TerminalPaneBindingStorage;
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
  const storage = options?.storage ?? resolveDefaultStorage();
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
      return bindings.get(key) ?? null;
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
