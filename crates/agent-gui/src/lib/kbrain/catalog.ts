import { useEffect, useMemo, useState } from "react";
import {
  type AppSettings,
  type CustomProvider,
  createProviderModelConfig,
  getDefaultUsageQueryConfig,
} from "../settings";
import { createKBrainClient } from "./client";
import { getKBrainRuntimeConnection } from "./runtimeConnection";
import type { KBrainModelRef } from "./types";

export function projectKBrainProviders(
  models: readonly KBrainModelRef[],
  existingProviders: readonly CustomProvider[] = [],
): CustomProvider[] {
  const existingById = new Map(existingProviders.map((provider) => [provider.id, provider]));
  const providers = new Map<string, CustomProvider>();
  for (const entry of models) {
    if (
      typeof entry?.provider !== "string" ||
      !entry.provider.trim() ||
      typeof entry?.model !== "string" ||
      !entry.model.trim()
    )
      continue;
    let provider = providers.get(entry.provider);
    if (!provider) {
      const existing = existingById.get(entry.provider);
      provider = existing
        ? {
            ...existing,
            apiKey: "",
            customHeaders: undefined,
            usageQuery: getDefaultUsageQueryConfig(),
            models: [],
            activeModels: [],
          }
        : {
            id: entry.provider,
            name: entry.provider,
            // The catalog exposes opaque IDs, not vendor types. Routing uses id, never type.
            type: "codex",
            baseUrl: "",
            isFullUrl: false,
            apiKey: "",
            models: [],
            activeModels: [],
            reasoning: "off",
            promptCachingEnabled: false,
            nativeWebSearchEnabled: false,
            useSystemProxy: false,
            usageQuery: getDefaultUsageQueryConfig(),
          };
      providers.set(entry.provider, provider);
    }
    if (provider.activeModels.includes(entry.model)) continue;
    const existing = existingById.get(entry.provider);
    const existingModel = existing?.models.find((model) => model.id === entry.model);
    const modelConfig = existingModel ?? createProviderModelConfig(provider.type, entry.model);
    provider.models.push({
      ...modelConfig,
      ...(entry.name && !existingModel ? { displayName: entry.name } : {}),
      ...(entry.ownedBy && !existingModel ? { ownedBy: entry.ownedBy } : {}),
      ...(typeof entry.contextWindow === "number" && !existingModel
        ? { contextWindow: entry.contextWindow, limitsSource: "provider" as const }
        : {}),
      ...(typeof entry.maxOutputTokens === "number" && !existingModel
        ? { maxOutputToken: entry.maxOutputTokens, limitsSource: "provider" as const }
        : {}),
      ...(entry.inputModalities && !existingModel
        ? { inputModalities: entry.inputModalities as ["text"] | ["text", "image"] }
        : {}),
    });
    // The backend catalog is the active-model source of truth. A model that
    // appears here is newly active even when the previous UI snapshot lacks it;
    // models omitted by the catalog remain hidden when they were disabled.
    provider.activeModels.push(entry.model);
  }
  return [...providers.values()];
}

export function projectKBrainSettings(
  settings: AppSettings,
  providers: CustomProvider[],
): AppSettings {
  // settings.selectedModel mirrors K-brain's default model (loaded from and saved to
  // defaultProvider/defaultModel), so new conversations start on the last chosen model.
  // Keep it only while the backend catalog still offers that model.
  const selected = settings.selectedModel;
  const available =
    selected &&
    providers.some(
      (provider) =>
        provider.id === selected.customProviderId && provider.activeModels.includes(selected.model),
    );
  return {
    ...settings,
    customProviders: providers,
    selectedModel: available ? selected : undefined,
  };
}

type CatalogOptions = {
  enabled?: boolean;
  baseUrl?: string;
  token?: string;
};

export const KBRAIN_SETTINGS_CHANGED_EVENT = "kbrain:settings-changed";

export function useKBrainCatalogSettings(settings: AppSettings, options: CatalogOptions = {}) {
  const connection = getKBrainRuntimeConnection();
  const enabled = options.enabled ?? connection !== null;
  const [settingsVersion, setSettingsVersion] = useState(0);
  const baseUrl = options.baseUrl ?? connection?.baseUrl;
  const token = options.token ?? connection?.token;
  const [catalog, setCatalog] = useState<{
    baseUrl: string | undefined;
    token: string | undefined;
    providers: CustomProvider[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onSettingsChanged = () => setSettingsVersion((version) => version + 1);
    window.addEventListener(KBRAIN_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => window.removeEventListener(KBRAIN_SETTINGS_CHANGED_EVENT, onSettingsChanged);
  }, [enabled]);
  useEffect(() => {
    const refreshKey = settingsVersion;
    if (!enabled || refreshKey < 0) return;
    let cancelled = false;
    setCatalog(null);
    void createKBrainClient({ baseUrl, token })
      .listModels()
      .then((models) => {
        if (!cancelled) {
          setCatalog({
            baseUrl,
            token,
            providers: projectKBrainProviders(models, settings.customProviders),
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCatalog({
            baseUrl,
            token,
            providers: [],
            error: `K-brain 模型目录加载失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, baseUrl, token, settingsVersion, settings.customProviders]); // refresh after backend settings writes
  const currentCatalog = catalog?.baseUrl === baseUrl && catalog?.token === token ? catalog : null;
  const runtimeSettings = useMemo(
    () => (enabled ? projectKBrainSettings(settings, currentCatalog?.providers ?? []) : settings),
    [enabled, settings, currentCatalog],
  );
  return { settings: runtimeSettings, error: enabled ? (currentCatalog?.error ?? null) : null };
}
