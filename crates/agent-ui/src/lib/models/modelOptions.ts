import type { ModelType } from "../settings/types";
import { isImageGenerationModel } from "./modelType";
import { toModelValue } from "./modelValue";

export type SharedModelOption<TProviderType extends string = string> = {
  value: string;
  label: string;
  providerId: string;
  providerName: string;
  providerType: TProviderType;
  model: string;
};

export type ModelOptionGroup<TProviderType extends string = string> = {
  id: string;
  name: string;
  providerType: TProviderType;
  opts: SharedModelOption<TProviderType>[];
};

export type ModelOptionsSettings<TProviderType extends string = string> = {
  customProviders: readonly {
    id: string;
    name: string;
    type: TProviderType;
    activeModels: readonly string[];
    /** 供应商停用后不进入选择器 */
    enabled?: boolean;
    // --- image generation (begin) -------------------------------------------
    /** 目录分区定位（生图模型判定要按预设的分区查目录）；缺省按 type 回退。 */
    presetId?: string;
    // --- image generation (end) ---------------------------------------------
    /** 可选：带 displayName 时选择器用它做标签 */
    models?: readonly { id: string; displayName?: string; modelType?: ModelType }[];
  }[];
  selectedModel?: {
    customProviderId: string;
    model: string;
  } | null;
};

export function groupModelOptionsByProvider<TProviderType extends string>(
  modelOptions: readonly SharedModelOption<TProviderType>[],
) {
  const groups: ModelOptionGroup<TProviderType>[] = [];
  const groupMap = new Map<string, ModelOptionGroup<TProviderType>>();
  for (const option of modelOptions) {
    const existing = groupMap.get(option.providerId);
    if (existing) {
      existing.opts.push(option);
      continue;
    }
    const group: ModelOptionGroup<TProviderType> = {
      id: option.providerId,
      name: option.providerName,
      providerType: option.providerType,
      opts: [option],
    };
    groupMap.set(option.providerId, group);
    groups.push(group);
  }
  return groups;
}

export type ProviderSortMode = "type" | "alpha";

const PROVIDER_SORT_MODE_STORAGE_KEY = "chatModelPickerProviderSort";

export function readStoredProviderSortMode(): ProviderSortMode {
  try {
    return localStorage.getItem(PROVIDER_SORT_MODE_STORAGE_KEY) === "alpha" ? "alpha" : "type";
  } catch {
    return "type";
  }
}

export function persistProviderSortMode(mode: ProviderSortMode): void {
  try {
    localStorage.setItem(PROVIDER_SORT_MODE_STORAGE_KEY, mode);
  } catch {
    return;
  }
}

export function sortModelOptionGroups<TProviderType extends string>(
  groups: readonly ModelOptionGroup<TProviderType>[],
  mode: ProviderSortMode,
): ModelOptionGroup<TProviderType>[] {
  if (mode === "alpha") {
    return [...groups].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  const typeOrder = new Map<string, number>();
  for (const group of groups) {
    if (!typeOrder.has(group.providerType)) typeOrder.set(group.providerType, typeOrder.size);
  }
  return [...groups].sort(
    (left, right) =>
      (typeOrder.get(left.providerType) ?? 0) - (typeOrder.get(right.providerType) ?? 0),
  );
}

export function buildModelOptions<TProviderType extends string>(
  settings: ModelOptionsSettings<TProviderType>,
  options?: { floatSelectedFirst?: boolean },
): SharedModelOption<TProviderType>[] {
  const modelOptions: SharedModelOption<TProviderType>[] = [];
  for (const provider of settings.customProviders) {
    if (provider.enabled === false) continue;
    const displayNames = new Map(
      (provider.models ?? [])
        .filter((item) => item.displayName?.trim())
        .map((item) => [item.id, item.displayName?.trim() ?? ""]),
    );
    for (const model of provider.activeModels) {
      // --- image generation (begin) -----------------------------------------
      // 生图模型不进聊天选择器：它们不走四类聊天接口，选中也发不出请求。
      if (isImageGenerationModel(provider, model)) continue;
      // --- image generation (end) -------------------------------------------
      modelOptions.push({
        providerType: provider.type,
        providerId: provider.id,
        providerName: provider.name,
        model,
        value: toModelValue(provider.id, model),
        label: displayNames.get(model) || model,
      });
    }
  }
  if (!settings.selectedModel || options?.floatSelectedFirst === false) return modelOptions;

  const selectedValue = toModelValue(
    settings.selectedModel.customProviderId,
    settings.selectedModel.model,
  );
  const selectedIndex = modelOptions.findIndex((option) => option.value === selectedValue);
  if (selectedIndex <= 0) return modelOptions;

  const [selectedOption] = modelOptions.splice(selectedIndex, 1);
  modelOptions.unshift(selectedOption);
  return modelOptions;
}
