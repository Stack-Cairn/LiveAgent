// K-brain owns provider credentials and usage execution. The GUI sends only provider IDs
// and draft metadata to the canonical local backend; vendor endpoints are never browser-facing.
import {
  type ProviderUsageResult,
  type UsageQueryProvider,
  useProviderUsageWithQuery,
} from "@liveagent/ui/lib/providers/usageQueryCore";
import { fetchKBrain } from "../kbrain/transport";
import type { UsageQueryConfig } from "../settings";

export * from "@liveagent/ui/lib/providers/usageQueryCore";

async function requestProviderUsage<T>(path: string, body: unknown): Promise<T> {
  const response = await fetchKBrain(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw.trim();
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      message = parsed.error || message;
    } catch {
      // Keep non-JSON backend errors readable.
    }
    throw new Error(message || `K-brain provider usage failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function queryProviderUsage(
  providerId: string,
  refresh: boolean,
): Promise<ProviderUsageResult | null> {
  return requestProviderUsage<ProviderUsageResult | null>(
    `/v1/providers/${encodeURIComponent(providerId)}/usage`,
    { refresh },
  );
}

/** Test a complete editor draft without changing persisted settings or the backend cache. */
export async function testProviderUsage(
  providerId: string,
  config: UsageQueryConfig,
): Promise<ProviderUsageResult | null> {
  return requestProviderUsage<ProviderUsageResult | null>(
    `/v1/providers/${encodeURIComponent(providerId)}/usage/test`,
    { config },
  );
}

export function useProviderUsage(providers: readonly UsageQueryProvider[]) {
  return useProviderUsageWithQuery(queryProviderUsage, providers);
}
