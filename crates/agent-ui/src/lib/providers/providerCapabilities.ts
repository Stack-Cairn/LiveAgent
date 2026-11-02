export function resolveProviderApi(providerId: string, requestFormat?: string): string {
  if (providerId === "claude_code") return "anthropic-messages";
  if (providerId === "gemini") return "google-generative-ai";
  if (providerId === "deepseek") return "openai-completions";
  if (providerId === "xai") return "openai-responses";
  return requestFormat ?? "openai-responses";
}

export function providerSupportsNativeWebSearch(
  _providerId: string,
  api: string | undefined,
  _options?: { baseUrl?: string; modelId?: string },
) {
  // K-brain rejects native search for Chat Completions, including search-preview models.
  return (
    api === "openai-responses" || api === "anthropic-messages" || api === "google-generative-ai"
  );
}
