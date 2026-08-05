/**
 * 托盘本机偏好（桌面 GUI 专属，不进 settings 同步/网关）：
 * - showConversationTitles：托盘是否显示会话标题（投屏隐私；关闭后显示「对话 N」）
 * - showRunningBadge：macOS 状态栏是否显示运行中数量文字徽标
 *
 * 存 localStorage；与全局快捷键绑定（`lib/shortcuts/globalShortcuts.ts`）
 * 同属「设备偏好」类别。带订阅以便托盘同步 effect 在设置页改动后即时重推。
 */

import { useSyncExternalStore } from "react";

export type TrayPrefs = {
  showConversationTitles: boolean;
  showRunningBadge: boolean;
};

const STORAGE_KEY = "liveagent.trayPrefs.v1";

export const DEFAULT_TRAY_PREFS: TrayPrefs = {
  showConversationTitles: true,
  showRunningBadge: false,
};

const listeners = new Set<() => void>();
let cached: TrayPrefs | null = null;

function normalizeTrayPrefs(input: unknown): TrayPrefs {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    showConversationTitles: obj.showConversationTitles !== false,
    showRunningBadge: obj.showRunningBadge === true,
  };
}

export function readTrayPrefs(): TrayPrefs {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cached = raw ? normalizeTrayPrefs(JSON.parse(raw)) : DEFAULT_TRAY_PREFS;
  } catch {
    cached = DEFAULT_TRAY_PREFS;
  }
  return cached;
}

export function writeTrayPrefs(patch: Partial<TrayPrefs>): TrayPrefs {
  const next = { ...readTrayPrefs(), ...patch };
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存储不可用时仅内存生效。
  }
  for (const listener of listeners) {
    listener();
  }
  return next;
}

export function subscribeTrayPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTrayPrefs(): TrayPrefs {
  return useSyncExternalStore(subscribeTrayPrefs, readTrayPrefs, readTrayPrefs);
}
