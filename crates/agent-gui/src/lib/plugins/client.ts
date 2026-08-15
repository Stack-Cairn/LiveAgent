import type {
  PluginClient,
  PluginInstallOptions,
  PluginInventoryItem,
} from "@liveagent/ui/lib/plugins/types";
import { invoke } from "@tauri-apps/api/core";

export const desktopPluginClient: PluginClient = {
  list: (workspace) => invoke<PluginInventoryItem[]>("plugin_list", { workspace }),
  install: (sourcePath: string, options: PluginInstallOptions) =>
    invoke<PluginInventoryItem>("plugin_install", { sourcePath, options }),
  setEnabled: (pluginId, enabled, workspace) =>
    invoke<number>("plugin_set_enabled", { pluginId, enabled, workspace }),
  setGrants: (pluginId, permissions) =>
    invoke<number>("plugin_set_grants", { pluginId, permissions }),
  uninstall: (pluginId) => invoke<void>("plugin_uninstall", { pluginId }),
  updateConfig: (update) => invoke<number>("plugin_update_config", { update }),
};
