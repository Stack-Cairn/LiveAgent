/**
 * `@tauri-apps/api/core` 的替身。
 *
 * vite.config.ts 的 resolve.alias + tsconfig.json 的 paths 把这个模块顶替到
 * `@tauri-apps/api/core` 上，于是 57 个 `import { invoke } from
 * "@tauri-apps/api/core"` 的文件一行不改就换了传输：后端命令走 loopback/远程
 * HTTP，壳专属命令走原生 IPC。
 *
 * 为什么是模块替身而不是在运行时包一层 `window.__TAURI_INTERNALS__.invoke`：
 * Tauri v2 的注入脚本用 `Object.defineProperty(..., { value })` 定义 internals
 * 和它的 invoke，**non-writable 且 non-configurable**（tauri crate
 * scripts/core.js）。壳里没有任何办法替换它，只能在它上面一层拦。
 *
 * 只实现前端真正用到的导出。新增用到的导出必须在这里补齐——tsconfig 的
 * paths 会让漏掉的导出变成编译错误，而不是运行时的 undefined。
 */

import { isShellCommand, LEGACY_GATEWAY_MESSAGE, REMOVED_GATEWAY_COMMANDS } from "./commandRouting";
import { getNativeInternals } from "./endpoint";
import { backendInvoke } from "./transport";

export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;

export type InvokeOptions = {
  headers?: Record<string, string> | Headers;
};

/**
 * 调后端命令。
 *
 * 分流见 commandRouting.ts。浏览器里没有壳，壳专属命令直接拒绝——它们没有
 * 远程对应物（远程点「选择文件夹」不该弹服务器的对话框），而且所有调用点
 * 都有 catch。
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  if (REMOVED_GATEWAY_COMMANDS.has(cmd)) {
    throw new Error(`${cmd} 是 v1 Gateway 时代的命令，已经删除。${LEGACY_GATEWAY_MESSAGE}`);
  }
  if (isShellCommand(cmd)) {
    const internals = getNativeInternals();
    if (!internals) {
      throw new Error(`壳专属命令在浏览器里不可用：${cmd}`);
    }
    return (await internals.invoke(cmd, args ?? {}, options)) as T;
  }
  return backendInvoke<T>(cmd, args);
}

/** 跑在 Tauri 桌面壳里？ */
export function isTauri(): boolean {
  return getNativeInternals() !== null;
}
