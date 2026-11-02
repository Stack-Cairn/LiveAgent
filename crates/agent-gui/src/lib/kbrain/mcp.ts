import type { McpServerConfig, McpSettings } from "../settings";

export type KBrainMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type KBrainMcpSnapshot = {
  settings: { servers: McpServerConfig[]; selected?: string[] };
  statuses: Array<Record<string, unknown>>;
};

export function toKBrainMcpSettings(settings: McpSettings) {
  return {
    servers: settings.servers.map((server) => ({
      id: server.id,
      description: server.description,
      docsUrl: server.docsUrl,
      enabled: server.enabled,
      transport: server.transport === "sse" ? "http" : server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      env: server.env,
      cwd: server.cwd,
      headers: server.headers,
      timeoutMs: server.timeoutMs,
      auth: server.auth,
    })),
    selected: settings.selected,
  };
}

export function fromKBrainMcpSettings(input: unknown, fallback: McpSettings): McpSettings {
  const value =
    input && typeof input === "object" ? (input as { settings?: unknown }).settings : undefined;
  const settings = value && typeof value === "object" ? (value as Partial<McpSettings>) : undefined;
  if (!Array.isArray(settings?.servers)) return fallback;
  return {
    ...fallback,
    servers: settings.servers as McpServerConfig[],
    selected: Array.isArray(settings.selected) ? (settings.selected as string[]) : [],
  };
}
