// Desktop access to K-brain's sandboxed UI routes: plugins (list, long-poll, manage,
// call a plugin's own tool), MCP App view HTML, HTML previews, and the MCP tool lookup an
// App view's tools/call needs. Every request carries the bearer token through fetchKBrain;
// pages themselves never see it.

import { type HtmlPreviewRecord, parseHtmlPreview } from "@liveagent/ui/lib/chat/htmlPreviews";
import {
  isMcpUiResultUrl,
  kbrainMcpToolName,
  resolveMcpToolPolicy,
} from "@liveagent/ui/lib/chat/mcpApps";
import { hasFrozenCapability, readKBrainHealthResponse } from "@liveagent/ui/lib/kbrain/health";
import {
  KBRAIN_MCP_APPS_STRUCTURED_CONTENT_CAPABILITY,
  KBRAIN_MCP_TOOL_CALL_APPROVAL_CAPABILITY,
  KBRAIN_MCP_TOOL_SERVER_IDS_CAPABILITY,
  KBRAIN_MCP_TOOL_VISIBILITY_CAPABILITY,
  type McpToolCallResponse,
  mcpToolCallRequestBody,
  parseMcpToolCallResponse,
} from "@liveagent/ui/lib/mcp/toolCall";
import {
  KBRAIN_HTML_PREVIEWS_CAPABILITY,
  KBRAIN_MCP_APPS_CAPABILITY,
  KBRAIN_PLUGIN_MANIFEST_UNKNOWN_FIELDS_CAPABILITY,
  KBRAIN_PLUGIN_TOOL_NAMES_CAPABILITY,
  KBRAIN_PLUGIN_UI_CAPABILITY,
  KBRAIN_PLUGIN_UI_ERRORS_CAPABILITY,
  KBRAIN_PLUGINS_CAPABILITY,
  type PluginList,
  type PluginListRequest,
  type PluginsClient,
  PluginsHttpError,
  parsePluginList,
} from "@liveagent/ui/lib/plugins/types";
import type { McpAppToolTarget } from "@liveagent/ui/lib/sandboxed-ui/mcpAppHost";
import { resolveKBrainClientOptions, subscribeKBrainRuntimeConnection } from "./runtimeConnection";
import { fetchKBrain } from "./transport";

/** Largest sandboxed HTML the desktop loads into a frame (the backend caps views at 4 MiB). */
const MAX_SANDBOXED_HTML_BYTES = 8 * 1024 * 1024;
const PLUGIN_LIST_WAIT_SECONDS = 30;
const CAPABILITY_TTL_MS = 30_000;
const MCP_LOOKUP_TTL_MS = 15_000;

export type KBrainSandboxedUiCapabilities = {
  plugins: boolean;
  pluginUi: boolean;
  mcpApps: boolean;
  htmlPreviews: boolean;
  /** ui_resource carries tool_name/result/result_url; tools/call returns `result`. */
  mcpAppsStructuredContent: boolean;
  /** GET /v1/mcp/tools takes `audience`; tools/call takes `caller`. */
  mcpToolVisibility: boolean;
  /** tools/call answers "ask" tools with approval_required and takes `approval_id`. */
  mcpToolCallApproval: boolean;
  /** GET /v1/mcp/tools serverId is the configured id; serverKey/serverLabel present. */
  mcpToolServerIds: boolean;
  /** contributes.toolDetails is present; plugin tools/call takes manifest or model name. */
  pluginToolNames: boolean;
  /** contributes.ui[].errorCode and host.panelLoadError pages. */
  pluginUiErrors: boolean;
  pluginManifestUnknownFields: boolean;
};

export const NO_KBRAIN_SANDBOXED_UI_CAPABILITIES: KBrainSandboxedUiCapabilities = {
  plugins: false,
  pluginUi: false,
  mcpApps: false,
  htmlPreviews: false,
  mcpAppsStructuredContent: false,
  mcpToolVisibility: false,
  mcpToolCallApproval: false,
  mcpToolServerIds: false,
  pluginToolNames: false,
  pluginUiErrors: false,
  pluginManifestUnknownFields: false,
};

