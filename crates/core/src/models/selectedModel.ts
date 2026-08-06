// SelectedModel 领域：类型 + 归一化/序列化。原先埋在 settings/index.ts 里，
// 收进 models/ 作为模型选择的单一定义处；settings 仅 re-export 保持旧路径可用。

export type SelectedModel = {
  customProviderId: string;
  model: string;
};

export function normalizeSelectedModel(input: unknown): SelectedModel | undefined {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const customProviderId =
    typeof obj.customProviderId === "string" ? obj.customProviderId.trim() : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";

  if (!customProviderId || !model) return undefined;
  return { customProviderId, model };
}

export function parseSelectedModelJson(json: string | null | undefined): SelectedModel | undefined {
  if (!json?.trim()) return undefined;
  try {
    return normalizeSelectedModel(JSON.parse(json));
  } catch {
    return undefined;
  }
}

export function serializeSelectedModelJson(
  selectedModel: SelectedModel | undefined,
): string | undefined {
  const normalized = normalizeSelectedModel(selectedModel);
  return normalized ? JSON.stringify(normalized) : undefined;
}

// 结构化最小依赖：只要求 id + activeModels，避免反向依赖 settings 的 CustomProvider。
export function normalizeSelectedModelForProviders(
  selectedModel: SelectedModel | undefined,
  customProviders: ReadonlyArray<{ id: string; activeModels: string[] }>,
): SelectedModel | undefined {
  if (!selectedModel) {
    return undefined;
  }

  const provider = customProviders.find((item) => item.id === selectedModel.customProviderId);
  if (!provider) {
    return undefined;
  }

  return provider.activeModels.includes(selectedModel.model) ? selectedModel : undefined;
}
