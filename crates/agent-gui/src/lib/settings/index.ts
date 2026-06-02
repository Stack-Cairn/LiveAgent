import { DEFAULT_LOCALE, type Locale, normalizeLocale } from "../../i18n/config";
import { mergeAlwaysEnabledSkillNames } from "../skills/builtin";
import { CUSTOM_SYSTEM_TOOL_OPTIONS, type SystemToolId } from "../tools/customSystemTools";
import { normalizeApiKey, normalizeBaseUrl, normalizeModels } from "./normalize";

export type { SystemToolId } from "../tools/customSystemTools";

export type ProviderId = "codex" | "claude_code" | "gemini";

export type ExecutionMode = "text" | "tools" | "agent-dev";

export type CodexRequestFormat = "openai-completions" | "openai-responses";

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type McpTransport = "stdio" | "http" | "sse";

export type HookLifecycleEventType =
  | "agent_start"
  | "turn_start"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "turn_end"
  | "agent_end";

export type ConversationHookType = "command" | "http";

export type HookHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type HookHttpRequest = {
  id: string;
  url: string;
  method: HookHttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
};

export type CronTaskType = "bash" | "http" | "prompt";

export type CronTask = {
  id: string;
  name: string;
  description: string;
  cron: string;
  enabled: boolean;
  remainingExecutions?: number;
  type: CronTaskType;
  script?: string;
  requests?: HookHttpRequest[];
  prompt?: string;
  selectedModel?: SelectedModel;
};

export type CronExecutionLog = {
  id: string;
  taskId: string;
  startedAt: number;
  success: boolean;
  durationMs: number;
  exitCode?: number;
  output?: string;
};

export type ConversationHook = {
  id: string;
  event: HookLifecycleEventType;
  name: string;
  description: string;
  enabled: boolean;
  type: ConversationHookType;
  script?: string;
  requests?: HookHttpRequest[];
};

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

export type ProjectToolsPanelTab = "terminal" | "fileTree" | "gitReview";

export type ProjectToolsPanelSettings = {
  width: number;
  activeTab: ProjectToolsPanelTab;
  tabOrders: Record<string, string[]>;
};

export type ProjectToolsFileTreeProjectState = {
  query: string;
  selectedPath: string;
  expandedPaths: string[];
  revision: number;
  stateVersion: number;
};

export type ProjectToolsFileTreeSettings = {
  openProjectPathKeys: string[];
  openVersion: number;
  projects: Record<string, ProjectToolsFileTreeProjectState>;
};

export type ProjectToolsGitReviewSettings = {
  openProjectPathKeys: string[];
  openVersion: number;
};

export type ProjectToolsFileTreeStatePatch = Partial<ProjectToolsFileTreeProjectState> & {
  bumpRevision?: boolean;
  bumpStateVersion?: boolean;
};

export type CustomSettings = {
  conversationTitleModel?: SelectedModel;
  chatSidebar: ChatSidebarSettings;
  projectToolsPanel: ProjectToolsPanelSettings;
  projectToolsFileTree: ProjectToolsFileTreeSettings;
  projectToolsGitReview: ProjectToolsGitReviewSettings;
};

export type UpdateSettings = {
  includePrereleases: boolean;
};

export type SystemSettings = {
  executionMode: ExecutionMode;
  workdir: string;
  selectedSystemTools: SystemToolId[];
  workspaceProjects: WorkspaceProject[];
  activeWorkspaceProjectId?: string;
  hiddenWorkspaceProjectPaths: string[];
  missingWorkspaceProjectPaths: string[];
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
  | "gemini";

export type AgentPromptTemplate = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  prompt: string;
  enabled: boolean;
};

export type CustomProvider = {
  id: string;
  name: string;
  type: ProviderId;
  baseUrl: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  models: ProviderModelConfig[];
  activeModels: string[];
  requestFormat?: CodexRequestFormat;
  reasoning: ReasoningLevel;
  promptCachingEnabled: boolean;
  nativeWebSearchEnabled: boolean;
};

export type Theme = "light" | "dark";

export type RemoteSettings = {
  enabled: boolean;
  gatewayUrl: string;
  grpcPort: number;
  grpcEndpoint: string;
  token: string;
  agentId: string;
  autoReconnect: boolean;
  heartbeatInterval: number;
  enableWebTerminal: boolean;
  enableWebGit: boolean;
};

