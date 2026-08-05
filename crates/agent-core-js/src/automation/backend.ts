// Desktop (Tauri) transport for the automation store: direct invoke calls
// plus change events emitted by the Rust AutomationStore notifier. This file
// is the per-platform adapter — the web frontend ships its own copy speaking
// the gateway cron.manage protocol.

import { callBackend } from "../backendClient";

import type {
  AutomationApplyInput,
  AutomationSnapshot,
  CompletePromptRunInput,
  CronApplyResponse,
  CronRunNowResponse,
  CronRunRecord,
  CronSnapshot,
  HooksApplyResponse,
  HooksSnapshot,
  PromptCompletionResponse,
  PromptRunRequest,
} from "./types";

export type AutomationBackendHandlers = {
  onCron: (snapshot: CronSnapshot) => void;
  onHooks: (snapshot: HooksSnapshot) => void;
};

export const backend = {
  fetchSnapshot(): Promise<AutomationSnapshot> {
    return callBackend<AutomationSnapshot>("automation_snapshot");
  },

  cronApply(input: AutomationApplyInput): Promise<CronApplyResponse> {
    return callBackend<CronApplyResponse>("automation_cron_apply", { input });
  },

  hooksApply(input: AutomationApplyInput): Promise<HooksApplyResponse> {
    return callBackend<HooksApplyResponse>("automation_hooks_apply", { input });
  },

  listRuns(taskId: string, limit?: number): Promise<CronRunRecord[]> {
    return callBackend<CronRunRecord[]>("automation_list_runs", {
      task_id: taskId,
      limit: limit ?? 100,
    });
  },

  clearRuns(taskId: string): Promise<number> {
    return callBackend<number>("automation_clear_runs", { task_id: taskId });
  },

  runNow(taskId: string): Promise<CronRunNowResponse> {
    return callBackend<CronRunNowResponse>("automation_run_cron_now", { task_id: taskId });
  },

  claimPromptRuns(): Promise<PromptRunRequest[]> {
    return callBackend<PromptRunRequest[]>("automation_claim_prompt_runs");
  },

  releasePromptRun(executionId: string): Promise<void> {
    return callBackend<void>("automation_release_prompt_run", {
      execution_id: executionId,
    });
  },

  completePromptRun(input: CompletePromptRunInput): Promise<PromptCompletionResponse> {
    return callBackend<PromptCompletionResponse>("automation_complete_prompt_run", { input });
  },

  async validateCronExpression(expression: string): Promise<void> {
    await callBackend("cron_validate_expression", { expression });
  },

  subscribe(_handlers: AutomationBackendHandlers): () => void {
    // 引擎侧没有事件推送通道:cron/hooks 变更事件只服务桌面 UI 的实时刷新。
    // 引擎读快照的路径(cronTools)每次都显式 refreshAutomationSnapshot,
    // 所以这里不订阅也不会读到陈旧状态。
    return () => {};
  },
};
