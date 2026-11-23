export type RunProgress = {
  stage:
    | "connecting"
    | "reconnecting"
    | "waiting_session"
    | "preparing"
    | "compacting"
    | "waiting_model"
    | "thinking"
    | "responding"
    | "tool"
    | "persisting"
    | "retrying";
  elapsed_ms?: number;
  model_request_ms?: number;
  first_thinking_ms?: number;
  first_text_ms?: number;
  client_first_text_ms?: number;
  /** While retrying: the failed attempt, out of the retries the request allows. */
  retry_attempt?: number;
  retry_max?: number;
  /** While retrying: when the next attempt starts (epoch ms, client clock). */
  retry_at_ms?: number;
};

const prefix = "kbrain-progress:";
const stages = new Set([
  "connecting",
  "reconnecting",
  "waiting_session",
  "preparing",
  "compacting",
  "waiting_model",
  "thinking",
  "responding",
  "tool",
  "persisting",
  "retrying",
]);
const numericKeys = [
  "elapsed_ms",
  "model_request_ms",
  "first_thinking_ms",
  "first_text_ms",
  "client_first_text_ms",
  "retry_attempt",
  "retry_max",
  "retry_at_ms",
] as const;

export function parseRunProgress(value: unknown): RunProgress | null {
  try {
    const decoded: unknown =
      typeof value === "string" && value.startsWith(prefix)
        ? JSON.parse(value.slice(prefix.length))
        : value;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const input = decoded as Record<string, unknown>;
    if (typeof input.stage !== "string" || !stages.has(input.stage)) return null;
    const progress: RunProgress = { stage: input.stage as RunProgress["stage"] };
    for (const key of numericKeys) {
      const field = input[key];
      if (typeof field === "number" && Number.isFinite(field) && field >= 0) progress[key] = field;
    }
    return progress;
  } catch {
    return null;
  }
}

export function encodeRunProgress(progress: RunProgress): string {
  return prefix + JSON.stringify(progress);
}
