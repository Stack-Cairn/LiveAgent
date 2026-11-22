// MCP App views (K-brain capability `mcp_apps`): a successful MCP tool result may carry a
// `ui_resource`, kept on the tool result details so the card can render the view.

export const MCP_UI_RESOURCE_DETAILS_KEY = "kbrainUiResource";

export type McpUiResource = {
  /** Configured MCP server id. */
  serverId: string;
  uri: string;
  /** Backend path of GET /v1/sessions/{id}/mcp-ui; fetching it needs the token. */
  url: string;
  /** The server's own tool name (`mcp_apps_structured_content`). */
  toolName?: string;
  /** Raw CallToolResult, inline in live events only (≤256 KiB). */
  result?: Record<string, unknown>;
  /** Backend path of the stored raw result (≤1 MiB); fetching it needs the token. */
  resultUrl?: string;
};

const RESULT_URL = /^\/v1\/sessions\/[^/?#]+\/mcp-ui\/results\/[0-9a-f]{32}$/;

/** A `ui_resource.result_url`: GET /v1/sessions/{id}/mcp-ui/results/{ref}. */
export function isMcpUiResultUrl(value: string) {
  return RESULT_URL.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Parses K-brain's `tool_result.ui_resource` (snake_case) or the stored camelCase form. */
export function parseMcpUiResource(value: unknown): McpUiResource | null {
  if (!isRecord(value)) return null;
  const serverId =
    typeof value.server_id === "string"
      ? value.server_id
      : typeof value.serverId === "string"
        ? value.serverId
        : "";
  const uri = typeof value.uri === "string" ? value.uri : "";
  const url = typeof value.url === "string" ? value.url : "";
  if (!serverId || !uri.startsWith("ui://") || !/^\/v1\/sessions\/[^/]+\/mcp-ui\?/.test(url)) {
    return null;
  }
  const toolName =
    typeof value.tool_name === "string"
      ? value.tool_name
      : typeof value.toolName === "string"
        ? value.toolName
        : "";
  const resultUrl =
    typeof value.result_url === "string"
      ? value.result_url
      : typeof value.resultUrl === "string"
        ? value.resultUrl
        : "";
  return {
    serverId,
    uri,
    url,
    ...(toolName ? { toolName } : {}),
    ...(isRecord(value.result) ? { result: value.result } : {}),
    ...(RESULT_URL.test(resultUrl) ? { resultUrl } : {}),
  };
}

/** Text-only CallToolResult: what a view gets when no raw result is available. */
export function textToolResult(output: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: "text", text: output }], isError };
}

/**
 * The CallToolResult a view's ui/notifications/tool-result carries: the inline raw
 * `result`, else the stored one from `resultUrl` (history only has that), else the text
 * output (results over 1 MiB and older backends).
 */
export async function resolveMcpAppToolResult(options: {
  resource: McpUiResource;
  output: string;
  failed: boolean;
  fetchResult?: (resultUrl: string) => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const { resource, output, failed, fetchResult } = options;
  if (resource.result) return resource.result;
  if (resource.resultUrl && fetchResult) {
    try {
      const stored = await fetchResult(resource.resultUrl);
      if (isRecord(stored)) return stored;
    } catch {
      // Fall back to the text output below.
    }
  }
  return textToolResult(output, failed);
}

/** Details with the view attached under `kbrainUiResource`; unchanged when there is none. */
export function withMcpUiResourceDetails<T>(details: T, raw: unknown): T {
  const resource = parseMcpUiResource(raw);
  if (!resource) return details;
  const base = isRecord(details) ? details : {};
  return { ...base, [MCP_UI_RESOURCE_DETAILS_KEY]: resource } as T;
}

export function readMcpUiResource(details: unknown): McpUiResource | null {
  return isRecord(details) ? parseMcpUiResource(details[MCP_UI_RESOURCE_DETAILS_KEY]) : null;
}

/** The server's own tool name inside K-brain's `mcp__<server>__<tool>` name. */
export function mcpToolShortName(fullName: string) {
  if (!fullName.startsWith("mcp__")) return fullName;
  const rest = fullName.slice("mcp__".length);
  const split = rest.indexOf("__");
  return split >= 0 ? rest.slice(split + 2) || fullName : fullName;
}

// Per code point, like Go regexp on a string.
const NOT_NAME_CHAR = /[^a-zA-Z0-9_-]/gu;

function sanitizeMcpNamePart(value: string) {
  return value ? value.replace(NOT_NAME_CHAR, "_") : "_";
}

function fnv1a32(text: string) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** K-brain's server key inside tool names (mirrors internal/mcp serverKey). */
export function kbrainMcpServerKey(serverId: string) {
  if (serverId && !/[^a-zA-Z0-9_-]/.test(serverId) && !serverId.includes("__")) return serverId;
  const hash = fnv1a32(serverId).toString(16).padStart(8, "0");
  return `${sanitizeMcpNamePart(serverId).replaceAll("_", "-")}_${hash}`;
}

/** The model-facing name K-brain gives `tool` of server `serverId`. */
export function kbrainMcpToolName(serverId: string, tool: string) {
  return `mcp__${kbrainMcpServerKey(serverId)}__${sanitizeMcpNamePart(tool)}`;
}

/**
 * A server's policy for one tool: the exact entry, else "*", else allow. Unknown values are
 * treated as deny, as K-brain refuses to run them.
 */
export function resolveMcpToolPolicy(
  policy: Record<string, unknown> | undefined,
  fullName: string,
): "allow" | "ask" | "deny" {
  const read = (key: string) => {
    const raw = policy?.[key];
    return typeof raw === "string" ? raw.toLowerCase() : "";
  };
  const value = read(fullName) || read("*");
  if (!value || value === "allow") return "allow";
  if (value === "ask") return "ask";
  return "deny";
}
