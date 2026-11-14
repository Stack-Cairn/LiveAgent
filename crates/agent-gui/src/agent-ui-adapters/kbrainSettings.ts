import { type KBrainHealth, readKBrainHealthResponse } from "@liveagent/ui/lib/kbrain/health";
import {
  readSandboxSetupResponse,
  type SandboxSetupOutcome,
} from "@liveagent/ui/lib/kbrain/sandboxSetup";
import {
  recordWebSearchFallbackState,
  webSearchFallbackStateFrom,
} from "@liveagent/ui/lib/providers/webSearchFallback";
import type {
  KBrainComputerStatus,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
  PermissionRule,
  PermissionRuleList,
} from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import { getKBrainRuntimeConnection } from "../lib/kbrain/runtimeConnection";

async function send(path: string, init?: RequestInit): Promise<Response> {
  const connection = getKBrainRuntimeConnection();
  if (!connection) throw new Error("K-brain backend connection is not ready");
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok)
    throw new Error((await response.text()) || `K-brain request failed (${response.status})`);
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await send(path, init)).json()) as T;
}

// The rules API answers errors as {"error": "..."}; show the message, not the JSON.
async function rulesRequest<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
    } catch {}
    throw new Error(message);
  }
}

type WirePermissionRule = {
  id: string;
  rule: string;
  effect: PermissionRule["effect"];
  scope: PermissionRule["scope"];
  created_at?: string;
  source_session?: string;
};

function permissionRuleFromWire(rule: WirePermissionRule): PermissionRule {
  return {
    id: rule.id,
    rule: rule.rule,
    effect: rule.effect,
    scope: rule.scope,
    ...(rule.created_at ? { createdAt: rule.created_at } : {}),
    ...(rule.source_session ? { sourceSession: rule.source_session } : {}),
  };
}

function rulesQuery(values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function getKBrainHealth(): Promise<KBrainHealth> {
  return send("/v1/health").then(readKBrainHealthResponse);
}

/**
 * Runs K-brain's Windows sandbox setup (`POST /v1/sandbox/setup`). The backend shows
 * a UAC prompt on its own desktop and answers only once the user chose, so there is
 * no client timeout; every status, including errors, comes back as an outcome.
 */
export async function setUpKBrainSandbox(): Promise<SandboxSetupOutcome> {
  const connection = getKBrainRuntimeConnection();
  if (!connection) throw new Error("K-brain backend connection is not ready");
  const response = await fetch(`${connection.baseUrl}/v1/sandbox/setup`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
    },
  });
  return readSandboxSetupResponse(response);
}

// Every settings document read here also updates the web search fallback state the
// composer and the run gate use.
function recordWebSearch(document: KBrainSettingsDocument): KBrainSettingsDocument {
  recordWebSearchFallbackState(webSearchFallbackStateFrom(document));
  return document;
}

export const kbrainSettingsAdapter: KBrainSettingsAdapter = {
  isKbrain: true,
  runtimeConnection: getKBrainRuntimeConnection,
  getConnection: getKBrainRuntimeConnection,
  getSettings: () => request<KBrainSettingsDocument>("/v1/settings").then(recordWebSearch),
  getComputerStatus: () => request<KBrainComputerStatus>("/v1/computer"),
  getHealth: getKBrainHealth,
  getCapabilities: () => getKBrainHealth().then((health) => health.capabilities),
  updateSettings: (update) =>
    request<KBrainSettingsDocument>("/v1/settings", {
      method: "PUT",
      body: JSON.stringify(update),
    }).then(recordWebSearch),
  listPermissionRules: async ({ workspace }) => {
    const list = await rulesRequest<{ project_root?: string; rules?: WirePermissionRule[] }>(
      `/v1/permissions/rules${rulesQuery({ workspace })}`,
    );
    return {
      ...(list.project_root ? { projectRoot: list.project_root } : {}),
      rules: (list.rules ?? []).map(permissionRuleFromWire),
    } satisfies PermissionRuleList;
  },
  addPermissionRule: async (input) =>
    permissionRuleFromWire(
      await rulesRequest<WirePermissionRule>("/v1/permissions/rules", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    ),
  deletePermissionRule: async ({ id, scope, workspace }) => {
    await rulesRequest<unknown>(
      `/v1/permissions/rules/${encodeURIComponent(id)}${rulesQuery({ scope, workspace })}`,
      { method: "DELETE" },
    );
  },
};

export const settingsHostAdapter = {
  isKbrain: true as const,
  runtimeConnection: getKBrainRuntimeConnection,
  kbrain: kbrainSettingsAdapter,
};
