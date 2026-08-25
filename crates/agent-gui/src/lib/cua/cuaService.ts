import { invoke } from "@tauri-apps/api/core";
import type { CuaService, CuaSettings, CuaStatus } from "@liveagent/ui/pages/settings/CuaSection";

/**
 * 桌面端到 Rust `cua_*` Tauri Command 的桥。设置面板与 Settings 扩展
 * 都会经这里读 / 写后端 CuaStore；前端 localStorage 是镜像（详见
 * `lib/settings/storage.ts` 的 CUA 持久化段落）。
 *
 * 重要：调用方拿到的是 `CuaService`（不耦合 Tauri 细节），settings 面板
 * / 任何后续 CLI 入口都能复用同一接口做自检。
 */
export const desktopCuaService: CuaService = {
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
};
