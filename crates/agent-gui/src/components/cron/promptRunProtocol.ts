import type { CompletePromptRunInput } from "@liveagent/ui/lib/automation/index";

export const PROMPT_RUN_RECONCILE_INTERVAL_MS = 15_000;

export function createCompletePromptRunInput(
  executionId: string,
  success: boolean,
  durationMs: number,
  output: string,
): CompletePromptRunInput {
  return {
    executionId,
    success,
    durationMs,
    output,
  };
}
