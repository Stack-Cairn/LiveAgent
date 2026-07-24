import type { KnownProvider, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_LOCALE, type Locale, normalizeLocale } from "../../i18n/config";
import { normalizeFontFamily } from "../fontFamily";
import {
  findCatalogModel,
  getProviderFallbackLimits,
  normalizeModelIdCandidates,
  normalizeModelLimits,
  resolveModelLimits,
} from "../models/modelCatalog";
import { createUuid } from "../shared/id";
import { mergeAlwaysEnabledSkillNames } from "../skills/builtin";
import { SYSTEM_TOOL_OPTIONS, type SystemToolId } from "../tools/systemToolOptions";
import { normalizeApiKey, normalizeBaseUrl, normalizeModels } from "./normalize";

export { normalizeFontFamily } from "../fontFamily";

export type { SystemToolId } from "../tools/systemToolOptions";

export type ProviderId = "codex" | "claude_code" | "gemini" | "xai";

export type ExecutionMode = "text" | "tools" | "agent-dev";

export type CodexRequestFormat = "openai-completions" | "openai-responses";

export type ReasoningLevel = ModelThinkingLevel;

export type McpTransport = "stdio" | "http" | "sse";

export type McpServerConfig = {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  messageUrl?: string;
};

export type McpSettings = {
  servers: McpServerConfig[];
  selected: string[];
};

export type SkillsSettings = {
  enabled: boolean;
  selected: string[];
};

export type MemoryOrganizerScope = "all" | "global" | "projects" | "current-project";
export type MemoryOrganizerMode = "conservative" | "standard" | "aggressive";
export type MemoryOrganizerFrequency = "none" | "daily" | "weekly";

export type MemoryOrganizerSchedule = {
  frequency: MemoryOrganizerFrequency;
  timeLocal: string;
  weekday?: number;
  timezone: string;
};

export type MemorySettings = {
  organizerModel?: SelectedModel;
  summaryModel?: SelectedModel;
  organizerEnabled: boolean;
  organizerSchedule: MemoryOrganizerSchedule;
  organizerScope: MemoryOrganizerScope;
  organizerMode: MemoryOrganizerMode;
  organizerLastRunAt?: number;
  organizerNextRunAt?: number;
};

export type ChatSidebarSettings = {
  projectsCollapsed: boolean;
  recentCollapsed: boolean;
};

export const RIGHT_DOCK_TOOL_KINDS = ["fileTree", "gitReview", "tunnel", "sshTunnel"] as const;

export type RightDockToolKind = (typeof RIGHT_DOCK_TOOL_KINDS)[number];

export type RightDockTabKind = RightDockToolKind | "terminal" | "backgroundTasks";

export type RightDockToolTab = {
  openedAt: number;
  uiState?: Record<string, unknown>;
};

// Persisted dock state is user intent only: terminal tab existence is derived
// from live sessions at render time, so tabOrder may contain session ids that
// are dead or not yet loaded — they are preserved here and lazily collected on
// user gestures once the session list is known.
export type RightDockProjectState = {
  activeTabId?: string;
  tabOrder: string[];
  tools: Partial<Record<RightDockToolKind, RightDockToolTab>>;
  openVersion: number;
  stateVersion: number;
  writerId: string;
  lastUsedAt: number;
};

export type RightDockSettings = {
  width: number;
  projects: Record<string, RightDockProjectState>;
};

export type RightDockFileTreeState = {
  query: string;
  selectedPath: string;
  expandedPaths: string[];
  showHidden: boolean;
  // Reveal nonce: bumped (via bumpRevision) when another surface asks the
  // file tree to reveal selectedPath (expand ancestors + scroll into view).
  // Content refreshes are driven by workspace-activity invalidation, and
  // merge ordering is covered by the project-level stateVersion.
  revision: number;
};

export type RightDockFileTreeStatePatch = Partial<RightDockFileTreeState> & {
  bumpRevision?: boolean;
};

export type FontScaleSettings = {
  sidebar: number;
  chat: number;
  rightDock: number;
};

export type CustomSettings = {
  conversationTitleModel?: SelectedModel;
  chatSidebar: ChatSidebarSettings;
  rightDock: RightDockSettings;
  // Empty strings select the built-in font stacks for their respective UI zones.
  interfaceFontFamily: string;
  chatFontFamily: string;
  codeFontFamily: string;
  fontScale: FontScaleSettings;
};

export type SystemProxyType = "socks5" | "http";

// 系统级出站代理：注入本地 shell 命令 env，并供勾选了 useSystemProxy 的
// 供应商模型请求走代理（代理连接由桌面 Rust 侧完成，凭据不进前端请求）。
export type SystemProxyConfig = {
  enabled: boolean;
  type: SystemProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
  passwordConfigured?: boolean;
};

export type SystemSettings = {
  executionMode: ExecutionMode;
  workdir: string;
  selectedSystemTools: SystemToolId[];
  workspaceProjects: WorkspaceProject[];
  activeWorkspaceProjectId?: string;
  hiddenWorkspaceProjectPaths: string[];
  missingWorkspaceProjectPaths: string[];
  // Archived workspaces (path-keyed, like hidden/missing). Archived rows stay
  // in the merged list but render disabled and can never be active.
  archivedWorkspaceProjectPaths: string[];
  systemProxy: SystemProxyConfig;
};

export type WorkspaceProjectKind = "managed" | "folder" | "history";

export type WorkspaceProject = {
  id: string;
  name: string;
  path: string;
  kind: WorkspaceProjectKind;
  createdAt: number;
  updatedAt: number;
  lastConversationAt?: number;
  isPinned?: boolean;
  pinnedAt?: number | null;
};

export type SelectedModel = {
  customProviderId: string;
  model: string;
};

export type ProviderModelConfig = {
  id: string;
  /** /models 元数据；缺失时保持旧设置格式兼容。 */
  ownedBy?: string;
  contextWindow: number;
  maxOutputToken: number;
};

export type ChatRuntimeControls = {
  thinkingEnabled: boolean;
  nativeWebSearchEnabled: boolean;
  reasoning: ReasoningLevel;
  reasoningByProvider: Partial<Record<ChatRuntimeReasoningProviderKey, ReasoningLevel>>;
};

export type ChatRuntimeReasoningProviderKey =
  | "claude_code"
  | "codex_openai_responses"
  | "codex_openai_completions"
  | "gemini"
  | "xai";

export type AgentPromptTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
};

export type SshAuthType = "password" | "privateKey" | "keyboardInteractive";
export type SshProxyType = "socks5" | "http";

export type SshProxyConfig = {
  type: SshProxyType;
  url: string;
  port: number;
  username: string;
  password: string;
  passwordConfigured?: boolean;
};

export type SshHostConfig = {
  id: string;
  name: string;
  description: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  password: string;
  passwordConfigured?: boolean;
  privateKey: string;
  privateKeyPath: string;
  privateKeyConfigured?: boolean;
  privateKeyPassphrase: string;
  privateKeyPassphraseConfigured?: boolean;
  proxy: SshProxyConfig;
};

export type SshSettings = {
  hosts: SshHostConfig[];
  projectHostAssociations: Record<string, string[]>;
};

export type CustomProvider = {
  id: string;
  name: string;
  type: ProviderId;
  baseUrl: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  customHeaders?: { key: string; value: string }[];
  models: ProviderModelConfig[];
  modelOrder?: string[];
  activeModels: string[];
  requestFormat?: CodexRequestFormat;
  reasoning: ReasoningLevel;
  promptCachingEnabled: boolean;
  /** 仅 Anthropic：ephemeral 缓存保留档位；long 在官方 API 上映射为 1h TTL。 */
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled: boolean;
  useSystemProxy: boolean;
};

export type EffectiveTheme = "light" | "dark";
export type Theme = EffectiveTheme | "system";

export const THEME_OPTIONS = ["light", "dark", "system"] as const satisfies readonly Theme[];

const SYSTEM_THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type RemoteSettings = {
  enabled: boolean;
  gatewayUrl: string;
  gatewayPort: number;
  token: string;
  agentId: string;
  autoReconnect: boolean;
  heartbeatInterval: number;
  enableWebTerminal: boolean;
  enableWebSshTerminal: boolean;
  enableWebGit: boolean;
  enableWebTunnels: boolean;
};

export type AppSettings = {
  system: SystemSettings;
  customProviders: CustomProvider[];
  mcp: McpSettings;
  agents: AgentPromptTemplate[];
  ssh: SshSettings;
  remote: RemoteSettings;
  memory: MemorySettings;
  customSettings: CustomSettings;
  skills: SkillsSettings;
  chatRuntimeControls: ChatRuntimeControls;
  selectedModel?: SelectedModel;
  theme: Theme;
  locale: Locale;
};

export const CODEX_REQUEST_FORMAT_LABELS: Record<CodexRequestFormat, string> = {
  "openai-completions": "OpenAI-Completions",
  "openai-responses": "Responses API",
};

const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const DEFAULT_MCP_TIMEOUT_MS = 60_000;
export const DEFAULT_CHAT_RUNTIME_CONTROLS: ChatRuntimeControls = {
  thinkingEnabled: true,
  nativeWebSearchEnabled: true,
  reasoning: "high",
  reasoningByProvider: {
    claude_code: "high",
    codex_openai_responses: "high",
    codex_openai_completions: "high",
    gemini: "high",
    xai: "high",
  },
};

export const DEFAULT_WORKSPACE_PROJECT_ID = "default-project";
export const DEFAULT_WORKSPACE_PROJECT_NAME = "Default Project";

function normalizeCodexRequestFormat(input: unknown): CodexRequestFormat | undefined {
  switch (input) {
    case "openai-completions":
    case "openai-responses":
      return input;
    default:
      return undefined;
  }
}

function normalizeCodexRouting(
  baseUrlInput: unknown,
  requestFormatInput: unknown,
): {
  baseUrl: string;
  requestFormat: CodexRequestFormat;
} {
  let baseUrl = normalizeBaseUrl(typeof baseUrlInput === "string" ? baseUrlInput : "");
  let requestFormat = normalizeCodexRequestFormat(requestFormatInput);
  const lower = baseUrl.toLowerCase();

  if (lower.endsWith(CODEX_CHAT_COMPLETIONS_SUFFIX)) {
    baseUrl = baseUrl.slice(0, -CODEX_CHAT_COMPLETIONS_SUFFIX.length);
    requestFormat ??= "openai-completions";
  } else if (lower.endsWith(CODEX_RESPONSES_SUFFIX)) {
    baseUrl = baseUrl.slice(0, -CODEX_RESPONSES_SUFFIX.length);
    requestFormat ??= "openai-responses";
  } else if (lower.endsWith(CODEX_RESPONSE_SUFFIX)) {
    baseUrl = baseUrl.slice(0, -CODEX_RESPONSE_SUFFIX.length);
    requestFormat ??= "openai-responses";
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    requestFormat: requestFormat ?? "openai-responses",
  };
}

