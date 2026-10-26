import { findCatalogModelAcrossProviders } from "@liveagent/ui/lib/models/modelCatalog";
import { resolveProviderApi } from "@liveagent/ui/lib/providers/providerCapabilities";
import {
  type AppSettings,
  type CustomProvider,
  normalizeCustomProvider,
  type ProviderId,
} from "../settings";
import { createKBrainClient } from "./client";
import { getKBrainRuntimeConnection } from "./runtimeConnection";
import type { KBrainSettingsDocument, KBrainSettingsProvider, KBrainSettingsUpdate } from "./types";

export const KBRAIN_SETTINGS_CHANGED_EVENT = "kbrain:settings-changed";

function providerType(provider: KBrainSettingsProvider): ProviderId {
  if (["codex", "claude_code", "gemini", "xai", "deepseek"].includes(String(provider.type))) {
    return provider.type as ProviderId;
  }
  switch (provider.api) {
    case "anthropic-messages":
      return "claude_code";
    case "google-generative-ai":
      return "gemini";
    default:
      return "codex";
  }
}

export function customProviderFromKBrain(provider: KBrainSettingsProvider): CustomProvider {
  const models = provider.models.map((model) => ({
    ...model,
    displayName: model.displayName ?? model.name,
    maxOutputToken: model.maxOutputToken ?? model.maxOutputTokens,
    inputModalities:
      model.inputModalities ?? (model.vision === true ? ["text", "image"] : undefined),
    limitsSource: model.limitsSource ?? "provider",
  }));
  return normalizeCustomProvider({
    ...provider,
    type: providerType(provider),
    name: provider.name || provider.id,
    requestFormat:
      provider.requestFormat ??
      (provider.api === "openai-completions" ? "openai-completions" : undefined),
    apiKey: "",
    apiKeyConfigured: provider.apiKeyConfigured === true,
    models,
    activeModels: provider.activeModels ?? models.map((model) => model.id),
    usageQuery: {
      ...provider.usageQuery,
      apiKey: "",
      accessToken: "",
      secretAccessKey: "",
    },
  });
}

export function appProvidersFromKBrain(document: KBrainSettingsDocument): CustomProvider[] {
  if (!document || !Array.isArray(document.providers)) {
    throw new Error("Malformed K-brain provider settings response");
  }
  return document.providers.map(customProviderFromKBrain);
}

type ProviderModel = CustomProvider["models"][number];

/**
 * K-brain 只按设置里的 inputModalities/vision 判定模型能否接收图片；中转供应商
 * 的 /models 通常不返回模态，模型就被当成纯文本，Read 到的图片会被丢弃。
 * 推送时按与模型选择器「视觉」标记相同的规则补齐：显式配置优先，其次按模型 id
 * 查本地模型目录。同一 id 跨供应商取同一结果（K-brain 要求共享模型元数据一致），
 * 因此任一供应商显式配置过的模态会作用于该 id 的全部未配置条目。
 */
function resolvePushedInputModalities(providers: readonly CustomProvider[]) {
  const explicit = new Map<string, ProviderModel["inputModalities"]>();
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if (model.inputModalities?.length && !explicit.has(model.id)) {
        explicit.set(model.id, model.inputModalities);
      }
    }
  }
  return (model: ProviderModel): ProviderModel => {
    if (model.inputModalities?.length) return model;
    const shared = explicit.get(model.id);
    if (shared) return { ...model, inputModalities: shared };
    const catalog = findCatalogModelAcrossProviders(model.id)?.inputModalities;
    return catalog?.includes("image") ? { ...model, inputModalities: ["text", "image"] } : model;
  };
}

/**
 * 生图开关选「自动」时字段缺失，但 K-brain 对缺失字段保持原值，所以要显式发空串。
 * 只对回传过 imageModel 的新版 K-brain 这样做；旧版不认识这个开关，原样发送。
 */
function withImageAdapter(model: ProviderModel): ProviderModel {
  if (model.imageModel === undefined || model.imageAdapter) return model;
  return { ...model, imageAdapter: "" };
}

