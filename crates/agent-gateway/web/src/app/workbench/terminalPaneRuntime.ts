// Web 端终端 Pane 的窗口级运行时单例。租约(View Lease)与绑定
// (Runtime Binding)必须全窗口共享:useGatewayWorkbench、终端 Pane 宿主
// 与 Right Dock 引用同一实例。
//
// Web 每次打开都从单 Pane 首页开始，因此运行时绑定也只保留在本次页面
// 生命周期内；Desktop 继续使用 sessionStorage 支持 webview reload 重挂。

import { createTerminalPaneBindingStore } from "@liveagent/ui/lib/workbench/terminalPaneBindingStore";
import { createTerminalPaneLeaseStore } from "@liveagent/ui/lib/workbench/terminalPaneLeaseStore";
import { createTerminalPaneAutoLaunchRegistry } from "@liveagent/ui/lib/workbench/terminalPaneRuntime";

export const gatewayTerminalPaneLease = createTerminalPaneLeaseStore();
export const gatewayTerminalPaneBindings = createTerminalPaneBindingStore({ storage: null });
export const gatewayTerminalPaneAutoLaunch = createTerminalPaneAutoLaunchRegistry();
