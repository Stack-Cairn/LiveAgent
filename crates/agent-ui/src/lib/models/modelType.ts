// 模型用途判定（chat / image）：图像生成不经四类聊天接口，而是由内置
// generate_image 工具直接打 OpenAI Images 或 Gemini generateContent
// （设计文档 §6.7）。这里是该判定的单一入口，选择器、连通性测试、
// 工具执行与设置归一化都读它。
//
// 优先级：用户显式覆盖（model.modelType）> 目录 outputModalities 含 "image"
// > 模型 id 启发式 > chat。

import { findProviderPreset, presetIdForLegacyType } from "../providers/registry";
import type { ModelType } from "../settings/types";
import { findCatalogModelInSection, findCatalogModelMatchAcrossProviders } from "./modelCatalog";

export type ModelTypeSource = "user" | "catalog" | "heuristic";

export type ResolvedModelType = { type: ModelType; source: ModelTypeSource };

/**
 * 生图模型 id 的启发式：目录没覆盖的中转 / 自建渠道靠命名兜底。
 * 只认已知的生图模型家族与结尾的 `-image` 段，避免把 "image understanding"
 * 之类的聊天模型（gpt-4o、gemini-*-vision）误判成生图。
 */
const IMAGE_MODEL_ID_PATTERN =
  /(^|[-/])(gpt-image|dall-e|imagen|flux|stable-diffusion|sd3|kolors|cogview|wanx|hunyuan-image|seedream|-image($|-))/i;

/** 仅按模型 id 判断是否为生图模型（没有供应商上下文时的兜底）。 */
export function isImageGenerationModelId(modelId: string): boolean {
  return IMAGE_MODEL_ID_PATTERN.test(modelId.trim());
}

/**
 * 判定只需要"目录分区从哪来"与"模型有没有显式覆盖"。放宽到 string 是为了
 * 兼容选择器那层的泛型 providerType（结构上与 CustomProvider 一致）。
 */
export type ModelTypeProvider = {
  type?: string;
  presetId?: string;
  models?: readonly { id: string; modelType?: ModelType }[];
};

function findModelType(provider: ModelTypeProvider, modelId: string): ModelType | undefined {
  const id = modelId.trim();
  return provider.models?.find((item) => item.id === id)?.modelType;
}

/**
 * 与 modelCapabilities.resolveModelCatalogInfo 同一口径（先查预设自己的分区，
 * 再跨分区回查）。这里不复用那个导出，是为了不让 settings 归一化经
 * modelCapabilities 绕回 settings 形成循环依赖——本模块只依赖目录与预设表。
 */
function findCatalogEntry(provider: ModelTypeProvider, modelId: string) {
  const preset = findProviderPreset(
    provider.presetId ?? presetIdForLegacyType(provider.type ?? ""),
  );
  const scoped = preset?.catalogProviderId
    ? findCatalogModelInSection(preset.catalogProviderId, modelId)
    : undefined;
  return (scoped ?? findCatalogModelMatchAcrossProviders(modelId))?.entry;
}

/**
 * 解析模型用途与判定来源。
 * - user：模型配置里写了 modelType（设置页手动切换）。
 * - catalog：目录条目的 outputModalities 含 "image"。
 * - heuristic：目录没命中时按 id 匹配已知生图家族；都不中即 chat。
 */
export function resolveModelType(provider: ModelTypeProvider, modelId: string): ResolvedModelType {
  const id = modelId.trim();
  const explicit = findModelType(provider, id);
  if (explicit) return { type: explicit, source: "user" };

  const catalog = findCatalogEntry(provider, id);
  if (catalog?.outputModalities?.includes("image")) return { type: "image", source: "catalog" };

  if (isImageGenerationModelId(id)) return { type: "image", source: "heuristic" };
  return { type: "chat", source: catalog ? "catalog" : "heuristic" };
}

/** 该模型是否走图像生成链路（选择器排除、连通性测试跳过都用它）。 */
export function isImageGenerationModel(provider: ModelTypeProvider, modelId: string): boolean {
  return resolveModelType(provider, modelId).type === "image";
}

/**
 * 供应商里所有 image 类型模型的本地 id（只看已启用的模型列表）。
 * 顺序按 activeModels，供"第一个可用生图模型"的兜底选择使用。
 */
export function listImageGenerationModels(
  provider: ModelTypeProvider & { activeModels: readonly string[] },
): string[] {
  return provider.activeModels.filter((modelId) => isImageGenerationModel(provider, modelId));
}
