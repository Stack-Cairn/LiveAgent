// The MCP server config fields LiveAgent owns, and the K-brain fields kept beside them.

/** Server fields LiveAgent edits or derives itself; anything else K-brain returns is kept as is. */
export const MCP_SERVER_CONFIG_FIELDS: readonly string[] = [
  "id",
  "name",
  "description",
  "docsUrl",
  "enabled",
  "transport",
  "command",
  "args",
  "url",
  "env",
  "cwd",
  "headers",
  "timeoutMs",
  "messageUrl",
  "auth",
  "policy",
  "workspaceRoots",
  "backendFields",
];

export function normalizeMcpBackendFields(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key || MCP_SERVER_CONFIG_FIELDS.includes(key) || value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
