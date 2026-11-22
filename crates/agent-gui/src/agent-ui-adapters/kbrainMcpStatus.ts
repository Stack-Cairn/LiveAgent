import type { McpServerRuntimeStatus, McpStatusAdapter } from "@liveagent/ui/lib/resourceHost";
import { createKBrainClient } from "../lib/kbrain/client";
import {
  kbrainMcpStatuses,
  reconnectKBrainMcp,
  subscribeKBrainMcpSettingsSaved,
} from "../lib/kbrain/mcp";
import { kbrainMcpServerToolSummaries } from "../lib/kbrain/mcpToolList";
import { readKBrainSandboxedUiCapabilities } from "../lib/kbrain/sandboxedUi";

/**
 * Adds each server's display label and view/app-only tool counts on backends whose
 * GET /v1/mcp/tools reports configured ids (`mcp_tool_server_ids`). Skipped while a
 * server is still connecting (the hub polls then) and on any failure.
 */
async function withToolSummaries(
  statuses: McpServerRuntimeStatus[],
): Promise<McpServerRuntimeStatus[]> {
  if (statuses.some((status) => status.status === "connecting")) return statuses;
  const capabilities = await readKBrainSandboxedUiCapabilities();
  if (!capabilities.mcpToolServerIds) return statuses;
  try {
    const client = createKBrainClient();
    const bodies = await Promise.all([
      client.discoverMcpTools({}),
      ...(capabilities.mcpToolVisibility ? [client.discoverMcpTools({ audience: "app" })] : []),
    ]);
    const summaries = kbrainMcpServerToolSummaries(bodies);
    return statuses.map((status) => {
      const summary = summaries.get(status.id);
      return summary ? { ...status, ...summary } : status;
    });
  } catch {
    return statuses;
  }
}

/** MCP Hub status and reconnect, read from K-brain's /v1/mcp. */
export const kbrainMcpStatusAdapter: McpStatusAdapter = {
  statuses: async () =>
    withToolSummaries(kbrainMcpStatuses(await createKBrainClient().getMcpSettings())),
  reconnect: async () => withToolSummaries(await reconnectKBrainMcp(createKBrainClient())),
  subscribe: subscribeKBrainMcpSettingsSaved,
  supportsServerNames: async () => (await readKBrainSandboxedUiCapabilities()).mcpToolServerIds,
};