const CAPABILITY_NAMES: Record<keyof KBrainSandboxedUiCapabilities, string> = {
  plugins: KBRAIN_PLUGINS_CAPABILITY,
  pluginUi: KBRAIN_PLUGIN_UI_CAPABILITY,
  mcpApps: KBRAIN_MCP_APPS_CAPABILITY,
  htmlPreviews: KBRAIN_HTML_PREVIEWS_CAPABILITY,
  mcpAppsStructuredContent: KBRAIN_MCP_APPS_STRUCTURED_CONTENT_CAPABILITY,
  mcpToolVisibility: KBRAIN_MCP_TOOL_VISIBILITY_CAPABILITY,
  mcpToolCallApproval: KBRAIN_MCP_TOOL_CALL_APPROVAL_CAPABILITY,
  mcpToolServerIds: KBRAIN_MCP_TOOL_SERVER_IDS_CAPABILITY,
  pluginToolNames: KBRAIN_PLUGIN_TOOL_NAMES_CAPABILITY,
  pluginUiErrors: KBRAIN_PLUGIN_UI_ERRORS_CAPABILITY,
  pluginManifestUnknownFields: KBRAIN_PLUGIN_MANIFEST_UNKNOWN_FIELDS_CAPABILITY,
};

/** Reads every sandboxed UI capability out of a /v1/health reply. */
export function sandboxedUiCapabilitiesFromHealth(
  health: Parameters<typeof hasFrozenCapability>[0],
): KBrainSandboxedUiCapabilities {
  const result = { ...NO_KBRAIN_SANDBOXED_UI_CAPABILITIES };
  for (const key of Object.keys(CAPABILITY_NAMES) as (keyof KBrainSandboxedUiCapabilities)[]) {
    result[key] = hasFrozenCapability(health, CAPABILITY_NAMES[key]);
  }
  return result;
}

export function sameSandboxedUiCapabilities(
  left: KBrainSandboxedUiCapabilities,
  right: KBrainSandboxedUiCapabilities,
) {
  return (Object.keys(CAPABILITY_NAMES) as (keyof KBrainSandboxedUiCapabilities)[]).every(
    (key) => left[key] === right[key],
  );
}

let capabilityRead: { at: number; value: Promise<KBrainSandboxedUiCapabilities> } | null = null;
let watchingConnection = false;

/** Sandboxed UI capabilities of the connected backend; a failed read counts as none. */
export function readKBrainSandboxedUiCapabilities(): Promise<KBrainSandboxedUiCapabilities> {
  if (!watchingConnection) {
    watchingConnection = true;
    subscribeKBrainRuntimeConnection(() => {
      capabilityRead = null;
    });
  }
  const now = Date.now();
  if (capabilityRead && now - capabilityRead.at < CAPABILITY_TTL_MS) return capabilityRead.value;
  const value = fetchKBrain("/v1/health")
    .then(readKBrainHealthResponse)
    .then(sandboxedUiCapabilitiesFromHealth)
    .catch(() => {
      capabilityRead = null;
      return NO_KBRAIN_SANDBOXED_UI_CAPABILITIES;
    });
  capabilityRead = { at: now, value };
  return value;
}

async function readErrorMessage(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = parsed.error ?? parsed.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON: keep the text.
  }
  return text.trim() || `K-brain request failed (${response.status})`;
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchKBrain(path, init);
  if (!response.ok) throw new PluginsHttpError(response.status, await readErrorMessage(response));
  return response.json();
}

async function requestPluginList(path: string, init: RequestInit = {}): Promise<PluginList> {
  const list = parsePluginList(await requestJson(path, init));
  if (!list) throw new Error("Malformed K-brain plugin list");
  return list;
}

function workdirBody(workdir?: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ...extra, ...(workdir?.trim() ? { workdir: workdir.trim() } : {}) });
}

export function kbrainBackendBaseUrl() {
  return resolveKBrainClientOptions({}).baseUrl?.trim().replace(/\/+$/, "") ?? "";
}

