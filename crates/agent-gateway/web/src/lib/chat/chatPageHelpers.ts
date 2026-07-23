import { type ModelOption, toModelValue } from "../providers/llm";
import type { AppSettings } from "../settings";

const MODEL_GENERATING_STATUS_PATTERN = /^第\s*\d+\s*轮：模型生成中\.\.\.$/;

export const VIBING_STATUS = "Vibing...";

export type ModelOptionGroup = {
  id: string;
  name: string;
  providerType: ModelOption["providerType"];
  opts: ModelOption[];
};

export function groupModelOptionsByProvider(modelOptions: readonly ModelOption[]) {
  const groups: ModelOptionGroup[] = [];
  const groupMap = new Map<string, ModelOptionGroup>();
  for (const option of modelOptions) {
    const existing = groupMap.get(option.providerId);
    if (existing) {
      existing.opts.push(option);
      continue;
    }
    const group: ModelOptionGroup = {
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

// 模型下拉里供应商分组的排列方式：type=按供应商类型聚簇，alpha=按供应商名称首字母排序
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
    // localStorage 不可用时仅保留会话内状态
  }
}

export function sortModelOptionGroups(
  groups: readonly ModelOptionGroup[],
  mode: ProviderSortMode,
): ModelOptionGroup[] {
  if (mode === "alpha") {
    return [...groups].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  // 类型顺序取首次出现位置，同类型内保持设置页里的原有顺序（sort 稳定）
  const typeOrder = new Map<string, number>();
  for (const group of groups) {
    if (!typeOrder.has(group.providerType)) typeOrder.set(group.providerType, typeOrder.size);
  }
  return [...groups].sort(
    (a, b) => (typeOrder.get(a.providerType) ?? 0) - (typeOrder.get(b.providerType) ?? 0),
  );
}

export function buildModelOptions(
  settings: AppSettings,
  opts?: { floatSelectedFirst?: boolean },
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of settings.customProviders) {
    for (const model of provider.activeModels) {
      options.push({
        providerType: provider.type,
        providerId: provider.id,
        providerName: provider.name,
        model,
        value: toModelValue(provider.id, model),
        label: model,
      });
    }
  }
  if (!settings.selectedModel || opts?.floatSelectedFirst === false) return options;

  const selectedValue = toModelValue(
    settings.selectedModel.customProviderId,
    settings.selectedModel.model,
  );
  const selectedIndex = options.findIndex((option) => option.value === selectedValue);
  if (selectedIndex <= 0) return options;

  const [selectedOption] = options.splice(selectedIndex, 1);
  options.unshift(selectedOption);
  return options;
}

export function normalizeLiveToolStatus(status: string | null) {
  if (status && MODEL_GENERATING_STATUS_PATTERN.test(status)) return VIBING_STATUS;
  return status;
}

export function isAbortLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("已取消") ||
    normalized.includes("abort") ||
    normalized.includes("aborted")
  );
}
