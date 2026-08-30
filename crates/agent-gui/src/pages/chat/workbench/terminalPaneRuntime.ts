// The terminal pane runtime helpers are shared with the WebUI (the
// implementation lives in @liveagent/ui); this module keeps the desktop's
// window-level singletons so ChatPage, TerminalPaneHost and tests reference
// the same instances.
import {
  createTerminalAppExitGuard,
  createTerminalPaneAutoLaunchRegistry,
} from "@liveagent/ui/lib/workbench/terminalPaneRuntime";
import { createTerminalPaneBindingStore } from "./terminalPaneBindingStore";
import { createTerminalPaneLeaseStore } from "./terminalPaneLeaseStore";

export {
  createTerminalAppExitGuard,
  createTerminalPaneAutoLaunchRegistry,
  createTerminalSurfaceId,
  type EnsureTerminalPaneSessionDeps,
  ensureTerminalPaneSession,
  type FindTerminalPaneForSessionDeps,
  findTerminalPaneForSession,
  isTerminalPaneAutoLaunchAuthorized,
  type ResolveLiveTerminalSurfaceIdsDeps,
  resolveLiveTerminalSurfaceIds,
  type TerminalPaneAutoLaunchRegistry,
  TerminalPaneSshPromptError,
} from "@liveagent/ui/lib/workbench/terminalPaneRuntime";

/**
 * 终端 Pane 的窗口级运行时单例:租约(View Lease)与绑定(Runtime Binding)
 * 必须全窗口共享,ChatPage、TerminalPaneHost 与测试引用同一实例。
 */
export const terminalPaneLease = createTerminalPaneLeaseStore();
export const terminalPaneBindings = createTerminalPaneBindingStore();

export const terminalPaneAutoLaunch = createTerminalPaneAutoLaunchRegistry();

export const terminalAppExitGuard = createTerminalAppExitGuard();