function settingsUpdateFromProviders(
  previousProviders: readonly CustomProvider[],
  providersInput: readonly CustomProvider[],
  selectedModel?: AppSettings["selectedModel"],
): KBrainSettingsUpdate {
  const previousById = new Map(previousProviders.map((provider) => [provider.id, provider]));
  const withInputModalities = resolvePushedInputModalities(providersInput);
  const providers = providersInput.map((provider) => {
    const { apiKey, apiKeyConfigured: _configured, ...metadata } = provider;
    const clearApiKey =
      !apiKey.trim() &&
      provider.apiKeyConfigured === false &&
      previousById.get(provider.id)?.apiKeyConfigured === true;
    return {
      ...metadata,
      ...(provider.models
        ? { models: provider.models.map((model) => withImageAdapter(withInputModalities(model))) }
        : {}),
      api: resolveProviderApi(provider.type, provider.requestFormat),
      ...(clearApiKey ? { clearApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };
  });
  const nextIds = new Set(providersInput.map((provider) => provider.id));
  return {
    defaultProvider: selectedModel?.customProviderId ?? "",
    defaultModel: selectedModel?.model ?? "",
    providers,
    deleteProviders: previousProviders
      .filter((provider) => !nextIds.has(provider.id))
      .map((provider) => provider.id),
  };
}

export function kBrainSettingsUpdateFromAppSettings(
  previous: AppSettings,
  next: AppSettings,
): KBrainSettingsUpdate {
  return settingsUpdateFromProviders(
    previous.customProviders,
    next.customProviders,
    next.selectedModel,
  );
}

/** Build a one-time import request without exposing legacy provider secrets to storage. */
export function kBrainSettingsUpdateFromLegacyProviders(
  previousProviders: readonly CustomProvider[],
  providers: readonly CustomProvider[],
  selectedModel?: AppSettings["selectedModel"],
): KBrainSettingsUpdate {
  return settingsUpdateFromProviders(previousProviders, providers, selectedModel);
}

/**
 * 启动对账：后端里缺少输入模态、但本地模型目录能确认支持图片的模型，补推一次。
 * 不依赖用户下次保存设置；没有需要补齐的模型时返回 undefined，不产生写入。
 */
export function kBrainSettingsUpdateForMissingInputModalities(
  providers: readonly CustomProvider[],
  selectedModel?: AppSettings["selectedModel"],
): KBrainSettingsUpdate | undefined {
  const withInputModalities = resolvePushedInputModalities(providers);
  const needsBackfill = providers.some((provider) =>
    (provider.models ?? []).some(
      (model) => !model.inputModalities?.length && withInputModalities(model) !== model,
    ),
  );
  if (!needsBackfill) return undefined;
  const update = settingsUpdateFromProviders(providers, providers, selectedModel);
  delete update.deleteProviders;
  return update;
}

/** Import only providers absent from the backend; existing backend records are untouched. */
export function kBrainSettingsUpdateFromMissingLegacyProviders(
  providers: readonly CustomProvider[],
  selectedModel?: AppSettings["selectedModel"],
): KBrainSettingsUpdate {
  const update = settingsUpdateFromProviders([], providers, selectedModel);
  delete update.deleteProviders;
  return update;
}

export function getKBrainSettingsClient() {
  const connection = getKBrainRuntimeConnection();
  if (!connection) throw new Error("K-brain backend connection is not ready");
  return createKBrainClient({ baseUrl: connection.baseUrl, token: connection.token });
}

export async function loadKBrainProviderSettings(): Promise<KBrainSettingsDocument> {
  const document = await getKBrainSettingsClient().getSettings();
  appProvidersFromKBrain(document);
  return document;
}

export async function saveKBrainProviderSettings(
  update: KBrainSettingsUpdate,
): Promise<KBrainSettingsDocument> {
  const document = await getKBrainSettingsClient().updateSettings(update);
  appProvidersFromKBrain(document);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(KBRAIN_SETTINGS_CHANGED_EVENT));
  }
  return document;
}
