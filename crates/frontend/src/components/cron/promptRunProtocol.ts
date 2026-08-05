import type { CompletePromptRunInput } from "../../lib/automation";

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