export function getBuiltinCustomProviders(): CustomProvider[] {
  return [
    {
      id: "builtin-claude_code",
      name: "Anthropic",
      type: "claude_code",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      reasoning: "off",
      promptCachingEnabled: true,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
    },
    {
      id: "builtin-codex",
      name: "OpenAI",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      requestFormat: "openai-responses",
      reasoning: "off",
      promptCachingEnabled: true,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
    },
    {
      id: "builtin-gemini",
      name: "Gemini",
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      reasoning: "off",
      promptCachingEnabled: false,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
    },
    {
      id: "builtin-xai",
      name: "Grok",
      type: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "",
      customHeaders: [],
      models: [],
      activeModels: [],
      requestFormat: "openai-responses",
      reasoning: "high",
      promptCachingEnabled: false,
      nativeWebSearchEnabled: true,
      useSystemProxy: false,
    },
  ];
}

function normalizeExecutionMode(input: unknown): ExecutionMode {
  switch (input) {
    case "text":
    case "tools":
    case "agent-dev":
      return input;
    default:
      return "tools";
  }
}

export function isAgentExecutionMode(mode: ExecutionMode): boolean {
  return mode !== "text";
}

export function isAgentDevMode(mode: ExecutionMode): boolean {
  return mode === "agent-dev";
}

function normalizeWorkdir(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

export function normalizeWorkspaceProjectPath(path: unknown): string {
  return typeof path === "string" ? path.trim() : "";
}

function isWindowsProjectPathLike(path: string): boolean {
  if (/^[\\/]{2}\?[\\/]/.test(path)) return true;
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(path)) return true;
  return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path);
}

function trimTrailingWindowsProjectSlashes(path: string): string {
  let minLength = 1;
  if (/^[A-Za-z]:\//.test(path)) {
    minLength = 3;
  } else if (path.startsWith("//")) {
    const uncRoot = /^\/\/[^/]+\/[^/]+/.exec(path);
    minLength = uncRoot?.[0].length ?? 2;
  }
  let next = path;
  while (next.length > minLength && next.endsWith("/")) {
    next = next.slice(0, -1);
  }
  return next;
}

function normalizeWindowsProjectPathKey(path: string): string {
  const stripped = path.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, "//").replace(/^[\\/]{2}\?[\\/]/, "");
  return trimTrailingWindowsProjectSlashes(stripped.replace(/\\/g, "/")).toLowerCase();
}

function normalizePosixProjectPathKey(path: string): string {
  let next = path;
  while (next.length > 1 && next.endsWith("/")) {
    next = next.slice(0, -1);
  }
  return next;
}

export function workspaceProjectPathKey(path: unknown): string {
  const normalizedPath = normalizeWorkspaceProjectPath(path);
  if (!normalizedPath) return "";
  return isWindowsProjectPathLike(normalizedPath)
    ? normalizeWindowsProjectPathKey(normalizedPath)
    : normalizePosixProjectPathKey(normalizedPath);
}

function assignNormalizedProjectKeyValue<T>(
  target: Record<string, T>,
  canonicalKeys: Set<string>,
  rawPathKey: string,
  value: T,
): void {
  const normalizedPathKey = workspaceProjectPathKey(rawPathKey);
  if (!normalizedPathKey) return;
  const isCanonicalKey = rawPathKey.trim() === normalizedPathKey;
  const existingIsCanonical = canonicalKeys.has(normalizedPathKey);
  if (isCanonicalKey || !existingIsCanonical) {
    target[normalizedPathKey] = value;
  }
  if (isCanonicalKey) {
    canonicalKeys.add(normalizedPathKey);
  }
}

export function normalizeRightDockFileTreePath(path: unknown): string {
  if (typeof path !== "string") return "";
  return path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function normalizeWorkspaceProjectKind(input: unknown): WorkspaceProjectKind {
  switch (input) {
    case "managed":
    case "folder":
    case "history":
      return input;
    default:
      return "folder";
  }
}

function normalizeWorkspaceProject(input: unknown): WorkspaceProject | null {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = normalizeWorkspaceProjectPath(obj.path);
  if (!path) return null;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid();
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : path
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() || "Project";
  const createdAt =
    typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt) && obj.createdAt > 0
      ? obj.createdAt
      : Date.now();
  const updatedAt =
    typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
      ? obj.updatedAt
      : createdAt;
  const lastConversationAt =
    typeof obj.lastConversationAt === "number" &&
    Number.isFinite(obj.lastConversationAt) &&
    obj.lastConversationAt > 0
      ? obj.lastConversationAt
      : undefined;
  const isPinned = obj.isPinned === true;
  const pinnedAt =
    typeof obj.pinnedAt === "number" && Number.isFinite(obj.pinnedAt) && obj.pinnedAt > 0
      ? obj.pinnedAt
      : undefined;
  return {
    id,
    name,
    path,
    kind: normalizeWorkspaceProjectKind(obj.kind),
    createdAt,
    updatedAt,
    ...(lastConversationAt ? { lastConversationAt } : {}),
    ...(isPinned ? { isPinned: true, pinnedAt: pinnedAt ?? updatedAt } : {}),
  };
}

