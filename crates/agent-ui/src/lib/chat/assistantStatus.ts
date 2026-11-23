const MODEL_GENERATING_STATUS_PATTERN = /^第\s*\d+\s*轮：模型生成中\.\.\.$/;

export const VIBING_STATUS = "Vibing...";

export function normalizeLiveToolStatus(status: string | null) {
  if (status && MODEL_GENERATING_STATUS_PATTERN.test(status)) return VIBING_STATUS;
  return status;
}

/** The reply ended because the user stopped it: its last round settled as aborted. */
export function isStoppedReply(rounds: readonly { meta?: { stopReason?: string } }[]) {
  return rounds.at(-1)?.meta?.stopReason === "aborted";
}

/**
 * The error a failed reply ended with: its last round settled as an error and
 * carries the backend's message. Null for every other reply.
 */
export function turnErrorOf(
  rounds: readonly { meta?: { stopReason?: string; errorMessage?: string } }[],
): string | null {
  const meta = rounds.at(-1)?.meta;
  return meta?.stopReason === "error" && meta.errorMessage?.trim() ? meta.errorMessage : null;
}
