import {
  type AppSettings,
  DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  getDefaultSystemProxyConfig,
  normalizeChatRuntimeControls,
  normalizeRightDockSettings,
  normalizeSettings,
  workspaceProjectPathKey,
} from "./index";

export type GatewayProviderApiKeyUpdates = Record<string, string>;
export type GatewayProviderUsageQuerySecretUpdates = Record<
  string,
  {
    apiKey?: string;
    accessToken?: string;
    secretAccessKey?: string;
  }
>;
export type GatewaySshSecretUpdates = Record<
  string,
  {
    password?: string;
    privateKey?: string;
    privateKeyPassphrase?: string;
    proxyPassword?: string;
  }
>;
export type GatewaySshSyncPatch = {
  hostChanges?: {
    id: string;
    before: AppSettings["ssh"]["hosts"][number] | null;
    after: AppSettings["ssh"]["hosts"][number] | null;
  }[];
  projectAssociationChanges?: {
    pathKey: string;
    before: string[];
    after: string[];
  }[];
  hostOrderChange?: {
    before: string[];
    after: string[];
  };
};
export type GatewaySettingsSyncProvider = Omit<AppSettings["customProviders"][number], "apiKey"> & {
  apiKeyConfigured?: boolean;
};
export type GatewaySettingsSyncCustomSettings = Partial<AppSettings["customSettings"]>;

export type GatewaySettingsSyncPayload = {
  system: AppSettings["system"];
  customProviders: GatewaySettingsSyncProvider[];
  mcp: AppSettings["mcp"];
  agents: AppSettings["agents"];
  ssh: AppSettings["ssh"];
  remote?: Pick<
    AppSettings["remote"],
    "enableWebTerminal" | "enableWebSshTerminal" | "enableWebGit" | "enableWebTunnels"
  >;
  memory: AppSettings["memory"];
  customSettings: GatewaySettingsSyncCustomSettings;
  skills: AppSettings["skills"];
  chatRuntimeControls: AppSettings["chatRuntimeControls"];
  selectedModel: AppSettings["selectedModel"] | null;
  theme: AppSettings["theme"];
  locale: AppSettings["locale"];
  sshPatch?: GatewaySshSyncPatch;
  providerApiKeyUpdates?: GatewayProviderApiKeyUpdates;
  providerUsageQuerySecretUpdates?: GatewayProviderUsageQuerySecretUpdates;
  sshSecretUpdates?: GatewaySshSecretUpdates;
  // systemProxy 密码回传 sidecar（仿 providerApiKeyUpdates 的简化范式）：
  // system 字段本身出口必被脱敏，明文密码只经此通道回到桌面端落库。
  systemProxyPasswordUpdate?: string;
};
export type GatewaySettingsSyncUpdatePayload = Partial<GatewaySettingsSyncPayload>;

const GATEWAY_SETTINGS_SYNC_FIELDS = [
  "system",
  "customProviders",
  "mcp",
  "agents",
  "ssh",
  "remote",
  "memory",
  "customSettings",
  "skills",
  "chatRuntimeControls",
  "selectedModel",
  "theme",
  "locale",
] as const satisfies readonly (keyof GatewaySettingsSyncPayload)[];

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function apiKeyConfiguredForProvider(provider: AppSettings["customProviders"][number]) {
  return provider.apiKey.trim().length > 0 || provider.apiKeyConfigured === true;
}

const DEFAULT_USAGE_QUERY_CONFIG: AppSettings["customProviders"][number]["usageQuery"] = {
  enabled: false,
  mode: "newapi",
  script: "",
  scripts: {},
  baseUrl: "",
  apiKey: "",
  apiKeyConfigured: false,
  accessToken: "",
  accessTokenConfigured: false,
  userId: "",
  accessKeyId: "",
  secretAccessKey: "",
  secretAccessKeyConfigured: false,
  codingPlanProvider: "",
  teamOrganizationId: "",
  teamProjectId: "",
  timeoutSecs: 10,
};

function usageQueryConfig(
  provider: AppSettings["customProviders"][number],
): AppSettings["customProviders"][number]["usageQuery"] {
  return provider.usageQuery ?? DEFAULT_USAGE_QUERY_CONFIG;
}

function redactUsageQueryConfig(
  usageQuery: AppSettings["customProviders"][number]["usageQuery"] | undefined,
) {
  const config = usageQuery ?? DEFAULT_USAGE_QUERY_CONFIG;
  return {
    ...config,
    apiKey: "",
    apiKeyConfigured: config.apiKey.trim().length > 0 || config.apiKeyConfigured === true,
    accessToken: "",
    accessTokenConfigured:
      config.accessToken.trim().length > 0 || config.accessTokenConfigured === true,
    secretAccessKey: "",
    secretAccessKeyConfigured:
      config.secretAccessKey.trim().length > 0 || config.secretAccessKeyConfigured === true,
  };
}

export function redactCustomProvidersForGateway(
  customProviders: AppSettings["customProviders"],
): GatewaySettingsSyncProvider[] {
  return customProviders.map((provider) => {
    const { apiKey: _apiKey, ...rest } = provider;
    return {
      ...rest,
      usageQuery: redactUsageQueryConfig(provider.usageQuery),
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
    usageQuery: redactUsageQueryConfig(provider.usageQuery),
    apiKeyConfigured: apiKeyConfiguredForProvider(provider),
  }));
}

