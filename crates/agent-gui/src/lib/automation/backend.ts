// Desktop (Tauri) transport for the automation store: direct invoke calls
// plus change events emitted by the Rust AutomationStore notifier. This file
// is the per-platform adapter — the web frontend ships its own copy speaking
// the gateway cron.manage protocol.

import { invoke } from "../../lib/tauriBridge";
import { listen } from "../../lib/tauriBridge";

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

const CRON_CHANGED_EVENT = "automation:cron-changed";
const HOOKS_CHANGED_EVENT = "automation:hooks-changed";

export type AutomationBackendHandlers = {
  onCron: (snapshot: CronSnapshot) => void;
  onHooks: (snapshot: HooksSnapshot) => void;
};

export const backend = {
  fetchSnapshot(): Promise<AutomationSnapshot> {
    return invoke<AutomationSnapshot>("automation_snapshot");
  },

  cronApply(input: AutomationApplyInput): Promise<CronApplyResponse> {
    return invoke<CronApplyResponse>("automation_cron_apply", { input });
  },

  hooksApply(input: AutomationApplyInput): Promise<HooksApplyResponse> {
    return invoke<HooksApplyResponse>("automation_hooks_apply", { input });
  },

  listRuns(taskId: string, limit?: number): Promise<CronRunRecord[]> {
    return invoke<CronRunRecord[]>("automation_list_runs", {
      task_id: taskId,
      limit: limit ?? 100,
    });
  },

  clearRuns(taskId: string): Promise<number> {
    return invoke<number>("automation_clear_runs", { task_id: taskId });
  },

  runNow(taskId: string): Promise<CronRunNowResponse> {
    return invoke<CronRunNowResponse>("automation_run_cron_now", { task_id: taskId });
  },

  claimPromptRuns(): Promise<PromptRunRequest[]> {
    return invoke<PromptRunRequest[]>("automation_claim_prompt_runs");
  },

  releasePromptRun(executionId: string): Promise<void> {
    return invoke<void>("automation_release_prompt_run", {
      execution_id: executionId,
    });
  },

  completePromptRun(input: CompletePromptRunInput): Promise<PromptCompletionResponse> {
    return invoke<PromptCompletionResponse>("automation_complete_prompt_run", { input });
  },

  async validateCronExpression(expression: string): Promise<void> {
    await invoke("cron_validate_expression", { expression });
  },

  subscribe(handlers: AutomationBackendHandlers): () => void {
    const unlistenCron = listen<CronSnapshot>(CRON_CHANGED_EVENT, (event) => {
      handlers.onCron(event.payload);
    });
    const unlistenHooks = listen<HooksSnapshot>(HOOKS_CHANGED_EVENT, (event) => {
      handlers.onHooks(event.payload);
    });
    return () => {
      void unlistenCron.then((unlisten) => unlisten());
      void unlistenHooks.then((unlisten) => unlisten());
    };
  },
};
