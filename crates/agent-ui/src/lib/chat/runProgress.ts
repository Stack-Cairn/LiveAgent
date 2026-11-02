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
    | "persisting";
  elapsed_ms?: number;
  model_request_ms?: number;
  first_thinking_ms?: number;
  first_text_ms?: number;
  client_first_text_ms?: number;
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
]);
const timingKeys = [
  "elapsed_ms",
  "model_request_ms",
  "first_thinking_ms",
  "first_text_ms",
  "client_first_text_ms",
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
    for (const key of timingKeys) {
      const timing = input[key];
      if (typeof timing === "number" && Number.isFinite(timing) && timing >= 0)
        progress[key] = timing;
    }
    return progress;
  } catch {
    return null;
  }
}

export function encodeRunProgress(progress: RunProgress): string {
  return prefix + JSON.stringify(progress);
}
