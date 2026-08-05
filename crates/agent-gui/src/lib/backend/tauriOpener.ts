/**
 * `@tauri-apps/plugin-opener` 的替身（vite alias + tsconfig paths，同
 * tauriCore.ts 的手法）。
 *
 * 壳里转发给真插件；浏览器里按能力降级：
 *   - openUrl → window.open（阶段 5「外链走 window.open」）
 *   - revealItemInDir → 拒绝。它揭示的是后端机器上的路径，浏览器没有对应物，
 *     调用点由 hasSystemFileOpener() 门控，正常不会走到这里。
 */

import { getNativeInternals } from "./endpoint";

export async function openUrl(url: string, openWith?: string): Promise<void> {
  const internals = getNativeInternals();
  if (internals) {
    await internals.invoke("plugin:opener|open_url", { url, with: openWith });
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

export async function openPath(path: string, openWith?: string): Promise<void> {
  const internals = getNativeInternals();
  if (!internals) throw new Error("浏览器里无法用系统程序打开本机路径");
  await internals.invoke("plugin:opener|open_path", { path, with: openWith });
}

export async function revealItemInDir(path: string): Promise<void> {
  const internals = getNativeInternals();
  if (!internals) throw new Error("浏览器里无法在文件管理器中显示后端路径");
  await internals.invoke("plugin:opener|reveal_item_in_dir", { path });
}
