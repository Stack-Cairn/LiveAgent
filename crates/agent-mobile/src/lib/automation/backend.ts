// Web transport for the automation store: every call is relayed through the
// gateway's generic cron.manage RPC to the desktop-authoritative
// AutomationStore. Change events arrive via the settings-sync snapshot
// (automationCron / automationHooks fields), which useGatewaySettingsSync
// feeds into the store — so subscribe() has nothing to wire up here. This
// file is the per-platform adapter — the desktop frontend ships its own copy
// speaking Tauri invoke.

import type {
  AutomationApplyInput,
  AutomationSnapshot,
  CronApplyResponse,
  CronRunNowResponse,
  CronRunRecord,
  CronSnapshot,
  HooksApplyResponse,
  HooksSnapshot,
} from "@liveagent/ui/lib/automation/types";
import { getGatewayWebSocketClient } from "../gatewaySocket";
import { loadToken } from "../storage";

export type AutomationBackendHandlers = {
  onCron: (snapshot: CronSnapshot) => void;
  onHooks: (snapshot: HooksSnapshot) => void;
};

async function cronManage<T>(action: string, taskId?: string, payload?: unknown): Promise<T> {
  const response = await getGatewayWebSocketClient(loadToken().trim()).cronManage({
    action,
    task_id: taskId,
    task_json: payload === undefined ? undefined : JSON.stringify(payload),
  });
  try {
    return JSON.parse(response.result_json) as T;
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.trim()
        ? `Automation response is not valid JSON: ${error.message.trim()}`
        : "Automation response is not valid JSON",
    );
  }
}

export const backend = {
  fetchSnapshot(): Promise<AutomationSnapshot> {
    return cronManage<AutomationSnapshot>("snapshot");
  },

  cronApply(input: AutomationApplyInput): Promise<CronApplyResponse> {
    return cronManage<CronApplyResponse>("cron_apply", undefined, input);
  },

  hooksApply(input: AutomationApplyInput): Promise<HooksApplyResponse> {
    return cronManage<HooksApplyResponse>("hooks_apply", undefined, input);
  },

  async listRuns(taskId: string, limit?: number): Promise<CronRunRecord[]> {
    const payload = await cronManage<{ runs?: CronRunRecord[] }>("list_runs", taskId, {
      limit: limit ?? 100,
    });
    return Array.isArray(payload.runs) ? payload.runs : [];
  },

  async clearRuns(taskId: string): Promise<number> {
    const payload = await cronManage<{ clearedCount?: number }>("clear_runs", taskId);
    return typeof payload.clearedCount === "number" ? payload.clearedCount : 0;
  },

  runNow(taskId: string): Promise<CronRunNowResponse> {
    return cronManage<CronRunNowResponse>("run_now", taskId);
  },

  async validateCronExpression(expression: string): Promise<void> {
    await cronManage("validate", undefined, { expression });
  },

  subscribe(_handlers: AutomationBackendHandlers): () => void {
    // Snapshots are pushed through the gateway settings-sync channel and fed
    // into the store by useGatewaySettingsSync.
    return () => {};
  },
};