export function createKBrainPluginsClient(): PluginsClient {
  const pluginPath = (id: string, action = "") =>
    `/v1/plugins/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
  return {
    list(request: PluginListRequest = {}) {
      const query = new URLSearchParams();
      if (request.workdir?.trim()) query.set("workdir", request.workdir.trim());
      if (request.since !== undefined) {
        query.set("since", String(request.since));
        query.set(
          "wait",
          String(Math.min(60, Math.max(1, request.wait ?? PLUGIN_LIST_WAIT_SECONDS))),
        );
      }
      const search = query.toString();
      const suffix = search ? `?${search}` : "";
      return requestPluginList(`/v1/plugins${suffix}`, { signal: request.signal });
    },
    setEnabled(id, enabled, workdir) {
      return requestPluginList(pluginPath(id, enabled ? "enable" : "disable"), {
        method: "POST",
        body: workdirBody(workdir),
      });
    },
    install(path, workdir) {
      return requestPluginList("/v1/plugins/install", {
        method: "POST",
        body: workdirBody(workdir, { path }),
      });
    },
    remove(id, workdir) {
      const query = workdir?.trim() ? `?workdir=${encodeURIComponent(workdir.trim())}` : "";
      return requestPluginList(`${pluginPath(id)}${query}`, { method: "DELETE" });
    },
    reload(workdir) {
      return requestPluginList("/v1/plugins/reload", {
        method: "POST",
        body: workdirBody(workdir),
      });
    },
    async callTool(pluginId, name, args, workdir) {
      const body = (await requestJson(pluginPath(pluginId, "tools/call"), {
        method: "POST",
        body: workdirBody(workdir, { name, arguments: args }),
      })) as { output?: unknown; failed?: unknown; cancelled?: unknown; toolName?: unknown };
      return {
        output: typeof body?.output === "string" ? body.output : "",
        failed: body?.failed === true || body?.cancelled === true,
        ...(typeof body?.toolName === "string" && body.toolName ? { toolName: body.toolName } : {}),
      };
    },
    resolvePanelUrl(url) {
      return `${kbrainBackendBaseUrl()}${url}`;
    },
  };
}

/** HTML a sandboxed frame renders via srcdoc; the backend already injected its CSP meta. */
export async function loadKBrainSandboxedHtml(path: string, signal?: AbortSignal) {
  if (!path.startsWith("/v1/sessions/")) throw new Error("Unexpected sandboxed UI path");
  const response = await fetchKBrain(path, { signal, headers: { Accept: "text/html" } });
  if (!response.ok) throw new PluginsHttpError(response.status, await readErrorMessage(response));
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("text/html")) {
    throw new Error("K-brain returned a non-HTML view");
  }
  const text = await response.text();
  if (text.length > MAX_SANDBOXED_HTML_BYTES) throw new Error("View is too large");
  return text;
}

export async function listKBrainSessionPreviews(sessionId: string): Promise<HtmlPreviewRecord[]> {
  const body = (await requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/previews`)) as {
    previews?: unknown;
  };
  return Array.isArray(body?.previews)
    ? body.previews.map(parseHtmlPreview).filter((item): item is HtmlPreviewRecord => item !== null)
    : [];
}

/** A stored raw tool result (`ui_resource.result_url`): the CallToolResult, or null. */
export async function loadKBrainMcpToolResult(resultUrl: string, signal?: AbortSignal) {
  if (!isMcpUiResultUrl(resultUrl)) throw new Error("Unexpected MCP result path");
  const body = (await requestJson(resultUrl, { signal })) as { result?: unknown };
  const result = body?.result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null;
}

type McpLookup = {
  /** Full names of the server's tools (older backends). */
  names: Set<string>;
  /** Server tool name -> full name, from `serverToolName` (`mcp_tool_server_ids`). */
  byServerToolName: Map<string, string>;
  policy: Record<string, unknown> | undefined;
  label: string | undefined;
};

export type KBrainMcpLookupOptions = {
  /** Ask for the tools a view may call (`audience=app`, `mcp_tool_visibility`). */
  appAudience: boolean;
};

const mcpLookups = new Map<string, Promise<McpLookup>>();
const mcpLookupTimes = new Map<string, number>();

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

/**
 * Indexes one server's GET /v1/mcp/tools entries. Newer backends report the configured
 * id as `serverId` (the old value moved to `serverKey`) and the server's own tool name as
 * `serverToolName`; older ones report the name key as `serverId` and only `toolName`.
 */