function normalizeWorkspaceProjects(input: unknown): WorkspaceProject[] {
  if (!Array.isArray(input)) return [];
  const out: WorkspaceProject[] = [];
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  for (const raw of input) {
    const project = normalizeWorkspaceProject(raw);
    if (!project) continue;
    const pathKey = workspaceProjectPathKey(project.path);
    if (!pathKey || seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    let id = project.id;
    if (seenIds.has(id)) {
      id = createUuid();
    }
    seenIds.add(id);
    out.push({ ...project, id });
  }
  return out;
}

export function normalizeHiddenWorkspaceProjectPaths(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of normalizeStringArray(input)) {
    const key = workspaceProjectPathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function normalizeMissingWorkspaceProjectPaths(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of normalizeStringArray(input)) {
    const key = workspaceProjectPathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function normalizeArchivedWorkspaceProjectPaths(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of normalizeStringArray(input)) {
    const key = workspaceProjectPathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function resolveWorkspaceProjects(
  system: SystemSettings,
  defaultWorkdir: string,
): SystemSettings {
  const defaultPath = normalizeWorkspaceProjectPath(defaultWorkdir || system.workdir);
  if (!defaultPath) return system;

  const now = Date.now();
  const defaultKey = workspaceProjectPathKey(defaultPath);
  const configured = normalizeWorkspaceProjects(system.workspaceProjects);
  const defaultExisting = configured.find(
    (project) =>
      project.id === DEFAULT_WORKSPACE_PROJECT_ID ||
      workspaceProjectPathKey(project.path) === defaultKey,
  );
  const defaultProject: WorkspaceProject = {
    id: DEFAULT_WORKSPACE_PROJECT_ID,
    name: DEFAULT_WORKSPACE_PROJECT_NAME,
    path: defaultPath,
    kind: "managed",
    createdAt: defaultExisting?.createdAt ?? now,
    updatedAt: defaultExisting?.updatedAt ?? now,
    ...(defaultExisting?.lastConversationAt
      ? { lastConversationAt: defaultExisting.lastConversationAt }
      : {}),
    ...(defaultExisting?.isPinned
      ? {
          isPinned: true,
          pinnedAt: defaultExisting.pinnedAt ?? defaultExisting.updatedAt,
        }
      : {}),
  };

  const projects: WorkspaceProject[] = [defaultProject];
  const seenPaths = new Set<string>([defaultKey]);
  const seenIds = new Set<string>([DEFAULT_WORKSPACE_PROJECT_ID]);
  for (const project of configured) {
    const pathKey = workspaceProjectPathKey(project.path);
    if (!pathKey || seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    let id = project.id;
    if (!id || id === DEFAULT_WORKSPACE_PROJECT_ID || seenIds.has(id)) {
      id = createUuid();
    }
    seenIds.add(id);
    projects.push({
      ...project,
      id,
      name:
        project.name.trim() ||
        project.path
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() ||
        "Project",
      kind: project.kind,
    });
  }

  const hiddenWorkspaceProjectPaths = normalizeHiddenWorkspaceProjectPaths(
    system.hiddenWorkspaceProjectPaths,
  ).filter((path) => workspaceProjectPathKey(path) !== defaultKey);
  const hiddenWorkspaceProjectPathKeys = new Set(
    hiddenWorkspaceProjectPaths.map(workspaceProjectPathKey),
  );
  const missingWorkspaceProjectPaths = normalizeMissingWorkspaceProjectPaths(
    system.missingWorkspaceProjectPaths,
  ).filter((path) => !hiddenWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path)));
  // Hidden means removed — a removed workspace has nothing left to archive.
  const normalizedArchivedWorkspaceProjectPaths = normalizeArchivedWorkspaceProjectPaths(
    system.archivedWorkspaceProjectPaths,
  ).filter((path) => !hiddenWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path)));
  const normalizedArchivedWorkspaceProjectPathKeys = new Set(
    normalizedArchivedWorkspaceProjectPaths.map(workspaceProjectPathKey),
  );
  const archivedWorkspaceProjectPaths = projects.every((project) =>
    normalizedArchivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
  )
    ? normalizedArchivedWorkspaceProjectPaths.filter(
        (path) => workspaceProjectPathKey(path) !== defaultKey,
      )
    : normalizedArchivedWorkspaceProjectPaths;
  const archivedWorkspaceProjectPathKeys = new Set(
    archivedWorkspaceProjectPaths.map(workspaceProjectPathKey),
  );
  const selectableProjects = projects.filter(
    (project) => !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
  );
  const activeProjectId = selectableProjects.some(
    (project) => project.id === system.activeWorkspaceProjectId,
  )
    ? system.activeWorkspaceProjectId
    : (selectableProjects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.id ??
      selectableProjects[0]?.id ??
      DEFAULT_WORKSPACE_PROJECT_ID);
  const activeProject =
    selectableProjects.find((project) => project.id === activeProjectId) ?? defaultProject;
  const workdir = normalizeWorkdir(system.workdir) || defaultPath;

  return {
    ...system,
    workdir,
    workspaceProjects: projects,
    activeWorkspaceProjectId: activeProject.id,
    hiddenWorkspaceProjectPaths,
    missingWorkspaceProjectPaths,
    archivedWorkspaceProjectPaths,
  };
}

const REASONING_LEVELS: ReasoningLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizeReasoningLevel(input: unknown): ReasoningLevel {
  return typeof input === "string" && (REASONING_LEVELS as string[]).includes(input)
    ? (input as ReasoningLevel)
    : "off";
}

export function normalizeChatRuntimeReasoning(input: unknown): ReasoningLevel {
  return typeof input === "string" && (REASONING_LEVELS as string[]).includes(input)
    ? (input as ReasoningLevel)
    : DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
}

const CHAT_RUNTIME_REASONING_PROVIDER_KEYS: ChatRuntimeReasoningProviderKey[] = [
  "claude_code",
  "codex_openai_responses",
  "codex_openai_completions",
  "gemini",
  "xai",
];

export function getChatRuntimeReasoningProviderKey(params: {
  providerId?: ProviderId;
  requestFormat?: CodexRequestFormat;
}): ChatRuntimeReasoningProviderKey {
  if (!params.providerId || params.providerId === "claude_code") {
    return "claude_code";
  }
  if (params.providerId === "gemini") {
    return "gemini";
  }
  if (params.providerId === "xai") {
    return "xai";
  }
  if (params.providerId === "codex" && params.requestFormat === "openai-completions") {
    return "codex_openai_completions";
  }
  return "codex_openai_responses";
}

function normalizeChatRuntimeReasoningForLevels(
  input: unknown,
  levels: ReasoningLevel[],
): ReasoningLevel {
  if (levels.length === 0) {
    return DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
  }
  const reasoning = normalizeChatRuntimeReasoning(input);
  return levels.includes(reasoning) ? reasoning : DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
}

function normalizeChatRuntimeReasoningByProvider(
  input: unknown,
  fallbackReasoning: ReasoningLevel,
): Partial<Record<ChatRuntimeReasoningProviderKey, ReasoningLevel>> {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const normalized: Partial<Record<ChatRuntimeReasoningProviderKey, ReasoningLevel>> = {
    ...DEFAULT_CHAT_RUNTIME_CONTROLS.reasoningByProvider,
  };
  CHAT_RUNTIME_REASONING_PROVIDER_KEYS.forEach((key) => {
    normalized[key] = normalizeChatRuntimeReasoning(
      Object.hasOwn(obj, key) ? obj[key] : fallbackReasoning,
    );
  });
  return normalized;
}

export function normalizeChatRuntimeControls(input: unknown): ChatRuntimeControls {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const reasoning = normalizeChatRuntimeReasoning(obj.reasoning);
  return {
    thinkingEnabled: obj.thinkingEnabled !== false,
    nativeWebSearchEnabled: obj.nativeWebSearchEnabled !== false,
    reasoning,
    reasoningByProvider: normalizeChatRuntimeReasoningByProvider(
      obj.reasoningByProvider,
      reasoning,
    ),
  };
}

export function getChatRuntimeReasoningLevelsForProvider(params: {
  providerId?: ProviderId;
  requestFormat?: CodexRequestFormat;
  modelId?: string;
  baseUrl?: string;
  modelConfig?: ProviderModelConfig;
}): ReasoningLevel[] {
  return getKnownModelThinkingLevels(params.providerId ?? "claude_code", params.modelId);
}

export function normalizeChatRuntimeControlsForProvider(
  input: unknown,
  params: {
    providerId?: ProviderId;
    requestFormat?: CodexRequestFormat;
    modelId?: string;
  },
): ChatRuntimeControls {
  const controls = normalizeChatRuntimeControls(input);
  const key = getChatRuntimeReasoningProviderKey(params);
  const levels = getChatRuntimeReasoningLevelsForProvider(params);
  const reasoningByProvider = {
    ...DEFAULT_CHAT_RUNTIME_CONTROLS.reasoningByProvider,
    ...controls.reasoningByProvider,
  };
  const reasoning = normalizeChatRuntimeReasoningForLevels(
    reasoningByProvider[key] ?? controls.reasoning,
    levels,
  );
  return {
    ...controls,
    reasoning,
    reasoningByProvider: {
      ...reasoningByProvider,
      [key]: reasoning,
    },
  };
}

export function updateChatRuntimeControlsForProvider(
  input: unknown,
  patch: Partial<ChatRuntimeControls>,
  params: {
    providerId?: ProviderId;
    requestFormat?: CodexRequestFormat;
    modelId?: string;
  },
): ChatRuntimeControls {
  const key = getChatRuntimeReasoningProviderKey(params);
  const levels = getChatRuntimeReasoningLevelsForProvider(params);
  const controls = normalizeChatRuntimeControls({
    ...normalizeChatRuntimeControls(input),
    ...patch,
  });
  const reasoningByProvider = {
    ...DEFAULT_CHAT_RUNTIME_CONTROLS.reasoningByProvider,
    ...controls.reasoningByProvider,
  };
  if (patch.reasoning !== undefined) {
    reasoningByProvider[key] = normalizeChatRuntimeReasoningForLevels(patch.reasoning, levels);
  }
  return normalizeChatRuntimeControlsForProvider(
    {
      ...controls,
      reasoningByProvider,
    },
    params,
  );
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeOptionalText(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function normalizeRecordStringString(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;

  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!key || !value) continue;
    out[key] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMcpTransport(input: unknown): McpTransport {
  if (input === "http" || input === "sse" || input === "stdio") return input;
  return "stdio";
}

export function normalizeSystemToolSelection(input: unknown): SystemToolId[] {
  const valid = new Set<SystemToolId>(SYSTEM_TOOL_OPTIONS.map((tool) => tool.id));
  const out: SystemToolId[] = [];

  for (const item of normalizeStringArray(input)) {
    const value = item as SystemToolId;
    if (!valid.has(value)) continue;
    if (out.includes(value)) continue;
    out.push(value);
  }

  return out;
}

function normalizeMcpSelection(input: unknown, servers: McpServerConfig[]): string[] {
  const valid = new Set(servers.map((server) => server.id).filter(Boolean));
  const out: string[] = [];

  for (const item of normalizeStringArray(input)) {
    if (!valid.has(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }

  return out;
}

function normalizeTimeoutMs(input: unknown): number {
  const numeric =
    typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  const timeoutMs = Number.isFinite(numeric) ? Math.floor(numeric) : DEFAULT_MCP_TIMEOUT_MS;
  return timeoutMs > 0 ? timeoutMs : DEFAULT_MCP_TIMEOUT_MS;
}

function normalizePositiveInteger(input: unknown, fallback: number): number {
  const numeric =
    typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  const value = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return value > 0 ? value : fallback;
}

function normalizeIntegerInRange(
  input: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = normalizePositiveInteger(input, fallback);
  return Math.min(max, Math.max(min, value));
}

export function normalizeRemoteSettings(input: unknown): RemoteSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    gatewayUrl: normalizeBaseUrl(typeof obj.gatewayUrl === "string" ? obj.gatewayUrl : ""),
    gatewayPort: normalizeIntegerInRange(obj.gatewayPort, 1, 65_535, 443),
    token: normalizeApiKey(typeof obj.token === "string" ? obj.token : ""),
    agentId: normalizeOptionalText(obj.agentId),
    autoReconnect: obj.autoReconnect !== false,
    heartbeatInterval: normalizePositiveInteger(obj.heartbeatInterval, 30),
    enableWebTerminal: obj.enableWebTerminal === true,
    enableWebSshTerminal: obj.enableWebSshTerminal === true,
    enableWebGit: obj.enableWebGit === true,
    enableWebTunnels: obj.enableWebTunnels === true,
  };
}

function toKnownProvider(providerId: ProviderId): KnownProvider {
  if (providerId === "codex" || providerId === "xai") return "openai";
  if (providerId === "gemini") return "google";
  return "anthropic";
}

// 思考档位检测用的 pi-ai 目录回查（限额/单价不走这里——那些来自
// lib/models/modelCatalog 的生成目录）：其 compat/thinkingLevelMap 反映
// pi-ai 请求路径元数据。xai 刻意不回查（resolveThinkingModel 早退），
// pi-ai 目录的 xai compat 反映 completions 路径，与 LiveAgent 强制
// Responses + thinkingLevelMap 不符。
function findKnownModel(providerId: ProviderId, modelId: string | undefined) {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  return getBuiltinModels(toKnownProvider(providerId)).find((model) => model.id === trimmedId);
}

// —— 以下 Anthropic 启发式与桌面端 anthropicModels.ts/modelFactory.ts
// 手动保持同步；装饰 id 候选链与目录模块共用同一实现 ——
// 中转/网关常给官方 Anthropic 模型 id 加装饰（日期后缀、@版本、大小写变化、
// AnyRouter 系的 [1m] 长上下文后缀），逐字匹配漏检后档位列表会塌缩、丢掉
// xhigh/max，上下文窗口默认值也与桌面端实际请求脱节。
function findKnownAnthropicModel(modelId: string) {
  const models = getBuiltinModels("anthropic");
  for (const candidate of normalizeModelIdCandidates(modelId)) {
    const known = models.find((model) => model.id === candidate);
    if (known) return known;
  }
  return undefined;
}

function findKnownModelForThinking(providerId: ProviderId, modelId: string) {
  return toKnownProvider(providerId) === "anthropic"
    ? findKnownAnthropicModel(modelId)
    : findKnownModel(providerId, modelId);
}

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  // minor 限定 1-2 位数字，避免把日期后缀（如 claude-sonnet-4-20250514）误读成小版本号；
  // 同时接受三方中转的倒序命名（claude-4.6-sonnet）。
  const match = normalizedModelId.match(
    new RegExp(`(?:${family}[-.]4[-.](\\d{1,2})(?!\\d)|4[-.](\\d{1,2})(?!\\d)[-.]${family})`),
  );
  if (!match) return false;
  const minor = Number(match[1] ?? match[2]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

// Claude 5 起（sonnet-5 / fable-5 / mythos-5 等）整个家族都是 adaptive thinking 且支持 xhigh。
// 倒序写法（claude-5-sonnet）用负向后行断言排除 3-5-sonnet 这类旧世代小版本号。
function isClaudeFamilyMajorVersionAtLeast(normalizedModelId: string, minimumMajor: number) {
  const match = normalizedModelId.match(
    /(?:(?:opus|sonnet|haiku|fable|mythos)[-.](\d{1,2})(?!\d)|(?<!\d[-.])(\d{1,2})[-.](?:opus|sonnet|haiku|fable|mythos))/,
  );
  if (!match) return false;
  const major = Number(match[1] ?? match[2]);
  return Number.isFinite(major) && major >= minimumMajor;
}

// adaptive 世代（Opus/Sonnet 4.6+、Claude 5、Mythos Preview）即 1M GA 世代；
// 与桌面端 anthropicModels.ts 的 isAnthropicAdaptiveModelId 手动同步。目录里
// forceAdaptiveThinking 的模型集合与该启发式等价，限额路径以此判定摆脱目录
// compat 依赖。
function isAnthropicAdaptiveModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return (
    id.includes("mythos-preview") ||
    isClaudeFamilyVersionAtLeast(id, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(id, "sonnet", 6) ||
    isClaudeFamilyMajorVersionAtLeast(id, 5)
  );
}

// 目录彻底未命中的三方改名 id（如 claude-4.6-sonnet）退回 id 启发式，推断
// xhigh/max 档位声明；与桌面端 deriveAnthropicThinkingOverridesForCustomModel 同步。
function deriveAnthropicThinkingLevelMapForCustomModel(
  modelId: string,
): Record<string, string> | undefined {
  if (!isAnthropicAdaptiveModelId(modelId)) return undefined;
  const id = modelId.trim().toLowerCase();
  const supportsXHigh =
    isClaudeFamilyVersionAtLeast(id, "opus", 7) || isClaudeFamilyMajorVersionAtLeast(id, 5);
  return supportsXHigh ? { xhigh: "xhigh", max: "max" } : { max: "max" };
}

// 旧世代默认按 200K 处理；显式 [1m] 变体表示中转端能力，adaptive 世代
// （forceAdaptiveThinking）则是 1M GA 世代。与桌面端 anthropicModels.ts 的
// 有效窗口规则手动保持同步。
const ANTHROPIC_STANDARD_CONTEXT_WINDOW = 200_000;
const ANTHROPIC_LONG_CONTEXT_WINDOW = 1_000_000;

function shouldSendAnthropicLongContextHeader(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return !(
      host === "api.anthropic.com" ||
      host.includes("aiplatform.googleapis.com") ||
      host.includes("vertexai.googleapis.com") ||
      host.endsWith(".deepseek.com") ||
      host === "deepseek.com" ||
      host.endsWith(".amazonaws.com")
    );
  } catch {
    return false;
  }
}

function getKnownModelLimits(
  providerId: ProviderId,
  modelId: string | undefined,
  baseUrl?: string,
): Pick<ProviderModelConfig, "contextWindow" | "maxOutputToken"> | undefined {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return undefined;
  // Anthropic 的有效窗口叠加 1M beta/adaptive 世代策略（与桌面端
  // anthropicModels.ts 手动同步）；其余供应商直接读生成目录（数据已在
  // 生成期过统一语义规则）。
  if (providerId === "claude_code") {
    const known = findCatalogModel("claude_code", trimmedId);
    if (!known) return undefined;
    const contextWindow = isAnthropicAdaptiveModelId(trimmedId)
      ? known.contextWindow
      : /\[1m\]$/i.test(trimmedId) &&
          (baseUrl === undefined || shouldSendAnthropicLongContextHeader(baseUrl))
        ? Math.max(known.contextWindow, ANTHROPIC_LONG_CONTEXT_WINDOW)
        : Math.min(known.contextWindow, ANTHROPIC_STANDARD_CONTEXT_WINDOW);
    return { contextWindow, maxOutputToken: known.maxOutputToken };
  }
  return resolveModelLimits(providerId, trimmedId);
}

// Grok / xAI 思考档：与桌面端 modelFactory 的 XAI_THINKING_LEVEL_MAP 手动同步
// （off:null=思考恒开，max 不暴露）。桌面端对 xai 的所有模型（目录内外）一律
// 盖这份映射，web 侧同样无条件应用，否则跨端钳制会把桌面设置的 xhigh 压回 high。
const XAI_THINKING_LEVEL_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
} as const;

function resolveThinkingModel(providerId: ProviderId, trimmedId: string) {
  if (providerId === "xai") {
    return {
      reasoning: true,
      thinkingLevelMap: XAI_THINKING_LEVEL_MAP,
    } as Parameters<typeof getSupportedThinkingLevels>[0];
  }
  const known = findKnownModelForThinking(providerId, trimmedId);
  if (known) return known;
  // 目录之外的自定义模型（deepseek/glm 等三方聚合）无法从 id 判断推理能力，
  // 与桌面端 modelFactory 自定义分支一致按可推理处理：标准档位，xhigh/max
  // 仍需目录 opt-in；deepseek 走 codex 时镜像桌面端 DeepSeek 适配层的 xhigh 档，
  // claude_code 走桌面端同款 id 启发式补 xhigh/max。
  const customThinkingLevelMap =
    providerId === "codex" && trimmedId.toLowerCase().includes("deepseek")
      ? { xhigh: "max" }
      : toKnownProvider(providerId) === "anthropic"
        ? deriveAnthropicThinkingLevelMapForCustomModel(trimmedId)
        : undefined;
  return {
    reasoning: true,
    ...(customThinkingLevelMap ? { thinkingLevelMap: customThinkingLevelMap } : {}),
  } as Parameters<typeof getSupportedThinkingLevels>[0];
}

export function getKnownModelThinkingLevels(
  providerId: ProviderId,
  modelId: string | undefined,
): ReasoningLevel[] {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return [];
  const model = resolveThinkingModel(providerId, trimmedId);
  return getSupportedThinkingLevels(model).filter((level) => level !== "off");
}

export function isThinkingAlwaysOnForModel(
  providerId: ProviderId,
  modelId: string | undefined,
  _baseUrl?: string,
  _requestFormat?: CodexRequestFormat,
  _modelConfig?: ProviderModelConfig,
): boolean {
  const trimmedId = modelId?.trim();
  if (!trimmedId) return false;
  // xai 的映射 off:null 意味着思考恒开（与桌面端一致）；其余供应商目录
  // 未命中时保持可关闭的兜底判定。
  if (providerId === "xai") {
    return !getSupportedThinkingLevels(resolveThinkingModel(providerId, trimmedId)).includes("off");
  }
  const known = findKnownModelForThinking(providerId, trimmedId);
  return known ? !getSupportedThinkingLevels(known).includes("off") : false;
}

export function getProviderModelDefaults(
  providerId: ProviderId,
  modelId?: string,
  baseUrl?: string,
): Pick<ProviderModelConfig, "contextWindow" | "maxOutputToken"> {
  const known = getKnownModelLimits(providerId, modelId, baseUrl);
  if (known) return known;

  if (
    providerId === "claude_code" &&
    modelId &&
    (/\[1m\]$/i.test(modelId.trim()) || isAnthropicAdaptiveModelId(modelId))
  ) {
    return {
      contextWindow:
        /\[1m\]$/i.test(modelId.trim()) && baseUrl && !shouldSendAnthropicLongContextHeader(baseUrl)
          ? ANTHROPIC_STANDARD_CONTEXT_WINDOW
          : ANTHROPIC_LONG_CONTEXT_WINDOW,
      maxOutputToken: getProviderFallbackLimits(providerId).maxOutputToken,
    };
  }

  return getProviderFallbackLimits(providerId);
}

export function createProviderModelConfig(
  providerId: ProviderId,
  modelId: string,
): ProviderModelConfig {
  const id = modelId.trim();
  const defaults = getProviderModelDefaults(providerId, id);
  return {
    id,
    contextWindow: defaults.contextWindow,
    maxOutputToken: defaults.maxOutputToken,
  };
}

export function normalizeProviderModelConfig(
  input: unknown,
  providerId: ProviderId,
): ProviderModelConfig | null {
  if (typeof input === "string") {
    const id = input.trim();
    return id ? createProviderModelConfig(providerId, id) : null;
  }

  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id =
    typeof obj.id === "string"
      ? obj.id.trim()
      : typeof obj.model === "string"
        ? obj.model.trim()
        : "";
  if (!id) return null;

  const defaults = getProviderModelDefaults(providerId, id);
  const ownedBy =
    (typeof obj.ownedBy === "string" ? obj.ownedBy.trim() : "") ||
    (typeof obj.owned_by === "string" ? obj.owned_by.trim() : "");
  const storedLimits = {
    contextWindow: normalizePositiveInteger(obj.contextWindow, defaults.contextWindow),
    maxOutputToken: normalizePositiveInteger(
      obj.maxOutputToken ?? obj.maxTokens,
      defaults.maxOutputToken,
    ),
  };
  // 退化限额（输出吃满窗口）可能来自坏目录数据落库期或手工配置，读侧统一修复；
  // 规则与目录生成期同源（normalizeModelLimits），对所有供应商一视同仁。
  const limits = normalizeModelLimits(storedLimits);
  return {
    id,
    ...(ownedBy ? { ownedBy } : {}),
    contextWindow: limits.contextWindow,
    maxOutputToken: limits.maxOutputToken,
  };
}
export function normalizeProviderModelConfigs(
  input: unknown,
  providerId: ProviderId,
): ProviderModelConfig[] {
  if (!Array.isArray(input)) return [];

  const out: ProviderModelConfig[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const normalized = normalizeProviderModelConfig(item, providerId);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }

  return out;
}

export function findProviderModelConfig(
  provider: Pick<CustomProvider, "models" | "type"> & { baseUrl?: string },
  modelId: string,
): ProviderModelConfig {
  const normalizedId = modelId.trim();
  const matched = provider.models.find((item) => item.id === normalizedId);
  if (!matched) {
    const defaults = getProviderModelDefaults(provider.type, normalizedId, provider.baseUrl);
    return {
      id: normalizedId,
      contextWindow: defaults.contextWindow,
      maxOutputToken: defaults.maxOutputToken,
    };
  }
  if (provider.type !== "claude_code") return matched;
  const defaults = getProviderModelDefaults(provider.type, normalizedId, provider.baseUrl);
  const known = findCatalogModel("claude_code", normalizedId);
  const isAdaptive = isAnthropicAdaptiveModelId(normalizedId);
  const hasLongContextSuffix = /\[1m\]$/i.test(normalizedId);
  const contextWindow = isAdaptive
    ? Math.max(matched.contextWindow, defaults.contextWindow)
    : hasLongContextSuffix
      ? shouldSendAnthropicLongContextHeader(provider.baseUrl)
        ? Math.max(matched.contextWindow, defaults.contextWindow)
        : defaults.contextWindow
      : known &&
          !shouldSendAnthropicLongContextHeader(provider.baseUrl) &&
          known.contextWindow > ANTHROPIC_STANDARD_CONTEXT_WINDOW
        ? defaults.contextWindow
        : matched.contextWindow === ANTHROPIC_STANDARD_CONTEXT_WINDOW
          ? defaults.contextWindow
          : matched.contextWindow;
  return {
    ...matched,
    contextWindow,
  };
}

function normalizeProviderId(input: unknown): ProviderId {
  switch (input) {
    case "codex":
    case "gemini":
    case "xai":
      return input;
    default:
      return "claude_code";
  }
}

function normalizeProviderName(id: string, input: unknown): string {
  const name = typeof input === "string" && input.trim() ? input.trim() : "未命名供应商";
  if (id === "builtin-claude_code" && name === "Claude Code") return "Anthropic";
  if (id === "builtin-codex" && name === "Codex") return "OpenAI";
  if (id === "builtin-xai" && (name === "xAI" || name === "XAI")) return "Grok";
  return name;
}

function normalizeCustomHeaders(input: unknown): { key: string; value: string }[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const header = item as Record<string, unknown>;
    const key = typeof header.key === "string" ? header.key.trim() : "";
    if (!key) return [];
    return [{ key, value: typeof header.value === "string" ? header.value : "" }];
  });
}

