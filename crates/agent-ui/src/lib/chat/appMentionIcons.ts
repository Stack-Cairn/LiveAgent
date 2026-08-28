/**
 * 应用提及图标注册表——弹层/chip/用户气泡共用的进程级真源。
 *
 * 图标是几 KB 的 PNG data URL，写进 chip DOM 属性或剪贴板 JSON 会把
 * 复制载荷与草稿序列化撑爆，所以序列化只携带应用身份
 * （name/bundleId/path），展示层在渲染时按身份来这里查图。宿主
 * （GUI 的 useMentionApps）拉到应用列表后登记一次；WebUI 从不登记，
 * 一切查询落空并回退占位图标——这正是"应用清单不出桌面宿主"的边界。
 *
 * 用 useSyncExternalStore 订阅：登记发生在异步枚举完成时，先挂载的
 * 气泡 chip 靠订阅在图标就绪后补上真实 logo，而不是永远停在占位。
 */

import { useSyncExternalStore } from "react";

export type AppMentionIconIdentity = {
  name?: string;
  bundleId?: string;
  path?: string;
};

type AppMentionIconSource = AppMentionIconIdentity & { iconDataUrl?: string };

const iconsByKey = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function identityKeys(identity: AppMentionIconIdentity): string[] {
  const keys: string[] = [];
  const bundleId = identity.bundleId?.trim().toLowerCase();
  const path = identity.path?.trim();
  const name = identity.name?.trim().toLowerCase();
  if (bundleId) keys.push(`bundle:${bundleId}`);
  if (path) keys.push(`path:${path}`);
  if (name) keys.push(`name:${name}`);
  return keys;
}

/** 登记一批应用图标。非 data:image/ 前缀的一律丢弃——注册表喂给 <img src>。 */
export function registerAppMentionIcons(apps: readonly AppMentionIconSource[]) {
  let changed = false;
  for (const app of apps) {
    const iconDataUrl = app.iconDataUrl;
    if (!iconDataUrl?.startsWith("data:image/")) continue;
    for (const key of identityKeys(app)) {
      if (iconsByKey.get(key) === iconDataUrl) continue;
      iconsByKey.set(key, iconDataUrl);
      changed = true;
    }
  }
  if (!changed) return;
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** 按身份查图标：bundle id 最稳定优先，其次安装路径，最后显示名。 */
export function getAppMentionIconDataUrl(identity: AppMentionIconIdentity): string | undefined {
  for (const key of identityKeys(identity)) {
    const icon = iconsByKey.get(key);
    if (icon) return icon;
  }
  return undefined;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion() {
  return version;
}

/** React 侧订阅：登记到达时已挂载的 chip 重查一次图标。 */
export function useAppMentionIcon(identity: AppMentionIconIdentity): string | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getAppMentionIconDataUrl(identity);
}