export function indexKBrainMcpServerTools(
  serverId: string,
  toolsBody: unknown,
  settingsBody: unknown,
): McpLookup {
  const names = new Set<string>();
  const byServerToolName = new Map<string, string>();
  let label: string | undefined;
  const tools = (toolsBody as { tools?: unknown })?.tools;
  for (const tool of Array.isArray(tools) ? (tools as Record<string, unknown>[]) : []) {
    const name = readString(tool?.name);
    if (!name) continue;
    const serverToolName = readString(tool.serverToolName);
    if (serverToolName) {
      // server_ids already filters by configured id; the check guards a mixed reply.
      if (readString(tool.serverId) && tool.serverId !== serverId) continue;
      byServerToolName.set(serverToolName, name);
      label ||= readString(tool.serverLabel) || undefined;
    }
    names.add(name);
  }
  let policy: Record<string, unknown> | undefined;
  const servers = (settingsBody as { settings?: { servers?: unknown } })?.settings?.servers;
  for (const server of Array.isArray(servers) ? servers : []) {
    const record = server as { id?: unknown; policy?: unknown; name?: unknown };
    if (record?.id !== serverId) continue;
    policy =
      record.policy && typeof record.policy === "object"
        ? (record.policy as Record<string, unknown>)
        : {};
    label ||= readString(record.name).trim() || undefined;
  }
  return { names, byServerToolName, policy, label };
}

async function readMcpLookup(
  cwd: string,
  serverId: string,
  options: KBrainMcpLookupOptions,
): Promise<McpLookup> {
  const key = `${cwd}\u0000${serverId}\u0000${options.appAudience ? "app" : ""}`;
  const at = Date.now();
  const cached = mcpLookups.get(key);
  if (cached && at - (mcpLookupTimes.get(key) ?? 0) < MCP_LOOKUP_TTL_MS) return cached;
  const query = new URLSearchParams({ server_ids: serverId });
  if (cwd) query.set("cwd", cwd);
  // Only backends with `mcp_tool_visibility` know the parameter.
  if (options.appAudience) query.set("audience", "app");
  const pending = Promise.all([requestJson(`/v1/mcp/tools?${query}`), requestJson("/v1/mcp")]).then(
    ([toolsBody, settingsBody]) => indexKBrainMcpServerTools(serverId, toolsBody, settingsBody),
  );
  pending.catch(() => mcpLookups.delete(key));
  mcpLookups.set(key, pending);
  mcpLookupTimes.set(key, at);
  return pending;
}

/** Picks `toolName` out of a server lookup: by server tool name, else by name key. */
export function resolveMcpLookupTool(
  lookup: McpLookup,
  serverId: string,
  toolName: string,
): McpAppToolTarget | null {
  let fullName = lookup.byServerToolName.get(toolName);
  if (!fullName && lookup.byServerToolName.size === 0) {
    const derived = kbrainMcpToolName(serverId, toolName);
    if (lookup.names.has(derived)) fullName = derived;
  }
  if (!fullName) return null;
  return { fullName, policy: resolveMcpToolPolicy(lookup.policy, fullName) };
}

/**
 * The full name and effective policy of `toolName` on `serverId` as seen from `cwd`, or
 * null when that server does not offer the tool there (or not to views).
 */
export async function resolveKBrainMcpAppTool(
  cwd: string,
  serverId: string,
  toolName: string,
  options: KBrainMcpLookupOptions = { appAudience: false },
): Promise<McpAppToolTarget | null> {
  return resolveMcpLookupTool(await readMcpLookup(cwd, serverId, options), serverId, toolName);
}

/** The server's display name (`serverLabel`, else the settings `name`), when it has one. */
export async function readKBrainMcpServerLabel(
  cwd: string,
  serverId: string,
  options: KBrainMcpLookupOptions = { appAudience: false },
): Promise<string | undefined> {
  const label = (await readMcpLookup(cwd, serverId, options)).label;
  return label && label !== serverId ? label : undefined;
}

export type KBrainMcpCallOptions = {
  /** Send `caller: "app"` (`mcp_tool_visibility`). */
  appCaller: boolean;
  /** The approval of a repeated call (`mcp_tool_call_approval`). */
  approvalId?: string;
};

export async function callKBrainMcpTool(
  cwd: string,
  fullName: string,
  args: Record<string, unknown>,
  options: KBrainMcpCallOptions = { appCaller: false },
): Promise<McpToolCallResponse> {
  const body = await requestJson("/v1/mcp/tools/call", {
    method: "POST",
    body: JSON.stringify(
      mcpToolCallRequestBody(fullName, args, cwd, {
        ...(options.appCaller ? { caller: "app" as const } : {}),
        ...(options.approvalId ? { approvalId: options.approvalId } : {}),
      }),
    ),
  });
  return parseMcpToolCallResponse(body);
}
