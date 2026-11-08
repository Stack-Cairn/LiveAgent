import { MCP_SERVER_CONFIG_FIELDS, type McpServerConfig, type McpSettings } from "../settings";

export { workspaceMcpServerIds } from "../settings";

export type KBrainMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type KBrainMcpServerStatus = {
  id: string;
  /** disabled | connecting | ready | failed | managed (owned by K-brain computer use). */
  status: string;
  error?: string;
  tools: number;
};

export type KBrainMcpSnapshot = {
  settings: { servers: McpServerConfig[]; selected?: string[] };
  statuses: Array<Record<string, unknown>>;
};

type RawServer = Record<string, unknown>;

/**
 * Server fields LiveAgent owns: a save always sends LiveAgent's value. env and
 * headers are left out when LiveAgent has none, so K-brain keeps the secrets its
 * GET redacts; a blank oauth credentialRef is kept the same way.
 */
const LIVEAGENT_SERVER_FIELDS = new Set([
  "id",
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
  "auth",
]);

/**
 * Server fields K-brain owns but LiveAgent can change. A save sends LiveAgent's
 * value only when it changed since the last save; otherwise K-brain's current
 * value is kept, so an unrelated save never undoes an edit made elsewhere.
 */
const SHARED_SERVER_FIELDS = ["policy", "workspaceRoots"] as const;

/** Fields every K-brain with live MCP settings accepts (it rejects unknown fields). */
const KBRAIN_SERVER_FIELDS = new Set([...LIVEAGENT_SERVER_FIELDS, ...SHARED_SERVER_FIELDS]);

function liveAgentServerFields(server: McpServerConfig): RawServer {
  return {
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
  };
}

