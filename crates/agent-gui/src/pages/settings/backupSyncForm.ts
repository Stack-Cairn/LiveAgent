// WebDAV 同步设置的纯逻辑：表单态推导与同步状态事件归约。
//
// 与 `BackupSyncSection.tsx` 分开，是为了让这些判断能脱离 React 直接被测到 ——
// 它们决定「按钮能不能点」「错误横幅要不要挂着」，都是出了错用户才会发现的地方。

import type { BackupSyncConfigView, BackupSyncStatusEvent } from "../../lib/backup";

/** 表单态。密码单独用 `passwordTouched` 标记，避免把占位符当真密码提交。 */
export type SyncForm = {
  url: string;
  username: string;
  password: string;
  passwordTouched: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
};

export type PresetId = "jianguoyun" | "nextcloud" | "synology" | "custom";

/** 预设仅填充 URL 模板，其余字段仍需用户自填。 */
export const SYNC_PRESETS: { id: Exclude<PresetId, "custom">; url: string }[] = [
  { id: "jianguoyun", url: "https://dav.jianguoyun.com/dav/" },
  { id: "nextcloud", url: "https://server/remote.php/dav/files/USER/" },
  { id: "synology", url: "http://nas-ip:5005/" },
];

/**
 * 由已保存的 URL 反推预设，让重新进入设置页时下拉框不会永远停在「自定义」。
 *
 * 坚果云按 host 判断（而非 `includes`），否则 `dav.jianguoyun.com.evil.test`
 * 也会被认成坚果云。
 */
export function detectPreset(url: string): PresetId {
  const trimmed = url.trim();
  if (!trimmed) return "custom";
  let host = "";
  let port = "";
  try {
    const parsed = new URL(trimmed);
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
  } catch {
    return "custom";
  }
  if (host === "dav.jianguoyun.com") return "jianguoyun";
  if (/\/remote\.php\/dav\//i.test(trimmed)) return "nextcloud";
  if (port === "5005" || port === "5006") return "synology";
  return "custom";
}

export function emptyForm(): SyncForm {
  return {
    url: "",
    username: "",
    password: "",
    passwordTouched: false,
    remoteDir: "",
    profile: "",
    autoSync: false,
  };
}

export function formFromView(view: BackupSyncConfigView): SyncForm {
  return {
    url: view.url,
    username: view.username,
    // 后端从不回传密码，表单里始终以空串起步，靠 placeholder 告知「已保存」。
    password: "",
    passwordTouched: false,
    remoteDir: view.remoteDir,
    profile: view.profile,
    autoSync: view.autoSync,
  };
}

/** 表单是否有未保存改动。上传/下载走的是库里的配置，脏表单必须先保存。 */
export function isDirty(form: SyncForm, view: BackupSyncConfigView | null): boolean {
  if (!view) return true;
  return (
    form.passwordTouched ||
    form.url !== view.url ||
    form.username !== view.username ||
    form.remoteDir !== view.remoteDir ||
    form.profile !== view.profile ||
    form.autoSync !== view.autoSync
  );
}

/**
 * 凭据是否齐到可以发起一次连接测试。
 *
 * 保存后会自动测一次连接，但用户完全可能只填了地址就先存一版。那种情况下
 * 测试必然以「请先填写用户名」失败，把一次正常的保存渲染成红色错误。
 */
export function canTestSyncConnection(view: BackupSyncConfigView): boolean {
  return Boolean(view.url && view.username && view.hasPassword);
}

/** 事件是否代表一次成功的后台自动同步。 */
export function isAutoSyncSuccess(payload: BackupSyncStatusEvent): boolean {
  return !payload.lastError && payload.lastSyncAt !== null;
}

/**
 * 把后台自动同步的结果事件并入视图。
 *
 * 后端已经把结果落了库，这里同步更新内存视图只是为了让常驻横幅立刻反映最新
 * 状态 —— 否则要等下次重新进入设置页才看得到。无事可做时原样返回 `prev`，
 * 让 React 跳过这次重渲染。
 */
export function applySyncStatusEvent(
  prev: BackupSyncConfigView | null,
  payload: BackupSyncStatusEvent,
): BackupSyncConfigView | null {
  if (!prev) return prev;
  if (payload.lastError) return { ...prev, lastError: payload.lastError };
  if (payload.lastSyncAt !== null) {
    // 成功即清错误：这条链路现在是通的，旧横幅已经过期。
    return { ...prev, lastSyncAt: payload.lastSyncAt, lastError: null };
  }
  return prev;
}
