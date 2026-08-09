// 楼层收藏的前端持久化：单个版本化 localStorage 键（与 lib/settings/storage.ts
// 的 JSON blob 惯例一致），结构 { version, conversations: { [conversationId]:
// messageId[] } }。收藏按稳定消息 id（`user-${uuid}`，随会话存 SQLite）记录，
// 因此重启后仍能对上。localStorage 不可用时收藏静默降级为仅本次运行有效。

const STORAGE_KEY = "liveagent.floor-bookmarks.v1";
/** 防止无限增长：仅保留最近写入的这么多个会话的收藏。 */
const MAX_CONVERSATIONS = 200;

const EMPTY_BOOKMARKS: ReadonlySet<string> = new Set();

let cache: Map<string, ReadonlySet<string>> | null = null;
const listeners = new Set<() => void>();

function readStoredConversations(): Record<string, string[]> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const conversations = (parsed as { conversations?: unknown }).conversations;
    if (!conversations || typeof conversations !== "object") return {};
    const result: Record<string, string[]> = {};
    for (const [conversationId, ids] of Object.entries(conversations as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (clean.length > 0) result[conversationId] = clean;
    }
    return result;
  } catch {
    return {};
  }
}

function ensureCache(): Map<string, ReadonlySet<string>> {
  if (!cache) {
    cache = new Map(
      Object.entries(readStoredConversations()).map(([conversationId, ids]) => [
        conversationId,
        new Set(ids) as ReadonlySet<string>,
      ]),
    );
  }
  return cache;
}

function persist(map: Map<string, ReadonlySet<string>>) {
  // 容量裁剪直接作用在内存 Map 上（Map 迭代序 = 插入序，头部最旧），
  // 再整体落盘——内存与 localStorage 永远一致，不会出现「本次运行还能看到
  // 已被淘汰会话的收藏、重启后凭空消失」的分叉。
  while (map.size > MAX_CONVERSATIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  try {
    const payload = {
      version: 1,
      conversations: Object.fromEntries([...map.entries()].map(([id, ids]) => [id, [...ids]])),
    };
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 存储不可用（隐私模式/配额）：收藏仅在本次运行内生效。
  }
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** 返回某会话的收藏集合；未变更时引用稳定，可直接用于 useSyncExternalStore。 */
export function getFloorBookmarks(conversationId: string): ReadonlySet<string> {
  return ensureCache().get(conversationId) ?? EMPTY_BOOKMARKS;
}

export function toggleFloorBookmark(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) return;
  const map = ensureCache();
  const next = new Set(map.get(conversationId) ?? []);
  if (next.has(messageId)) {
    next.delete(messageId);
  } else {
    next.add(messageId);
  }
  if (next.size === 0) {
    map.delete(conversationId);
  } else {
    // 重新插入让该会话回到 Map 尾部（persist 的容量裁剪保最近使用）。
    map.delete(conversationId);
    map.set(conversationId, next);
  }
  persist(map);
  emit();
}

export function subscribeFloorBookmarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅供测试：清空内存缓存，强制下次访问重读 localStorage。 */
export function resetFloorBookmarksCacheForTest(): void {
  cache = null;
}