function normalizeProviderModelOrder(
  input: unknown,
  models: readonly ProviderModelConfig[],
): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const validIds = new Set(models.map((model) => model.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of normalizeStringArray(input)) {
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    order.push(model.id);
  }
  return order;
}

export function normalizeCustomProvider(input: unknown): CustomProvider {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const type = normalizeProviderId(obj.type);
  const codexRouting =
    type === "codex" || type === "xai"
      ? normalizeCodexRouting(obj.baseUrl, type === "xai" ? "openai-responses" : obj.requestFormat)
      : undefined;
  const models = normalizeProviderModelConfigs(obj.models, type);
  const modelOrder = normalizeProviderModelOrder(obj.modelOrder, models);
  const validModelIds = new Set(models.map((model) => model.id));
  const apiKey = normalizeApiKey(typeof obj.apiKey === "string" ? obj.apiKey : "");
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid();

  return {
    id,
    name: normalizeProviderName(id, obj.name),
    type,
    baseUrl: codexRouting
      ? codexRouting.baseUrl
      : normalizeBaseUrl(typeof obj.baseUrl === "string" ? obj.baseUrl : ""),
    apiKey,
    apiKeyConfigured: apiKey.length > 0 || obj.apiKeyConfigured === true,
    customHeaders: normalizeCustomHeaders(obj.customHeaders),
    models,
    ...(modelOrder ? { modelOrder } : {}),
    activeModels: normalizeModels(normalizeStringArray(obj.activeModels)).filter((modelId) =>
      validModelIds.has(modelId),
    ),
    requestFormat: type === "xai" ? "openai-responses" : codexRouting?.requestFormat,
    reasoning: normalizeReasoningLevel(obj.reasoning),
    // Anthropic/OpenAI 默认开启提示词缓存（OpenAI 侧体现为稳定的
    // prompt_cache_key 路由提示）；Gemini / xAI 不使用 OpenAI 风格 prompt cache。
    promptCachingEnabled:
      type === "gemini" || type === "xai" ? false : obj.promptCachingEnabled !== false,
    ...(type === "claude_code" && obj.promptCacheRetention === "long"
      ? { promptCacheRetention: "long" as const }
      : {}),
    nativeWebSearchEnabled: obj.nativeWebSearchEnabled !== false,
    useSystemProxy: obj.useSystemProxy === true,
  };
}

