export function appendSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  if (!head) return suffix;
  return `${head}\n\n${suffix}`;
}

export function resolveMaxTokens(requestedMaxTokens: number | undefined, modelMaxTokens: number) {
  if (!requestedMaxTokens || requestedMaxTokens <= 0) return modelMaxTokens;
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

export function normalizeSessionId(sessionId: string | undefined) {
  const value = sessionId?.trim();
  return value ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
