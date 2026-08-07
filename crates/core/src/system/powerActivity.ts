import { callBackend } from "../backendClient";

import { createUuid } from "../shared/id";

const POWER_ACTIVITY_TTL_MS = 15 * 60_000;
const POWER_ACTIVITY_REFRESH_MS = Math.floor(POWER_ACTIVITY_TTL_MS / 2);

function createActivityId(scope: string) {
  return `${scope}:${createUuid()}`;
}

async function beginPowerActivity(activityId: string, reason: string) {
  // 后端命令声明 rename_all = "snake_case"，参数 key 必须逐字一致。
  await callBackend("system_begin_power_activity", {
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
      await callBackend("system_end_power_activity", { activity_id: activityId });
    } catch (error) {
      console.warn("system_end_power_activity failed", error);
    }
  }
}