export function normalizeAgentPromptTemplate(input: unknown): AgentPromptTemplate {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid(),
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "未命名模板",
    description: normalizeOptionalText(obj.description),
    prompt: normalizeOptionalText(obj.prompt),
    enabled: obj.enabled === true,
  };
}

function normalizeSshAuthType(input: unknown): SshAuthType {
  switch (input) {
    case "privateKey":
    case "keyboardInteractive":
      return input;
    default:
      return "password";
  }
}

function normalizeSshPort(input: unknown): number {
  const value = typeof input === "number" || typeof input === "string" ? Number(input) : 22;
  if (!Number.isFinite(value)) return 22;
  const port = Math.floor(value);
  return port >= 1 && port <= 65535 ? port : 22;
}

function normalizeSshProxyPort(input: unknown): number {
  const value = typeof input === "number" || typeof input === "string" ? Number(input) : 0;
  if (!Number.isFinite(value)) return 0;
  const port = Math.floor(value);
  return port >= 1 && port <= 65535 ? port : 0;
}

function normalizeSshProxyType(input: unknown): SshProxyType {
  return input === "http" ? "http" : "socks5";
}

export function normalizeSshProxyConfig(input: unknown): SshProxyConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const password = normalizeOptionalText(obj.password);
  return {
    type: normalizeSshProxyType(obj.type),
    url: normalizeOptionalText(obj.url),
    port: normalizeSshProxyPort(obj.port),
    username: typeof obj.username === "string" ? obj.username.trim() : "",
    password,
    passwordConfigured: password.length > 0 || obj.passwordConfigured === true,
  };
}

export function normalizeSshHostConfig(input: unknown): SshHostConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const host = typeof obj.host === "string" ? obj.host.trim() : "";
  const name =
    typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : host || "未命名 SSH";
  const authType = normalizeSshAuthType(obj.authType);
  const password = authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.password);
  const privateKey =
    authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.privateKey);
  const privateKeyPath =
    authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.privateKeyPath);
  const privateKeyPassphrase =
    authType === "keyboardInteractive" ? "" : normalizeOptionalText(obj.privateKeyPassphrase);
  const passwordConfigured =
    authType !== "keyboardInteractive" && (password.length > 0 || obj.passwordConfigured === true);
  const privateKeyConfigured =
    authType !== "keyboardInteractive" &&
    (privateKey.length > 0 || privateKeyPath.length > 0 || obj.privateKeyConfigured === true);
  const privateKeyPassphraseConfigured =
    authType !== "keyboardInteractive" &&
    (privateKeyPassphrase.length > 0 || obj.privateKeyPassphraseConfigured === true);

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createUuid(),
    name,
    description: normalizeOptionalText(obj.description),
    host,
    port: normalizeSshPort(obj.port),
    username: typeof obj.username === "string" ? obj.username.trim() : "",
    authType,
    password,
    passwordConfigured,
    privateKey,
    privateKeyPath,
    privateKeyConfigured,
    privateKeyPassphrase,
    privateKeyPassphraseConfigured,
    proxy: normalizeSshProxyConfig(obj.proxy),
  };
}

export function normalizeSshSettings(input: unknown): SshSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sourceHosts = Array.isArray(obj.hosts) ? obj.hosts : [];
  const seenIds = new Set<string>();
  const hosts = sourceHosts.map((host) => {
    const normalized = normalizeSshHostConfig(host);
    if (!seenIds.has(normalized.id)) {
      seenIds.add(normalized.id);
      return normalized;
    }
    const id = createUuid();
    seenIds.add(id);
    return { ...normalized, id };
  });
  const hostIds = new Set(hosts.map((host) => host.id));

  return {
    hosts,
    projectHostAssociations: normalizeSshProjectHostAssociations(
      obj.projectHostAssociations,
      hostIds,
    ),
  };
}

function normalizeSshProjectHostAssociations(
  input: unknown,
  hostIds: ReadonlySet<string>,
): Record<string, string[]> {
  const rawAssociations = (
    input && typeof input === "object" && !Array.isArray(input) ? input : {}
  ) as Record<string, unknown>;
  const associations: Record<string, string[]> = {};
  const canonicalKeys = new Set<string>();
  for (const [pathKey, rawHostIds] of Object.entries(rawAssociations)) {
    if (!Array.isArray(rawHostIds)) continue;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const rawHostId of rawHostIds) {
      if (typeof rawHostId !== "string") continue;
      const hostId = rawHostId.trim();
      if (!hostId || !hostIds.has(hostId) || seen.has(hostId)) continue;
      seen.add(hostId);
      ids.push(hostId);
      if (ids.length >= 64) break;
    }
    if (ids.length === 0) continue;
    assignNormalizedProjectKeyValue(associations, canonicalKeys, pathKey, ids);
    if (Object.keys(associations).length >= 100) break;
  }
  return associations;
}

export function getDefaultSystemProxyConfig(): SystemProxyConfig {
  return {
    enabled: false,
    type: "http",
    host: "",
    port: 0,
    username: "",
    password: "",
  };
}

export function isValidSystemProxyHost(input: string): boolean {
  const host = input.trim();
  if (!host || /[\s/\\@#?%]/.test(host)) return false;
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const hostForUrl = host.includes(":") && !bracketed ? `[${host}]` : host;
  try {
    const parsed = new URL(`http://${hostForUrl}`);
    return parsed.hostname.length > 0 && parsed.port === "";
  } catch {
    return false;
  }
}

export function normalizeSystemProxyConfig(input: unknown): SystemProxyConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const port = Number(obj.port);
  const password = typeof obj.password === "string" ? obj.password : "";
  return {
    enabled: obj.enabled === true,
    type: obj.type === "socks5" ? "socks5" : "http",
    host: typeof obj.host === "string" ? obj.host.trim() : "",
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
    username: typeof obj.username === "string" ? obj.username.trim() : "",
    password,
    passwordConfigured: password.trim().length > 0 || obj.passwordConfigured === true,
  };
}

export function normalizeSystemSettings(input: unknown): SystemSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    executionMode: normalizeExecutionMode(obj.executionMode),
    workdir: normalizeWorkdir(obj.workdir),
    selectedSystemTools: normalizeSystemToolSelection(obj.selectedSystemTools),
    workspaceProjects: normalizeWorkspaceProjects(obj.workspaceProjects),
    activeWorkspaceProjectId:
      typeof obj.activeWorkspaceProjectId === "string" && obj.activeWorkspaceProjectId.trim()
        ? obj.activeWorkspaceProjectId.trim()
        : undefined,
    hiddenWorkspaceProjectPaths: normalizeHiddenWorkspaceProjectPaths(
      obj.hiddenWorkspaceProjectPaths,
    ),
    missingWorkspaceProjectPaths: normalizeMissingWorkspaceProjectPaths(
      obj.missingWorkspaceProjectPaths,
    ),
    archivedWorkspaceProjectPaths: normalizeArchivedWorkspaceProjectPaths(
      obj.archivedWorkspaceProjectPaths,
    ),
    systemProxy: normalizeSystemProxyConfig(obj.systemProxy),
  };
}

