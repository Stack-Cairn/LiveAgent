// Web 端终端 Pane 的窗口级运行时单例。租约(View Lease)与绑定
// (Runtime Binding)必须全窗口共享:useGatewayWorkbench、终端 Pane 宿主
// 与 Right Dock 引用同一实例。
//
// 与桌面端使用同一恢复语义:布局和 surfaceId 持久化，运行时绑定表保留到
// 当前窗口刷新后；后端注册表仍有会话就直接重挂，
// 会话已消失则清理陈旧绑定并按 launchSpec 重建。

import { createTerminalPaneBindingStore } from "@liveagent/ui/lib/workbench/terminalPaneBindingStore";
import { createTerminalPaneLeaseStore } from "@liveagent/ui/lib/workbench/terminalPaneLeaseStore";
import { createTerminalPaneAutoLaunchRegistry } from "@liveagent/ui/lib/workbench/terminalPaneRuntime";

export const gatewayTerminalPaneLease = createTerminalPaneLeaseStore();
export const gatewayTerminalPaneBindings = createTerminalPaneBindingStore();
export const gatewayTerminalPaneAutoLaunch = createTerminalPaneAutoLaunchRegistry();
