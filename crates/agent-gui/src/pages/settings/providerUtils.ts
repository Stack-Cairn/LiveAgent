import { invoke } from "@tauri-apps/api/core";
import { prepareProxyRequest } from "../../lib/providers/proxy";
import {
  createProviderModelConfig,
  normalizeProviderModelConfigs,
  type ProviderId,
  type ProviderModelConfig,
} from "../../lib/settings";
import { normalizeBaseUrl } from "../../lib/settings/normalize";

const GATEWAY_WEBUI_MARKER = "gateway";
const GATEWAY_TOKEN_STORAGE_KEY = "liveagent.gateway.token";
const CODEX_MODELS_SUFFIXES = ["/chat/completions", "/responses", "/response"];
const GEMINI_GENERATE_SUFFIXES = [":streamGenerateContent", ":generateContent"];
const ANTHROPIC_API_VERSION = "2023-06-01";

export type ProviderModelsFetchOptions = {
  allowPrivateNetwork?: boolean;
};

export function isProviderModelsConfirmationRequired(error: unknown) {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "provider_models_confirmation_required"
  );
}

function isPrivateIPv4(host: string) {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 127
  );
}

export function isProviderModelsPrivateAddress(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl.trim());
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      host === "localhost" ||
      isPrivateIPv4(host) ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("::ffff:127.")
    );
  } catch {
    return false;
  }
}

export function providerModelsConfirmationKey(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl.trim());
    return parsed.origin.toLowerCase();
  } catch {
    return baseUrl.trim();
  }
}

export function isGatewayWebuiRuntime() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.liveagentWebui === GATEWAY_WEBUI_MARKER
  );
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

function buildDefaultModelsHeaders(type: ProviderId, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (type === "gemini") {
    headers["x-goog-api-key"] = apiKey;
    return headers;
  }
  headers["x-api-key"] = apiKey;
  if (type === "claude_code") {
    headers["anthropic-version"] = ANTHROPIC_API_VERSION;
  }
  return headers;
}

function buildOfficialModelsHeaders(type: ProviderId, apiKey: string): Record<string, string> {
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
    { kind: "default", headers: buildDefaultModelsHeaders(type, apiKey) },
    { kind: "official", headers: buildOfficialModelsHeaders(type, apiKey) },
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
  options?: ProviderModelsFetchOptions,
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
    allow_private_network: options?.allowPrivateNetwork === true,
  } as any);

  const items = extractModelListItems(data);
  if (items !== null) {
    return normalizeFetchedModels(items, type);
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
    out.push({
      id,
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
    merged.push(existingById.get(model.id) ?? model);
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

export function createDraftModelConfig(
  providerType: ProviderId,
  modelId: string,
): ProviderModelConfig {
  return createProviderModelConfig(providerType, modelId);
}

export async function fetchModelsFromApi(
  type: ProviderId,
  baseUrl: string,
  apiKey: string,
  options?: ProviderModelsFetchOptions,
): Promise<ProviderModelConfig[]> {
  const normalizedUrl = normalizeModelBaseUrl(type, baseUrl);
  const normalizedApiKey = apiKey.trim();
  if (isGatewayWebuiRuntime()) {
    return fetchModelsThroughGateway(type, normalizedUrl, normalizedApiKey, options);
  }

  const attempts = buildProviderModelsAttempts(type, normalizedUrl, normalizedApiKey);
  const failures: ProviderModelsFailure[] = [];
  let emptyResult: ProviderModelConfig[] | null = null;

  for (const attempt of attempts) {
    const proxyRequest = await prepareProxyRequest(type, normalizedUrl, attempt.headers);
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
    const models = normalizeFetchedModels(items, type);
    if (models.length > 0) return models;
    emptyResult = models;
  }

  if (emptyResult !== null) return emptyResult;

  const failure = pickProviderModelsFailure(failures);
  throw new Error(failure?.message ?? "Failed to fetch model list");
}
