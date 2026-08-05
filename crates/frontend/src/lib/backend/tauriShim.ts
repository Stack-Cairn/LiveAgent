/**
 * 浏览器环境的 `__TAURI_INTERNALS__` polyfill。
 *
 * 阶段 4 之后，业务代码的 invoke/listen 已经由 vite alias 顶替到
 * lib/backend/tauriCore.ts 与 tauriEvent.ts，不再经过这里。这个 polyfill 只
 * 剩一个职责：让**仍然直接读 `window.__TAURI_INTERNALS__` 的第三方模块**
 * （`@tauri-apps/plugin-opener`、`@tauri-apps/api/window|webview|path`——它们
 * 内部走相对 import，alias 管不到）在纯浏览器里不至于抛
 * "Cannot read properties of undefined"。
 *
 * 桌面壳里什么都不做：真 internals 由 Tauri 注入，且它的每个成员都是
 * `Object.defineProperty(..., { value })` 定义的 non-writable/non-configurable
 * 属性，改不了也不该改。
 *
 * 它必须是 main.tsx 的第一个 import：模块作用域里就有 invoke 的文件不少。
 */

import { LEGACY_GATEWAY_MESSAGE, REMOVED_GATEWAY_COMMANDS } from "./commandRouting";
import { backendInvoke, dispatchLocalEvent, subscribeBackendEvent } from "./transport";

export function installTauriShim() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return; // 真 Tauri 壳在场，不干预

  // ---- 回调注册表：transformCallback 的存储 ----
  let nextCallbackId = 1;
  const callbacks = new Map<number, (payload: unknown) => void>();
  // 事件订阅：callback id → 退订函数（transport 层的 WS 订阅）
  const unsubscribes = new Map<number, () => void>();

  function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    // 事件插件：翻译成 transport 的 WS 订阅
    if (cmd === "plugin:event|listen") {
      const eventName = String(args?.event);
      const handlerId = Number(args?.handler);
      const unsubscribe = subscribeBackendEvent(eventName, (frame) => {
        callbacks.get(handlerId)?.({ event: frame.event, id: handlerId, payload: frame.payload });
      });
      unsubscribes.set(handlerId, unsubscribe);
      return Promise.resolve(handlerId);
    }
    if (cmd === "plugin:event|unlisten") {
      const handlerId = Number(args?.eventId);
      unsubscribes.get(handlerId)?.();
      unsubscribes.delete(handlerId);
      callbacks.delete(handlerId);
      return Promise.resolve();
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      // 前端本地事件：浏览器里没有 Rust 广播，直接回环给本地订阅者
      dispatchLocalEvent(String(args?.event), args?.payload);
      return Promise.resolve();
    }
    if (REMOVED_GATEWAY_COMMANDS.has(cmd)) {
      return Promise.reject(
        new Error(`${cmd} 是 v1 Gateway 时代的命令，已经删除。${LEGACY_GATEWAY_MESSAGE}`),
      );
    }
    // 其余插件命令（窗口、托盘、opener）浏览器里没有对应物。调用点都有 catch。
    if (cmd.startsWith("plugin:")) {
      return Promise.reject(new Error(`Tauri 插件命令在浏览器里不可用：${cmd}`));
    }
    return backendInvoke(cmd, args);
  }

  w.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback: (payload: unknown) => void, _once?: boolean) {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      unsubscribes.get(id)?.();
      unsubscribes.delete(id);
      callbacks.delete(id);
    },
    runCallback(id: number, payload: unknown) {
      callbacks.get(id)?.(payload);
    },
    convertFileSrc(filePath: string, protocol = "asset") {
      return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
    },
    // 标记这是网络 shim：endpoint.ts 靠它区分「真壳」和「我们自己装的壳」
    __LIVEAGENT_NETWORK_SHIM__: true,
  };

  // @tauri-apps/api 的 event.js `_unlisten` 会直接调
  // window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener——同样要垫上。
  // 真正的清理在 plugin:event|unlisten 分支里做，这里只需存在即可。
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event: string, eventId: number) {
      callbacks.delete(eventId);
    },
  };
}

installTauriShim();
