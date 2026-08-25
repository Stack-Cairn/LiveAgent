/**
 * CUA Driver 安装器共享 TS 类型。Agent-UI 跨 desktop / web 共用。
 *
 * 后端字段命名约定：Rust 侧全部用 camelCase，serde 自动 rename；前端拿到
 * 的是扁平结构。`stage` 是稳定字符串 literal，前端按 i18n key 翻译。
 */

export type InstallerStage =
  | "starting"
  | "downloading"
  | "installing"
  | "startingDaemon"
  | "completed"
  | "failed"
  | "cancelled";

export type InstallerProgressEvent = {
  stage: InstallerStage;
  message: string;
  logTail?: string;
  percent?: number;
};

export type CuaDriverDetection = {
  installed: boolean;
  version?: string;
  path?: string;
  platform: string;
  appBundleInstalled?: boolean;
  daemonRunning: boolean;
  doctorOutput?: string;
  error?: string;
};

export type CuaInstallResult = {
  success: boolean;
  log: string;
  installedVersion?: string;
  daemonStarted: boolean;
  error?: string;
};

export type CuaUpdateResult = {
  updateAvailable: boolean;
  log: string;
  newVersion?: string;
  error?: string;
};

export type InstallCommand = {
  program: string;
  args: string[];
  description: string;
  needsSudo: boolean;
};

export type InstallPreview = {
  platform: string;
  command: InstallCommand;
  linuxAptAvailable?: boolean;
  linuxMissingPackages?: string[];
};

/**
 * Tauri 端 `cua_install_progress` 事件名。
 * 桌面端通过 `@tauri-apps/api/event` 的 `listen` 订阅。
 */
export const CUA_INSTALL_PROGRESS_EVENT = "cua_install_progress";

/**
 * CUA Driver 安装器服务——由 host（桌面端）注入。
 * 与 `CuaService` 合并使用；WebUI 不会提供。
 */
export type CuaInstallerService = {
  detectDriver: () => Promise<CuaDriverDetection | null>;
  installDriver: () => Promise<CuaInstallResult | null>;
  updateDriver: (apply: boolean) => Promise<CuaUpdateResult | null>;
  startDriverDaemon: () => Promise<boolean>;
  getInstallPreview: () => Promise<InstallPreview | null>;
  /**
   * 订阅后端 `cua_install_progress` 事件。可选；只有桌面端实现会提供。
   * 返回 unlisten 句柄，用于在 React 卸载时清理。
   */
  subscribeProgress?: (handler: (event: InstallerProgressEvent) => void) => Promise<() => void>;
};