export function normalizeMcpServerConfig(input: unknown): McpServerConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd.trim() : "";
  const messageUrl = typeof obj.messageUrl === "string" ? obj.messageUrl.trim() : "";

  return {
    id,
    enabled: Boolean(obj.enabled),
    transport: normalizeMcpTransport(obj.transport),
    command: typeof obj.command === "string" ? obj.command.trim() : "",
    args: normalizeStringArray(obj.args),
    url: typeof obj.url === "string" ? obj.url.trim() : "",
    env: normalizeRecordStringString(obj.env),
    cwd: cwd || undefined,
    headers: normalizeRecordStringString(obj.headers),
    timeoutMs: normalizeTimeoutMs(obj.timeoutMs),
    messageUrl: messageUrl || undefined,
  };
}

export function normalizeMcpSettings(input: unknown): McpSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const servers = Array.isArray(obj.servers)
    ? obj.servers.map((server) => normalizeMcpServerConfig(server))
    : [];

  return {
    servers,
    selected: normalizeMcpSelection(obj.selected, servers),
  };
}

export function normalizeAgentPromptTemplates(input: unknown): AgentPromptTemplate[] {
  if (!Array.isArray(input)) return [];
  let hasEnabled = false;
  return input.map((template) => {
    const normalized = normalizeAgentPromptTemplate(template);
    if (!normalized.enabled) return normalized;
    if (hasEnabled) return { ...normalized, enabled: false };
    hasEnabled = true;
    return normalized;
  });
}

export function normalizeSkillsSettings(input: unknown): SkillsSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    enabled: obj.enabled === false ? false : true,
    selected: mergeAlwaysEnabledSkillNames(normalizeStringArray(obj.selected)),
  };
}

export function normalizeSelectedModel(input: unknown): SelectedModel | undefined {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const customProviderId =
    typeof obj.customProviderId === "string" ? obj.customProviderId.trim() : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";

  if (!customProviderId || !model) return undefined;
  return { customProviderId, model };
}

export function parseSelectedModelJson(json: string | null | undefined): SelectedModel | undefined {
  if (!json?.trim()) return undefined;
  try {
    return normalizeSelectedModel(JSON.parse(json));
  } catch {
    return undefined;
  }
}

export function serializeSelectedModelJson(
  selectedModel: SelectedModel | undefined,
): string | undefined {
  const normalized = normalizeSelectedModel(selectedModel);
  return normalized ? JSON.stringify(normalized) : undefined;
}

export function normalizeTheme(input: unknown): Theme {
  if (input === "dark") return "dark";
  if (input === "system" || input === "auto") return "system";
  return "light";
}

export function resolveEffectiveTheme(theme: Theme): EffectiveTheme {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

export function getNextTheme(theme: Theme): Theme {
  if (theme === "light") return "dark";
  if (theme === "dark") return "system";
  return "light";
}

export function subscribeToSystemThemePreference(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const query = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }

  query.addListener(listener);
  return () => query.removeListener(listener);
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function getDefaultMemoryOrganizerSchedule(): MemoryOrganizerSchedule {
  return {
    frequency: "none",
    timeLocal: "03:00",
    weekday: 1,
    timezone: localTimezone(),
  };
}

function normalizeMemoryOrganizerFrequency(input: unknown): MemoryOrganizerFrequency {
  if (input === "daily" || input === "weekly") return input;
  return "none";
}

function normalizeMemoryOrganizerTime(input: unknown) {
  const value = typeof input === "string" ? input.trim() : "";
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "03:00";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? value : "03:00";
}

function normalizeMemoryOrganizerWeekday(input: unknown) {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 1;
}

function normalizeMemoryOrganizerSchedule(input: unknown): MemoryOrganizerSchedule {
  const defaults = getDefaultMemoryOrganizerSchedule();
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    frequency: normalizeMemoryOrganizerFrequency(obj.frequency),
    timeLocal: normalizeMemoryOrganizerTime(obj.timeLocal),
    weekday: normalizeMemoryOrganizerWeekday(obj.weekday),
    timezone:
      typeof obj.timezone === "string" && obj.timezone.trim()
        ? obj.timezone.trim()
        : defaults.timezone,
  };
}

function normalizeMemoryOrganizerScope(input: unknown): MemoryOrganizerScope {
  switch (input) {
    case "global":
    case "projects":
    case "current-project":
      return input;
    default:
      return "all";
  }
}

function normalizeMemoryOrganizerMode(input: unknown): MemoryOrganizerMode {
  switch (input) {
    case "conservative":
    case "aggressive":
      return input;
    default:
      return "standard";
  }
}

function normalizeOptionalTimestamp(input: unknown): number | undefined {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function computeNextMemoryOrganizerRunAt(
  schedule: MemoryOrganizerSchedule,
  from = Date.now(),
): number | undefined {
  if (schedule.frequency === "none") {
    return undefined;
  }

  const [hourRaw, minuteRaw] = schedule.timeLocal.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const base = new Date(from);
  const candidate = new Date(base);
  candidate.setSeconds(0, 0);
  candidate.setHours(
    Number.isInteger(hour) ? hour : 3,
    Number.isInteger(minute) ? minute : 0,
    0,
    0,
  );

  if (schedule.frequency === "weekly") {
    const targetWeekday = normalizeMemoryOrganizerWeekday(schedule.weekday);
    const currentWeekday = candidate.getDay();
    let days = (targetWeekday - currentWeekday + 7) % 7;
    if (days === 0 && candidate.getTime() <= from) {
      days = 7;
    }
    candidate.setDate(candidate.getDate() + days);
    return candidate.getTime();
  }

  if (candidate.getTime() <= from) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

export function normalizeSelectedModelForProviders(
  selectedModel: SelectedModel | undefined,
  customProviders: CustomProvider[],
): SelectedModel | undefined {
  if (!selectedModel) {
    return undefined;
  }

  const provider = customProviders.find((item) => item.id === selectedModel.customProviderId);
  if (!provider) {
    return undefined;
  }

  return provider.activeModels.includes(selectedModel.model) ? selectedModel : undefined;
}

export function normalizeMemorySettings(
  input: unknown,
  customProviders: CustomProvider[],
): MemorySettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const organizerModel = normalizeSelectedModelForProviders(
    normalizeSelectedModel(obj.organizerModel),
    customProviders,
  );
  const organizerSchedule = normalizeMemoryOrganizerSchedule(obj.organizerSchedule);
  const organizerEnabled =
    obj.organizerEnabled === true &&
    Boolean(organizerModel) &&
    organizerSchedule.frequency !== "none";
  const organizerNextRunAt = organizerEnabled
    ? (normalizeOptionalTimestamp(obj.organizerNextRunAt) ??
      computeNextMemoryOrganizerRunAt(organizerSchedule) ??
      undefined)
    : undefined;
  return {
    organizerModel,
    summaryModel: normalizeSelectedModelForProviders(
      normalizeSelectedModel(obj.summaryModel),
      customProviders,
    ),
    organizerEnabled,
    organizerSchedule,
    organizerScope: normalizeMemoryOrganizerScope(obj.organizerScope),
    organizerMode: normalizeMemoryOrganizerMode(obj.organizerMode),
    organizerLastRunAt: normalizeOptionalTimestamp(obj.organizerLastRunAt),
    organizerNextRunAt,
  };
}

export const RIGHT_DOCK_SINGLETON_TAB_IDS = {
  fileTree: "tool:fileTree",
  gitReview: "tool:gitReview",
  tunnel: "tool:tunnel",
  sshTunnel: "tool:sshTunnel",
} as const satisfies Record<RightDockToolKind, string>;

const RIGHT_DOCK_TOOL_KIND_BY_TAB_ID = new Map<string, RightDockToolKind>(
  RIGHT_DOCK_TOOL_KINDS.map((kind) => [RIGHT_DOCK_SINGLETON_TAB_IDS[kind], kind]),
);

export function rightDockToolKindForTabId(tabId: string): RightDockToolKind | undefined {
  return RIGHT_DOCK_TOOL_KIND_BY_TAB_ID.get(tabId);
}

// Empty buckets whose tools were closed act as tombstones so a stale snapshot
// cannot resurrect them through merge; they expire after this window.
const RIGHT_DOCK_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_RIGHT_DOCK_PROJECTS = 100;

export const DEFAULT_RIGHT_DOCK_FILE_TREE_STATE: RightDockFileTreeState = {
  query: "",
  selectedPath: "",
  expandedPaths: [""],
  showHidden: false,
  revision: 0,
};

function normalizeRightDockFileTreeSearchQuery(query: unknown): string {
  return typeof query === "string" ? query.slice(0, 200) : "";
}

function normalizeRightDockFileTreeExpandedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [""];
  const normalized = Array.from(
    new Set(
      paths
        .map((path) => normalizeRightDockFileTreePath(path))
        .filter((path) => path.length <= 1024),
    ),
  );
  return normalized.slice(0, 512);
}

export function normalizeRightDockFileTreeState(input: unknown): RightDockFileTreeState {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    query: normalizeRightDockFileTreeSearchQuery(obj.query),
    selectedPath: normalizeRightDockFileTreePath(obj.selectedPath),
    expandedPaths: normalizeRightDockFileTreeExpandedPaths(obj.expandedPaths),
    showHidden: obj.showHidden === true,
    revision: normalizeIntegerInRange(obj.revision, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function normalizeRightDockTabOrder(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > 160 || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    if (order.length >= 128) break;
  }
  return order;
}

function normalizeRightDockRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key.trim() || key.length > 80) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      Array.isArray(value) ||
      (value && typeof value === "object")
    ) {
      output[key] = value;
    }
    if (Object.keys(output).length >= 64) break;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeRightDockToolUiState(
  kind: RightDockToolKind,
  input: unknown,
): Record<string, unknown> | undefined {
  if (kind === "fileTree") {
    return normalizeRightDockFileTreeState(input);
  }
  return normalizeRightDockRecord(input);
}

