import {
  normalizeChatRuntimeControls,
  normalizeSettings,
  type AppSettings,
} from "./index";

export type GatewayProviderApiKeyUpdates = Record<string, string>;
export type GatewaySettingsSyncProvider = Omit<
  AppSettings["customProviders"][number],
  "apiKey"
> & {
  apiKeyConfigured?: boolean;
};

export type GatewaySettingsSyncPayload = {
  system: AppSettings["system"];
  customProviders: GatewaySettingsSyncProvider[];
  mcp: AppSettings["mcp"];
  agents: AppSettings["agents"];
  hooks: AppSettings["hooks"];
  cron: AppSettings["cron"];
  memory: AppSettings["memory"];
  skills: AppSettings["skills"];
  chatRuntimeControls: AppSettings["chatRuntimeControls"];
  selectedModel: AppSettings["selectedModel"] | null;
  theme: AppSettings["theme"];
  locale: AppSettings["locale"];
  providerApiKeyUpdates?: GatewayProviderApiKeyUpdates;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function apiKeyConfiguredForProvider(provider: AppSettings["customProviders"][number]) {
  return provider.apiKey.trim().length > 0 || provider.apiKeyConfigured === true;
}

export function redactCustomProvidersForGateway(
  customProviders: AppSettings["customProviders"],
): GatewaySettingsSyncProvider[] {
  return customProviders.map((provider) => {
    const { apiKey: _apiKey, ...rest } = provider;
    return {
      ...rest,
      apiKeyConfigured: apiKeyConfiguredForProvider(provider),
    };
  });
}

export function redactCustomProvidersForWebStorage(
  customProviders: AppSettings["customProviders"],
): AppSettings["customProviders"] {
  return customProviders.map((provider) => ({
    ...provider,
    apiKey: "",
    apiKeyConfigured: apiKeyConfiguredForProvider(provider),
  }));
}

export function redactSettingsForWebStorage(settings: AppSettings): AppSettings {
  return normalizeSettings({
    ...settings,
    customProviders: redactCustomProvidersForWebStorage(settings.customProviders),
  });
}

function collectProviderApiKeyUpdates(
  customProviders: AppSettings["customProviders"],
): GatewayProviderApiKeyUpdates | undefined {
  const updates: GatewayProviderApiKeyUpdates = {};
  for (const provider of customProviders) {
    const apiKey = provider.apiKey.trim();
    if (provider.id.trim() && apiKey) {
      updates[provider.id] = apiKey;
    }
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function normalizeProviderApiKeyUpdates(value: unknown): GatewayProviderApiKeyUpdates {
  const source = asObject(value);
  const updates: GatewayProviderApiKeyUpdates = {};
  for (const [id, apiKey] of Object.entries(source)) {
    const normalizedId = id.trim();
    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    if (normalizedId && normalizedApiKey) {
      updates[normalizedId] = normalizedApiKey;
    }
  }
  return updates;
}

function mergeSyncedCustomProviders(
  current: AppSettings["customProviders"],
  incoming: unknown,
  apiKeyUpdates: GatewayProviderApiKeyUpdates,
): AppSettings["customProviders"] {
  if (!Array.isArray(incoming)) {
    return current;
  }

  const currentById = new Map(current.map((provider) => [provider.id, provider]));
  return incoming.map((item) => {
    const source = asObject(item);
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const currentProvider = id ? currentById.get(id) : undefined;
    const apiKeyUpdate = id ? apiKeyUpdates[id] : undefined;
    const sourceApiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
    const apiKey = (apiKeyUpdate ?? sourceApiKey) || currentProvider?.apiKey || "";
    const sourceHasConfiguredFlag = Object.prototype.hasOwnProperty.call(
      source,
      "apiKeyConfigured",
    );

    return {
      ...source,
      apiKey,
      apiKeyConfigured:
        apiKey.length > 0 ||
        source.apiKeyConfigured === true ||
        (!sourceHasConfiguredFlag && currentProvider?.apiKeyConfigured === true),
    };
  }) as AppSettings["customProviders"];
}

export function buildGatewaySettingsSyncPayload(
  settings: AppSettings,
  options: { includeProviderApiKeyUpdates?: boolean } = {},
): GatewaySettingsSyncPayload {
  const payload: GatewaySettingsSyncPayload = {
    system: settings.system,
    customProviders: redactCustomProvidersForGateway(settings.customProviders),
    mcp: settings.mcp,
    agents: settings.agents,
    hooks: settings.hooks,
    cron: settings.cron,
    memory: settings.memory,
    skills: settings.skills,
    chatRuntimeControls: settings.chatRuntimeControls,
    selectedModel: settings.selectedModel ?? null,
    theme: settings.theme,
    locale: settings.locale,
  };
  const providerApiKeyUpdates = options.includeProviderApiKeyUpdates
    ? collectProviderApiKeyUpdates(settings.customProviders)
    : undefined;
  if (providerApiKeyUpdates) {
    payload.providerApiKeyUpdates = providerApiKeyUpdates;
  }
  return payload;
}

export function applyGatewaySettingsSyncPayload(
  current: AppSettings,
  payload: unknown,
): AppSettings {
  const source = asObject(payload);
  const providerApiKeyUpdates = normalizeProviderApiKeyUpdates(source.providerApiKeyUpdates);
  const selectedModel =
    source.selectedModel === null
      ? undefined
      : (source.selectedModel as AppSettings["selectedModel"] | undefined) ??
        current.selectedModel;
  const memory = Object.prototype.hasOwnProperty.call(source, "memory")
    ? (source.memory as AppSettings["memory"] | null | undefined) ?? {}
    : current.memory;

  return normalizeSettings({
    ...current,
    system: (source.system as AppSettings["system"] | undefined) ?? current.system,
    customProviders: mergeSyncedCustomProviders(
      current.customProviders,
      source.customProviders,
      providerApiKeyUpdates,
    ),
    mcp: (source.mcp as AppSettings["mcp"] | undefined) ?? current.mcp,
    agents: (source.agents as AppSettings["agents"] | undefined) ?? current.agents,
    hooks: (source.hooks as AppSettings["hooks"] | undefined) ?? current.hooks,
    cron: (source.cron as AppSettings["cron"] | undefined) ?? current.cron,
    memory: memory as AppSettings["memory"],
    skills: (source.skills as AppSettings["skills"] | undefined) ?? current.skills,
    chatRuntimeControls: Object.prototype.hasOwnProperty.call(source, "chatRuntimeControls")
      ? normalizeChatRuntimeControls(source.chatRuntimeControls)
      : current.chatRuntimeControls,
    selectedModel,
    theme: (source.theme as AppSettings["theme"] | undefined) ?? current.theme,
    locale: (source.locale as AppSettings["locale"] | undefined) ?? current.locale,
    remote: current.remote,
  });
}
