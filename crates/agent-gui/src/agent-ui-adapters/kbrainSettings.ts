import { type KBrainHealth, readKBrainHealthResponse } from "@liveagent/ui/lib/kbrain/health";
import type {
  KBrainComputerStatus,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
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

export function getKBrainHealth(): Promise<KBrainHealth> {
  return send("/v1/health").then(readKBrainHealthResponse);
}

export const kbrainSettingsAdapter: KBrainSettingsAdapter = {
  isKbrain: true,
  runtimeConnection: getKBrainRuntimeConnection,
  getConnection: getKBrainRuntimeConnection,
  getSettings: () => request<KBrainSettingsDocument>("/v1/settings"),
  getComputerStatus: () => request<KBrainComputerStatus>("/v1/computer"),
  getHealth: getKBrainHealth,
  getCapabilities: () => getKBrainHealth().then((health) => health.capabilities),
  updateSettings: (update) =>
    request<KBrainSettingsDocument>("/v1/settings", {
      method: "PUT",
      body: JSON.stringify(update),
    }),
};

export const settingsHostAdapter = {
  isKbrain: true as const,
  runtimeConnection: getKBrainRuntimeConnection,
  kbrain: kbrainSettingsAdapter,
};
