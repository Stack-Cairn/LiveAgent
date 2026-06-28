import { invoke } from "@tauri-apps/api/core";

const POWER_ACTIVITY_TTL_MS = 15 * 60_000;
const POWER_ACTIVITY_REFRESH_MS = Math.floor(POWER_ACTIVITY_TTL_MS / 2);

function createActivityId(scope: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${scope}:${crypto.randomUUID()}`;
  }
  return `${scope}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function beginPowerActivity(activityId: string, reason: string) {
  await invoke("system_begin_power_activity", {
    activity_id: activityId,
    reason,
    ttl_ms: POWER_ACTIVITY_TTL_MS,
  });
}

export async function withPowerActivity<T>(scope: string, reason: string, run: () => Promise<T>) {
  const activityId = createActivityId(scope);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await beginPowerActivity(activityId, reason);
    refreshTimer = setInterval(() => {
      beginPowerActivity(activityId, reason).catch((error) => {
        console.warn("system_begin_power_activity refresh failed", error);
      });
    }, POWER_ACTIVITY_REFRESH_MS);
  } catch (error) {
    console.warn("system_begin_power_activity failed", error);
  }

  try {
    return await run();
  } finally {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
    }
    try {
      await invoke("system_end_power_activity", { activity_id: activityId });
    } catch (error) {
      console.warn("system_end_power_activity failed", error);
    }
  }
}
