import type { Locale } from "@liveagent/app/i18n/config";
import type { ThinkingLevel } from "@liveagent/ui/lib/models/modelThinking";
import type { WorkspaceProjectGroup } from "@liveagent/ui/lib/workspaceProjectTypes";

export type ProviderId = "codex" | "claude_code" | "gemini" | "xai" | "deepseek";

export type ExecutionMode = "text" | "tools" | "agent-dev";

export type CodexRequestFormat = "openai-completions" | "openai-responses";

export type ReasoningLevel = "off" | ThinkingLevel;

export type McpTransport = "stdio" | "http" | "sse";

/**
 * MCP OAuth 鉴权配置（docs/design/mcp-oauth.md）。缺省 = "none"（现状，静态
 * headers 继续生效）。token 永不落 settings——只存 keychain（Rust 侧），
 * 因此该结构可安全进 Gateway 同步与 WebDAV 备份。
 */
export type McpAuthType = "none" | "oauth";

export type McpAuthConfig = {
  type: McpAuthType;
  /** 覆盖 PRM scopes_supported 的空格分隔 scope 列表。 */
  scope?: string;
  /** 静态 client_id（企业 AS）；缺省走 RFC 7591 动态注册。 */
  clientId?: string;
};

export type McpServerConfig = {
  id: string;
  description?: string;
  docsUrl?: string;
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
  auth?: McpAuthConfig;
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

// Stable id of the derived background-tasks tab (not a RightDockToolKind:
// its existence also derives from the managed-process store at render time).
export const RIGHT_DOCK_BACKGROUND_TASKS_TAB_ID = "background-tasks";

// Cross-client visibility intent for the background-tasks tab. `opened`
// keeps the tab visible with no processes; `dismissedIds` snapshots the
// process ids visible at close time — a process id outside the snapshot
// re-derives the tab on every client.
export type RightDockBackgroundTasksState = {
  opened: boolean;
  dismissedIds: string[];
};

// Persisted dock state is user intent only: terminal tab existence is derived
// from live sessions at render time, so tabOrder may contain session ids that
// are dead or not yet loaded — they are preserved here and lazily collected on
// user gestures once the session list is known.
export type RightDockProjectState = {
  activeTabId?: string;
  tabOrder: string[];
  tools: Partial<Record<RightDockToolKind, RightDockToolTab>>;
  backgroundTasks: RightDockBackgroundTasksState;
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

export type ChatTranscriptSettings = {
  width: number;
};

/**
 * Composer 上下文占用的三档展示样式（docs/design/composer-context-stats-bar.md §4.7）：
 * "statsBar" 只显示卡片下方的会话统计状态栏（含占用读数），用量环不渲染；
 * "both" 状态栏与常显用量环同时显示；
 * "ring" 只显示常显用量环（0% 起），状态栏不渲染。三档都保留 ≥50% 的手动压缩入口。
 */
export type ComposerContextDisplayMode = "statsBar" | "both" | "ring";

export type CustomSettings = {
  conversationTitleModel?: SelectedModel;
  // AI commit-message generation in the Git review dock. Unset means "follow
  // the current conversation model"; a stored selection whose provider/model
  // is no longer active normalizes back to unset, restoring that fallback.
  commitMessageModel?: SelectedModel;
  chatSidebar: ChatSidebarSettings;
  chatTranscript: ChatTranscriptSettings;
  rightDock: RightDockSettings;
  composerContextDisplay: ComposerContextDisplayMode;
  // Empty strings select the built-in stacks for each typography role.
  interfaceFontFamily: string;
  chatFontFamily: string;
  codeFontFamily: string;
  fontScale: FontScaleSettings;
};

export type UpdateSettings = {
  includePrereleases: boolean;
};

/**
 * cc-switch style automatic provider failover: an ordered fallback queue of
 * same-vendor *providers* tried when the active model's request fails with a
 * provider-fault-class error, plus circuit breaker knobs mirroring cc-switch's
 * 失败阈值/冷却时间 settings.
 *
 * Failover switches providers, never models (matching cc-switch): the failed
 * request is re-sent to the next provider in the queue with the *same model
 * id* the conversation was using. Providers that don't have that model active
 * are skipped at plan time.
 *
 * Failover is scoped per vendor type (mirroring cc-switch's Claude/Codex/
 * Gemini app tabs): a Claude request only fails over to Claude providers, a
 * Codex request only to Codex providers, never across vendors.
 */
export type ProviderFailoverSettings = {
  enabled: boolean;
  /** Ordered fallback provider ids (P1 → P2 → …), same vendor type only. */
  queue: string[];
  /** Max provider switches per request (attempts = switches + 1). */
  maxSwitches: number;
  /** Consecutive failures before a target's circuit breaker opens. */
  failureThreshold: number;
  /** Seconds an open breaker skips its target before a half-open probe. */
  cooldownSeconds: number;
};

/** Per-vendor failover settings, keyed by the provider tab type. */
export type ModelFailoverSettings = Record<ProviderId, ProviderFailoverSettings>;

export const MODEL_FAILOVER_QUEUE_LIMIT = 8;

export const PROVIDER_FAILOVER_TYPES: readonly ProviderId[] = [
  "claude_code",
  "codex",
  "gemini",
  "xai",
  "deepseek",
];

export const DEFAULT_PROVIDER_FAILOVER_SETTINGS: ProviderFailoverSettings = {
  enabled: false,
  queue: [],
  maxSwitches: 3,
  failureThreshold: 4,
  cooldownSeconds: 60,
};

export function getDefaultModelFailoverSettings(): ModelFailoverSettings {
  return {
    claude_code: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    codex: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    gemini: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    xai: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
    deepseek: { ...DEFAULT_PROVIDER_FAILOVER_SETTINGS },
  };
}

/**
 * Cloudflare 5xx status codes that relays surface when their origin
 * errors. pi-ai's `isRetryableAssistantError` already retries 524; these are
 * the rest of Cloudflare's transient 5xx family (#608). Offered as toggleable
 * presets in the settings UI; the runtime retries any error message that
 * contains the code as a standalone number.
 */
export const RETRYABLE_PRESET_HTTP_STATUS_CODES = [520, 521, 522, 523, 525, 526, 527] as const;

/**
 * User-defined retry-error classification, layered on top of pi-ai's
 * `isRetryableAssistantError`. Lets users decide which errors the stream-retry
 * loop should treat as transient (#608) — preset Cloudflare 5xx toggles plus
 * free-text substrings for relay/gateway wording pi-ai doesn't recognize.
 */
export type RetryErrorSettings = {
  /**
   * HTTP status codes (from `RETRYABLE_PRESET_HTTP_STATUS_CODES`) the user has
   * enabled. Defaults to all presets on so relays self-heal out of the box.
   */
  presetStatusCodes: number[];
  /**
   * Free-text substrings matched case-insensitively against the error message.
   * An error containing any of these is retried. e.g. "SSL handshake failed".
   */
  customPatterns: string[];
};

export const DEFAULT_RETRY_ERROR_SETTINGS: RetryErrorSettings = {
  presetStatusCodes: [...RETRYABLE_PRESET_HTTP_STATUS_CODES],
  customPatterns: [],
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

/** 工具审批策略:allow 直接执行、ask 执行前请求用户批准、deny 直接拒绝。 */
export type ToolPolicy = "allow" | "ask" | "deny";

// 命令执行方式(对话框内切换,单一互斥维度):
// - ask:每次带副作用的工具调用都请求用户批准(只读工具不拦)。
// - auto:按工具审批策略直接执行(既有默认行为)。
// - sandbox / sandboxOffline:Bash 与常驻进程在 OS 级沙箱内执行(macOS
//   Seatbelt / Linux bubblewrap / Windows 受限令牌 WRITE_RESTRICTED),写入限
//   工作区+临时目录;offline 变体额外断网。Windows 免管理员双后端:sandbox=受限
//   令牌(只围栏写,读放行);sandboxOffline=AppContainer(WFP 内核级全断网含
//   loopback,默认拒读 ⇒ 系统目录/工作区可读、用户主目录等敏感目录读掩蔽)。
export type CommandSafetyMode = "ask" | "auto" | "sandbox" | "sandboxOffline";

export const COMMAND_SAFETY_MODES: readonly CommandSafetyMode[] = [
  "ask",
  "auto",
  "sandbox",
  "sandboxOffline",
];

// Browser 工具的浏览器接入模式:
// - auto:扩展已连接则用用户日常浏览器(带登录态),否则回退独立 profile。
// - userProfile:只用用户日常浏览器;扩展未连接时报错并引导安装,绝不回退
//   (用户显式要登录态时,静默降级到无登录态的隔离浏览器会造成"看似在操作
//   我的账号实际不是"的误判)。
// - isolated:只用独立 profile 的专用浏览器,即使扩展在线也不碰用户浏览器。
export type BrowserAutomationMode = "auto" | "userProfile" | "isolated";

export const BROWSER_AUTOMATION_MODES: readonly BrowserAutomationMode[] = [
  "auto",
  "userProfile",
  "isolated",
];

export type SystemSettings = {
  executionMode: ExecutionMode;
  workdir: string;
  /**
   * 按规范工具名(内置名 / `mcp_*`)覆盖审批策略;缺省由
   * resolveToolPolicy 按来源推断(内置/mcp=allow、只读工具恒 allow)。
   * 可选:旧快照缺失该字段时视为空表(全部走默认),保证零回归。
   */
  toolPolicies?: Record<string, ToolPolicy>;
  /**
   * 允许 CUA 工具把 LiveAgent 自己当作操作目标。缺省 false。
   *
   * 关闭时（默认）宿主的窗口既不会出现在 cua-driver 的枚举结果里，也不
   * 能被直接寻址——模型操作宿主界面等于能点掉自己的审批弹窗、改写这份
   * 权限设置、或者直接关掉应用。打开它的正当场景只有一个：用 LiveAgent
   * 自动化测试 LiveAgent。实现见 `lib/tools/cuaSelfGuard.ts`。
   */
  cuaAllowSelfTargeting?: boolean;
  commandSafetyMode: CommandSafetyMode;
  /** Browser 工具的浏览器接入模式;缺省 auto(旧快照缺失该字段时同 auto)。 */
  browserAutomationMode: BrowserAutomationMode;
  workspaceProjects: WorkspaceProject[];
  workspaceProjectGroups: WorkspaceProjectGroup[];
  activeWorkspaceProjectId?: string;
  hiddenWorkspaceProjectPaths: string[];
  missingWorkspaceProjectPaths: string[];
  // Archived workspaces (path-keyed, like hidden/missing). Archived rows stay
  // in the merged list but render disabled and can never be active.
  archivedWorkspaceProjectPaths: string[];
  workspaceResourceSettings: Record<string, WorkspaceResourceSettings>;
  systemProxy: SystemProxyConfig;
};

export type WorkspaceResourceSettingsMode = "inherit" | "custom" | "off";

export type ProjectPromptStrategy = "append" | "replace";

export type WorkspaceResourceSettings = {
  mode: WorkspaceResourceSettingsMode;
  skillNames: string[];
  mcpServerIds: string[];
  projectPrompt: string;
  projectPromptStrategy: ProjectPromptStrategy;
  stateVersion: number;
  writerId: string;
  updatedAt: number;
};

export type EffectiveWorkspaceResources = {
  mode: WorkspaceResourceSettingsMode;
  skillsEnabled: boolean;
  skillNames: string[];
  mcpServerIds: string[];
  mcpServers: McpServerConfig[];
};

export type EffectivePromptSettings = {
  globalTemplates: AgentPromptTemplate[];
  globalPrompt: string;
  projectPrompt: string;
  projectPromptStrategy: ProjectPromptStrategy;
  prompt: string;
};

export type WorkspaceProjectKind = "managed" | "folder" | "history";

export type WorkspaceProject = {
  id: string;
  name: string;
  path: string;
  kind: WorkspaceProjectKind;
  worktree?: {
    repositoryPath: string;
    branch?: string;
  };
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

export type PromptCacheHintMode = "auto" | "openai-key" | "openrouter-session" | "none";

/**
 * 限额来源：catalog（目录命中）> provider（供应商接口自带声明值）
 * > fallback（兜底猜测）；user 是用户手改，任何时候都不被自动覆盖。
 * 缺失时（旧存档）按 normalizeProviderModelConfig 的迁移推断规则一次性补齐。
 */
export type ModelLimitsSource = "catalog" | "provider" | "fallback" | "user";

/** 模型输入模态的合法值全集（运行时校验与类型的单一来源）。 */
export const MODEL_INPUT_MODALITIES = ["text", "image"] as const;

/** 模型输入模态；缺省时按 provider 内置规则推断。 */
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

/**
 * 归一化后的输入模态覆盖的规范形态：聊天协议始终发送文本，
 * 因此 "text" 恒在首位；normalizer 只会产出这两种形状。
 */
export type ModelInputModalitiesOverride = ["text"] | ["text", "image"];

export type ProviderModelConfig = {
  id: string;
  /** /models 元数据；缺失时保持旧设置格式兼容。 */
  ownedBy?: string;
  contextWindow: number;
  maxOutputToken: number;
  limitsSource?: ModelLimitsSource;
  /** OpenAI 兼容端点的缓存提示协议；缺失时继承供应商设置。 */
  promptCacheHintMode?: PromptCacheHintMode;
  /**
   * 用户手动的输入模态覆盖（如 ["text","image"] 强制开启图片输入）。
   * 缺失时按 provider 内置启发式推断（白名单/官方已知模型目录）。
   * 生效范围：仅 codex/xai/gemini provider（这些路径的附件发送受
   * model.input 门控）；deepseek wire 层硬拒绝图片、anthropic 附件
   * 路径不读 model.input，这两类 provider 上本字段不起作用。
   * 读取前须经 normalizeInputModalities 归一化。
   */
  inputModalities?: ModelInputModalitiesOverride;
};

export type ChatRuntimeControls = {
  thinkingEnabled: boolean;
  nativeWebSearchEnabled: boolean;
  /** Plan mode:本轮只注入只读工具,经 ExitPlanMode 批准后才进入执行。 */
  planModeEnabled: boolean;
  reasoning: ReasoningLevel;
  reasoningByProvider: Partial<Record<ChatRuntimeReasoningProviderKey, ReasoningLevel>>;
};

export type ChatRuntimeReasoningProviderKey =
  | "claude_code"
  | "codex_openai_responses"
  | "codex_openai_completions"
  | "gemini"
  | "xai"
  | "deepseek";

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
  /** 直接复用「系统设置 → 应用代理」（systemProxy）；开启时忽略手动代理字段。 */
  useSystemProxy: boolean;
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

export type UsageQueryMode = "coding-plan" | "balance" | "general" | "newapi" | "custom";

export type UsageQueryScripts = Partial<Record<"custom" | "general" | "newapi", string>>;

export type UsageQueryCodingPlanProvider =
  | ""
  | "kimi"
  | "zhipu"
  | "zhipu_team"
  | "minimax"
  | "zenmux"
  | "volcengine";

export type UsageQueryConfig = {
  enabled: boolean;
  mode: UsageQueryMode;
  /** 当前模式的生效脚本(Rust 执行层只读这一个字段)。 */
  script: string;
  /** 每种脚本模式各自的脚本:切换查询方式互不串扰,未填写过的显示模板预设。 */
  scripts: UsageQueryScripts;
  baseUrl: string;
  /** 查询专用 API Key 覆盖(空则回退供应商自身的 apiKey)。 */
  apiKey: string;
  apiKeyConfigured?: boolean;
  accessToken: string;
  accessTokenConfigured?: boolean;
  userId: string;
  accessKeyId: string;
  secretAccessKey: string;
  secretAccessKeyConfigured?: boolean;
  /** Token Plan 供应商(空=按 Base URL 自动检测;智谱团队必须显式选择)。 */
  codingPlanProvider: UsageQueryCodingPlanProvider;
  /** 智谱团队套餐:组织/项目 ID(作为 bigmodel-organization / bigmodel-project 请求头)。 */
  teamOrganizationId: string;
  teamProjectId: string;
  /** 请求超时(秒,2-30)。 */
  timeoutSecs: number;
};

export const USAGE_QUERY_TIMEOUT_MIN_SECS = 2;

export const USAGE_QUERY_TIMEOUT_MAX_SECS = 30;

export const USAGE_QUERY_TIMEOUT_DEFAULT_SECS = 10;

export function getDefaultUsageQueryConfig(): UsageQueryConfig {
  return {
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
    timeoutSecs: USAGE_QUERY_TIMEOUT_DEFAULT_SECS,
  };
}

export type CustomProvider = {
  id: string;
  name: string;
  type: ProviderId;
  baseUrl: string;
  /** 将 baseUrl 作为最终请求地址，本地反代不再追加协议端点路径。 */
  isFullUrl: boolean;
  /** 可选的模型列表完整地址；留空时从 baseUrl 自动推导。 */
  modelsUrl?: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  customHeaders?: { key: string; value: string }[];
  models: ProviderModelConfig[];
  modelOrder?: string[];
  activeModels: string[];
  requestFormat?: CodexRequestFormat;
  reasoning: ReasoningLevel;
  promptCachingEnabled: boolean;
  /** OpenAI 兼容端点的缓存提示协议；旧配置由 promptCachingEnabled 迁移。 */
  promptCacheHintMode?: PromptCacheHintMode;
  /** 仅 Anthropic：ephemeral 缓存保留档位；long 在官方 API 上映射为 1h TTL。 */
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled: boolean;
  useSystemProxy: boolean;
  /** 流内重试策略；缺省 = 全局默认行为（等价于 mode:"default"）。 */
  retryPolicy?: ProviderRetryPolicy;
  usageQuery: UsageQueryConfig;
};

/**
 * 供应商级流内重试策略。
 *
 * - default：沿用全局默认（5 次重试，即 DEFAULT_STREAM_RETRY_MAX_ATTEMPTS-1）
 *   ——与未配置等价，归一化时直接省略字段，保证旧配置零迁移；
 * - off：禁用流内重试（不影响跨供应商 failover）；
 * - custom：使用 maxRetries——首次失败后的重试次数，不含首次请求（钳位
 *   1..10；0 次重试请直接选 off）。与重试状态提示"正在重试 (n/m)"的 m
 *   同一口径。
 */
export type ProviderRetryPolicy = { mode: "off" } | { mode: "custom"; maxRetries: number };

export const PROVIDER_RETRY_MAX_RETRIES_LIMITS = {
  min: 1,
  max: 10,
} as const;

/**
 * 全局默认流内重试次数（不含首次请求）的 UI 展示镜像。运行时真源是
 * agent-gui streamRetry.ts 的 DEFAULT_STREAM_RETRY_MAX_ATTEMPTS（总尝试
 * 数 = 重试数 + 1；UI 边界禁止反向依赖）；两者一致性由
 * provider-retry-policy 单测锁定。
 */
export const PROVIDER_RETRY_DEFAULT_MAX_RETRIES = 5;

export type EffectiveTheme = "light" | "dark";

export type Theme = EffectiveTheme | "system";

export type CloseWindowBehavior = "minimize" | "exit";

export const THEME_OPTIONS = ["light", "dark", "system"] as const satisfies readonly Theme[];

export const CLOSE_WINDOW_BEHAVIOR_OPTIONS = [
  "minimize",
  "exit",
] as const satisfies readonly CloseWindowBehavior[];

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

export type SttProviderId =
  | "tencent_cloud"
  | "volcengine_seed_v3"
  | "aliyun_dashscope"
  | "baidu_cloud";

export type SttProviderSettings = {
  id: SttProviderId;
  configured: boolean;
  websocketUrl: string;
  model: string;
  apiKey: string;
  appId: string;
  secretId: string;
  secretKey: string;
  accessToken: string;
  cluster: string;
  resourceId: string;
  engineModelType: string;
  baiduAppId: string;
  baiduApiKey: string;
  devPid: string;
  /** 一次性清密钥指令；保存端消费后必须移除，不得进入公开快照。 */
  clearSecrets?: boolean;
};

export type SttSettings = {
  enabled: boolean;
  provider: SttProviderId | null;
  providers: Record<SttProviderId, SttProviderSettings>;
  /** 一次性允许仅切换语音输入开关，不因当前供应商未配置而拒绝保存。 */
  allowIncomplete?: boolean;
};

export type AppSettings = {
  system: SystemSettings;
  customProviders: CustomProvider[];
  mcp: McpSettings;
  agents: AgentPromptTemplate[];
  ssh: SshSettings;
  remote: RemoteSettings;
  stt: SttSettings;
  memory: MemorySettings;
  customSettings: CustomSettings;
  modelFailover: ModelFailoverSettings;
  retryErrorSettings: RetryErrorSettings;
  updates: UpdateSettings;
  skills: SkillsSettings;
  chatRuntimeControls: ChatRuntimeControls;
  selectedModel?: SelectedModel;
  theme: Theme;
  locale: Locale;
  /** Desktop-only: close title-bar X to hide to tray or exit the application. */
  closeWindowBehavior: CloseWindowBehavior;
};

export const CODEX_REQUEST_FORMAT_LABELS: Record<CodexRequestFormat, string> = {
  "openai-completions": "OpenAI-Completions",
  "openai-responses": "Responses API",
};

export const PROMPT_CACHE_HINT_MODES = [
  "auto",
  "openai-key",
  "openrouter-session",
  "none",
] as const satisfies readonly PromptCacheHintMode[];

export const DEFAULT_CHAT_RUNTIME_CONTROLS: ChatRuntimeControls = {
  thinkingEnabled: true,
  nativeWebSearchEnabled: true,
  planModeEnabled: false,
  reasoning: "high",
  reasoningByProvider: {
    claude_code: "high",
    codex_openai_responses: "high",
    codex_openai_completions: "high",
    gemini: "high",
    xai: "high",
    deepseek: "high",
  },
};

export const DEFAULT_WORKSPACE_PROJECT_ID = "default-project";

export const DEFAULT_WORKSPACE_PROJECT_NAME = "Default Project";