function normalizeRightDockToolTab(kind: RightDockToolKind, input: unknown): RightDockToolTab {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const uiState = normalizeRightDockToolUiState(kind, obj.uiState);
  return {
    openedAt: normalizeIntegerInRange(obj.openedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    ...(uiState ? { uiState } : {}),
  };
}

// Accepts both the current shape ({ tools }) and the legacy persisted shape
// ({ tabs } keyed by tab id, including now-derived terminal entries which are
// dropped). tabOrder keeps unknown ids: they are terminal session ids.
export function normalizeRightDockProjectState(input: unknown): RightDockProjectState {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawTools = (
    obj.tools && typeof obj.tools === "object" && !Array.isArray(obj.tools) ? obj.tools : {}
  ) as Record<string, unknown>;
  const legacyTabs = (
    obj.tabs && typeof obj.tabs === "object" && !Array.isArray(obj.tabs) ? obj.tabs : {}
  ) as Record<string, unknown>;
  const tools: Partial<Record<RightDockToolKind, RightDockToolTab>> = {};
  for (const kind of RIGHT_DOCK_TOOL_KINDS) {
    const raw = rawTools[kind] ?? legacyTabs[RIGHT_DOCK_SINGLETON_TAB_IDS[kind]];
    if (!raw || typeof raw !== "object") continue;
    const legacy = raw as Record<string, unknown>;
    tools[kind] = normalizeRightDockToolTab(
      kind,
      "openedAt" in legacy ? legacy : { ...legacy, openedAt: legacy.createdAt },
    );
  }
  const tabOrder = normalizeRightDockTabOrder(obj.tabOrder);
  for (const kind of RIGHT_DOCK_TOOL_KINDS) {
    const tabId = RIGHT_DOCK_SINGLETON_TAB_IDS[kind];
    if (tools[kind] && !tabOrder.includes(tabId)) tabOrder.push(tabId);
  }
  const rawActiveTabId = typeof obj.activeTabId === "string" ? obj.activeTabId.trim() : "";
  const activeTabId = rawActiveTabId && rawActiveTabId.length <= 160 ? rawActiveTabId : undefined;
  return {
    ...(activeTabId ? { activeTabId } : {}),
    tabOrder,
    tools,
    openVersion: normalizeIntegerInRange(obj.openVersion, 0, Number.MAX_SAFE_INTEGER, 0),
    stateVersion: normalizeIntegerInRange(obj.stateVersion, 0, Number.MAX_SAFE_INTEGER, 0),
    writerId: typeof obj.writerId === "string" ? obj.writerId.trim().slice(0, 32) : "",
    lastUsedAt: normalizeIntegerInRange(obj.lastUsedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function normalizeRightDockSettings(input: unknown): RightDockSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawProjects = (
    obj.projects && typeof obj.projects === "object" && !Array.isArray(obj.projects)
      ? obj.projects
      : {}
  ) as Record<string, unknown>;
  const now = Date.now();
  const projects: Record<string, RightDockProjectState> = {};
  for (const [pathKey, projectState] of Object.entries(rawProjects)) {
    const normalizedPathKey = workspaceProjectPathKey(pathKey);
    if (!normalizedPathKey || projects[normalizedPathKey]) continue;
    const project = normalizeRightDockProjectState(projectState);
    const isEmpty = Object.keys(project.tools).length === 0;
    if (isEmpty && project.openVersion === 0 && project.stateVersion === 0) continue;
    if (isEmpty) {
      // Tombstone: start (or continue) the expiry clock, drop once elapsed.
      const tombstonedAt = project.lastUsedAt > 0 ? project.lastUsedAt : now;
      if (now - tombstonedAt > RIGHT_DOCK_TOMBSTONE_TTL_MS) continue;
      projects[normalizedPathKey] = { ...project, lastUsedAt: tombstonedAt };
      continue;
    }
    projects[normalizedPathKey] = project;
  }
  const keys = Object.keys(projects);
  if (keys.length > MAX_RIGHT_DOCK_PROJECTS) {
    // Keep the most recently used buckets instead of the first-inserted ones.
    keys.sort((a, b) => {
      const byRecency = (projects[b]?.lastUsedAt ?? 0) - (projects[a]?.lastUsedAt ?? 0);
      return byRecency !== 0 ? byRecency : a.localeCompare(b);
    });
    for (const key of keys.slice(MAX_RIGHT_DOCK_PROJECTS)) {
      delete projects[key];
    }
  }
  return {
    width: normalizeIntegerInRange(obj.width, 320, 1280, 420),
    projects,
  };
}

export function normalizeFontScale(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(1.4, Math.max(0.8, Math.round(num * 100) / 100));
}

export function normalizeFontScaleSettings(input: unknown): FontScaleSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    sidebar: normalizeFontScale(obj.sidebar),
    chat: normalizeFontScale(obj.chat),
    rightDock: normalizeFontScale(obj.rightDock),
  };
}

export function normalizeCustomSettings(
  input: unknown,
  customProviders: CustomProvider[],
): CustomSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const chatSidebar = (
    obj.chatSidebar && typeof obj.chatSidebar === "object" ? obj.chatSidebar : {}
  ) as Record<string, unknown>;
  return {
    conversationTitleModel: normalizeSelectedModelForProviders(
      normalizeSelectedModel(obj.conversationTitleModel),
      customProviders,
    ),
    chatSidebar: {
      projectsCollapsed: chatSidebar.projectsCollapsed === true,
      recentCollapsed: chatSidebar.recentCollapsed === true,
    },
    rightDock: normalizeRightDockSettings(obj.rightDock),
    // Read the retired field only to migrate persisted settings; normalization never emits it.
    interfaceFontFamily: normalizeFontFamily(
      Object.hasOwn(obj, "interfaceFontFamily") ? obj.interfaceFontFamily : obj.fontFamily,
    ),
    chatFontFamily: normalizeFontFamily(obj.chatFontFamily),
    codeFontFamily: normalizeFontFamily(obj.codeFontFamily),
    fontScale: normalizeFontScaleSettings(obj.fontScale),
  };
}

export function getDefaultSettings(): AppSettings {
  const customProviders = getBuiltinCustomProviders();
  return {
    system: {
      executionMode: "tools",
      workdir: "",
      selectedSystemTools: [],
      workspaceProjects: [],
      activeWorkspaceProjectId: undefined,
      hiddenWorkspaceProjectPaths: [],
      missingWorkspaceProjectPaths: [],
      archivedWorkspaceProjectPaths: [],
      systemProxy: getDefaultSystemProxyConfig(),
    },
    customProviders,
    mcp: {
      servers: [],
      selected: [],
    },
    agents: [],
    ssh: {
      hosts: [],
      projectHostAssociations: {},
    },
    remote: {
      enabled: false,
      gatewayUrl: "",
      gatewayPort: 443,
      token: "",
      agentId: "",
      autoReconnect: true,
      heartbeatInterval: 30,
      enableWebTerminal: false,
      enableWebSshTerminal: false,
      enableWebGit: false,
      enableWebTunnels: false,
    },
    memory: normalizeMemorySettings({}, customProviders),
    customSettings: normalizeCustomSettings({}, customProviders),
    skills: {
      enabled: true,
      selected: mergeAlwaysEnabledSkillNames([]),
    },
    chatRuntimeControls: DEFAULT_CHAT_RUNTIME_CONTROLS,
    selectedModel: undefined,
    theme: "light",
    locale: DEFAULT_LOCALE,
  };
}

export function normalizeSettings(input?: Partial<AppSettings> | null): AppSettings {
  const defaults = getDefaultSettings();
  const obj = (input && typeof input === "object" ? input : {}) as Partial<AppSettings>;
  const customProviders = Array.isArray(obj.customProviders)
    ? obj.customProviders.map((provider) => normalizeCustomProvider(provider))
    : defaults.customProviders;
  const selectedModel = normalizeSelectedModelForProviders(
    normalizeSelectedModel(obj.selectedModel),
    customProviders,
  );

  return {
    system: normalizeSystemSettings(obj.system ?? defaults.system),
    customProviders,
    mcp: normalizeMcpSettings(obj.mcp ?? defaults.mcp),
    agents: normalizeAgentPromptTemplates(obj.agents ?? defaults.agents),
    ssh: normalizeSshSettings(obj.ssh ?? defaults.ssh),
    remote: normalizeRemoteSettings(obj.remote ?? defaults.remote),
    memory: normalizeMemorySettings(obj.memory ?? defaults.memory, customProviders),
    customSettings: normalizeCustomSettings(
      obj.customSettings ?? defaults.customSettings,
      customProviders,
    ),
    skills: normalizeSkillsSettings(obj.skills ?? defaults.skills),
    chatRuntimeControls: normalizeChatRuntimeControls(
      obj.chatRuntimeControls ?? defaults.chatRuntimeControls,
    ),
    selectedModel,
    theme: normalizeTheme(obj.theme),
    locale: normalizeLocale(obj.locale),
  };
}

export function updateSystem(prev: AppSettings, patch: Partial<SystemSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    system: {
      ...prev.system,
      ...patch,
    },
  });
}

export function updateMcp(prev: AppSettings, patch: Partial<McpSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    mcp: {
      ...prev.mcp,
      ...patch,
    },
  });
}

export function updateAgents(prev: AppSettings, agents: AgentPromptTemplate[]): AppSettings {
  return normalizeSettings({
    ...prev,
    agents,
  });
}

export function updateSsh(prev: AppSettings, patch: Partial<SshSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    ssh: {
      ...prev.ssh,
      ...patch,
    },
  });
}

function normalizeSshProjectHostIdList(ssh: SshSettings, hostIds: readonly string[]): string[] {
  const availableHostIds = new Set(ssh.hosts.map((host) => host.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const rawHostId of hostIds) {
    const hostId = rawHostId.trim();
    if (!hostId || !availableHostIds.has(hostId) || seen.has(hostId)) continue;
    seen.add(hostId);
    ids.push(hostId);
    if (ids.length >= 64) break;
  }
  return ids;
}

export function getSshProjectHostIds(ssh: SshSettings, projectPathKey: string): string[] {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return [];
  return normalizeSshProjectHostIdList(ssh, ssh.projectHostAssociations[normalizedPathKey] ?? []);
}

export function updateSshProjectHostIds(
  prev: AppSettings,
  projectPathKey: string,
  hostIds: readonly string[],
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const nextHostIds = normalizeSshProjectHostIdList(prev.ssh, hostIds);
  const currentHostIds = getSshProjectHostIds(prev.ssh, normalizedPathKey);
  if (
    currentHostIds.length === nextHostIds.length &&
    currentHostIds.every((hostId, index) => hostId === nextHostIds[index])
  ) {
    return prev;
  }
  const projectHostAssociations = { ...prev.ssh.projectHostAssociations };
  if (nextHostIds.length > 0) {
    projectHostAssociations[normalizedPathKey] = nextHostIds;
  } else {
    delete projectHostAssociations[normalizedPathKey];
  }
  return updateSsh(prev, { projectHostAssociations });
}

export function removeSshHostFromProjectAssociations(
  prev: AppSettings,
  hostId: string,
): AppSettings {
  const normalizedHostId = hostId.trim();
  if (!normalizedHostId) return prev;
  let changed = false;
  const projectHostAssociations: Record<string, string[]> = {};
  for (const [pathKey, hostIds] of Object.entries(prev.ssh.projectHostAssociations)) {
    const nextHostIds = hostIds.filter((item) => item !== normalizedHostId);
    if (nextHostIds.length !== hostIds.length) {
      changed = true;
    }
    if (nextHostIds.length > 0) {
      projectHostAssociations[pathKey] = nextHostIds;
    }
  }
  return changed ? updateSsh(prev, { projectHostAssociations }) : prev;
}

export function updateSkills(prev: AppSettings, patch: Partial<SkillsSettings>): AppSettings {
  return normalizeSettings({
    ...prev,
    skills: {
      ...prev.skills,
      ...patch,
    },
  });
}

export function updateMemorySettings(
  prev: AppSettings,
  patch: Partial<MemorySettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    memory: {
      ...prev.memory,
      ...patch,
    },
  });
}

