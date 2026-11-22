// Desktop access to K-brain's sandboxed UI routes: plugins (list, long-poll, manage,
// call a plugin's own tool), MCP App view HTML, HTML previews, and the MCP tool lookup an
// App view's tools/call needs. Every request carries the bearer token through fetchKBrain;
// pages themselves never see it.

import { type HtmlPreviewRecord, parseHtmlPreview } from "@liveagent/ui/lib/chat/htmlPreviews";
import { kbrainMcpToolName, resolveMcpToolPolicy } from "@liveagent/ui/lib/chat/mcpApps";
import { hasFrozenCapability, readKBrainHealthResponse } from "@liveagent/ui/lib/kbrain/health";
import {
  KBRAIN_HTML_PREVIEWS_CAPABILITY,
  KBRAIN_MCP_APPS_CAPABILITY,
  KBRAIN_PLUGIN_UI_CAPABILITY,
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
};

const NO_CAPABILITIES: KBrainSandboxedUiCapabilities = {
  plugins: false,
  pluginUi: false,
  mcpApps: false,
  htmlPreviews: false,
};

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
    .then((health) => ({
      plugins: hasFrozenCapability(health, KBRAIN_PLUGINS_CAPABILITY),
      pluginUi: hasFrozenCapability(health, KBRAIN_PLUGIN_UI_CAPABILITY),
      mcpApps: hasFrozenCapability(health, KBRAIN_MCP_APPS_CAPABILITY),
      htmlPreviews: hasFrozenCapability(health, KBRAIN_HTML_PREVIEWS_CAPABILITY),
    }))
    .catch(() => {
      capabilityRead = null;
      return NO_CAPABILITIES;
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
      })) as { output?: unknown; failed?: unknown; cancelled?: unknown };
      return {
        output: typeof body?.output === "string" ? body.output : "",
        failed: body?.failed === true || body?.cancelled === true,
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

type McpLookup = { at: number; names: Set<string>; policies: Map<string, Record<string, unknown>> };
const mcpLookups = new Map<string, Promise<McpLookup>>();
const mcpLookupTimes = new Map<string, number>();

async function readMcpLookup(cwd: string, serverId: string): Promise<McpLookup> {
  const key = `${cwd}\u0000${serverId}`;
  const at = Date.now();
  const cached = mcpLookups.get(key);
  if (cached && at - (mcpLookupTimes.get(key) ?? 0) < MCP_LOOKUP_TTL_MS) return cached;
  const query = new URLSearchParams({ server_ids: serverId });
  if (cwd) query.set("cwd", cwd);
  const pending = Promise.all([requestJson(`/v1/mcp/tools?${query}`), requestJson("/v1/mcp")]).then(
    ([toolsBody, settingsBody]) => {
      const names = new Set<string>();
      for (const tool of ((toolsBody as { tools?: unknown })?.tools as unknown[]) ?? []) {
        const name = (tool as { name?: unknown })?.name;
        if (typeof name === "string") names.add(name);
      }
      const policies = new Map<string, Record<string, unknown>>();
      const servers = (settingsBody as { settings?: { servers?: unknown } })?.settings?.servers;
      for (const server of Array.isArray(servers) ? servers : []) {
        const record = server as { id?: unknown; policy?: unknown };
        if (typeof record?.id !== "string") continue;
        policies.set(
          record.id,
          record.policy && typeof record.policy === "object"
            ? (record.policy as Record<string, unknown>)
            : {},
        );
      }
      return { at, names, policies };
    },
  );
  pending.catch(() => mcpLookups.delete(key));
  mcpLookups.set(key, pending);
  mcpLookupTimes.set(key, at);
  return pending;
}

/**
 * The full name and effective policy of `toolName` on `serverId` as seen from `cwd`, or
 * null when that server does not offer the tool there.
 */
export async function resolveKBrainMcpAppTool(
  cwd: string,
  serverId: string,
  toolName: string,
): Promise<McpAppToolTarget | null> {
  const fullName = kbrainMcpToolName(serverId, toolName);
  const lookup = await readMcpLookup(cwd, serverId);
  if (!lookup.names.has(fullName)) return null;
  return { fullName, policy: resolveMcpToolPolicy(lookup.policies.get(serverId), fullName) };
}

export async function callKBrainMcpTool(
  cwd: string,
  fullName: string,
  args: Record<string, unknown>,
): Promise<{ output: string; failed: boolean }> {
  const body = (await requestJson("/v1/mcp/tools/call", {
    method: "POST",
    body: JSON.stringify({ name: fullName, arguments: args, ...(cwd ? { cwd } : {}) }),
  })) as { output?: unknown; failed?: unknown; cancelled?: unknown };
  return {
    output: typeof body?.output === "string" ? body.output : "",
    failed: body?.failed === true || body?.cancelled === true,
  };
}