export function redactSettingsForWebStorage(settings: AppSettings): AppSettings {
  return normalizeSettings({
    ...settings,
    system: {
      ...settings.system,
      systemProxy: redactSystemProxyConfig(settings.system.systemProxy),
    },
    customProviders: redactCustomProvidersForWebStorage(settings.customProviders),
    ssh: redactSshSettingsForWebStorage(settings.ssh),
  });
}

function redactSystemProxyConfig(
  proxy: AppSettings["system"]["systemProxy"],
): AppSettings["system"]["systemProxy"] {
  return {
    ...proxy,
    password: "",
    passwordConfigured: proxy.password.trim().length > 0 || proxy.passwordConfigured === true,
  };
}

function redactSshSettingsForWebStorage(ssh: AppSettings["ssh"]): AppSettings["ssh"] {
  return {
    projectHostAssociations: ssh.projectHostAssociations,
    hosts: ssh.hosts.map((host) => {
      const isKeyboardInteractiveAuth = host.authType === "keyboardInteractive";
      return {
        ...host,
        password: "",
        passwordConfigured:
          !isKeyboardInteractiveAuth &&
          (host.password.trim().length > 0 || host.passwordConfigured === true),
        privateKey: "",
        privateKeyConfigured:
          !isKeyboardInteractiveAuth &&
          (host.privateKey.trim().length > 0 ||
            host.privateKeyPath.trim().length > 0 ||
            host.privateKeyConfigured === true),
        privateKeyPassphrase: "",
        privateKeyPassphraseConfigured:
          !isKeyboardInteractiveAuth &&
          (host.privateKeyPassphrase.trim().length > 0 ||
            host.privateKeyPassphraseConfigured === true),
        proxy: {
          ...host.proxy,
          password: "",
          passwordConfigured:
            host.proxy.password.trim().length > 0 || host.proxy.passwordConfigured === true,
        },
      };
    }),
  };
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

function collectProviderUsageQuerySecretUpdates(
  customProviders: AppSettings["customProviders"],
): GatewayProviderUsageQuerySecretUpdates | undefined {
  const updates: GatewayProviderUsageQuerySecretUpdates = {};
  for (const provider of customProviders) {
    const id = provider.id.trim();
    if (!id) continue;
    const update: GatewayProviderUsageQuerySecretUpdates[string] = {};
    const usageQuery = usageQueryConfig(provider);
    if (usageQuery.apiKey.trim()) {
      update.apiKey = usageQuery.apiKey.trim();
    }
    if (usageQuery.accessToken.trim()) {
      update.accessToken = usageQuery.accessToken.trim();
    }
    if (usageQuery.secretAccessKey.trim()) {
      update.secretAccessKey = usageQuery.secretAccessKey.trim();
    }
    if (Object.keys(update).length > 0) updates[id] = update;
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function collectChangedProviderUsageQuerySecretUpdates(
  previous: AppSettings["customProviders"],
  next: AppSettings["customProviders"],
): GatewayProviderUsageQuerySecretUpdates | undefined {
  const previousById = new Map(previous.map((provider) => [provider.id, provider]));
  const updates: GatewayProviderUsageQuerySecretUpdates = {};
  for (const provider of next) {
    const id = provider.id.trim();
    if (!id) continue;
    const previousProvider = previousById.get(id);
    const previousUsageQuery = previousProvider ? usageQueryConfig(previousProvider) : undefined;
    const usageQuery = usageQueryConfig(provider);
    const update: GatewayProviderUsageQuerySecretUpdates[string] = {};
    // WebUI 侧秘密恒被脱敏为空串,值比较发现不了"删除已配置密钥";
    // Configured true→false 是显式清除信号(对齐 SSH passwordConfiguredCleared)。
    const apiKeyCleared =
      previousUsageQuery?.apiKeyConfigured === true && usageQuery.apiKeyConfigured === false;
    if (usageQuery.apiKey !== previousUsageQuery?.apiKey || apiKeyCleared) {
      update.apiKey = usageQuery.apiKey.trim();
    }
    const accessTokenCleared =
      previousUsageQuery?.accessTokenConfigured === true &&
      usageQuery.accessTokenConfigured === false;
    if (usageQuery.accessToken !== previousUsageQuery?.accessToken || accessTokenCleared) {
      update.accessToken = usageQuery.accessToken.trim();
    }
    const secretAccessKeyCleared =
      previousUsageQuery?.secretAccessKeyConfigured === true &&
      usageQuery.secretAccessKeyConfigured === false;
    if (
      usageQuery.secretAccessKey !== previousUsageQuery?.secretAccessKey ||
      secretAccessKeyCleared
    ) {
      update.secretAccessKey = usageQuery.secretAccessKey.trim();
    }
    if (Object.keys(update).length > 0) updates[id] = update;
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

export function collectSshSecretUpdates(
  ssh: AppSettings["ssh"],
): GatewaySshSecretUpdates | undefined {
  const updates: GatewaySshSecretUpdates = {};
  for (const host of ssh.hosts) {
    const id = host.id.trim();
    if (!id) continue;
    // keyboardInteractive hosts store no login secrets, but proxy credentials
    // are independent of the auth type and must still sync.
    const isKeyboardInteractiveAuth = host.authType === "keyboardInteractive";
    const password = isKeyboardInteractiveAuth ? "" : host.password.trim();
    const privateKey = isKeyboardInteractiveAuth ? "" : host.privateKey.trim();
    const privateKeyPassphrase = isKeyboardInteractiveAuth ? "" : host.privateKeyPassphrase.trim();
    const proxyPassword = host.proxy.password.trim();
    const update: GatewaySshSecretUpdates[string] = {};
    if (password) update.password = password;
    if (privateKey) update.privateKey = privateKey;
    if (privateKeyPassphrase) update.privateKeyPassphrase = privateKeyPassphrase;
    if (proxyPassword) update.proxyPassword = proxyPassword;
    if (Object.keys(update).length > 0) {
      updates[id] = update;
    }
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function readSecret(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasSecretUpdateField(
  update: GatewaySshSecretUpdates[string] | undefined,
  key: keyof GatewaySshSecretUpdates[string],
) {
  return update ? Object.hasOwn(update, key) : false;
}

function collectChangedSshSecretUpdates(
  prev: AppSettings["ssh"],
  next: AppSettings["ssh"],
): GatewaySshSecretUpdates | undefined {
  const previousHostsById = new Map(prev.hosts.map((host) => [host.id, host]));
  const updates: GatewaySshSecretUpdates = {};

  for (const host of next.hosts) {
    const id = host.id.trim();
    if (!id) continue;
    const previous = previousHostsById.get(id);
    const update: GatewaySshSecretUpdates[string] = {};

    if (host.authType === "password") {
      const password = readSecret(host.password);
      const passwordConfiguredCleared =
        previous?.passwordConfigured === true && host.passwordConfigured === false;
      if (password !== readSecret(previous?.password) || passwordConfiguredCleared) {
        update.password = password;
      }
    }

    if (host.authType === "privateKey") {
      const privateKey = readSecret(host.privateKey);
      const privateKeyPassphrase = readSecret(host.privateKeyPassphrase);
      const privateKeyConfiguredCleared =
        previous?.privateKeyConfigured === true && host.privateKeyConfigured === false;
      const privateKeyPassphraseConfiguredCleared =
        previous?.privateKeyPassphraseConfigured === true &&
        host.privateKeyPassphraseConfigured === false;
      if (privateKey !== readSecret(previous?.privateKey) || privateKeyConfiguredCleared) {
        update.privateKey = privateKey;
      }
      if (
        privateKeyPassphrase !== readSecret(previous?.privateKeyPassphrase) ||
        privateKeyPassphraseConfiguredCleared
      ) {
        update.privateKeyPassphrase = privateKeyPassphrase;
      }
    }

    const proxyPassword = readSecret(host.proxy.password);
    const proxyPasswordConfiguredCleared =
      previous?.proxy.passwordConfigured === true && host.proxy.passwordConfigured === false;
    if (proxyPassword !== readSecret(previous?.proxy.password) || proxyPasswordConfiguredCleared) {
      update.proxyPassword = proxyPassword;
    }

    if (Object.keys(update).length > 0) {
      updates[id] = update;
    }
  }

  return Object.keys(updates).length > 0 ? updates : undefined;
}

function redactSshSettingsForGateway(ssh: AppSettings["ssh"]): AppSettings["ssh"] {
  return redactSshSettingsForWebStorage(ssh);
}

function idsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeAssociationEntries(associations: AppSettings["ssh"]["projectHostAssociations"]) {
  return Object.entries(associations).sort(([left], [right]) => left.localeCompare(right));
}

export function buildGatewaySshSyncPatch(
  prev: AppSettings["ssh"],
  next: AppSettings["ssh"],
): GatewaySshSyncPatch | undefined {
  const previousSsh = redactSshSettingsForGateway(prev);
  const nextSsh = redactSshSettingsForGateway(next);
  const previousHostsById = new Map(previousSsh.hosts.map((host) => [host.id, host]));
  const nextHostsById = new Map(nextSsh.hosts.map((host) => [host.id, host]));
  const hostChanges: NonNullable<GatewaySshSyncPatch["hostChanges"]> = [];
  const seenHostIds = new Set<string>();

  for (const host of previousSsh.hosts) seenHostIds.add(host.id);
  for (const host of nextSsh.hosts) seenHostIds.add(host.id);

  for (const hostId of seenHostIds) {
    const before = previousHostsById.get(hostId) ?? null;
    const after = nextHostsById.get(hostId) ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      hostChanges.push({ id: hostId, before, after });
    }
  }

  const previousOrder = previousSsh.hosts.map((host) => host.id);
  const nextOrder = nextSsh.hosts.map((host) => host.id);
  const sameHostSet =
    previousOrder.length === nextOrder.length && previousOrder.every((id) => nextHostsById.has(id));
  const hostOrderChange =
    sameHostSet && !idsEqual(previousOrder, nextOrder)
      ? { before: previousOrder, after: nextOrder }
      : undefined;

  const projectAssociationChanges: NonNullable<GatewaySshSyncPatch["projectAssociationChanges"]> =
    [];
  const previousAssociations = normalizeAssociationEntries(previousSsh.projectHostAssociations);
  const nextAssociations = normalizeAssociationEntries(nextSsh.projectHostAssociations);
  const pathKeys = new Set<string>([
    ...previousAssociations.map(([pathKey]) => pathKey),
    ...nextAssociations.map(([pathKey]) => pathKey),
  ]);
  for (const pathKey of pathKeys) {
    const before = previousSsh.projectHostAssociations[pathKey] ?? [];
    const after = nextSsh.projectHostAssociations[pathKey] ?? [];
    if (!idsEqual(before, after)) {
      projectAssociationChanges.push({ pathKey, before, after });
    }
  }

  const patch: GatewaySshSyncPatch = {};
  if (hostChanges.length > 0) patch.hostChanges = hostChanges;
  if (projectAssociationChanges.length > 0) {
    patch.projectAssociationChanges = projectAssociationChanges;
  }
  if (hostOrderChange) patch.hostOrderChange = hostOrderChange;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function syncableCustomSettings(
  customSettings: AppSettings["customSettings"],
): GatewaySettingsSyncCustomSettings {
  return {
    ...customSettings,
    taskCompletionNotifications: true,
    chatSidebar: {
      projectsCollapsed: false,
      recentCollapsed: false,
    },
    // Typography, scale, and transcript width are local UI preferences; fixed
    // defaults prevent visual preferences from being broadcast through the gateway.
    interfaceFontFamily: "",
    chatFontFamily: "",
    codeFontFamily: "",
    chatTranscript: { width: DEFAULT_CHAT_TRANSCRIPT_WIDTH },
    fontScale: { sidebar: 1, chat: 1, rightDock: 1 },
  };
}

function syncableSystemSettings(system: AppSettings["system"]): AppSettings["system"] {
  const syncableSystem = {
    ...system,
    // systemProxy 密码不随 system 字段出站（明文只走 systemProxyPasswordUpdate sidecar）。
    systemProxy: redactSystemProxyConfig(system.systemProxy),
  };
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

/// 镜像 SSH 代理密码的同步规则：sidecar 优先；脱敏值（空密码 + passwordConfigured=true）
/// 不清空既有密码；passwordConfigured === false 是显式清除信号。
function mergeSyncedSystemProxy(
  current: AppSettings["system"]["systemProxy"] | undefined,
  incoming: AppSettings["system"]["systemProxy"] | undefined,
  passwordUpdate: string | undefined,
): AppSettings["system"]["systemProxy"] {
  const currentProxy = current ?? getDefaultSystemProxyConfig();
  if (!incoming || typeof incoming !== "object") {
    return currentProxy;
  }
  const cleared = incoming.passwordConfigured === false;
  const incomingPassword = typeof incoming.password === "string" ? incoming.password : "";
  const currentPassword = typeof currentProxy.password === "string" ? currentProxy.password : "";
  const password =
    passwordUpdate !== undefined
      ? passwordUpdate
      : incomingPassword.trim()
        ? incomingPassword
        : cleared
          ? ""
          : currentPassword;
  return {
    ...incoming,
    password,
    passwordConfigured:
      password.trim().length > 0 || (!cleared && incoming.passwordConfigured === true),
  };
}

function mergeSyncedSystemSettings(
  current: AppSettings["system"],
  incoming: unknown,
  systemProxyPasswordUpdate?: string,
): AppSettings["system"] {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return current;
  }

  const incomingSystem = incoming as AppSettings["system"];
  const activeWorkspaceProjectId = resolveSyncedActiveWorkspaceProjectId(current, incomingSystem);
  const systemProxy = mergeSyncedSystemProxy(
    current.systemProxy,
    incomingSystem.systemProxy,
    systemProxyPasswordUpdate,
  );
  if (!Array.isArray(incomingSystem.workspaceProjects)) {
    return {
      ...incomingSystem,
      activeWorkspaceProjectId,
      systemProxy,
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
    systemProxy,
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

function normalizeProviderUsageQuerySecretUpdates(
  value: unknown,
): GatewayProviderUsageQuerySecretUpdates {
  const source = asObject(value);
  const updates: GatewayProviderUsageQuerySecretUpdates = {};
  for (const [id, rawUpdate] of Object.entries(source)) {
    const normalizedId = id.trim();
    if (!normalizedId) continue;
    const updateSource = asObject(rawUpdate);
    const update: GatewayProviderUsageQuerySecretUpdates[string] = {};
    if (Object.hasOwn(updateSource, "apiKey") && typeof updateSource.apiKey === "string") {
      update.apiKey = updateSource.apiKey.trim();
    }
    if (
      Object.hasOwn(updateSource, "accessToken") &&
      typeof updateSource.accessToken === "string"
    ) {
      update.accessToken = updateSource.accessToken.trim();
    }
    if (
      Object.hasOwn(updateSource, "secretAccessKey") &&
      typeof updateSource.secretAccessKey === "string"
    ) {
      update.secretAccessKey = updateSource.secretAccessKey.trim();
    }
    if (Object.keys(update).length > 0) updates[normalizedId] = update;
  }
  return updates;
}

function mergeSyncedUsageQuery(
  current: AppSettings["customProviders"][number]["usageQuery"] | undefined,
  incoming: unknown,
  update: GatewayProviderUsageQuerySecretUpdates[string] | undefined,
) {
  const source = asObject(incoming);
  const apiKey =
    (update && Object.hasOwn(update, "apiKey") ? update.apiKey : undefined) ??
    (typeof source.apiKey === "string" && source.apiKey.trim()
      ? source.apiKey.trim()
      : (current?.apiKey ?? ""));
  const accessToken =
    (update && Object.hasOwn(update, "accessToken") ? update.accessToken : undefined) ??
    (typeof source.accessToken === "string" && source.accessToken.trim()
      ? source.accessToken.trim()
      : (current?.accessToken ?? ""));
  const secretAccessKey =
    (update && Object.hasOwn(update, "secretAccessKey") ? update.secretAccessKey : undefined) ??
    (typeof source.secretAccessKey === "string" && source.secretAccessKey.trim()
      ? source.secretAccessKey.trim()
      : (current?.secretAccessKey ?? ""));

  return {
    ...source,
    apiKey,
    apiKeyConfigured:
      apiKey.length > 0 ||
      source.apiKeyConfigured === true ||
      (!Object.hasOwn(source, "apiKeyConfigured") && current?.apiKeyConfigured === true),
    accessToken,
    accessTokenConfigured:
      accessToken.length > 0 ||
      source.accessTokenConfigured === true ||
      (!Object.hasOwn(source, "accessTokenConfigured") && current?.accessTokenConfigured === true),
    secretAccessKey,
    secretAccessKeyConfigured:
      secretAccessKey.length > 0 ||
      source.secretAccessKeyConfigured === true ||
      (!Object.hasOwn(source, "secretAccessKeyConfigured") &&
        current?.secretAccessKeyConfigured === true),
  };
}

function normalizeSshSecretUpdates(value: unknown): GatewaySshSecretUpdates {
  const source = asObject(value);
  const updates: GatewaySshSecretUpdates = {};
  for (const [id, rawUpdate] of Object.entries(source)) {
    const normalizedId = id.trim();
    if (!normalizedId) continue;
    const updateSource = asObject(rawUpdate);
    const update: GatewaySshSecretUpdates[string] = {};
    if (Object.hasOwn(updateSource, "password") && typeof updateSource.password === "string") {
      update.password = updateSource.password.trim();
    }
    if (Object.hasOwn(updateSource, "privateKey") && typeof updateSource.privateKey === "string") {
      update.privateKey = updateSource.privateKey.trim();
    }
    if (
      Object.hasOwn(updateSource, "privateKeyPassphrase") &&
      typeof updateSource.privateKeyPassphrase === "string"
    ) {
      update.privateKeyPassphrase = updateSource.privateKeyPassphrase.trim();
    }
    if (
      Object.hasOwn(updateSource, "proxyPassword") &&
      typeof updateSource.proxyPassword === "string"
    ) {
      update.proxyPassword = updateSource.proxyPassword.trim();
    }
    if (Object.keys(update).length > 0) {
      updates[normalizedId] = update;
    }
  }
  return updates;
}

function mergeSyncedCustomProviders(
  current: AppSettings["customProviders"],
  incoming: unknown,
  apiKeyUpdates: GatewayProviderApiKeyUpdates,
  usageQuerySecretUpdates: GatewayProviderUsageQuerySecretUpdates,
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
    const sourceHasConfiguredFlag = Object.hasOwn(source, "apiKeyConfigured");
    const usageQuery = Object.hasOwn(source, "usageQuery")
      ? mergeSyncedUsageQuery(
          currentProvider?.usageQuery,
          source.usageQuery,
          id ? usageQuerySecretUpdates[id] : undefined,
        )
      : currentProvider && usageQueryConfig(currentProvider);

    return {
      ...source,
      apiKey,
      apiKeyConfigured:
        apiKey.length > 0 ||
        source.apiKeyConfigured === true ||
        (!sourceHasConfiguredFlag && currentProvider?.apiKeyConfigured === true),
      ...(usageQuery ? { usageQuery } : {}),
    };
  }) as AppSettings["customProviders"];
}

function mergeSyncedRemoteSettings(
  current: AppSettings["remote"],
  incoming: unknown,
): AppSettings["remote"] {
  const source = asObject(incoming);
  if (
    !Object.hasOwn(source, "enableWebTerminal") &&
    !Object.hasOwn(source, "enableWebSshTerminal") &&
    !Object.hasOwn(source, "enableWebGit") &&
    !Object.hasOwn(source, "enableWebTunnels")
  ) {
    return current;
  }
  return {
    ...current,
    enableWebTerminal: Object.hasOwn(source, "enableWebTerminal")
      ? source.enableWebTerminal === true
      : current.enableWebTerminal,
    enableWebSshTerminal: Object.hasOwn(source, "enableWebSshTerminal")
      ? source.enableWebSshTerminal === true
      : current.enableWebSshTerminal,
    enableWebGit: Object.hasOwn(source, "enableWebGit")
      ? source.enableWebGit === true
      : current.enableWebGit,
    enableWebTunnels: Object.hasOwn(source, "enableWebTunnels")
      ? source.enableWebTunnels === true
      : current.enableWebTunnels,
  };
}

function mergeSyncedSshSettings(
  current: AppSettings["ssh"],
  incoming: unknown,
  secretUpdates: GatewaySshSecretUpdates,
): AppSettings["ssh"] {
  const source = asObject(incoming);
  const normalized = normalizeSettings({ ssh: incoming as AppSettings["ssh"] }).ssh;
  const currentById = new Map(current.hosts.map((host) => [host.id, host]));
  const projectHostAssociations = Object.hasOwn(source, "projectHostAssociations")
    ? normalized.projectHostAssociations
    : normalizeSettings({
        ssh: {
          hosts: normalized.hosts,
          projectHostAssociations: current.projectHostAssociations,
        },
      }).ssh.projectHostAssociations;
  return {
    projectHostAssociations,
    hosts: normalized.hosts.map((host) => {
      const currentHost = currentById.get(host.id);
      const update = secretUpdates[host.id];
      const isKeyboardInteractiveAuth = host.authType === "keyboardInteractive";
      const hasPasswordUpdate = hasSecretUpdateField(update, "password");
      const hasPrivateKeyUpdate = hasSecretUpdateField(update, "privateKey");
      const hasPrivateKeyPassphraseUpdate = hasSecretUpdateField(update, "privateKeyPassphrase");
      const hasProxyPasswordUpdate = hasSecretUpdateField(update, "proxyPassword");
      const password = isKeyboardInteractiveAuth
        ? ""
        : hasPasswordUpdate
          ? readSecret(update?.password)
          : host.password.trim() || currentHost?.password || "";
      const privateKey = isKeyboardInteractiveAuth
        ? ""
        : hasPrivateKeyUpdate
          ? readSecret(update?.privateKey)
          : host.privateKey.trim() || currentHost?.privateKey || "";
      const privateKeyPassphrase = isKeyboardInteractiveAuth
        ? ""
        : hasPrivateKeyPassphraseUpdate
          ? readSecret(update?.privateKeyPassphrase)
          : host.privateKeyPassphrase.trim() || currentHost?.privateKeyPassphrase || "";
      const proxyPassword = hasProxyPasswordUpdate
        ? readSecret(update?.proxyPassword)
        : host.proxy.password.trim() || currentHost?.proxy.password || "";
      return {
        ...host,
        password,
        passwordConfigured:
          !isKeyboardInteractiveAuth &&
          (hasPasswordUpdate
            ? password.length > 0
            : password.length > 0 ||
              host.passwordConfigured === true ||
              currentHost?.passwordConfigured === true),
        privateKey,
        privateKeyConfigured:
          !isKeyboardInteractiveAuth &&
          (hasPrivateKeyUpdate
            ? privateKey.length > 0 || host.privateKeyPath.trim().length > 0
            : privateKey.length > 0 ||
              host.privateKeyPath.trim().length > 0 ||
              host.privateKeyConfigured === true ||
              currentHost?.privateKeyConfigured === true),
        privateKeyPassphrase,
        privateKeyPassphraseConfigured:
          !isKeyboardInteractiveAuth &&
          (hasPrivateKeyPassphraseUpdate
            ? privateKeyPassphrase.length > 0
            : privateKeyPassphrase.length > 0 ||
              host.privateKeyPassphraseConfigured === true ||
              currentHost?.privateKeyPassphraseConfigured === true),
        proxy: {
          ...host.proxy,
          password: proxyPassword,
          passwordConfigured: hasProxyPasswordUpdate
            ? proxyPassword.length > 0
            : proxyPassword.length > 0 ||
              host.proxy.passwordConfigured === true ||
              currentHost?.proxy.passwordConfigured === true,
        },
      };
    }),
  };
}

function applySyncedSshPatch(
  current: AppSettings["ssh"],
  patch: unknown,
  secretUpdates: GatewaySshSecretUpdates,
): AppSettings["ssh"] {
  const source = asObject(patch) as GatewaySshSyncPatch;
  const hostsById = new Map(current.hosts.map((host) => [host.id, { ...host }]));
  let hostOrder = current.hosts.map((host) => host.id);

  for (const change of Array.isArray(source.hostChanges) ? source.hostChanges : []) {
    const id = typeof change?.id === "string" ? change.id.trim() : "";
    if (!id) continue;
    if (change.after === null) {
      hostsById.delete(id);
      hostOrder = hostOrder.filter((hostId) => hostId !== id);
      continue;
    }
    const normalized = normalizeSettings({
      ssh: { hosts: [change.after], projectHostAssociations: {} },
    }).ssh.hosts[0];
    if (!normalized) continue;
    const existing = hostsById.get(id);
    hostsById.set(id, {
      ...existing,
      ...normalized,
      password: normalized.password || existing?.password || "",
      privateKey: normalized.privateKey || existing?.privateKey || "",
      privateKeyPassphrase: normalized.privateKeyPassphrase || existing?.privateKeyPassphrase || "",
      proxy: {
        ...normalized.proxy,
        password: normalized.proxy.password || existing?.proxy.password || "",
      },
    });
    if (!hostOrder.includes(id)) hostOrder.push(id);
  }

  const orderChange = asObject(source.hostOrderChange);
  if (Array.isArray(orderChange.after)) {
    const requestedOrder = orderChange.after
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => id && hostsById.has(id));
    const ordered = new Set(requestedOrder);
    hostOrder = [
      ...requestedOrder,
      ...hostOrder.filter((id) => hostsById.has(id) && !ordered.has(id)),
    ];
  } else {
    hostOrder = hostOrder.filter((id) => hostsById.has(id));
  }

  for (const [id, update] of Object.entries(secretUpdates)) {
    const host = hostsById.get(id);
    if (!host) continue;
    if (host.authType === "password" && hasSecretUpdateField(update, "password")) {
      host.password = readSecret(update.password);
      host.passwordConfigured = host.password.length > 0;
    }
    if (host.authType === "privateKey") {
      if (hasSecretUpdateField(update, "privateKey")) {
        host.privateKey = readSecret(update.privateKey);
        host.privateKeyConfigured =
          host.privateKey.length > 0 || host.privateKeyPath.trim().length > 0;
      }
      if (hasSecretUpdateField(update, "privateKeyPassphrase")) {
        host.privateKeyPassphrase = readSecret(update.privateKeyPassphrase);
        host.privateKeyPassphraseConfigured = host.privateKeyPassphrase.length > 0;
      }
    }
    if (hasSecretUpdateField(update, "proxyPassword")) {
      const proxyPassword = readSecret(update.proxyPassword);
      host.proxy = {
        ...host.proxy,
        password: proxyPassword,
        passwordConfigured: proxyPassword.length > 0,
      };
    }
  }

  const projectHostAssociations = { ...current.projectHostAssociations };
  for (const change of Array.isArray(source.projectAssociationChanges)
    ? source.projectAssociationChanges
    : []) {
    const pathKey = typeof change?.pathKey === "string" ? change.pathKey.trim() : "";
    if (!pathKey) continue;
    const after = Array.isArray(change.after)
      ? change.after.filter((id): id is string => typeof id === "string")
      : [];
    if (after.length > 0) {
      projectHostAssociations[pathKey] = after;
    } else {
      delete projectHostAssociations[pathKey];
    }
  }

  return normalizeSettings({
    ssh: {
      hosts: hostOrder
        .map((id) => hostsById.get(id))
        .filter((host): host is AppSettings["ssh"]["hosts"][number] => Boolean(host)),
      projectHostAssociations,
    },
  }).ssh;
}

// Per-project last-writer-wins ordered by (stateVersion, writerId): both
// sides of a sync evaluate the same total order, so concurrent writers
// converge deterministically instead of relying on tie-break direction.
function rightDockIncomingWins(
  incoming: { stateVersion: number; writerId: string },
  current: { stateVersion: number; writerId: string },
): boolean {
  if (incoming.stateVersion !== current.stateVersion) {
    return incoming.stateVersion > current.stateVersion;
  }
  return incoming.writerId > current.writerId;
}

function mergeSyncedRightDockSettings(
  current: AppSettings["customSettings"]["rightDock"],
  incoming: unknown,
): AppSettings["customSettings"]["rightDock"] {
  const currentState = normalizeRightDockSettings(current);
  const incomingState = normalizeRightDockSettings(incoming);
  const projects = { ...currentState.projects };

  for (const [pathKey, incomingProject] of Object.entries(incomingState.projects)) {
    const currentProject = projects[pathKey];
    if (!currentProject) {
      projects[pathKey] = incomingProject;
      continue;
    }
    const winner = rightDockIncomingWins(incomingProject, currentProject)
      ? incomingProject
      : currentProject;
    projects[pathKey] = {
      ...winner,
      openVersion: Math.max(currentProject.openVersion, incomingProject.openVersion),
      stateVersion: Math.max(currentProject.stateVersion, incomingProject.stateVersion),
      lastUsedAt: Math.max(currentProject.lastUsedAt, incomingProject.lastUsedAt),
    };
  }

  // Width stays device-local; re-normalizing applies the LRU project cap.
  return normalizeRightDockSettings({
    width: currentState.width,
    projects,
  });
}

function collectSystemProxyPasswordUpdate(system: AppSettings["system"]): string | undefined {
  const password = system.systemProxy.password;
  return typeof password === "string" && password.trim() ? password : undefined;
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
    ssh: redactSshSettingsForGateway(settings.ssh),
    remote: {
      enableWebTerminal: settings.remote.enableWebTerminal,
      enableWebSshTerminal: settings.remote.enableWebSshTerminal,
      enableWebGit: settings.remote.enableWebGit,
      enableWebTunnels: settings.remote.enableWebTunnels,
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
  const providerUsageQuerySecretUpdates = options.includeProviderApiKeyUpdates
    ? collectProviderUsageQuerySecretUpdates(settings.customProviders)
    : undefined;
  if (providerUsageQuerySecretUpdates) {
    payload.providerUsageQuerySecretUpdates = providerUsageQuerySecretUpdates;
  }
  const sshSecretUpdates = options.includeProviderApiKeyUpdates
    ? collectSshSecretUpdates(settings.ssh)
    : undefined;
  if (sshSecretUpdates) {
    payload.sshSecretUpdates = sshSecretUpdates;
  }
  const systemProxyPasswordUpdate = options.includeProviderApiKeyUpdates
    ? collectSystemProxyPasswordUpdate(settings.system)
    : undefined;
  if (systemProxyPasswordUpdate !== undefined) {
    payload.systemProxyPasswordUpdate = systemProxyPasswordUpdate;
  }
  return payload;
}

export function buildGatewaySettingsSyncUpdatePayload(
  prev: AppSettings,
  next: AppSettings,
  options: { includeProviderApiKeyUpdates?: boolean } = {},
): GatewaySettingsSyncUpdatePayload {
  const previousPayload = buildGatewaySettingsSyncPayload(prev);
  const nextPayload = buildGatewaySettingsSyncPayload(next);
  const update: GatewaySettingsSyncUpdatePayload = {};
  const sshPatch = buildGatewaySshSyncPatch(prev.ssh, next.ssh);

  for (const field of GATEWAY_SETTINGS_SYNC_FIELDS) {
    if (field === "ssh") {
      if (sshPatch) {
        update.sshPatch = sshPatch;
      }
      continue;
    }
    if (JSON.stringify(previousPayload[field]) !== JSON.stringify(nextPayload[field])) {
      (update as Record<string, unknown>)[field] = nextPayload[field];
    }
  }

  const providerApiKeyUpdates = options.includeProviderApiKeyUpdates
    ? collectProviderApiKeyUpdates(next.customProviders)
    : undefined;
  if (providerApiKeyUpdates) {
    update.customProviders ??= nextPayload.customProviders;
    update.providerApiKeyUpdates = providerApiKeyUpdates;
  }
  const providerUsageQuerySecretUpdates = options.includeProviderApiKeyUpdates
    ? collectChangedProviderUsageQuerySecretUpdates(prev.customProviders, next.customProviders)
    : undefined;
  if (providerUsageQuerySecretUpdates) {
    update.customProviders ??= nextPayload.customProviders;
    update.providerUsageQuerySecretUpdates = providerUsageQuerySecretUpdates;
  }
  const sshSecretUpdates = options.includeProviderApiKeyUpdates
    ? collectChangedSshSecretUpdates(prev.ssh, next.ssh)
    : undefined;
  if (sshSecretUpdates) {
    update.sshPatch ??= sshPatch ?? {};
    update.sshSecretUpdates = sshSecretUpdates;
  }
  const systemProxyPasswordUpdate = options.includeProviderApiKeyUpdates
    ? collectSystemProxyPasswordUpdate(next.system)
    : undefined;
  if (systemProxyPasswordUpdate !== undefined) {
    // sidecar 必须与（脱敏后的）system 字段成对出现，接收端才能定位回填目标。
    update.system ??= nextPayload.system;
    update.systemProxyPasswordUpdate = systemProxyPasswordUpdate;
  }

  return update;
}

export function applyGatewaySettingsSyncPayload(
  current: AppSettings,
  payload: unknown,
): AppSettings {
  const source = asObject(payload);
  const providerApiKeyUpdates = normalizeProviderApiKeyUpdates(source.providerApiKeyUpdates);
  const providerUsageQuerySecretUpdates = normalizeProviderUsageQuerySecretUpdates(
    source.providerUsageQuerySecretUpdates,
  );
  const sshSecretUpdates = normalizeSshSecretUpdates(source.sshSecretUpdates);
  const systemProxyPasswordUpdate =
    typeof source.systemProxyPasswordUpdate === "string" && source.systemProxyPasswordUpdate.trim()
      ? source.systemProxyPasswordUpdate
      : undefined;
  const selectedModel =
    source.selectedModel === null
      ? undefined
      : ((source.selectedModel as AppSettings["selectedModel"] | undefined) ??
        current.selectedModel);
  const memory = Object.hasOwn(source, "memory")
    ? ((source.memory as AppSettings["memory"] | null | undefined) ?? {})
    : current.memory;
  const customSettings = Object.hasOwn(source, "customSettings")
    ? ((source.customSettings as GatewaySettingsSyncCustomSettings | null | undefined) ?? {})
    : current.customSettings;
  const incomingCustomSettings = customSettings as GatewaySettingsSyncCustomSettings;

  return normalizeSettings({
    ...current,
    system: Object.hasOwn(source, "system")
      ? mergeSyncedSystemSettings(current.system, source.system, systemProxyPasswordUpdate)
      : current.system,
    customProviders: mergeSyncedCustomProviders(
      current.customProviders,
      source.customProviders,
      providerApiKeyUpdates,
      providerUsageQuerySecretUpdates,
    ),
    mcp: (source.mcp as AppSettings["mcp"] | undefined) ?? current.mcp,
    agents: (source.agents as AppSettings["agents"] | undefined) ?? current.agents,
    ssh: Object.hasOwn(source, "ssh")
      ? mergeSyncedSshSettings(current.ssh, source.ssh, sshSecretUpdates)
      : Object.hasOwn(source, "sshPatch")
        ? applySyncedSshPatch(current.ssh, source.sshPatch, sshSecretUpdates)
        : current.ssh,
    memory: memory as AppSettings["memory"],
    customSettings: {
      ...incomingCustomSettings,
      providerIdentities:
        incomingCustomSettings.providerIdentities ?? current.customSettings.providerIdentities,
      taskCompletionNotifications: current.customSettings.taskCompletionNotifications,
      rightDock: Object.hasOwn(incomingCustomSettings, "rightDock")
        ? mergeSyncedRightDockSettings(
            current.customSettings.rightDock,
            incomingCustomSettings.rightDock,
          )
        : current.customSettings.rightDock,
      chatSidebar: current.customSettings.chatSidebar,
      // Notifications, typography, scale, and transcript width are local UI preferences,
      // never gateway-synced.
      interfaceFontFamily: current.customSettings.interfaceFontFamily,
      chatFontFamily: current.customSettings.chatFontFamily,
      codeFontFamily: current.customSettings.codeFontFamily,
      chatTranscript: current.customSettings.chatTranscript,
      fontScale: current.customSettings.fontScale,
    },
    skills: (source.skills as AppSettings["skills"] | undefined) ?? current.skills,
    chatRuntimeControls: Object.hasOwn(source, "chatRuntimeControls")
      ? normalizeChatRuntimeControls(source.chatRuntimeControls)
      : current.chatRuntimeControls,
    selectedModel,
    theme: (source.theme as AppSettings["theme"] | undefined) ?? current.theme,
    locale: (source.locale as AppSettings["locale"] | undefined) ?? current.locale,
    remote: Object.hasOwn(source, "remote")
      ? mergeSyncedRemoteSettings(current.remote, source.remote)
      : current.remote,
  });
}
