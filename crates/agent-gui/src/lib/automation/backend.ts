// Desktop (Tauri) transport for the automation store: direct invoke calls
// plus change events emitted by the Rust AutomationStore notifier. This file
// is the per-platform adapter — the web frontend ships its own copy speaking
// the gateway cron.manage protocol.

import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import type {
  AutomationApplyInput,
  AutomationSnapshot,
  CompletePromptRunInput,
  CronApplyResponse,
  CronOccurrencesResponse,
  CronRunNowResponse,
  CronRunRecord,
  CronSnapshot,
  HooksApplyResponse,
  HooksSnapshot,
  PromptCompletionResponse,
  PromptRunRequest,
} from "@liveagent/ui/lib/automation/types";
import { isKBrainBackendEnabled, isKBrainBrowserHost } from "../host";
import { requestPlanning } from "../planning/kbrain";
import {
  applyKBrainCron,
  cancelKBrainCron,
  clearKBrainCronRuns,
  fetchKBrainCron,
  listKBrainCronRuns,
  runKBrainCronNow,
  subscribeKBrainCron,
  validateKBrainCron,
} from "./kbrainCron";
import { applyKBrainHooks, fetchKBrainHooks } from "./kbrainHooks";

const CRON_CHANGED_EVENT = "automation:cron-changed";
const HOOKS_CHANGED_EVENT = "automation:hooks-changed";

export type AutomationBackendHandlers = {
  onCron: (snapshot: CronSnapshot) => void;
  onHooks: (snapshot: HooksSnapshot) => void;
};

const EMPTY_SNAPSHOT: AutomationSnapshot = {
  cron: { revision: 0, tasks: [] },
  hooks: { revision: 0, hooks: [] },
};

export const backend = {
  async fetchSnapshot(): Promise<AutomationSnapshot> {
    const native = isKBrainBackendEnabled()
      ? EMPTY_SNAPSHOT
      : isKBrainBrowserHost()
        ? EMPTY_SNAPSHOT
        : await invoke<AutomationSnapshot>("automation_snapshot");
    if (!isKBrainBackendEnabled()) return native;
    const cron = await fetchKBrainCron();
    let hooks = await fetchKBrainHooks();
    // Import native definitions only into a pristine backend store.
    if (hooks.revision === 1 && hooks.hooks.length === 0 && native.hooks.hooks.length > 0) {
      const imported = await applyKBrainHooks({
        baseRevision: hooks.revision,
        ops: native.hooks.hooks.map((hook) => ({
          op: "create",
          item: { ...hook },
        })),
      });
      hooks = imported.hooks;
    }
    return { cron, hooks };
  },

  cronApply(input: AutomationApplyInput): Promise<CronApplyResponse> {
    if (isKBrainBackendEnabled()) return applyKBrainCron(input);
    if (isKBrainBrowserHost()) {
      return Promise.reject(new Error("K-brain browser mode does not support desktop automation"));
    }
    return invoke<CronApplyResponse>("automation_cron_apply", { input });
  },

  hooksApply(input: AutomationApplyInput): Promise<HooksApplyResponse> {
    if (isKBrainBackendEnabled()) return applyKBrainHooks(input);
    return invoke<HooksApplyResponse>("automation_hooks_apply", { input });
  },

  listRuns(taskId: string, limit?: number): Promise<CronRunRecord[]> {
    if (isKBrainBackendEnabled()) return listKBrainCronRuns(taskId, limit);
    if (isKBrainBrowserHost()) return Promise.resolve([]);
    return invoke<CronRunRecord[]>("automation_list_runs", {
      task_id: taskId,
      limit: limit ?? 100,
    });
  },

  cronOccurrences(from: number, to: number): Promise<CronOccurrencesResponse> {
    if (isKBrainBackendEnabled()) return requestPlanning("cron.occurrences", { from, to });
    return invoke<CronOccurrencesResponse>("automation_cron_occurrences", { from, to });
  },

  clearRuns(taskId: string): Promise<number> {
    if (isKBrainBackendEnabled()) return clearKBrainCronRuns(taskId);
    if (isKBrainBrowserHost()) return Promise.resolve(0);
    return invoke<number>("automation_clear_runs", { task_id: taskId });
  },

  runNow(taskId: string): Promise<CronRunNowResponse> {
    if (isKBrainBackendEnabled()) return runKBrainCronNow(taskId);
    if (isKBrainBrowserHost())
      return Promise.reject(new Error("K-brain browser mode does not support desktop automation"));
    return invoke<CronRunNowResponse>("automation_run_cron_now", {
      task_id: taskId,
    });
  },

  cancelRun(taskId: string, executionId?: string): Promise<void> {
    if (isKBrainBackendEnabled())
      return cancelKBrainCron(taskId, executionId).then(() => undefined);
    return Promise.reject(new Error("Cron run cancellation is unavailable on this host"));
  },

  canCancelRun(): boolean {
    return isKBrainBackendEnabled();
  },

  claimPromptRuns(): Promise<PromptRunRequest[]> {
    if (isKBrainBackendEnabled()) return Promise.resolve([]);
    return invoke<PromptRunRequest[]>("automation_claim_prompt_runs");
  },

  releasePromptRun(executionId: string): Promise<void> {
    if (isKBrainBackendEnabled()) return Promise.resolve();
    return invoke<void>("automation_release_prompt_run", {
      execution_id: executionId,
    });
  },

  completePromptRun(input: CompletePromptRunInput): Promise<PromptCompletionResponse> {
    if (isKBrainBackendEnabled()) return Promise.resolve({ status: "already_finished" });
    return invoke<PromptCompletionResponse>("automation_complete_prompt_run", {
      input,
    });
  },

  async validateCronExpression(expression: string): Promise<void> {
    if (isKBrainBackendEnabled()) return validateKBrainCron(expression);
    if (isKBrainBrowserHost())
      throw new Error("K-brain browser mode does not support desktop automation");
    await invoke("cron_validate_expression", { expression });
  },

  subscribe(handlers: AutomationBackendHandlers): () => void {
    const stopCron = isKBrainBackendEnabled() ? subscribeKBrainCron(handlers.onCron) : () => {};
    const unlistenCron = listen<CronSnapshot>(CRON_CHANGED_EVENT, (event) => {
      if (!isKBrainBackendEnabled()) handlers.onCron(event.payload);
    });
    const unlistenHooks = listen<HooksSnapshot>(HOOKS_CHANGED_EVENT, (event) => {
      if (!isKBrainBackendEnabled()) handlers.onHooks(event.payload);
    });
    return () => {
      stopCron();
      void unlistenCron.then((unlisten) => unlisten());
      void unlistenHooks.then((unlisten) => unlisten());
    };
  },
};
