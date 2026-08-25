import type {
  CuaDriverDetection,
  CuaInstallResult,
  CuaUpdateResult,
  InstallerProgressEvent,
  InstallPreview,
} from "@liveagent/ui/pages/settings/CuaInstaller";
import type { CuaService, CuaSettings, CuaStatus } from "@liveagent/ui/pages/settings/CuaSection";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 桌面端到 Rust `cua_*` Tauri Command 的桥。设置面板与 Settings 扩展
 * 都会经这里读 / 写后端 CuaStore；前端 localStorage 是镜像（详见
 * `lib/settings/storage.ts` 的 CUA 持久化段落）。
 *
 * 重要：调用方拿到的是 `CuaService`（不耦合 Tauri 细节），settings 面板
 * / 任何后续 CLI 入口都能复用同一接口做自检。
 */
export const desktopCuaService: CuaService & CuaInstallerService = {
  platformLabel: "macos",
  async fetchStatus(): Promise<CuaStatus | null> {
    try {
      return await invoke<CuaStatus>("cua_status");
    } catch (err) {
      console.warn("[cua] fetchStatus failed", err);
      return null;
    }
  },
  async setConfig(config: CuaSettings): Promise<CuaStatus | null> {
    try {
      return await invoke<CuaStatus>("cua_set_config", { config });
    } catch (err) {
      console.warn("[cua] setConfig failed", err);
      return null;
    }
  },
  async clearAudit(): Promise<CuaStatus | null> {
    try {
      return await invoke<CuaStatus>("cua_clear_audit");
    } catch (err) {
      console.warn("[cua] clearAudit failed", err);
      return null;
    }
  },
  async detectDriver(): Promise<CuaDriverDetection | null> {
    try {
      return await invoke<CuaDriverDetection>("cua_driver_detect");
    } catch (err) {
      console.warn("[cua] detectDriver failed", err);
      return null;
    }
  },
  async installDriver(): Promise<CuaInstallResult | null> {
    try {
      return await invoke<CuaInstallResult>("cua_driver_install");
    } catch (err) {
      console.warn("[cua] installDriver failed", err);
      return null;
    }
  },
  async updateDriver(apply: boolean): Promise<CuaUpdateResult | null> {
    try {
      return await invoke<CuaUpdateResult>("cua_driver_update", { apply });
    } catch (err) {
      console.warn("[cua] updateDriver failed", err);
      return null;
    }
  },
  async startDriverDaemon(): Promise<boolean> {
    try {
      const result = await invoke<{ ok: boolean; error?: unknown }>("cua_driver_start_daemon");
      return result.ok;
    } catch (err) {
      console.warn("[cua] startDriverDaemon failed", err);
      return false;
    }
  },
  async getInstallPreview(): Promise<InstallPreview | null> {
    try {
      return await invoke<InstallPreview>("cua_driver_install_preview");
    } catch (err) {
      console.warn("[cua] getInstallPreview failed", err);
      return null;
    }
  },
  async subscribeProgress(handler: (event: InstallerProgressEvent) => void): Promise<() => void> {
    // Tauri 2 的 listen 返回 unlisten 句柄；直接透传给调用方。
    const unlisten = await listen<InstallerProgressEvent>("cua_install_progress", (event) =>
      handler(event.payload),
    );
    return unlisten;
  },
};

export type CuaInstallerService = {
  detectDriver: () => Promise<CuaDriverDetection | null>;
  installDriver: () => Promise<CuaInstallResult | null>;
  updateDriver: (apply: boolean) => Promise<CuaUpdateResult | null>;
  startDriverDaemon: () => Promise<boolean>;
  getInstallPreview: () => Promise<InstallPreview | null>;
  subscribeProgress: (handler: (event: InstallerProgressEvent) => void) => Promise<() => void>;
};
