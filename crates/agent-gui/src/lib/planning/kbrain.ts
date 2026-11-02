import { invoke } from "@liveagent/app/shims/tauriCore";
import { followBrowserPlanning } from "@liveagent/ui/lib/planning/browserTimeZone";
import { isTauriHost } from "../host";
import { kBrainStorageScope } from "../kbrain/mapping";
import { fetchKBrain } from "../kbrain/transport";
import { observeTimeZoneResponse, reportTimeZoneFailure } from "./timeZoneNotice";

const migrations = new Map<string, Promise<void>>();

async function migrateOnDemand(action: string) {
  if (
    !isTauriHost() ||
    !(
      ["query", "export", "mutate", "import"].includes(action) || action.startsWith("subscription.")
    )
  )
    return;
  const scope = kBrainStorageScope();
  let pending = migrations.get(scope);
  if (!pending) {
    pending = invoke<void>("planning_migrate_legacy");
    migrations.set(scope, pending);
  }
  try {
    await pending;
  } catch (error) {
    migrations.delete(scope);
    throw error;
  }
}

export async function requestPlanning<T>(action: string, input: unknown = {}): Promise<T> {
  const scope = kBrainStorageScope();
  try {
    let result = await sendPlanning<T>(action, input);
    if (!isTauriHost())
      result = await followBrowserPlanning(scope, action, result, () =>
        sendPlanning<{ preference?: unknown }>("timezone.get", {}),
      );
    observeTimeZoneResponse(scope, action, result);
    return result;
  } catch (error) {
    reportTimeZoneFailure(scope, error);
    throw error;
  }
}

async function sendPlanning<T>(action: string, input: unknown): Promise<T> {
  await migrateOnDemand(action);
  const response = await fetchKBrain(
    "/v1/planning",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, input }),
    },
    {},
    ["query", "export", "cron.occurrences", "timezone.get"].includes(action),
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `K-brain Planning request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
