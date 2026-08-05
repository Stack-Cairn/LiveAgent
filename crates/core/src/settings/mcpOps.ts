import {
  type AppSettings,
  type McpServerConfig,
  type McpSettings,
  normalizeMcpServerConfig,
  normalizeMcpSettings,
  normalizeSettings,
} from "./index";

/**
 * Identity-keyed MCP settings operations.
 *
 * All MCP settings writes (tool, UI, sync) must be expressed as ops and merged
 * through `applyMcpOps` inside a `setSettings(prev => ...)` updater. Ops merge
 * against `prev` by server id, so concurrent writers never clobber each other
 * the way whole-object replacement did.
 */
export type McpSettingsOp =
  | { kind: "upsert"; server: McpServerConfig }
  | { kind: "patch"; serverId: string; patch: Partial<McpServerConfig> }
  | { kind: "remove"; serverId: string }
  | { kind: "setEnabled"; serverIds: string[]; enabled: boolean };

function sameServerConfig(a: McpServerConfig, b: McpServerConfig) {
  // Both sides are produced by normalizeMcpServerConfig, which builds the
  // object with a fixed key order, so JSON equality is reliable here.
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyOp(servers: McpServerConfig[], op: McpSettingsOp): McpServerConfig[] {
  switch (op.kind) {
    case "upsert": {
      const server = normalizeMcpServerConfig(op.server);
      if (!server.id) return servers;
      const index = servers.findIndex((item) => item.id === server.id);
      if (index < 0) return [...servers, server];
      if (sameServerConfig(servers[index], server)) return servers;
      return servers.map((item, i) => (i === index ? server : item));
    }
    case "patch": {
      const index = servers.findIndex((item) => item.id === op.serverId);
      if (index < 0) return servers;
      const merged = normalizeMcpServerConfig({
        ...servers[index],
        ...op.patch,
        id: servers[index].id,
      });
      if (sameServerConfig(servers[index], merged)) return servers;
      return servers.map((item, i) => (i === index ? merged : item));
    }
    case "remove": {
      if (!servers.some((item) => item.id === op.serverId)) return servers;
      return servers.filter((item) => item.id !== op.serverId);
    }
    case "setEnabled": {
      const ids = new Set(op.serverIds);
      if (!servers.some((item) => ids.has(item.id) && item.enabled !== op.enabled)) return servers;
      return servers.map((item) =>
        ids.has(item.id) && item.enabled !== op.enabled ? { ...item, enabled: op.enabled } : item,
      );
    }
  }
}

/**
 * Pure reducer: applies ops in order and returns `prev` identity when nothing
 * changed (App.setSettings short-circuits on identity). Never throws and has
 * no side effects, so React StrictMode double invocation is safe.
 */
export function applyMcpOps(prev: McpSettings, ops: McpSettingsOp[]): McpSettings {
  let servers = prev.servers;
  for (const op of ops) {
    servers = applyOp(servers, op);
  }
  if (servers === prev.servers) return prev;
  return normalizeMcpSettings({ servers, selected: prev.selected });
}

export function applyMcpOpsToAppSettings(prev: AppSettings, ops: McpSettingsOp[]): AppSettings {
  const mcp = applyMcpOps(prev.mcp, ops);
  if (mcp === prev.mcp) return prev;
  return normalizeSettings({ ...prev, mcp });
}

/** Servers eligible for dynamic mcp_* tool loading. */
export function selectEnabledMcpServers(settings: McpSettings): McpServerConfig[] {
  return settings.servers.filter((server) => server.enabled && server.id.trim());
}
