import type { Api, Model } from "@liveagent/app/lib/agentTypes";
import {
  type ModelThinkingCapability,
  resolveModelThinking,
  toThinkingLevelMap,
} from "@liveagent/ui/lib/models/modelThinking";
import {
  getProviderModelDefaults,
  normalizeInputModalities,
  type ProviderId,
  type ProviderModelConfig,
} from "../../settings";

function resolveModelThinkingFields(
  capability: ModelThinkingCapability,
): Pick<Model<Api>, "reasoning"> & { thinkingLevelMap?: Model<Api>["thinkingLevelMap"] } {
  const thinkingLevelMap = toThinkingLevelMap(capability);
  return {
    reasoning: capability.reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

/**
 * Build the stable model descriptor used by the UI and agent loop.
 * Upstream routing, credentials, and wire protocol belong to K-brain.
 */
export function createModelFromConfig(
  providerId: ProviderId,
  modelId: string,
  _baseUrl: string,
  _requestFormat?: unknown,
  modelConfig?: ProviderModelConfig,
  _upstreamBaseUrl?: string,
): Model<Api> {
  const id = modelId.trim();
  if (!id) throw new Error("No model selected");
  const defaults = getProviderModelDefaults(providerId, id);
  const thinking = resolveModelThinking(providerId, id);
  const input = normalizeInputModalities(modelConfig?.inputModalities) ?? ["text"];
  const contextWindow = modelConfig?.contextWindow ?? defaults.contextWindow;
  const maxTokens = modelConfig?.maxOutputToken ?? defaults.maxOutputToken;
  return {
    id,
    name: id,
    api: "kbrain",
    provider: providerId,
    baseUrl: "",
    ...resolveModelThinkingFields(thinking),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}
