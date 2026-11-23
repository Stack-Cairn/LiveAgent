import type { TurnErrorDetail } from "./turnError";

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

/** The stopped reply was cut off by a backend restart rather than by the user. */
export function isInterruptedByShutdown(
  rounds: readonly { meta?: { stopReason?: string; cancelReason?: string } }[],
) {
  const meta = rounds.at(-1)?.meta;
  return meta?.stopReason === "aborted" && meta.cancelReason === "shutdown";
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

/** The backend's structured detail for a failed reply's error, if it sent one. */
export function turnErrorDetailOf(
  rounds: readonly { meta?: { stopReason?: string; errorDetail?: TurnErrorDetail } }[],
): TurnErrorDetail | null {
  const meta = rounds.at(-1)?.meta;
  return meta?.stopReason === "error" ? (meta.errorDetail ?? null) : null;
}
