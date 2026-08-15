import type { PluginClient, PluginInventoryItem } from "@liveagent/ui/lib/plugins/types";
import type { GatewayWebSocketClient } from "../gatewaySocket";

export function createGatewayPluginClient(api: GatewayWebSocketClient | null): PluginClient {
  const requireApi = () => {
    if (!api) throw new Error("桌面端 Agent 未连接，无法管理插件");
    return api;
  };

  return {
    canInstall: false,
    list: (workspace) => requireApi().pluginManage<PluginInventoryItem[]>("list", { workspace }),
    install: async () => {
      throw new Error("WebUI 不允许远程安装插件，请在桌面端 Plugin Hub 完成安装");
    },
    setEnabled: (pluginId, enabled, workspace) =>
      requireApi().pluginManage<number>("set_enabled", {
        pluginId,
        enabled,
        workspace,
      }),
    setGrants: (pluginId, permissions) =>
      requireApi().pluginManage<number>("set_grants", { pluginId, permissions }),
    uninstall: async (pluginId) => {
      await requireApi().pluginManage("uninstall", { pluginId });
    },
    updateConfig: (update) => requireApi().pluginManage<number>("update_config", update),
  };
}
