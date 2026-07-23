import { invoke } from "@tauri-apps/api/core";
import { prepareProxyRequest } from "../../lib/providers/proxy";
import { isGatewayWebuiRuntime } from "../../lib/runtimeEnv";
import {
  createProviderModelConfig,
  normalizeProviderModelConfigs,
  type ProviderId,
  type ProviderModelConfig,
} from "../../lib/settings";
import { normalizeBaseUrl } from "../../lib/settings/normalize";

const GATEWAY_TOKEN_STORAGE_KEY = "liveagent.gateway.token";
const CODEX_MODELS_SUFFIXES = ["/chat/completions", "/responses", "/response"];
const GEMINI_GENERATE_SUFFIXES = [":streamGenerateContent", ":generateContent"];
const ANTHROPIC_API_VERSION = "2023-06-01";

// Gateway WebUI 判定移至 lib/runtimeEnv 单一真源；此处再导出保持既有调用方不变。
export { isGatewayWebuiRuntime };
export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${String(Math.round(value / 1_000))}K`;
  const millions = value / 1_000_000;
  return `${Number.isInteger(millions) ? String(millions) : millions.toFixed(1)}M`;
}

function normalizeModelBaseUrl(type: ProviderId, baseUrl: string) {
  let normalizedUrl = normalizeBaseUrl(baseUrl);

  if (type !== "codex" && type !== "gemini") {
    return normalizedUrl;
  }

  const lower = normalizedUrl.toLowerCase();

  if (type === "codex") {
    for (const suffix of CODEX_MODELS_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        normalizedUrl = normalizedUrl.slice(0, -suffix.length);
        break;
      }
    }
  } else {
    for (const suffix of GEMINI_GENERATE_SUFFIXES) {
      if (lower.endsWith(suffix.toLowerCase())) {
        normalizedUrl = normalizedUrl.slice(0, -suffix.length);
        break;
      }
    }
    const modelsIndex = normalizedUrl.toLowerCase().lastIndexOf("/models");
    if (modelsIndex >= 0) {
      const afterModels = normalizedUrl.slice(modelsIndex + "/models".length);
      if (!afterModels || afterModels.startsWith("/")) {
        normalizedUrl = normalizedUrl.slice(0, modelsIndex);
      }
    }
  }

  return normalizeBaseUrl(normalizedUrl);
}

export type ProviderModelsAttemptKind = "default" | "official";

export type ProviderModelsAttempt = {
  kind: ProviderModelsAttemptKind;
  headers: Record<string, string>;
};

export type ProviderModelsFailure = {
  status: number | null;
  message: string;
};

function buildGeminiModelsUrl(baseUrl: string, versionPath: string) {
  const normalizedUrl = normalizeBaseUrl(baseUrl);
  if (normalizedUrl.toLowerCase().endsWith("/models")) return normalizedUrl;
  if (/\/v\d+(?:beta)?$/i.test(normalizedUrl)) return `${normalizedUrl}/models`;
  return `${normalizedUrl}/${versionPath}/models`;
}

export function buildProviderModelsUrl(
  type: ProviderId,
  baseUrl: string,
  kind: ProviderModelsAttemptKind,
) {
  if (type === "gemini") {
    return buildGeminiModelsUrl(baseUrl, kind === "official" ? "v1beta" : "v1");
  }

  return baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
}

// 每个供应商只带自家标准的 API Key 请求头：claude_code 用 x-api-key、
// codex 用 Authorization Bearer、gemini 用 x-goog-api-key，绝不双头齐发。
// default/official 两次尝试仅在 URL 上有差异（gemini v1 vs v1beta），
// 请求头完全一致，重复的尝试由签名去重收敛。
function buildModelsHeaders(type: ProviderId, apiKey: string): Record<string, string> {
  if (type === "gemini") {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    };
  }
  if (type === "claude_code") {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function providerModelsAttemptSignature(
  type: ProviderId,
  baseUrl: string,
  attempt: ProviderModelsAttempt,
) {
  const url = buildProviderModelsUrl(type, baseUrl, attempt.kind);
  const headers = Object.entries(attempt.headers).sort(([a], [b]) => a.localeCompare(b));
  return `${url}||${JSON.stringify(headers)}`;
}

export function buildProviderModelsAttempts(
  type: ProviderId,
  baseUrl: string,
  apiKey: string,
): ProviderModelsAttempt[] {
  const candidates: ProviderModelsAttempt[] = [
    { kind: "default", headers: buildModelsHeaders(type, apiKey) },
    { kind: "official", headers: buildModelsHeaders(type, apiKey) },
  ];

  const attempts: ProviderModelsAttempt[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const signature = providerModelsAttemptSignature(type, baseUrl, candidate);
    if (seen.has(signature)) continue;
    seen.add(signature);
    attempts.push(candidate);
  }
  return attempts;
}

function isMissingEndpointStatus(status: number | null) {
  return status === 404 || status === 405;
}

export function pickProviderModelsFailure(
  failures: ProviderModelsFailure[],
): ProviderModelsFailure | null {
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    if (!isMissingEndpointStatus(failures[index].status)) return failures[index];
  }
  return failures.length > 0 ? failures[failures.length - 1] : null;
}

function extractModelListItems(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  const payload = data as { data?: unknown; models?: unknown } | null;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return null;
}

async function readFetchError(response: Response, fallback: string) {
  const raw = (await response.text()).trim();
  if (!raw) {
    return fallback;
  }

  try {
    const payload = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const errorText =
      typeof payload.error === "string"
        ? payload.error.trim()
        : typeof payload.message === "string"
          ? payload.message.trim()
          : "";
    return errorText || raw;
  } catch {
    return raw;
  }
}

async function fetchModelsThroughGateway(
  type: ProviderId,
  baseUrl: string,
  apiKey: string,
  useSystemProxy: boolean,
): Promise<ProviderModelConfig[]> {
  const token =
    typeof window !== "undefined"
      ? (window.localStorage.getItem(GATEWAY_TOKEN_STORAGE_KEY) ?? "").trim()
      : "";
  if (!token) {
    throw new Error("Gateway token is required");
  }

  const data = await invoke<unknown>("gateway_provider_models", {
    type,
    base_url: baseUrl,
    api_key: apiKey,
    use_system_proxy: useSystemProxy,
  });

  const items = extractModelListItems(data);
  if (items !== null) {
    return normalizeApiFetchedModels(items, type);
  }

  const maybeError =
    data && typeof data === "object" && "error" in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).error
      : null;
  if (typeof maybeError === "string" && maybeError.trim() !== "") {
    throw new Error(maybeError);
  }

  return [];
}

export function normalizeFetchedModels(
  items: unknown,
  providerType: ProviderId,
): ProviderModelConfig[] {
  if (providerType === "gemini") {
    return normalizeGeminiFetchedModels(items);
  }
  return normalizeProviderModelConfigs(items, providerType);
}

function normalizeApiFetchedModels(
  items: unknown,
  providerType: ProviderId,
): ProviderModelConfig[] {
  const models = normalizeFetchedModels(items, providerType);
  if (providerType !== "claude_code") return models;

  return models.map((model) => {
    const defaults = createProviderModelConfig(providerType, model.id);
    const roundsToOneMillion =
      model.contextWindow < 1_000_000 && Math.round(model.contextWindow / 1_000) === 1_000;
    return defaults.contextWindow === 1_000_000 && roundsToOneMillion
      ? { ...model, contextWindow: defaults.contextWindow }
      : model;
  });
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function normalizeGeminiModelId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.startsWith("models/") ? raw.slice("models/".length) : raw;
}

function normalizeGeminiFetchedModels(items: unknown): ProviderModelConfig[] {
  if (!Array.isArray(items)) return [];

  const out: ProviderModelConfig[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const supportedMethods = Array.isArray(obj.supportedGenerationMethods)
      ? obj.supportedGenerationMethods.filter((value): value is string => typeof value === "string")
      : [];
    if (supportedMethods.length > 0 && !supportedMethods.includes("generateContent")) {
      continue;
    }

    const id = normalizeGeminiModelId(obj.name ?? obj.id ?? obj.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const draft = createProviderModelConfig("gemini", id);
    const ownedBy =
      (typeof obj.ownedBy === "string" ? obj.ownedBy.trim() : "") ||
      (typeof obj.owned_by === "string" ? obj.owned_by.trim() : "");
    out.push({
      id,
      ...(ownedBy ? { ownedBy } : {}),
      contextWindow: normalizePositiveInteger(obj.inputTokenLimit) ?? draft.contextWindow,
      maxOutputToken: normalizePositiveInteger(obj.outputTokenLimit) ?? draft.maxOutputToken,
    });
  }

  return out;
}

export function mergeFetchedModels(
  fetched: ProviderModelConfig[],
  existing: ProviderModelConfig[],
): ProviderModelConfig[] {
  const merged: ProviderModelConfig[] = [];
  const existingById = new Map(existing.map((model) => [model.id, model]));
  const seen = new Set<string>();

  for (const model of fetched) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const existingModel = existingById.get(model.id);
    const shouldNormalizeOneMillion =
      existingModel !== undefined &&
      model.contextWindow === 1_000_000 &&
      existingModel.contextWindow < 1_000_000 &&
      Math.round(existingModel.contextWindow / 1_000) === 1_000;
    merged.push(
      existingModel
        ? {
            ...existingModel,
            ...(shouldNormalizeOneMillion ? { contextWindow: model.contextWindow } : {}),
            ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
          }
        : model,
    );
  }

  for (const model of existing) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }

  return merged;
}

export function sortModelsBySelection(
  models: ProviderModelConfig[],
  activeModels: ReadonlySet<string>,
): ProviderModelConfig[] {
  const selected: ProviderModelConfig[] = [];
  const unselected: ProviderModelConfig[] = [];

  for (const model of models) {
    if (activeModels.has(model.id)) selected.push(model);
    else unselected.push(model);
  }

  return [...selected, ...unselected];
}

export function getModelBulkActionCounts(
  selectedModels: ReadonlySet<string>,
  activeModels: ReadonlySet<string>,
): { enableCount: number; disableCount: number } {
  let enableCount = 0;
  let disableCount = 0;
  for (const modelId of selectedModels) {
    if (activeModels.has(modelId)) disableCount += 1;
    else enableCount += 1;
  }
  return { enableCount, disableCount };
}

export function applyModelBulkActiveState(
  activeModels: ReadonlySet<string>,
  selectedModels: ReadonlySet<string>,
  enabled: boolean,
): Set<string> {
  const next = new Set(activeModels);
  for (const modelId of selectedModels) {
    if (enabled) next.add(modelId);
    else next.delete(modelId);
  }
  return next;
}

export function createDraftModelConfig(
  providerType: ProviderId,
  modelId: string,
): ProviderModelConfig {
  return createProviderModelConfig(providerType, modelId);
}

export function buildProviderModelsFetchKey(
  baseUrl: string,
  apiKey: string,
  useSystemProxy: boolean,
): string {
  return `${baseUrl.trim()}||${apiKey.trim()}||${useSystemProxy ? "proxy" : "direct"}`;
}

export async function fetchModelsFromApi(
  type: ProviderId,
  baseUrl: string,
  apiKey: string,
  options?: { useSystemProxy?: boolean },
): Promise<ProviderModelConfig[]> {
  const normalizedUrl = normalizeModelBaseUrl(type, baseUrl);
  const normalizedApiKey = apiKey.trim();
  if (isGatewayWebuiRuntime()) {
    return fetchModelsThroughGateway(
      type,
      normalizedUrl,
      normalizedApiKey,
      options?.useSystemProxy === true,
    );
  }

  const attempts = buildProviderModelsAttempts(type, normalizedUrl, normalizedApiKey);
  const failures: ProviderModelsFailure[] = [];
  let emptyResult: ProviderModelConfig[] | null = null;

  for (const attempt of attempts) {
    const proxyRequest = await prepareProxyRequest(type, normalizedUrl, attempt.headers, {
      useSystemProxy: options?.useSystemProxy === true,
    });
    const modelsUrl = buildProviderModelsUrl(type, proxyRequest.baseUrl, attempt.kind);

    let response: Response;
    try {
      response = await fetch(modelsUrl, { headers: proxyRequest.headers });
    } catch (error) {
      failures.push({
        status: null,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!response.ok) {
      failures.push({
        status: response.status,
        message: await readFetchError(response, `HTTP ${response.status} ${response.statusText}`),
      });
      continue;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      failures.push({ status: null, message: "Model list response is not valid JSON" });
      continue;
    }

    const items = extractModelListItems(data);
    if (items === null) {
      emptyResult ??= [];
      continue;
    }
    const models = normalizeApiFetchedModels(items, type);
    if (models.length > 0) return models;
    emptyResult = models;
  }

  if (emptyResult !== null) return emptyResult;

  const failure = pickProviderModelsFailure(failures);
  throw new Error(failure?.message ?? "Failed to fetch model list");
}
