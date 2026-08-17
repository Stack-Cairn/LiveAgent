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
