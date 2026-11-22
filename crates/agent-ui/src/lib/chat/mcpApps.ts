// MCP App views (K-brain capability `mcp_apps`): a successful MCP tool result may carry a
// `ui_resource`, kept on the tool result details so the card can render the view.

export const MCP_UI_RESOURCE_DETAILS_KEY = "kbrainUiResource";

export type McpUiResource = {
  serverId: string;
  uri: string;
  /** Backend path of GET /v1/sessions/{id}/mcp-ui; fetching it needs the token. */
  url: string;
};

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
  return { serverId, uri, url };
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