export function updateCustomSettings(
  prev: AppSettings,
  patch: Partial<CustomSettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    customSettings: {
      ...prev.customSettings,
      ...patch,
    },
  });
}

const RIGHT_DOCK_WRITER_ID_STORAGE_KEY = "liveagent.client-id";

let cachedRightDockWriterId = "";

function generateRightDockWriterId(): string {
  return createUuid().replace(/-/g, "").slice(0, 12);
}

// Stable per-client id used to break stateVersion ties deterministically in
// mergeSyncedRightDockSettings: both sides of a merge evaluate the same
// (stateVersion, writerId) order, so concurrent writers converge without the
// old "+2 beats the echo" version-bump tricks.
export function getRightDockWriterId(): string {
  if (cachedRightDockWriterId) return cachedRightDockWriterId;
  let stored = "";
  try {
    stored = globalThis.localStorage?.getItem(RIGHT_DOCK_WRITER_ID_STORAGE_KEY) ?? "";
  } catch {
    stored = "";
  }
  const normalized = stored.trim().slice(0, 32);
  if (normalized) {
    cachedRightDockWriterId = normalized;
    return normalized;
  }
  const generated = generateRightDockWriterId();
  try {
    globalThis.localStorage?.setItem(RIGHT_DOCK_WRITER_ID_STORAGE_KEY, generated);
  } catch {
    // Ephemeral id for environments without storage (e.g. tests).
  }
  cachedRightDockWriterId = generated;
  return generated;
}

// Version fields are stamped centrally by updateRightDockProjectState; content
// is everything a user can observe or reorder.
function rightDockProjectContentKey(state: RightDockProjectState): string {
  return JSON.stringify({
    activeTabId: state.activeTabId ?? "",
    tabOrder: state.tabOrder,
    tools: RIGHT_DOCK_TOOL_KINDS.map((kind) => [kind, state.tools[kind] ?? null]),
    openVersion: state.openVersion,
  });
}

function rightDockFileTreeStateEqual(
  left: RightDockFileTreeState,
  right: RightDockFileTreeState,
): boolean {
  return (
    left.query === right.query &&
    left.selectedPath === right.selectedPath &&
    left.showHidden === right.showHidden &&
    left.revision === right.revision &&
    left.expandedPaths.length === right.expandedPaths.length &&
    left.expandedPaths.every((path, index) => path === right.expandedPaths[index])
  );
}

export function getRightDockProjectState(
  customSettings: CustomSettings,
  projectPathKey: string,
): RightDockProjectState {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  return normalizeRightDockProjectState(
    normalizedPathKey ? customSettings.rightDock.projects[normalizedPathKey] : {},
  );
}

export function updateRightDockWidth(prev: AppSettings, width: number): AppSettings {
  const nextWidth = normalizeIntegerInRange(width, 320, 1280, 420);
  if (prev.customSettings.rightDock.width === nextWidth) return prev;
  return updateCustomSettings(prev, {
    rightDock: {
      ...prev.customSettings.rightDock,
      width: nextWidth,
    },
  });
}

// All persisted dock mutations funnel through here: the updater describes
// content only, and version stamping (stateVersion / writerId / lastUsedAt)
// happens centrally so no call site can get the merge bookkeeping wrong.
export function updateRightDockProjectState(
  prev: AppSettings,
  projectPathKey: string,
  updater: (current: RightDockProjectState) => RightDockProjectState,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const current = getRightDockProjectState(prev.customSettings, normalizedPathKey);
  const next = normalizeRightDockProjectState(updater(current));
  if (rightDockProjectContentKey(current) === rightDockProjectContentKey(next)) return prev;
  return updateCustomSettings(prev, {
    rightDock: {
      ...prev.customSettings.rightDock,
      projects: {
        ...prev.customSettings.rightDock.projects,
        [normalizedPathKey]: {
          ...next,
          stateVersion: current.stateVersion + 1,
          writerId: getRightDockWriterId(),
          lastUsedAt: Date.now(),
        },
      },
    },
  });
}

export function createRightDockToolTab(kind: RightDockToolKind): RightDockToolTab {
  return {
    openedAt: Date.now(),
    ...(kind === "fileTree" ? { uiState: DEFAULT_RIGHT_DOCK_FILE_TREE_STATE } : {}),
  };
}

export function openRightDockToolTabState(
  current: RightDockProjectState,
  kind: RightDockToolKind,
): RightDockProjectState {
  const tabId = RIGHT_DOCK_SINGLETON_TAB_IDS[kind];
  const alreadyOpen = Boolean(current.tools[kind]);
  if (alreadyOpen && current.activeTabId === tabId && current.tabOrder.includes(tabId)) {
    return current;
  }
  return {
    ...current,
    activeTabId: tabId,
    tabOrder: current.tabOrder.includes(tabId) ? current.tabOrder : [...current.tabOrder, tabId],
    tools: alreadyOpen ? current.tools : { ...current.tools, [kind]: createRightDockToolTab(kind) },
    openVersion: current.openVersion + (alreadyOpen ? 0 : 1),
  };
}

export function openRightDockSingletonTab(
  prev: AppSettings,
  projectPathKey: string,
  kind: RightDockToolKind,
): AppSettings {
  return updateRightDockProjectState(prev, projectPathKey, (current) =>
    openRightDockToolTabState(current, kind),
  );
}

export function isRightDockSingletonTabOpen(
  customSettings: CustomSettings,
  projectPathKey: string,
  kind: RightDockToolKind,
): boolean {
  const state = getRightDockProjectState(customSettings, projectPathKey);
  return Boolean(state.tools[kind]);
}

export function removeRightDockProjectState(
  prev: AppSettings,
  projectPathKey: string,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const hasRightDockProject = Object.hasOwn(
    prev.customSettings.rightDock.projects,
    normalizedPathKey,
  );
  const hasSshProjectAssociation = Object.hasOwn(
    prev.ssh.projectHostAssociations,
    normalizedPathKey,
  );
  if (!hasRightDockProject && !hasSshProjectAssociation) return prev;
  const currentRightDockProject = getRightDockProjectState(prev.customSettings, normalizedPathKey);
  const hasRightDockTools = Object.keys(currentRightDockProject.tools).length > 0;
  if (hasRightDockProject && !hasRightDockTools && !hasSshProjectAssociation) return prev;

  const projects = hasRightDockProject
    ? { ...prev.customSettings.rightDock.projects }
    : prev.customSettings.rightDock.projects;
  if (hasRightDockProject && hasRightDockTools) {
    projects[normalizedPathKey] = {
      tabOrder: [],
      tools: {},
      openVersion: currentRightDockProject.openVersion + 1,
      stateVersion: currentRightDockProject.stateVersion + 1,
      writerId: getRightDockWriterId(),
      lastUsedAt: Date.now(),
    };
  }
  const projectHostAssociations = hasSshProjectAssociation
    ? { ...prev.ssh.projectHostAssociations }
    : prev.ssh.projectHostAssociations;
  if (hasSshProjectAssociation) delete projectHostAssociations[normalizedPathKey];

  return normalizeSettings({
    ...prev,
    ssh: {
      ...prev.ssh,
      projectHostAssociations,
    },
    customSettings: {
      ...prev.customSettings,
      rightDock: {
        ...prev.customSettings.rightDock,
        projects,
      },
    },
  });
}

export function getRightDockFileTreeState(
  customSettings: CustomSettings,
  projectPathKey: string,
): RightDockFileTreeState {
  const projectState = getRightDockProjectState(customSettings, projectPathKey);
  const state = projectState.tools.fileTree?.uiState;
  return state ? normalizeRightDockFileTreeState(state) : DEFAULT_RIGHT_DOCK_FILE_TREE_STATE;
}

export function updateRightDockFileTreeState(
  prev: AppSettings,
  projectPathKey: string,
  patch: RightDockFileTreeStatePatch,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const current = getRightDockFileTreeState(prev.customSettings, normalizedPathKey);
  const next: RightDockFileTreeState = {
    query:
      patch.query !== undefined
        ? normalizeRightDockFileTreeSearchQuery(patch.query)
        : current.query,
    selectedPath:
      patch.selectedPath !== undefined
        ? normalizeRightDockFileTreePath(patch.selectedPath)
        : current.selectedPath,
    expandedPaths:
      patch.expandedPaths !== undefined
        ? normalizeRightDockFileTreeExpandedPaths(patch.expandedPaths)
        : current.expandedPaths,
    showHidden: patch.showHidden ?? current.showHidden,
    revision: patch.bumpRevision
      ? current.revision + 1
      : patch.revision !== undefined
        ? normalizeIntegerInRange(patch.revision, 0, Number.MAX_SAFE_INTEGER, 0)
        : current.revision,
  };
  if (rightDockFileTreeStateEqual(current, next)) return prev;
  return updateRightDockProjectState(prev, normalizedPathKey, (projectState) => {
    const tab = projectState.tools.fileTree ?? createRightDockToolTab("fileTree");
    return {
      ...projectState,
      tools: {
        ...projectState.tools,
        fileTree: { ...tab, uiState: next },
      },
    };
  });
}

export function updateCustomProviders(
  prev: AppSettings,
  customProviders: CustomProvider[],
): AppSettings {
  return normalizeSettings({
    ...prev,
    customProviders,
  });
}

export function setSelectedModel(
  prev: AppSettings,
  selectedModel: SelectedModel | undefined,
): AppSettings {
  return normalizeSettings({
    ...prev,
    selectedModel,
  });
}
