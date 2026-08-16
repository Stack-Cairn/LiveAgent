import { findCatalogModel } from "./modelCatalog";
import { isAnthropicAdaptiveModelId } from "./modelThinking";

export { isAnthropicAdaptiveModelId };

export const ANTHROPIC_STANDARD_CONTEXT_WINDOW = 200_000;
export const ANTHROPIC_LONG_CONTEXT_WINDOW = 1_000_000;

export function hasAnthropicLongContextSuffix(modelId: string): boolean {
  return /\[1m\]$/i.test(modelId.trim());
}

function getAnthropicEndpointHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function shouldSendAnthropicLongContextHeader(baseUrl: string | undefined): boolean {
  const host = getAnthropicEndpointHost(baseUrl);
  if (!host) return false;
  return !(
    host === "api.anthropic.com" ||
    host.includes("aiplatform.googleapis.com") ||
    host.includes("vertexai.googleapis.com") ||
    host.endsWith(".amazonaws.com")
  );
}

function effectiveAnthropicContextWindow(
  knownContextWindow: number,
  modelId: string,
  baseUrl?: string,
): number {
  if (isAnthropicAdaptiveModelId(modelId)) return knownContextWindow;
  if (
    hasAnthropicLongContextSuffix(modelId) &&
    (baseUrl === undefined || shouldSendAnthropicLongContextHeader(baseUrl))
  ) {
    return ANTHROPIC_LONG_CONTEXT_WINDOW;
  }
  return Math.min(knownContextWindow, ANTHROPIC_STANDARD_CONTEXT_WINDOW);
}

export function resolveAnthropicContextWindow(
  modelId: string,
  configuredContextWindow: number,
  baseUrl?: string,
): number {
  const known = findCatalogModel("claude_code", modelId);
  if (isAnthropicAdaptiveModelId(modelId)) {
    return Math.max(configuredContextWindow, known?.contextWindow ?? ANTHROPIC_LONG_CONTEXT_WINDOW);
  }
  if (hasAnthropicLongContextSuffix(modelId)) {
    if (baseUrl === undefined || shouldSendAnthropicLongContextHeader(baseUrl)) {
      return Math.max(configuredContextWindow, ANTHROPIC_LONG_CONTEXT_WINDOW);
    }
    return known
      ? effectiveAnthropicContextWindow(known.contextWindow, modelId, baseUrl)
      : Math.min(configuredContextWindow, ANTHROPIC_STANDARD_CONTEXT_WINDOW);
  }
  if (
    known &&
    baseUrl !== undefined &&
    shouldSendAnthropicLongContextHeader(baseUrl) &&
    configuredContextWindow > ANTHROPIC_STANDARD_CONTEXT_WINDOW
  ) {
    return configuredContextWindow;
  }
  return known
    ? effectiveAnthropicContextWindow(known.contextWindow, modelId, baseUrl)
    : configuredContextWindow;
}

export function resolveAnthropicKnownModelLimits(
  modelId: string | undefined,
  baseUrl?: string,
): { contextWindow: number; maxOutputToken: number } | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  const known = findCatalogModel("claude_code", trimmedId);
  if (!known) return undefined;
  return {
    contextWindow: resolveAnthropicContextWindow(trimmedId, known.contextWindow, baseUrl),
    maxOutputToken: known.maxOutputToken,
  };
}
