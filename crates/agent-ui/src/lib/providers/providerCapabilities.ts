import type { ProviderId } from "../settings/types";

export function resolveProviderApi(providerId: string, requestFormat?: string): string {
  if (providerId === "claude_code") return "anthropic-messages";
  if (providerId === "gemini") return "google-generative-ai";
  if (providerId === "deepseek") return "openai-completions";
  if (providerId === "xai") return "openai-responses";
  return requestFormat ?? "openai-responses";
}

const PROVIDER_IDS: readonly ProviderId[] = ["codex", "claude_code", "gemini", "xai", "deepseek"];

/**
 * LiveAgent provider type of a K-brain provider entry. K-brain keeps an
 * explicit `type` as given and speaks the protocol named by `api`; it derives
 * `api` from `type` only when `api` is empty (internal/config), so a
 * hand-written provider can carry `api` alone. Without a valid `type` the
 * type therefore follows `api`, the inverse of resolveProviderApi. The
 * desktop app and the WebUI must both use this rule, or a bridged turn
 * names a provider type the desktop does not have.
 */
export function resolveKBrainProviderType(provider: { type?: unknown; api?: unknown }): ProviderId {
  if (PROVIDER_IDS.includes(provider.type as ProviderId)) return provider.type as ProviderId;
  switch (provider.api) {
    case "anthropic-messages":
      return "claude_code";
    case "google-generative-ai":
      return "gemini";
    default:
      return "codex";
  }
}

/** Request format of a K-brain provider entry: explicit, else implied by `api`. */
export function resolveKBrainRequestFormat(provider: {
  requestFormat?: unknown;
  api?: unknown;
}): string | undefined {
  if (typeof provider.requestFormat === "string" && provider.requestFormat) {
    return provider.requestFormat;
  }
  return provider.api === "openai-completions" ? "openai-completions" : undefined;
}

export function providerSupportsNativeWebSearch(
  _providerId: string,
  api: string | undefined,
  options?: { baseUrl?: string; modelId?: string; nativeWebSearchSupported?: boolean },
) {
  // K-brain's provider flag describes the API family, not each model. Flash
  // adds server tools to Chat Completions even when that family reports false.
  if (api === "openai-completions" && options?.modelId?.toLowerCase() === "deepseek-flash") {
    return true;
  }
  return (
    options?.nativeWebSearchSupported ??
    (api === "openai-responses" || api === "anthropic-messages" || api === "google-generative-ai")
  );
}