export type AppSettings = {
  system: SystemSettings;
  customProviders: CustomProvider[];
  mcp: McpSettings;
  agents: AgentPromptTemplate[];
  hooks: ConversationHook[];
  cron: CronTask[];
  remote: RemoteSettings;
  memory: MemorySettings;
  customSettings: CustomSettings;
  updates: UpdateSettings;
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

export const HOOK_LIFECYCLE_EVENTS: HookLifecycleEventType[] = [
  "agent_start",
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "agent_end",
];

export const HOOK_HTTP_METHODS: HookHttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export const HOOK_EVENT_TRANSLATION_KEYS: Record<HookLifecycleEventType, string> = {
  agent_start: "settings.hooksEventAgentStart",
  turn_start: "settings.hooksEventTurnStart",
  message_start: "settings.hooksEventMessageStart",
  message_update: "settings.hooksEventMessageUpdate",
  message_end: "settings.hooksEventMessageEnd",
  tool_execution_start: "settings.hooksEventToolExecutionStart",
  tool_execution_update: "settings.hooksEventToolExecutionUpdate",
  tool_execution_end: "settings.hooksEventToolExecutionEnd",
  turn_end: "settings.hooksEventTurnEnd",
  agent_end: "settings.hooksEventAgentEnd",
};

export const HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS: Record<HookLifecycleEventType, string> = {
  agent_start: "settings.hooksEventAgentStartDesc",
  turn_start: "settings.hooksEventTurnStartDesc",
  message_start: "settings.hooksEventMessageStartDesc",
  message_update: "settings.hooksEventMessageUpdateDesc",
  message_end: "settings.hooksEventMessageEndDesc",
  tool_execution_start: "settings.hooksEventToolExecutionStartDesc",
  tool_execution_update: "settings.hooksEventToolExecutionUpdateDesc",
  tool_execution_end: "settings.hooksEventToolExecutionEndDesc",
  turn_end: "settings.hooksEventTurnEndDesc",
  agent_end: "settings.hooksEventAgentEndDesc",
};

const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const DEFAULT_MCP_TIMEOUT_MS = 60_000;
const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000;
const DEFAULT_CLAUDE_MAX_OUTPUT_TOKEN = 32_000;
const DEFAULT_CODEX_CONTEXT_WINDOW = 258_000;
const DEFAULT_CODEX_MAX_OUTPUT_TOKEN = 142_000;
const DEFAULT_GEMINI_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_GEMINI_MAX_OUTPUT_TOKEN = 65_536;
export const DEFAULT_CHAT_RUNTIME_CONTROLS: ChatRuntimeControls = {
  thinkingEnabled: true,
  nativeWebSearchEnabled: true,
  reasoning: "high",
  reasoningByProvider: {
    claude_code: "high",
    codex_openai_responses: "high",
    codex_openai_completions: "high",
    gemini: "high",
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
      models: [],
      activeModels: [],
      reasoning: "off",
      promptCachingEnabled: true,
      nativeWebSearchEnabled: true,
    },
    {
      id: "builtin-codex",
      name: "OpenAI",
      type: "codex",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      models: [],
      activeModels: [],
      requestFormat: "openai-responses",
      reasoning: "off",
      promptCachingEnabled: false,
      nativeWebSearchEnabled: true,
    },
    {
      id: "builtin-gemini",
      name: "Gemini",
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      models: [],
      activeModels: [],
      reasoning: "off",
      promptCachingEnabled: false,
      nativeWebSearchEnabled: true,
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

export function workspaceProjectPathKey(path: unknown): string {
  return normalizeWorkspaceProjectPath(path);
}

export function normalizeProjectToolsFileTreePath(path: unknown): string {
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
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID();
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
      id = crypto.randomUUID();
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
      ? { isPinned: true, pinnedAt: defaultExisting.pinnedAt ?? defaultExisting.updatedAt }
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
      id = crypto.randomUUID();
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
  const activeProjectId = projects.some((project) => project.id === system.activeWorkspaceProjectId)
    ? system.activeWorkspaceProjectId
    : DEFAULT_WORKSPACE_PROJECT_ID;
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? defaultProject;
  const workdir = normalizeWorkdir(system.workdir) || defaultPath;

  return {
    ...system,
    workdir,
    workspaceProjects: projects,
    activeWorkspaceProjectId: activeProject.id,
    hiddenWorkspaceProjectPaths,
    missingWorkspaceProjectPaths,
  };
}

export function normalizeReasoningLevel(input: unknown): ReasoningLevel {
  switch (input) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return input;
    default:
      return "off";
  }
}

export function normalizeChatRuntimeReasoning(input: unknown): ReasoningLevel {
  switch (input) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return input;
    default:
      return DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
  }
}

const CHAT_RUNTIME_REASONING_PROVIDER_KEYS: ChatRuntimeReasoningProviderKey[] = [
  "claude_code",
  "codex_openai_responses",
  "codex_openai_completions",
  "gemini",
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
  if (params.providerId === "codex" && params.requestFormat === "openai-completions") {
    return "codex_openai_completions";
  }
  return "codex_openai_responses";
}

function getChatRuntimeReasoningLevelsForProviderKey(
  key: ChatRuntimeReasoningProviderKey,
): ReasoningLevel[] {
  if (key === "claude_code") {
    return ["low", "medium", "high", "xhigh"];
  }
  if (key === "gemini") {
    return ["minimal", "low", "medium", "high"];
  }
  if (key === "codex_openai_completions") {
    return ["minimal", "low", "medium", "high", "xhigh"];
  }
  return ["minimal", "low", "medium", "high", "xhigh"];
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
    const levels = getChatRuntimeReasoningLevelsForProviderKey(key);
    normalized[key] = normalizeChatRuntimeReasoningForLevels(
      Object.hasOwn(obj, key) ? obj[key] : fallbackReasoning,
      levels,
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
}): ReasoningLevel[] {
  return getChatRuntimeReasoningLevelsForProviderKey(getChatRuntimeReasoningProviderKey(params));
}

export function normalizeChatRuntimeControlsForProvider(
  input: unknown,
  params: {
    providerId?: ProviderId;
    requestFormat?: CodexRequestFormat;
  },
): ChatRuntimeControls {
  const controls = normalizeChatRuntimeControls(input);
  const key = getChatRuntimeReasoningProviderKey(params);
  const levels = getChatRuntimeReasoningLevelsForProviderKey(key);
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
  },
): ChatRuntimeControls {
  const key = getChatRuntimeReasoningProviderKey(params);
  const levels = getChatRuntimeReasoningLevelsForProviderKey(key);
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

function normalizeOrderedUniqueStrings(input: unknown): string[] {
  const out: string[] = [];
  for (const value of normalizeStringArray(input)) {
    if (out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function normalizeOptionalText(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function normalizeCronRemainingExecutions(input: unknown): number | undefined {
  if (input == null) return undefined;
  if (typeof input === "string" && input.trim() === "") return undefined;
  const numeric =
    typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) {
    return undefined;
  }
  return numeric;
}

function normalizeHookLifecycleEventType(input: unknown): HookLifecycleEventType {
  return HOOK_LIFECYCLE_EVENTS.includes(input as HookLifecycleEventType)
    ? (input as HookLifecycleEventType)
    : "agent_start";
}

function normalizeConversationHookType(input: unknown): ConversationHookType {
  return input === "http" ? "http" : "command";
}

function normalizeCronTaskType(input: unknown): CronTaskType {
  switch (input) {
    case "http":
    case "prompt":
      return input;
    default:
      return "bash";
  }
}

function normalizeHookHttpMethod(input: unknown): HookHttpMethod {
  const value = typeof input === "string" ? input.trim().toUpperCase() : "";
  return HOOK_HTTP_METHODS.includes(value as HookHttpMethod) ? (value as HookHttpMethod) : "POST";
}

export function canHookHttpMethodHaveBody(method: HookHttpMethod): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function normalizeHookHttpRequest(input: unknown): HookHttpRequest {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const method = normalizeHookHttpMethod(obj.method);
  const body =
    canHookHttpMethodHaveBody(method) && Object.hasOwn(obj, "body") ? obj.body : undefined;

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID(),
    url: normalizeOptionalText(obj.url),
    method,
    headers: normalizeRecordStringString(obj.headers),
    body,
  };
}

export function normalizeConversationHook(input: unknown): ConversationHook {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const type = normalizeConversationHookType(obj.type);

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID(),
    event: normalizeHookLifecycleEventType(obj.event),
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "未命名 Hook",
    description: normalizeOptionalText(obj.description),
    enabled: obj.enabled === true,
    type,
    script: type === "command" ? normalizeOptionalText(obj.script) : undefined,
    requests:
      type === "http" && Array.isArray(obj.requests)
        ? obj.requests.map((request) => normalizeHookHttpRequest(request))
        : undefined,
  };
}

export function normalizeConversationHooks(input: unknown): ConversationHook[] {
  if (!Array.isArray(input)) return [];
  return input.map((hook) => normalizeConversationHook(hook));
}

export function normalizeCronTask(input: unknown): CronTask {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const type = normalizeCronTaskType(obj.type);
  const remainingExecutions = normalizeCronRemainingExecutions(obj.remainingExecutions);

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID(),
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "未命名任务",
    description: normalizeOptionalText(obj.description),
    cron: normalizeOptionalText(obj.cron),
    enabled: obj.enabled === true && remainingExecutions !== 0,
    remainingExecutions,
    type,
    script: type === "bash" ? normalizeOptionalText(obj.script) : undefined,
    requests:
      type === "http" && Array.isArray(obj.requests)
        ? obj.requests.map((request) => normalizeHookHttpRequest(request))
        : undefined,
    prompt: type === "prompt" ? normalizeOptionalText(obj.prompt) : undefined,
    selectedModel: type === "prompt" ? normalizeSelectedModel(obj.selectedModel) : undefined,
  };
}

export function normalizeCronTasks(input: unknown): CronTask[] {
  if (!Array.isArray(input)) return [];
  return input.map((task) => normalizeCronTask(task));
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
  const valid = new Set<SystemToolId>(CUSTOM_SYSTEM_TOOL_OPTIONS.map((tool) => tool.id));
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

function normalizeGrpcEndpoint(input: unknown): string {
  const value = normalizeOptionalText(input);
  if (!value) return "";
  if (/^https?:/i.test(value)) return normalizeBaseUrl(value);
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeRemoteSettings(input: unknown): RemoteSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    gatewayUrl: normalizeBaseUrl(typeof obj.gatewayUrl === "string" ? obj.gatewayUrl : ""),
    grpcPort: normalizeIntegerInRange(obj.grpcPort, 1, 65_535, 50051),
    grpcEndpoint: normalizeGrpcEndpoint(obj.grpcEndpoint),
    token: normalizeApiKey(typeof obj.token === "string" ? obj.token : ""),
    agentId: normalizeOptionalText(obj.agentId),
    autoReconnect: obj.autoReconnect !== false,
    heartbeatInterval: normalizePositiveInteger(obj.heartbeatInterval, 30),
    enableWebTerminal: obj.enableWebTerminal === true,
    enableWebGit: obj.enableWebGit === true,
  };
}

export function getProviderModelDefaults(
  providerId: ProviderId,
): Pick<ProviderModelConfig, "contextWindow" | "maxOutputToken"> {
  if (providerId === "codex") {
    return {
      contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
      maxOutputToken: DEFAULT_CODEX_MAX_OUTPUT_TOKEN,
    };
  }

  if (providerId === "gemini") {
    return {
      contextWindow: DEFAULT_GEMINI_CONTEXT_WINDOW,
      maxOutputToken: DEFAULT_GEMINI_MAX_OUTPUT_TOKEN,
    };
  }

  return {
    contextWindow: DEFAULT_CLAUDE_CONTEXT_WINDOW,
    maxOutputToken: DEFAULT_CLAUDE_MAX_OUTPUT_TOKEN,
  };
}

export function createProviderModelConfig(
  providerId: ProviderId,
  modelId: string,
): ProviderModelConfig {
  const id = modelId.trim();
  const defaults = getProviderModelDefaults(providerId);
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

  const defaults = getProviderModelDefaults(providerId);
  return {
    id,
    contextWindow: normalizePositiveInteger(obj.contextWindow, defaults.contextWindow),
    maxOutputToken: normalizePositiveInteger(
      obj.maxOutputToken ?? obj.maxTokens,
      defaults.maxOutputToken,
    ),
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
  provider: Pick<CustomProvider, "models" | "type">,
  modelId: string,
): ProviderModelConfig {
  const normalizedId = modelId.trim();
  const matched = provider.models.find((item) => item.id === normalizedId);
  return matched ?? createProviderModelConfig(provider.type, normalizedId);
}

function normalizeProviderId(input: unknown): ProviderId {
  switch (input) {
    case "codex":
    case "gemini":
      return input;
    default:
      return "claude_code";
  }
}

function normalizeProviderName(id: string, input: unknown): string {
  const name = typeof input === "string" && input.trim() ? input.trim() : "未命名供应商";
  if (id === "builtin-claude_code" && name === "Claude Code") return "Anthropic";
  if (id === "builtin-codex" && name === "Codex") return "OpenAI";
  return name;
}

export function normalizeCustomProvider(input: unknown): CustomProvider {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const type = normalizeProviderId(obj.type);
  const codexRouting =
    type === "codex" ? normalizeCodexRouting(obj.baseUrl, obj.requestFormat) : undefined;
  const models = normalizeProviderModelConfigs(obj.models, type);
  const validModelIds = new Set(models.map((model) => model.id));
  const apiKey = normalizeApiKey(typeof obj.apiKey === "string" ? obj.apiKey : "");
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID();

  return {
    id,
    name: normalizeProviderName(id, obj.name),
    type,
    baseUrl: codexRouting
      ? codexRouting.baseUrl
      : normalizeBaseUrl(typeof obj.baseUrl === "string" ? obj.baseUrl : ""),
    apiKey,
    apiKeyConfigured: apiKey.length > 0 || obj.apiKeyConfigured === true,
    models,
    activeModels: normalizeModels(normalizeStringArray(obj.activeModels)).filter((modelId) =>
      validModelIds.has(modelId),
    ),
    requestFormat: codexRouting?.requestFormat,
    reasoning: normalizeReasoningLevel(obj.reasoning),
    promptCachingEnabled: type === "claude_code" ? obj.promptCachingEnabled !== false : false,
    nativeWebSearchEnabled: obj.nativeWebSearchEnabled !== false,
  };
}

export function normalizeAgentPromptTemplate(input: unknown): AgentPromptTemplate {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : crypto.randomUUID(),
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "未命名模板",
    description: normalizeOptionalText(obj.description),
    tags: normalizeOrderedUniqueStrings(obj.tags),
    prompt: normalizeOptionalText(obj.prompt),
    enabled: obj.enabled === true,
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

export function normalizeTheme(input: unknown): Theme {
  return input === "dark" ? "dark" : "light";
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

function normalizeSelectedModelForProviders(
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

const DEFAULT_PROJECT_TOOLS_FILE_TREE_PROJECT_STATE: ProjectToolsFileTreeProjectState = {
  query: "",
  selectedPath: "",
  expandedPaths: [""],
  revision: 0,
  stateVersion: 0,
};

function normalizeProjectToolsFileTreeSearchQuery(query: unknown): string {
  return typeof query === "string" ? query.slice(0, 200) : "";
}

function normalizeProjectToolsFileTreeExpandedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [""];
  const normalized = Array.from(
    new Set(
      paths
        .map((path) => normalizeProjectToolsFileTreePath(path))
        .filter((path) => path.length <= 1024),
    ),
  );
  return normalized.slice(0, 512);
}

function normalizeProjectToolsFileTreeProjectState(
  input: unknown,
): ProjectToolsFileTreeProjectState {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    query: normalizeProjectToolsFileTreeSearchQuery(obj.query),
    selectedPath: normalizeProjectToolsFileTreePath(obj.selectedPath),
    expandedPaths: normalizeProjectToolsFileTreeExpandedPaths(obj.expandedPaths),
    revision: normalizeIntegerInRange(obj.revision, 0, Number.MAX_SAFE_INTEGER, 0),
    stateVersion: normalizeIntegerInRange(obj.stateVersion, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function normalizeProjectToolsFileTreeSettings(
  input: unknown,
): ProjectToolsFileTreeSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const openProjectPathKeys = Array.from(
    new Set(
      (Array.isArray(obj.openProjectPathKeys) ? obj.openProjectPathKeys : [])
        .map((pathKey) => workspaceProjectPathKey(pathKey))
        .filter(Boolean),
    ),
  ).sort();
  const rawProjects = (
    obj.projects && typeof obj.projects === "object" && !Array.isArray(obj.projects)
      ? obj.projects
      : {}
  ) as Record<string, unknown>;
  const projects: Record<string, ProjectToolsFileTreeProjectState> = {};
  for (const [pathKey, projectState] of Object.entries(rawProjects)) {
    const normalizedPathKey = workspaceProjectPathKey(pathKey);
    if (!normalizedPathKey) continue;
    projects[normalizedPathKey] = normalizeProjectToolsFileTreeProjectState(projectState);
  }
  return {
    openProjectPathKeys,
    openVersion: normalizeIntegerInRange(obj.openVersion, 0, Number.MAX_SAFE_INTEGER, 0),
    projects,
  };
}

export function normalizeProjectToolsGitReviewSettings(
  input: unknown,
): ProjectToolsGitReviewSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const openProjectPathKeys = Array.from(
    new Set(
      (Array.isArray(obj.openProjectPathKeys) ? obj.openProjectPathKeys : [])
        .map((pathKey) => workspaceProjectPathKey(pathKey))
        .filter(Boolean),
    ),
  ).sort();
  return {
    openProjectPathKeys,
    openVersion: normalizeIntegerInRange(obj.openVersion, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function normalizeProjectToolsPanelTabOrder(input: unknown): string[] {
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

export function normalizeProjectToolsPanelTabOrders(input: unknown): Record<string, string[]> {
  const rawOrders = (
    input && typeof input === "object" && !Array.isArray(input) ? input : {}
  ) as Record<string, unknown>;
  const orders: Record<string, string[]> = {};
  for (const [pathKey, value] of Object.entries(rawOrders)) {
    const normalizedPathKey = workspaceProjectPathKey(pathKey);
    if (!normalizedPathKey) continue;
    const order = normalizeProjectToolsPanelTabOrder(value);
    if (order.length === 0) continue;
    orders[normalizedPathKey] = order;
    if (Object.keys(orders).length >= 100) break;
  }
  return orders;
}

export function normalizeCustomSettings(
  input: unknown,
  customProviders: CustomProvider[],
): CustomSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const chatSidebar = (
    obj.chatSidebar && typeof obj.chatSidebar === "object" ? obj.chatSidebar : {}
  ) as Record<string, unknown>;
  const legacyTerminalPanel = (
    obj.terminalPanel && typeof obj.terminalPanel === "object" ? obj.terminalPanel : {}
  ) as Record<string, unknown>;
  const projectToolsPanel = (
    obj.projectToolsPanel && typeof obj.projectToolsPanel === "object" ? obj.projectToolsPanel : {}
  ) as Record<string, unknown>;
  const projectToolsPanelActiveTab =
    projectToolsPanel.activeTab === "terminal" ||
    projectToolsPanel.activeTab === "fileTree" ||
    projectToolsPanel.activeTab === "gitReview"
      ? projectToolsPanel.activeTab
      : "fileTree";
  const projectToolsFileTree = (
    obj.projectToolsFileTree && typeof obj.projectToolsFileTree === "object"
      ? obj.projectToolsFileTree
      : {}
  ) as unknown;
  const projectToolsGitReview = (
    obj.projectToolsGitReview && typeof obj.projectToolsGitReview === "object"
      ? obj.projectToolsGitReview
      : {}
  ) as unknown;
  return {
    conversationTitleModel: normalizeSelectedModelForProviders(
      normalizeSelectedModel(obj.conversationTitleModel),
      customProviders,
    ),
    chatSidebar: {
      projectsCollapsed: chatSidebar.projectsCollapsed === true,
      recentCollapsed: chatSidebar.recentCollapsed === true,
    },
    projectToolsPanel: {
      width: normalizeIntegerInRange(
        obj.terminalPanelWidth ?? projectToolsPanel.width ?? legacyTerminalPanel.width,
        320,
        1280,
        420,
      ),
      activeTab: projectToolsPanelActiveTab,
      tabOrders: normalizeProjectToolsPanelTabOrders(projectToolsPanel.tabOrders),
    },
    projectToolsFileTree: normalizeProjectToolsFileTreeSettings(projectToolsFileTree),
    projectToolsGitReview: normalizeProjectToolsGitReviewSettings(projectToolsGitReview),
  };
}

export function normalizeUpdateSettings(input: unknown): UpdateSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    includePrereleases: obj.includePrereleases === true,
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
    },
    customProviders,
    mcp: {
      servers: [],
      selected: [],
    },
    agents: [],
    hooks: [],
    cron: [],
    remote: {
      enabled: false,
      gatewayUrl: "",
      grpcPort: 50051,
      grpcEndpoint: "",
      token: "",
      agentId: "",
      autoReconnect: true,
      heartbeatInterval: 30,
      enableWebTerminal: false,
      enableWebGit: false,
    },
    memory: normalizeMemorySettings({}, customProviders),
    customSettings: normalizeCustomSettings({}, customProviders),
    updates: normalizeUpdateSettings({}),
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
    hooks: normalizeConversationHooks(obj.hooks ?? defaults.hooks),
    cron: normalizeCronTasks(obj.cron ?? defaults.cron),
    remote: normalizeRemoteSettings(obj.remote ?? defaults.remote),
    memory: normalizeMemorySettings(obj.memory ?? defaults.memory, customProviders),
    customSettings: normalizeCustomSettings(
      obj.customSettings ?? defaults.customSettings,
      customProviders,
    ),
    updates: normalizeUpdateSettings(obj.updates ?? defaults.updates),
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

export function updateHooks(prev: AppSettings, hooks: ConversationHook[]): AppSettings {
  return normalizeSettings({
    ...prev,
    hooks,
  });
}

export function updateCronTasks(prev: AppSettings, cron: CronTask[]): AppSettings {
  return normalizeSettings({
    ...prev,
    cron,
  });
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

function hasProjectToolsFileTreeSessionState(state: ProjectToolsFileTreeSettings): boolean {
  return (
    state.openVersion > 0 ||
    state.openProjectPathKeys.length > 0 ||
    Object.keys(state.projects).length > 0
  );
}

function hasProjectToolsGitReviewSessionState(state: ProjectToolsGitReviewSettings): boolean {
  return state.openVersion > 0 || state.openProjectPathKeys.length > 0;
}

export function preserveProjectToolsSessionState(
  next: AppSettings,
  current: AppSettings,
): AppSettings {
  const currentFileTree = normalizeProjectToolsFileTreeSettings(
    current.customSettings.projectToolsFileTree,
  );
  const currentGitReview = normalizeProjectToolsGitReviewSettings(
    current.customSettings.projectToolsGitReview,
  );

  return normalizeSettings({
    ...next,
    customSettings: {
      ...next.customSettings,
      projectToolsFileTree: hasProjectToolsFileTreeSessionState(currentFileTree)
        ? currentFileTree
        : next.customSettings.projectToolsFileTree,
      projectToolsGitReview: hasProjectToolsGitReviewSessionState(currentGitReview)
        ? currentGitReview
        : next.customSettings.projectToolsGitReview,
    },
  });
}

export function getProjectToolsPanelTabOrder(
  customSettings: CustomSettings,
  projectPathKey: string,
): string[] {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return [];
  return customSettings.projectToolsPanel.tabOrders[normalizedPathKey] ?? [];
}

function projectToolsPanelTabOrderEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function updateProjectToolsPanelTabOrder(
  prev: AppSettings,
  projectPathKey: string,
  tabOrder: readonly string[],
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const nextOrder = normalizeProjectToolsPanelTabOrder(tabOrder);
  const currentOrder = getProjectToolsPanelTabOrder(prev.customSettings, normalizedPathKey);
  if (projectToolsPanelTabOrderEqual(currentOrder, nextOrder)) return prev;

  const tabOrders = { ...prev.customSettings.projectToolsPanel.tabOrders };
  if (nextOrder.length > 0) {
    tabOrders[normalizedPathKey] = nextOrder;
  } else {
    delete tabOrders[normalizedPathKey];
  }

  return updateCustomSettings(prev, {
    projectToolsPanel: {
      ...prev.customSettings.projectToolsPanel,
      tabOrders,
    },
  });
}

export function removeProjectToolsProjectState(
  prev: AppSettings,
  projectPathKey: string,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;

  const hasTabOrder = Object.hasOwn(
    prev.customSettings.projectToolsPanel.tabOrders,
    normalizedPathKey,
  );
  const openProjectPathKeys = prev.customSettings.projectToolsFileTree.openProjectPathKeys
    .map((pathKey) => workspaceProjectPathKey(pathKey))
    .filter(Boolean);
  const nextOpenProjectPathKeys = openProjectPathKeys.filter(
    (pathKey) => pathKey !== normalizedPathKey,
  );
  const removedOpenProjectPathKey = nextOpenProjectPathKeys.length !== openProjectPathKeys.length;
  const gitReviewOpenProjectPathKeys =
    prev.customSettings.projectToolsGitReview.openProjectPathKeys
      .map((pathKey) => workspaceProjectPathKey(pathKey))
      .filter(Boolean);
  const nextGitReviewOpenProjectPathKeys = gitReviewOpenProjectPathKeys.filter(
    (pathKey) => pathKey !== normalizedPathKey,
  );
  const removedGitReviewOpenProjectPathKey =
    nextGitReviewOpenProjectPathKeys.length !== gitReviewOpenProjectPathKeys.length;
  const hasFileTreeProjectState = Object.hasOwn(
    prev.customSettings.projectToolsFileTree.projects,
    normalizedPathKey,
  );
  const removedFileTreeState = removedOpenProjectPathKey || hasFileTreeProjectState;

  if (
    !hasTabOrder &&
    !removedOpenProjectPathKey &&
    !removedGitReviewOpenProjectPathKey &&
    !hasFileTreeProjectState
  ) {
    return prev;
  }

  const tabOrders = hasTabOrder
    ? { ...prev.customSettings.projectToolsPanel.tabOrders }
    : prev.customSettings.projectToolsPanel.tabOrders;
  if (hasTabOrder) {
    delete tabOrders[normalizedPathKey];
  }

  const projects = hasFileTreeProjectState
    ? { ...prev.customSettings.projectToolsFileTree.projects }
    : prev.customSettings.projectToolsFileTree.projects;
  if (hasFileTreeProjectState) {
    delete projects[normalizedPathKey];
  }

  return updateCustomSettings(prev, {
    projectToolsPanel: {
      ...prev.customSettings.projectToolsPanel,
      tabOrders,
    },
    projectToolsFileTree: {
      ...prev.customSettings.projectToolsFileTree,
      openProjectPathKeys: removedOpenProjectPathKey
        ? nextOpenProjectPathKeys.sort()
        : prev.customSettings.projectToolsFileTree.openProjectPathKeys,
      openVersion: removedFileTreeState
        ? prev.customSettings.projectToolsFileTree.openVersion + 1
        : prev.customSettings.projectToolsFileTree.openVersion,
      projects,
    },
    projectToolsGitReview: {
      ...prev.customSettings.projectToolsGitReview,
      openProjectPathKeys: removedGitReviewOpenProjectPathKey
        ? nextGitReviewOpenProjectPathKeys.sort()
        : prev.customSettings.projectToolsGitReview.openProjectPathKeys,
      openVersion: removedGitReviewOpenProjectPathKey
        ? prev.customSettings.projectToolsGitReview.openVersion + 1
        : prev.customSettings.projectToolsGitReview.openVersion,
    },
  });
}

export function isProjectToolsFileTreeOpen(
  customSettings: CustomSettings,
  projectPathKey: string,
): boolean {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  return (
    normalizedPathKey !== "" &&
    customSettings.projectToolsFileTree.openProjectPathKeys.includes(normalizedPathKey)
  );
}

export function getProjectToolsFileTreeProjectState(
  customSettings: CustomSettings,
  projectPathKey: string,
): ProjectToolsFileTreeProjectState {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return DEFAULT_PROJECT_TOOLS_FILE_TREE_PROJECT_STATE;
  return (
    customSettings.projectToolsFileTree.projects[normalizedPathKey] ??
    DEFAULT_PROJECT_TOOLS_FILE_TREE_PROJECT_STATE
  );
}

export function updateProjectToolsFileTreeOpen(
  prev: AppSettings,
  projectPathKey: string,
  open: boolean,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const openProjectPathKeys = new Set(
    prev.customSettings.projectToolsFileTree.openProjectPathKeys
      .map((pathKey) => workspaceProjectPathKey(pathKey))
      .filter(Boolean),
  );
  if (openProjectPathKeys.has(normalizedPathKey) === open) return prev;
  if (open) {
    openProjectPathKeys.add(normalizedPathKey);
  } else {
    openProjectPathKeys.delete(normalizedPathKey);
  }
  return updateCustomSettings(prev, {
    projectToolsFileTree: {
      ...prev.customSettings.projectToolsFileTree,
      openProjectPathKeys: Array.from(openProjectPathKeys).sort(),
      openVersion: prev.customSettings.projectToolsFileTree.openVersion + 1,
    },
  });
}

export function isProjectToolsGitReviewOpen(
  customSettings: CustomSettings,
  projectPathKey: string,
): boolean {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  return (
    normalizedPathKey !== "" &&
    customSettings.projectToolsGitReview.openProjectPathKeys.includes(normalizedPathKey)
  );
}

export function updateProjectToolsGitReviewOpen(
  prev: AppSettings,
  projectPathKey: string,
  open: boolean,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const openProjectPathKeys = new Set(
    prev.customSettings.projectToolsGitReview.openProjectPathKeys
      .map((pathKey) => workspaceProjectPathKey(pathKey))
      .filter(Boolean),
  );
  if (openProjectPathKeys.has(normalizedPathKey) === open) return prev;
  if (open) {
    openProjectPathKeys.add(normalizedPathKey);
  } else {
    openProjectPathKeys.delete(normalizedPathKey);
  }
  return updateCustomSettings(prev, {
    projectToolsGitReview: {
      ...prev.customSettings.projectToolsGitReview,
      openProjectPathKeys: Array.from(openProjectPathKeys).sort(),
      openVersion: prev.customSettings.projectToolsGitReview.openVersion + 1,
    },
  });
}

function projectToolsFileTreeProjectStateEqual(
  left: ProjectToolsFileTreeProjectState,
  right: ProjectToolsFileTreeProjectState,
): boolean {
  return (
    left.query === right.query &&
    left.selectedPath === right.selectedPath &&
    left.revision === right.revision &&
    left.stateVersion === right.stateVersion &&
    left.expandedPaths.length === right.expandedPaths.length &&
    left.expandedPaths.every((path, index) => path === right.expandedPaths[index])
  );
}

export function updateProjectToolsFileTreeProjectState(
  prev: AppSettings,
  projectPathKey: string,
  patch: ProjectToolsFileTreeStatePatch,
): AppSettings {
  const normalizedPathKey = workspaceProjectPathKey(projectPathKey);
  if (!normalizedPathKey) return prev;
  const current = getProjectToolsFileTreeProjectState(prev.customSettings, normalizedPathKey);
  const next: ProjectToolsFileTreeProjectState = {
    query:
      patch.query !== undefined
        ? normalizeProjectToolsFileTreeSearchQuery(patch.query)
        : current.query,
    selectedPath:
      patch.selectedPath !== undefined
        ? normalizeProjectToolsFileTreePath(patch.selectedPath)
        : current.selectedPath,
    expandedPaths:
      patch.expandedPaths !== undefined
        ? normalizeProjectToolsFileTreeExpandedPaths(patch.expandedPaths)
        : current.expandedPaths,
    revision: patch.bumpRevision
      ? current.revision + 1
      : patch.revision !== undefined
        ? normalizeIntegerInRange(patch.revision, 0, Number.MAX_SAFE_INTEGER, 0)
        : current.revision,
    stateVersion: patch.bumpStateVersion
      ? current.stateVersion + 1
      : patch.stateVersion !== undefined
        ? normalizeIntegerInRange(patch.stateVersion, 0, Number.MAX_SAFE_INTEGER, 0)
        : current.stateVersion,
  };
  if (projectToolsFileTreeProjectStateEqual(current, next)) return prev;
  return updateCustomSettings(prev, {
    projectToolsFileTree: {
      ...prev.customSettings.projectToolsFileTree,
      projects: {
        ...prev.customSettings.projectToolsFileTree.projects,
        [normalizedPathKey]: next,
      },
    },
  });
}

export function updateUpdateSettings(
  prev: AppSettings,
  patch: Partial<UpdateSettings>,
): AppSettings {
  return normalizeSettings({
    ...prev,
    updates: {
      ...prev.updates,
      ...patch,
    },
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
