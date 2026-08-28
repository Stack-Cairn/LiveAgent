// Web 端终端 Pane 的窗口级运行时单例。租约(View Lease)与绑定
// (Runtime Binding)必须全窗口共享:useGatewayWorkbench、终端 Pane 宿主
// 与 Right Dock 引用同一实例。
//
// 与桌面端的差异:Web 端不持久化工作台布局,刷新后终端 Pane 不会恢复,
// 因此绑定表使用纯内存存储——持久化到 sessionStorage 只会留下指向
// 已不存在 Pane 的孤儿绑定。

import {
  createTerminalPaneBindingStore,
  type TerminalPaneBindingStorage,
} from "@liveagent/ui/lib/workbench/terminalPaneBindingStore";
import { createTerminalPaneLeaseStore } from "@liveagent/ui/lib/workbench/terminalPaneLeaseStore";
import { createTerminalPaneAutoLaunchRegistry } from "@liveagent/ui/lib/workbench/terminalPaneRuntime";

function createMemoryStorage(): TerminalPaneBindingStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

export const gatewayTerminalPaneLease = createTerminalPaneLeaseStore();
export const gatewayTerminalPaneBindings = createTerminalPaneBindingStore({
  storage: createMemoryStorage(),
});
export const gatewayTerminalPaneAutoLaunch = createTerminalPaneAutoLaunchRegistry();
