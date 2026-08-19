import { invoke } from "@tauri-apps/api/core";
import type { SkillsSettings } from "../settings";

/**
 * 配置备份的 IPC 封装。
 *
 * 后端只能看到 SQLite 里的 providers / mcp / system 三域；skills 启用态存在
 * webview localStorage（见 `lib/settings/storage.ts`），因此导出时由前端拼进
 * payload，导入时由后端回传给前端写回。
 */

/** 各域条目数，仅用于确认对话框展示摘要。 */
export type BackupDomainCounts = {
  providers: number;
  mcp: number;
  system: number;
  skills: number;
};

export type BackupManifest = {
  protocolVersion: number;
  schemaVersion: number;
  snapshotId: string;
  /** RFC3339 UTC。 */
  createdAt: string;
  deviceName: string;
  appVersion: string;
  /** 首版恒为 "none"，为后续端到端加密预留。 */
  encryption: string;
  domains: BackupDomainCounts;
};

export type BackupImportPreview = {
  path: string;
  manifest: BackupManifest;
};

export type BackupApplyOutcome = {
  applied: BackupDomainCounts;
  /** 需由调用方写回 localStorage —— 后端无法操作 webview 存储。 */
  skills: SkillsSettings | null;
  /** 应用前生成的本地备份文件路径。 */
  backupPath: string | null;
};

/**
 * 导出配置到用户选择的文件。返回落盘路径；用户取消返回 null。
 *
 * 后端错误信息已是可直接展示的中文文案，故不额外包一层错误类型。
 */
export async function exportBackup(skills: SkillsSettings): Promise<string | null> {
  return await invoke<string | null>("settings_backup_export", { skills });
}

/** 选择并解析备份文件，仅校验不写库。用户取消返回 null。 */
export async function peekBackupImport(): Promise<BackupImportPreview | null> {
  return await invoke<BackupImportPreview | null>("settings_backup_peek_import", { path: null });
}

/** 应用备份。写库前后端会自动备份当前配置。 */
export async function applyBackupImport(path: string): Promise<BackupApplyOutcome> {
  return await invoke<BackupApplyOutcome>("settings_backup_apply_import", { path });
}

// ===== WebDAV 同步 =====

/** 后端回传的同步配置视图：**不含密码**，只告知是否已设置。 */
export type BackupSyncConfigView = {
  url: string;
  username: string;
  hasPassword: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
  /** 毫秒时间戳。 */
  lastSyncAt: number | null;
  /**
   * 最近一次**自动**同步的失败原因，已落库。
   *
   * 手动同步的错误不写这里 —— 那种失败当场就反馈给了正在操作的用户。
   * 自动同步发生在后台，用户多半不在设置页，所以必须持久化，
   * 否则页面一卸载错误就没了，配置早已停止同步而用户毫不知情。
   */
  lastError: string | null;
};

/**
 * 保存请求。
 *
 * `passwordTouched` 为 false 时后端沿用库里的旧密码 —— UI 用掩码占位符填充
 * 密码框，若原样提交会把占位符写成真密码。
 */
export type BackupSyncConfigRequest = {
  url: string;
  username: string;
  password: string;
  passwordTouched: boolean;
  remoteDir: string;
  profile: string;
  autoSync: boolean;
};

export type BackupRemoteInfo = {
  manifest: BackupManifest;
  size: number;
  sha256: string;
};

export async function loadSyncConfig(): Promise<BackupSyncConfigView> {
  return await invoke<BackupSyncConfigView>("settings_backup_load_sync_config");
}

export async function saveSyncConfig(
  config: BackupSyncConfigRequest,
): Promise<BackupSyncConfigView> {
  return await invoke<BackupSyncConfigView>("settings_backup_save_sync_config", { config });
}

/** 测试连接。用库中已保存的配置，因此需先保存再测试。 */
export async function testSyncConnection(): Promise<void> {
  await invoke("settings_backup_test_sync_connection");
}

/** 拉取远端摘要。远端还没有备份时返回 null。 */
export async function fetchRemoteInfo(): Promise<BackupRemoteInfo | null> {
  return await invoke<BackupRemoteInfo | null>("settings_backup_fetch_remote_info");
}

/** 上传当前配置。返回本次同步的毫秒时间戳。 */
export async function uploadBackup(skills: SkillsSettings): Promise<number> {
  return await invoke<number>("settings_backup_upload", { skills });
}

/** 下载并应用远端配置。 */
export async function downloadBackup(): Promise<BackupApplyOutcome> {
  return await invoke<BackupApplyOutcome>("settings_backup_download");
}

/**
 * 通知后端「配置已变更」，触发自动同步的防抖上传。
 *
 * providers / mcp / system 三域后端自己就能感知；skills 存在 localStorage，
 * 后端读不到，所以每次都把最新的 skills 一并送过去缓存起来，供后台上传使用。
 *
 * 自动同步是尽力而为的后台行为：失败绝不能冒泡成「保存失败」，
 * 因此调用方一律 fire-and-forget。
 */
export function markBackupDirty(skills: SkillsSettings): void {
  void invoke("settings_backup_mark_dirty", { skills }).catch(() => {
    // 忽略：自动同步的失败通过 backup-sync-status-updated 事件呈现。
  });
}

/** 后台自动同步的结果事件载荷。手动同步的成败由命令返回值直接告知，不走此事件。 */
export type BackupSyncStatusEvent = {
  lastSyncAt: number | null;
  lastError: string | null;
};

export const BACKUP_SYNC_STATUS_EVENT = "backup-sync-status-updated";
