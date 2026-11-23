// Entries of K-brain's GET /v1/mcp/tools as the desktop tool bundle uses them. Backends
// with `mcp_tool_server_ids` report the configured server id as `serverId` and move the
// name key (the old `serverId`) to `serverKey`; tool names built from the server stay on
// the name key so they read the same on either backend.

import { kbrainMcpServerKey } from "@liveagent/ui/lib/chat/mcpApps";

export type KBrainMcpToolInfo = {
  /** Configured server id (older backends: the name key, as they report it). */
  serverId: string;
  /** Name key of the server inside `mcp__<serverKey>__<tool>`. */
  serverKey: string;
  serverLabel: string;
  /** The tool's name as the client names it (sanitized). */
  name: string;
  /** Model-facing full name to call it by (`mcp__<serverKey>__<tool>`). */
  fullName: string;
  description: string;
  inputSchema: unknown;
};

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** Whether an entry's `visibility` (`mcp_tool_visibility`) lets the model call it. */
function isModelVisibleMcpTool(entry: { visibility?: unknown }) {
  const visibility = entry.visibility;
  if (!Array.isArray(visibility) || visibility.length === 0) return true;
  const known = visibility.filter((value) => value === "model" || value === "app");
  return known.length === 0 || known.includes("model");
}

/** Model-callable tools of a GET /v1/mcp/tools reply, keyed for the desktop bundle. */
export function kbrainModelMcpToolInfos(body: unknown): KBrainMcpToolInfo[] {
  const tools = (body as { tools?: unknown } | null)?.tools;
  const infos: KBrainMcpToolInfo[] = [];
  for (const raw of Array.isArray(tools) ? tools : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const fullName = readString(entry.name);
    const serverId = readString(entry.serverId);
    if (!fullName || !serverId || !isModelVisibleMcpTool(entry)) continue;
    infos.push({
      serverId,
      serverKey: readString(entry.serverKey) || serverId,
      serverLabel: readString(entry.serverLabel),
      name: readString(entry.toolName) || fullName,
      fullName,
      description: readString(entry.description),
      inputSchema: entry.inputSchema,
    });
  }
  return infos;
}

export type KBrainMcpServerToolSummary = {
  label?: string;
  /** Tools declaring an MCP App view (`uiResourceUri`). */
  uiTools: number;
  /** Tools whose visibility leaves out the model. */
  appOnlyTools: number;
};

/**
 * Per configured server id: display label, view tools and app-only tools, from the
 * GET /v1/mcp/tools replies of a `mcp_tool_server_ids` backend (one per audience; a tool
 * in both counts once).
 */
export function kbrainMcpServerToolSummaries(
  bodies: readonly unknown[],
): Map<string, KBrainMcpServerToolSummary> {
  const seen = new Set<string>();
  const summaries = new Map<string, KBrainMcpServerToolSummary>();
  for (const body of bodies) {
    const tools = (body as { tools?: unknown } | null)?.tools;
    for (const raw of Array.isArray(tools) ? tools : []) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const serverId = readString(entry.serverId);
      const name = readString(entry.name);
      if (!serverId || !name || seen.has(name)) continue;
      seen.add(name);
      const summary = summaries.get(serverId) ?? { uiTools: 0, appOnlyTools: 0 };
      const label = readString(entry.serverLabel);
      if (label && label !== serverId) summary.label = label;
      if (readString(entry.uiResourceUri)) summary.uiTools += 1;
      if (!isModelVisibleMcpTool(entry)) summary.appOnlyTools += 1;
      summaries.set(serverId, summary);
    }
  }
  return summaries;
}

/**
 * Display label by server key (the `<serverKey>` of `mcp__<serverKey>__<tool>`), for tool
 * row headers: an entry's `serverLabel` from GET /v1/mcp/tools, else its configured
 * `serverId`, else the GET /v1/mcp settings `name` or `id` of the server whose key it is.
 * Keys whose only label is the key itself are left out, so callers fall back to the key.
 */
export function kbrainMcpServerLabels(toolsBody: unknown, settingsBody: unknown) {
  const labels = new Map<string, string>();
  const add = (key: string, label: string) => {
    const text = label.trim();
    if (key && text && text !== key && !labels.has(key)) labels.set(key, text);
  };
  const tools = (toolsBody as { tools?: unknown } | null)?.tools;
  for (const raw of Array.isArray(tools) ? tools : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (!readString(entry.name)) continue;
    // Older backends report the name key as serverId and the same value as serverLabel.
    const serverId = readString(entry.serverId);
    const key = readString(entry.serverKey) || serverId;
    add(key, readString(entry.serverLabel) || serverId);
    if (serverId !== key) add(key, serverId);
  }
  const servers = (settingsBody as { settings?: { servers?: unknown } } | null)?.settings?.servers;
  for (const raw of Array.isArray(servers) ? servers : []) {
    if (!raw || typeof raw !== "object") continue;
    const server = raw as Record<string, unknown>;
    const id = readString(server.id).trim();
    if (!id) continue;
    const key = kbrainMcpServerKey(id);
    add(key, readString(server.name) || id);
    add(key, id);
  }
  return labels;
}
