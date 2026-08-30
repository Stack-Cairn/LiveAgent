// @ 提及应用的「最近使用」前端持久化：单个版本化 localStorage 键（与
// lib/chat-floor-nav/floorBookmarks.ts 的 JSON blob 惯例一致），结构
// { version, keys: string[] }，keys 按最近使用在前排列。身份键直接复用
// appMentionIcons 的 identityKeys 裁决（bundle id > path > name），不另
// 维护一份优先级。localStorage 不可用时静默降级为仅本次运行有效。

import { type AppMentionIconIdentity, identityKeys } from "./appMentionIcons";

const STORAGE_KEY = "liveagent.app-mention-recents.v1";
const STORAGE_VERSION = 1;
// 存的比弹层展示的多：已卸载/被门控滤掉的应用不该把榜单掏空。
const MAX_RECENT_KEYS = 20;

export type AppMentionRecencyIdentity = AppMentionIconIdentity;

/** 应用的最近使用榜单键——取身份键裁决里最稳定的一个作规范键。 */
export function appMentionRecencyKey(identity: AppMentionRecencyIdentity): string {
  return identityKeys(identity)[0] ?? "";
}

/**
 * 按最近使用排序：上榜的按榜单先后排在最前，未上榜的保持入参原序
 * （宿主给的字母序；Array.prototype.sort 是稳定排序）。
 */
export function sortAppsByMentionRecency<T extends AppMentionRecencyIdentity>(
  apps: readonly T[],
  recentKeys: readonly string[],
): T[] {
  const rank = new Map(recentKeys.map((key, index) => [key, index]));
  const rankOf = (app: T) => rank.get(appMentionRecencyKey(app)) ?? Number.MAX_SAFE_INTEGER;
  return [...apps].sort((a, b) => rankOf(a) - rankOf(b));
}

let cache: string[] | null = null;

function readStoredKeys(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== STORAGE_VERSION
    ) {
      return [];
    }
    const keys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return [];
    return keys.filter((key): key is string => typeof key === "string" && key.length > 0);
  } catch {
    return [];
  }
}

function persist(keys: string[]) {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, keys }),
    );
  } catch {
    // 存储不可用（隐私模式/配额）：榜单仅在本次运行内生效。
  }
}

/** 最近使用的应用身份键，最近在前。 */
export function readAppMentionRecents(): readonly string[] {
  if (cache === null) cache = readStoredKeys();
  return cache;
}

/** 记录一次 @ 应用的使用：身份键提到榜首并落盘。 */
export function recordAppMentionUse(identity: AppMentionRecencyIdentity): void {
  const key = appMentionRecencyKey(identity);
  if (!key) return;
  const next = [key, ...readAppMentionRecents().filter((existing) => existing !== key)].slice(
    0,
    MAX_RECENT_KEYS,
  );
  cache = next;
  persist(next);
}

/** 仅供测试：清空内存缓存，强制下次访问重读 localStorage。 */
export function resetAppMentionRecentsCacheForTest(): void {
  cache = null;
}
