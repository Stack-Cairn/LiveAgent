import {
  normalizeChatRuntimeControls,
  normalizeProjectToolsFileTreeSettings,
  normalizeSettings,
  workspaceProjectPathKey,
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
  remote?: Pick<AppSettings["remote"], "enableWebTerminal">;
  memory: AppSettings["memory"];
  customSettings: Partial<AppSettings["customSettings"]>;
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

function syncableCustomSettings(customSettings: AppSettings["customSettings"]) {
  const syncable = { ...customSettings } as Partial<AppSettings["customSettings"]>;
  delete syncable.projectToolsPanel;
  return {
    ...syncable,
    chatSidebar: {
      projectsCollapsed: false,
      recentCollapsed: false,
    },
  };
}

function syncableSystemSettings(system: AppSettings["system"]): AppSettings["system"] {
  const syncableSystem = { ...system };
  delete syncableSystem.activeWorkspaceProjectId;
  return syncableSystem as AppSettings["system"];
}

function readWorkspaceProjectLastConversationAt(
  project: AppSettings["system"]["workspaceProjects"][number],
) {
  return typeof project.lastConversationAt === "number" &&
    Number.isFinite(project.lastConversationAt) &&
    project.lastConversationAt > 0
    ? project.lastConversationAt
    : 0;
}

function resolveSyncedActiveWorkspaceProjectId(
  current: AppSettings["system"],
  incomingSystem: AppSettings["system"],
) {
  const explicitActiveProjectId =
    typeof incomingSystem.activeWorkspaceProjectId === "string" &&
    incomingSystem.activeWorkspaceProjectId.trim()
      ? incomingSystem.activeWorkspaceProjectId.trim()
      : "";
  const currentActiveProjectId = current.activeWorkspaceProjectId?.trim() || "";
  const currentActiveProject = current.workspaceProjects.find(
    (project) => project.id === currentActiveProjectId,
  );
  const currentActivePathKey = workspaceProjectPathKey(currentActiveProject?.path ?? "");
  const incomingProjects = Array.isArray(incomingSystem.workspaceProjects)
    ? incomingSystem.workspaceProjects
    : [];

  if (
    explicitActiveProjectId &&
    incomingProjects.some((project) => project.id === explicitActiveProjectId)
  ) {
    return explicitActiveProjectId;
  }
  if (
    currentActiveProjectId &&
    incomingProjects.some((project) => project.id === currentActiveProjectId)
  ) {
    return currentActiveProjectId;
  }
  if (currentActivePathKey) {
    const matchingProject = incomingProjects.find(
      (project) => workspaceProjectPathKey(project.path) === currentActivePathKey,
    );
    if (matchingProject?.id?.trim()) {
      return matchingProject.id.trim();
    }
  }

  return explicitActiveProjectId || currentActiveProjectId;
}

function mergeSyncedSystemSettings(
  current: AppSettings["system"],
  incoming: unknown,
): AppSettings["system"] {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return current;
  }

  const incomingSystem = incoming as AppSettings["system"];
  const activeWorkspaceProjectId = resolveSyncedActiveWorkspaceProjectId(
    current,
    incomingSystem,
  );
  if (!Array.isArray(incomingSystem.workspaceProjects)) {
    return {
      ...incomingSystem,
      activeWorkspaceProjectId,
    };
  }

  const currentActivityByPath = new Map<string, number>();
  for (const project of current.workspaceProjects) {
    const pathKey = workspaceProjectPathKey(project.path);
    const lastConversationAt = readWorkspaceProjectLastConversationAt(project);
    if (pathKey && lastConversationAt > 0) {
      currentActivityByPath.set(pathKey, lastConversationAt);
    }
  }

  return {
    ...incomingSystem,
    activeWorkspaceProjectId,
    workspaceProjects: incomingSystem.workspaceProjects.map((project) => {
      const lastConversationAt = Math.max(
        readWorkspaceProjectLastConversationAt(project),
        currentActivityByPath.get(workspaceProjectPathKey(project.path)) ?? 0,
      );
      return lastConversationAt > 0
        ? {
            ...project,
            lastConversationAt,
          }
        : project;
    }),
  };
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

function mergeSyncedRemoteSettings(
  current: AppSettings["remote"],
  incoming: unknown,
): AppSettings["remote"] {
  const source = asObject(incoming);
  if (!Object.prototype.hasOwnProperty.call(source, "enableWebTerminal")) {
    return current;
  }
  return {
    ...current,
    enableWebTerminal: source.enableWebTerminal === true,
  };
}

function mergeSyncedProjectToolsFileTreeSettings(
  current: AppSettings["customSettings"]["projectToolsFileTree"],
  incoming: unknown,
): AppSettings["customSettings"]["projectToolsFileTree"] {
  const currentState = normalizeProjectToolsFileTreeSettings(current);
  const incomingState = normalizeProjectToolsFileTreeSettings(incoming);
  const openFromIncoming = incomingState.openVersion >= currentState.openVersion;
  const incomingOpenProjectPathKeys = new Set(incomingState.openProjectPathKeys);
  const projects: AppSettings["customSettings"]["projectToolsFileTree"]["projects"] = {
    ...currentState.projects,
  };

  for (const [pathKey, incomingProject] of Object.entries(incomingState.projects)) {
    const currentProject = projects[pathKey];
    if (!currentProject) {
      if (openFromIncoming && incomingOpenProjectPathKeys.has(pathKey)) {
        projects[pathKey] = incomingProject;
      }
      continue;
    }
    const uiSource =
      incomingProject.stateVersion >= currentProject.stateVersion
        ? incomingProject
        : currentProject;
    projects[pathKey] = {
      query: uiSource.query,
      selectedPath: uiSource.selectedPath,
      expandedPaths: uiSource.expandedPaths,
      stateVersion: Math.max(currentProject.stateVersion, incomingProject.stateVersion),
      revision: Math.max(currentProject.revision, incomingProject.revision),
    };
  }

  return {
    openProjectPathKeys: openFromIncoming
      ? incomingState.openProjectPathKeys
      : currentState.openProjectPathKeys,
    openVersion: Math.max(currentState.openVersion, incomingState.openVersion),
    projects,
  };
}

export function buildGatewaySettingsSyncPayload(
  settings: AppSettings,
  options: { includeProviderApiKeyUpdates?: boolean } = {},
): GatewaySettingsSyncPayload {
  const payload: GatewaySettingsSyncPayload = {
    system: syncableSystemSettings(settings.system),
    customProviders: redactCustomProvidersForGateway(settings.customProviders),
    mcp: settings.mcp,
    agents: settings.agents,
    hooks: settings.hooks,
    cron: settings.cron,
    remote: {
      enableWebTerminal: settings.remote.enableWebTerminal,
    },
    memory: settings.memory,
    customSettings: syncableCustomSettings(settings.customSettings),
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
  const customSettings = Object.prototype.hasOwnProperty.call(source, "customSettings")
    ? (source.customSettings as AppSettings["customSettings"] | null | undefined) ?? {}
    : current.customSettings;
  const incomingCustomSettings = customSettings as Partial<AppSettings["customSettings"]>;

  return normalizeSettings({
    ...current,
    system: Object.prototype.hasOwnProperty.call(source, "system")
      ? mergeSyncedSystemSettings(current.system, source.system)
      : current.system,
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
    customSettings: {
      ...incomingCustomSettings,
      projectToolsFileTree: Object.prototype.hasOwnProperty.call(
        incomingCustomSettings,
        "projectToolsFileTree",
      )
        ? mergeSyncedProjectToolsFileTreeSettings(
            current.customSettings.projectToolsFileTree,
            incomingCustomSettings.projectToolsFileTree,
          )
        : current.customSettings.projectToolsFileTree,
      chatSidebar: current.customSettings.chatSidebar,
      projectToolsPanel: current.customSettings.projectToolsPanel,
    },
    skills: (source.skills as AppSettings["skills"] | undefined) ?? current.skills,
    chatRuntimeControls: Object.prototype.hasOwnProperty.call(source, "chatRuntimeControls")
      ? normalizeChatRuntimeControls(source.chatRuntimeControls)
      : current.chatRuntimeControls,
    selectedModel,
    theme: (source.theme as AppSettings["theme"] | undefined) ?? current.theme,
    locale: (source.locale as AppSettings["locale"] | undefined) ?? current.locale,
    remote: Object.prototype.hasOwnProperty.call(source, "remote")
      ? mergeSyncedRemoteSettings(current.remote, source.remote)
      : current.remote,
  });
}
