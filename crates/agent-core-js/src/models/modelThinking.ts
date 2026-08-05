export type ModelThinkingCapability = any;
export type ThinkingLevelMap = any;

export function resolveModelThinking(model: any): ModelThinkingCapability {
  return {};
}

export function toThinkingLevelMap(model: any): ThinkingLevelMap {
  return {};
}

export function anthropicModelSupportsXHigh(model: string): boolean {
  return false;
}

export function isAnthropicAdaptiveModelId(id: string): boolean {
  return false;
}
