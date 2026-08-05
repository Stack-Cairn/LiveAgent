export function normalizeConversationSystemPrompt(systemPrompt: string | undefined) {
  if (typeof systemPrompt !== "string") return undefined;

  const trimmed = systemPrompt.trim();
  if (!trimmed) return undefined;

  return trimmed;
}
