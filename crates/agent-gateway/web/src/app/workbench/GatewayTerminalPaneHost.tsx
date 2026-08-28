import {
  TerminalPaneHost,
  type TerminalPaneHostProps,
} from "@liveagent/ui/components/workbench/TerminalPaneHost";
import { gatewayTerminalPaneBindings, gatewayTerminalPaneLease } from "./terminalPaneRuntime";

export type GatewayTerminalPaneHostProps = Omit<TerminalPaneHostProps, "bindings" | "lease">;

/**
 * Web 端终端 Pane 宿主:共享实现 + 网关注入(网关终端 client 与窗口级
 * 租约/绑定单例)。逻辑语义见 @liveagent/ui 的 TerminalPaneHost。
 */
export function GatewayTerminalPaneHost(props: GatewayTerminalPaneHostProps) {
  return (
    <TerminalPaneHost
      {...props}
      bindings={gatewayTerminalPaneBindings}
      lease={gatewayTerminalPaneLease}
    />
  );
}
