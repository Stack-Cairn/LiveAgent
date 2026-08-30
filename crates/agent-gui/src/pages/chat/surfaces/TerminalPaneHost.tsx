import {
  TerminalPaneHost as SharedTerminalPaneHost,
  type TerminalPaneHostProps as SharedTerminalPaneHostProps,
} from "@liveagent/ui/components/workbench/TerminalPaneHost";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import {
  terminalPaneAutoLaunch,
  terminalPaneBindings,
  terminalPaneLease,
} from "../workbench/terminalPaneRuntime";

export type TerminalPaneHostProps = Omit<
  SharedTerminalPaneHostProps,
  "client" | "bindings" | "lease" | "autoLaunch"
>;

/**
 * 桌面端终端 Pane 宿主:共享实现 + 桌面注入(Tauri 终端 client 与窗口级
 * 租约/绑定单例)。逻辑语义见 @liveagent/ui 的 TerminalPaneHost。
 */
export function TerminalPaneHost(props: TerminalPaneHostProps) {
  return (
    <SharedTerminalPaneHost
      {...props}
      client={tauriTerminalClient}
      bindings={terminalPaneBindings}
      lease={terminalPaneLease}
      autoLaunch={terminalPaneAutoLaunch}
    />
  );
}
