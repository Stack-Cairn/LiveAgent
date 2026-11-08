import type { McpStatusAdapter } from "@liveagent/ui/lib/resourceHost";
import { createKBrainClient } from "../lib/kbrain/client";
import {
  kbrainMcpStatuses,
  reconnectKBrainMcp,
  subscribeKBrainMcpSettingsSaved,
} from "../lib/kbrain/mcp";

/** MCP Hub status and reconnect, read from K-brain's /v1/mcp. */
export const kbrainMcpStatusAdapter: McpStatusAdapter = {
  statuses: async () => kbrainMcpStatuses(await createKBrainClient().getMcpSettings()),
  reconnect: () => reconnectKBrainMcp(createKBrainClient()),
  subscribe: subscribeKBrainMcpSettingsSaved,
};
