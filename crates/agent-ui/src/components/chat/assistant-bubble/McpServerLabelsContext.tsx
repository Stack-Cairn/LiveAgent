// Display labels of MCP servers for tool row headers. K-brain names a server's tools
// `mcp__<serverKey>__<tool>`, where the key is a sanitized (sometimes hashed) form of the
// configured id; the host maps keys back to the server's label from the tool list it
// already keeps. Hosts without one provide nothing and rows show the key.

import { createContext, useContext, useEffect } from "react";
import { parseDynamicMcpToolName } from "./assistantBubbleUtils";

export type McpServerLabels = {
  /** Display label by server key (the `<serverKey>` of `mcp__<serverKey>__<tool>`). */
  labels: ReadonlyMap<string, string>;
  /**
   * Asks the host to load its labels: one shared lookup, called when a row meets a key
   * the map does not have. Repeated calls must be cheap.
   */
  request?: () => void;
};

const NO_MCP_SERVER_LABELS: McpServerLabels = { labels: new Map() };

const McpServerLabelsContext = createContext<McpServerLabels>(NO_MCP_SERVER_LABELS);

export const McpServerLabelsProvider = McpServerLabelsContext.Provider;

/** The server key of a K-brain MCP tool name, or "" for any other name. */
function mcpToolServerKey(toolName: string) {
  if (!toolName.trim().startsWith("mcp__")) return "";
  return parseDynamicMcpToolName(toolName)?.serverId ?? "";
}

/** The host's display label of the MCP server a tool belongs to, when it has one. */
export function useMcpServerLabel(toolName: string): string | undefined {
  const { labels, request } = useContext(McpServerLabelsContext);
  const serverKey = mcpToolServerKey(toolName);
  const label = serverKey ? labels.get(serverKey) : undefined;
  useEffect(() => {
    if (serverKey && !label) request?.();
  }, [label, request, serverKey]);
  return label && label !== serverKey ? label : undefined;
}