/** Full K-brain records for servers K-brain does not have yet (first import). */
export function toKBrainMcpSettings(settings: McpSettings) {
  return {
    servers: settings.servers.map((server) => ({
      ...liveAgentServerFields(server),
      ...(server.policy ? { policy: server.policy } : {}),
      ...(server.workspaceRoots ? { workspaceRoots: server.workspaceRoots } : {}),
    })),
    selected: settings.selected,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The `settings` object of a GET/PUT /v1/mcp response, or undefined when malformed. */
export function kbrainMcpSettingsDocument(
  input: unknown,
): (Record<string, unknown> & { servers: RawServer[] }) | undefined {
  const settings = isRecord(input) ? input.settings : undefined;
  if (!isRecord(settings) || !Array.isArray(settings.servers)) return undefined;
  return {
    ...settings,
    servers: settings.servers.filter(isRecord),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Applies the policy entries LiveAgent changed (against `before`) to K-brain's
 * current policy, so an entry another client set meanwhile (say one tool's
 * rule) survives LiveAgent changing a different one. Undefined when empty.
 */
function mergePolicy(
  live: unknown,
  before: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (isRecord(live)) {
    for (const [key, value] of Object.entries(live)) {
      if (typeof value === "string") out[key] = value;
    }
  }
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(next ?? {})])) {
    if (before?.[key] === next?.[key]) continue;
    if (next?.[key] === undefined) delete out[key];
    else out[key] = next[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Builds the PUT /v1/mcp body for LiveAgent's MCP settings on top of what
 * K-brain currently has. PUT replaces the whole document, so every field
 * LiveAgent does not edit (per-server policy and workspaceRoots, fields added
 * by newer K-brain releases, top-level fields) is copied from `current`.
 *
 * `previous` is LiveAgent's MCP settings before this edit. policy and
 * workspaceRoots are sent from `next` only when they changed against it (or the
 * server is new to K-brain); otherwise K-brain's value wins.
 */
export function mergeKBrainMcpSettings(
  current: unknown,
  next: McpSettings,
  previous?: McpSettings,
): Record<string, unknown> {
  const document = kbrainMcpSettingsDocument(current);
  if (!document) throw new Error("Malformed K-brain MCP settings");
  const { servers: currentServers, selected: _selected, ...topLevel } = document;
  const liveById = new Map<string, RawServer>();
  const observed = new Set(KBRAIN_SERVER_FIELDS);
  for (const server of currentServers) {
    if (typeof server.id === "string") liveById.set(server.id, server);
    for (const key of Object.keys(server)) observed.add(key);
  }
  const previousById = new Map((previous?.servers ?? []).map((server) => [server.id, server]));

  const servers = next.servers.map((server) => {
    const live = liveById.get(server.id);
    const out: RawServer = {};
    if (live) {
      for (const [key, value] of Object.entries(live)) {
        if (!LIVEAGENT_SERVER_FIELDS.has(key)) out[key] = value;
      }
    } else {
      // A new or renamed server: keep the K-brain fields LiveAgent loaded with it,
      // limited to fields this backend reports so it cannot reject the request.
      for (const [key, value] of Object.entries(server.backendFields ?? {})) {
        if (observed.has(key) && !KBRAIN_SERVER_FIELDS.has(key)) out[key] = value;
      }
    }
    Object.assign(out, liveAgentServerFields(server));
    const before = previousById.get(server.id);
    for (const field of SHARED_SERVER_FIELDS) {
      const changed = before
        ? !sameValue(before[field], server[field])
        : server[field] !== undefined;
      if (!changed && live) continue;
      const value =
        field === "policy" && live && before
          ? mergePolicy(live.policy, before.policy, server.policy)
          : server[field];
      if (value === undefined) delete out[field];
      else out[field] = value;
    }
    return out;
  });

  return { ...topLevel, servers, selected: next.selected };
}

export function fromKBrainMcpSettings(input: unknown, fallback: McpSettings): McpSettings {
  const settings = kbrainMcpSettingsDocument(input);
  if (!settings) return fallback;
  return {
    ...fallback,
    servers: settings.servers.map((server) => {
      const backendFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(server)) {
        if (!MCP_SERVER_CONFIG_FIELDS.includes(key)) backendFields[key] = value;
      }
      return {
        ...server,
        backendFields: Object.keys(backendFields).length > 0 ? backendFields : undefined,
      } as McpServerConfig;
    }),
    selected: Array.isArray(settings.selected)
      ? settings.selected.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** Per-server connection status from GET /v1/mcp or POST /v1/mcp/reload. */
export function kbrainMcpStatuses(input: unknown): KBrainMcpServerStatus[] {
  const statuses = isRecord(input) ? input.statuses : undefined;
  if (!Array.isArray(statuses)) return [];
  const out: KBrainMcpServerStatus[] = [];
  for (const item of statuses) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.status !== "string") continue;
    out.push({
      id: item.id,
      status: item.status,
      ...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
      tools: typeof item.tools === "number" && Number.isFinite(item.tools) ? item.tools : 0,
    });
  }
  return out;
}

const savedListeners = new Set<() => void>();

/** Notifies MCP status views after LiveAgent saved MCP settings to K-brain. */
export function subscribeKBrainMcpSettingsSaved(listener: () => void): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}

export function notifyKBrainMcpSettingsSaved(): void {
  for (const listener of savedListeners) listener();
}

type McpReloadClient = {
  getMcpSettings: () => Promise<unknown>;
  updateMcpSettings: (input: unknown) => Promise<unknown>;
  reloadMcp: () => Promise<unknown>;
};

/**
 * Restarts K-brain's MCP servers. POST /v1/mcp/reload re-reads the settings
 * file, which does not exist until the first PUT; then the current settings
 * are saved back unchanged, which restarts the servers the same way (env,
 * headers and credentials K-brain redacts are kept because they are omitted).
 */
export async function reconnectKBrainMcp(
  client: McpReloadClient,
): Promise<KBrainMcpServerStatus[]> {
  try {
    return kbrainMcpStatuses(await client.reloadMcp());
  } catch (reloadError) {
    const current = await client.getMcpSettings();
    const document = kbrainMcpSettingsDocument(current);
    if (!document) throw reloadError;
    return kbrainMcpStatuses(await client.updateMcpSettings(document));
  }
}

/**
 * Run option value that offers no MCP server. K-brain reads an empty or
 * missing `mcp_server_ids` as "use the saved selection" (all servers when none
 * is saved), so "none" is sent as an id no server can match.
 */
export const KBRAIN_NO_MCP_SERVERS = "liveagent:no-mcp-servers";

/** `mcp_server_ids` for a run; see workspaceMcpServerIds. */
export function kbrainRunMcpServerIds(ids: readonly string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  return ids.length > 0 ? [...ids] : [KBRAIN_NO_MCP_SERVERS];
}
