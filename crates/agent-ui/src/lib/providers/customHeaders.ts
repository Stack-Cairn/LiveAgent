import type { CustomProvider } from "@liveagent/app/lib/settings";

const RESERVED_CUSTOM_HEADER_KEYS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "anthropic-beta",
  "host",
  "content-length",
]);
// 本地反代的内部通道命名空间：放行会让用户把代理令牌/上游 origin 等控制头注入
// 上游请求。反代自己也会剥掉这一前缀，这里在配置侧提前拒绝以便给出明确反馈。
const RESERVED_CUSTOM_HEADER_KEY_PREFIX = "x-liveagent-";
const HTTP_HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// 头取值只允许可见 ASCII 与水平制表符：CR/LF 会造成 header 注入，非 ASCII 会让
// WebView 的 fetch() 直接抛错、把整轮对话打断成一条与请求头无关的报错。
const HTTP_HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/;

export type CustomHeader = { key: string; value: string };

export type CustomHeaderImportIssueReason =
  | "invalid-item"
  | "unsupported-value"
  | "invalid-key"
  | "reserved"
  | "invalid-value"
  | "malformed-header";

export type CustomHeaderImportIssue = {
  key?: string;
  reason: CustomHeaderImportIssueReason;
};

export type CustomHeaderImportResult = {
  headers: CustomHeader[];
  issues: CustomHeaderImportIssue[];
};

export type CustomHeaderImportErrorCode =
  | "empty"
  | "invalid-json"
  | "unsupported-json"
  | "unterminated-quote";

export class CustomHeaderImportError extends Error {
  constructor(readonly code: CustomHeaderImportErrorCode) {
    super(code);
    this.name = "CustomHeaderImportError";
  }
}

// Claude Code CLI 的 SDK 指纹头，逐字复刻官方源码 claude-code-source（v2.1.88，
// 其内联的 @anthropic-ai/sdk = 0.74.0）发往 /v1/messages 的固定头；配套的 UA 见
// CLI_IDENTITY_USER_AGENTS.claude_code——版本号必须成套，SDK 版本和 UA 里的 CLI
// 版本对不上本身就是破绽。
// anthropic-beta 不在这里：它按请求内容逐次计算（comma 拼接的 beta 列表），写死一个
// 值反而失真，因此列进 RESERVED_CUSTOM_HEADER_KEYS 由发请求那侧生成。
// X-Stainless-OS/Arch/Runtime-Version 本为运行机实测值，这里固定成一台 macOS/arm64
// 机器的成套取值。
export const ANTHROPIC_DEFAULT_REQUEST_HEADERS = {
  "x-app": "cli",
  "Content-Type": "application/json",
  "X-Stainless-OS": "MacOS",
  "X-Stainless-Arch": "arm64",
  "X-Stainless-Lang": "js",
  "anthropic-version": "2023-06-01",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Timeout": "600",
  // 官方 SDK client.mjs:468 写的是 Pascal-Case；HTTP 大小写不敏感，但部分反代/
  // 风控按字面比对，必须与 SDK 一致。
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Runtime-Version": "v26.3.0",
  "anthropic-dangerous-direct-browser-access": "true",
} as const;

// Claude Code 每会话头（claude-code-source src/services/api/client.ts:108 / :356）。
// 取值是运行时 session UUID，一键模拟不写死；请求装配侧有 sessionId 时再填。
export const CLAUDE_SESSION_ID_HEADER = "X-Claude-Code-Session-Id";
export const CLIENT_REQUEST_ID_HEADER = "x-client-request-id";

// 旧 Responses 链路（LiveAgent 既有 + 部分中转）仍认这两个下划线头。
export const CODEX_SESSION_ID_HEADER = "session_id";
export const CODEX_CONVERSATION_ID_HEADER = "conversation_id";
// 现行 Codex CLI（codex-rs/codex-api/src/requests/headers.rs +
// endpoint/responses.rs）改发连字符头：session-id / thread-id，并把 thread-id
// 同步到 x-client-request-id。
export const CODEX_OFFICIAL_SESSION_ID_HEADER = "session-id";
export const CODEX_THREAD_ID_HEADER = "thread-id";

// 各官方 CLI 的版本号：UA 与随附的 version / client-version 头必须同源，二者对不上
// 本身就是破绽。claude_code / xai 取自用户提供的官方源码（claude-code-source
// package.json = 2.1.88；xai-grok-version/Cargo.toml = 1.0.6）；codex 源码树是占位
// 0.0.0（release 才 bump），无法作真值，沿用当前发行号。
const CLAUDE_CLI_VERSION = "2.1.88";
const CODEX_CLI_VERSION = "0.151.0";
const GROK_CLI_VERSION = "1.0.6";

// Codex CLI 每次请求除 UA 外恒发的两个静态身份头：originator（codex-rs
// login/src/auth/default_client.rs default_headers()，值 codex_cli_rs）与 version
// （codex-rs model-provider-info/src/lib.rs，值 = CARGO_PKG_VERSION，与 UA 同版本）。
export const CODEX_ORIGINATOR_HEADER = "originator";
export const CODEX_ORIGINATOR_VALUE = "codex_cli_rs";
export const CODEX_VERSION_HEADER = "version";

// grok-shell 除 UA 外恒发的静态客户端身份头（xai-grok-http/src/lib.rs 的
// process_client_identifier / process_client_mode + xai-grok-shell
// mvp_agent/mod.rs inject_proxy_headers）。client-identifier/version/mode 各端都发；
// X-XAI-Token-Auth / x-authenticateresponse 仅走官方 cli-chat-proxy 时注入，属于 CLI
// 默认（已登录）指纹的一部分，直连 api.x.ai 时服务端忽略未知头、无副作用。
const GROK_IDENTITY_HEADERS: readonly CustomHeader[] = [
  { key: "x-grok-client-identifier", value: "grok-shell" },
  { key: "x-grok-client-version", value: GROK_CLI_VERSION },
  { key: "x-grok-client-mode", value: "interactive" },
  { key: "X-XAI-Token-Auth", value: "xai-grok-cli" },
  { key: "x-authenticateresponse", value: "authenticate-response" },
];

// grok-shell 每回合头（xai-grok-sampler/src/client.rs GrokRequestHeaders），取值随
// conv/req/session 变化，一键模拟不写死。
const GROK_DYNAMIC_HEADER_KEYS = [
  "x-grok-conv-id",
  "x-grok-req-id",
  "x-grok-session-id",
  "x-grok-agent-id",
  "x-grok-model-override",
  "x-grok-turn-idx",
] as const;

const COMMON_CUSTOM_HEADER_KEY_PRESETS = [
  "X-Request-ID",
  "X-User-ID",
  "X-Environment",
  "HTTP-Referer",
  "X-Title",
] as const;

const ANTHROPIC_CUSTOM_HEADER_KEY_PRESETS: readonly string[] = [
  ...Object.keys(ANTHROPIC_DEFAULT_REQUEST_HEADERS),
  CLAUDE_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  ...COMMON_CUSTOM_HEADER_KEY_PRESETS,
];

const CODEX_CUSTOM_HEADER_KEY_PRESETS: readonly string[] = [
  CODEX_ORIGINATOR_HEADER,
  CODEX_VERSION_HEADER,
  CODEX_OFFICIAL_SESSION_ID_HEADER,
  CODEX_THREAD_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CODEX_SESSION_ID_HEADER,
  CODEX_CONVERSATION_ID_HEADER,
  ...COMMON_CUSTOM_HEADER_KEY_PRESETS,
];

const XAI_CUSTOM_HEADER_KEY_PRESETS: readonly string[] = [
  ...GROK_IDENTITY_HEADERS.map((header) => header.key),
  ...GROK_DYNAMIC_HEADER_KEYS,
  ...COMMON_CUSTOM_HEADER_KEY_PRESETS,
];

const CUSTOM_HEADER_KEY_PRESETS: Record<CustomProvider["type"], readonly string[]> = {
  claude_code: ANTHROPIC_CUSTOM_HEADER_KEY_PRESETS,
  codex: CODEX_CUSTOM_HEADER_KEY_PRESETS,
  gemini: COMMON_CUSTOM_HEADER_KEY_PRESETS,
  xai: XAI_CUSTOM_HEADER_KEY_PRESETS,
  deepseek: COMMON_CUSTOM_HEADER_KEY_PRESETS,
};

export function getCustomHeaderKeyPresets(providerId: CustomProvider["type"]): readonly string[] {
  return CUSTOM_HEADER_KEY_PRESETS[providerId];
}

export function isAnthropicOAuthApiKey(apiKey: string | undefined): boolean {
  return Boolean(apiKey?.includes("sk-ant-oat"));
}

// 「模拟 CLI」按钮写入的身份 UA，逐字复刻各官方 CLI 发往模型 API 的 User-Agent：
// claude-code-source src/utils/http.ts、codex-rs login/src/auth/default_client.rs 的
// get_codex_user_agent()、grok xai-grok-sampler/src/client.rs。版本号取自上面三个
// *_CLI_VERSION 常量，保证 UA 与随附的 version / client-version 头同源。os/arch/终端
// 段本为运行机实测值，这里固定成成套取值（codex 取 WSL Ubuntu；grok 取 linux）。
// 这些值只在用户点按钮时写进自定义请求头，发请求那侧不含任何内置伪装。
export const CLI_IDENTITY_USER_AGENTS = {
  claude_code: `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  codex: `codex_cli_rs/${CODEX_CLI_VERSION} (Ubuntu 24.4.0; x86_64) WindowsTerminal`,
  xai: `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`,
} as const;

export type CliIdentityProviderId = keyof typeof CLI_IDENTITY_USER_AGENTS;

export const CLI_IDENTITY_PROVIDER_IDS = Object.keys(
  CLI_IDENTITY_USER_AGENTS,
) as CliIdentityProviderId[];

export function isCliIdentityProviderId(value: string): value is CliIdentityProviderId {
  return Object.hasOwn(CLI_IDENTITY_USER_AGENTS, value);
}

/** 下拉菜单把与当前供应商匹配的身份档排在最前，降低点错家的概率。 */
export function listCliIdentityProviderIds(preferred?: string): readonly CliIdentityProviderId[] {
  if (!preferred || !isCliIdentityProviderId(preferred)) return CLI_IDENTITY_PROVIDER_IDS;
  return [preferred, ...CLI_IDENTITY_PROVIDER_IDS.filter((id) => id !== preferred)];
}

// 一键模拟按钮写入的整套 CLI 身份头。Content-Type 由发请求那一侧按 body 决定，不进
// 用户可编辑列表；每会话随机的动态头（Claude 的 X-Claude-Code-Session-Id /
// x-client-request-id；Codex 的 session-id/thread-id；Grok 的
// x-grok-conv-id/req-id/session-id/turn-idx）冒充成固定串反而比不带更可疑，一律留给
// 请求装配侧按 sessionId 填，或用户自己填（键名已进各自预设）。
export function buildCliIdentityHeaders(type: CliIdentityProviderId): CustomHeader[] {
  const headers: CustomHeader[] = [{ key: "User-Agent", value: CLI_IDENTITY_USER_AGENTS[type] }];
  if (type === "claude_code") {
    // Anthropic SDK 指纹头整套写入（Content-Type 除外，见上）。
    for (const [key, value] of Object.entries(ANTHROPIC_DEFAULT_REQUEST_HEADERS)) {
      if (key.toLowerCase() === "content-type") continue;
      headers.push({ key, value });
    }
  } else if (type === "codex") {
    // Codex CLI 每次请求恒发的两个静态身份头：originator + version。
    headers.push({ key: CODEX_ORIGINATOR_HEADER, value: CODEX_ORIGINATOR_VALUE });
    headers.push({ key: CODEX_VERSION_HEADER, value: CODEX_CLI_VERSION });
  } else if (type === "xai") {
    // grok-shell 的静态客户端身份头（含 cli-chat-proxy 标记）。
    for (const header of GROK_IDENTITY_HEADERS) {
      headers.push({ ...header });
    }
  }
  return headers;
}

// 每家 CLI 名下的全部头名：一键写入的静态身份头 + 用户可能手填的每会话动态头。
// 切换身份时按这张表把其它 CLI 的头整套剥掉——只做同名覆盖的话仅换掉 User-Agent，
// 上一家的 x-app / X-Stainless-* / originator / x-grok-* 会留下来，拼出一份哪家都
// 不像的假指纹。Content-Type 不在此列（按钮不写、也非某家专属）。
const CLI_IDENTITY_HEADER_FAMILIES: Record<CliIdentityProviderId, readonly string[]> = {
  claude_code: [
    ...buildCliIdentityHeaders("claude_code").map((header) => header.key),
    CLAUDE_SESSION_ID_HEADER,
    CLIENT_REQUEST_ID_HEADER,
  ],
  codex: [
    ...buildCliIdentityHeaders("codex").map((header) => header.key),
    CODEX_OFFICIAL_SESSION_ID_HEADER,
    CODEX_THREAD_ID_HEADER,
    CLIENT_REQUEST_ID_HEADER,
    CODEX_SESSION_ID_HEADER,
    CODEX_CONVERSATION_ID_HEADER,
  ],
  xai: [
    ...buildCliIdentityHeaders("xai").map((header) => header.key),
    ...GROK_DYNAMIC_HEADER_KEYS,
  ],
};

export type CliIdentityApplyResult = {
  headers: CustomHeader[];
  importedCount: number;
  overwrittenCount: number;
  removedCount: number;
};

/**
 * 应用/切换 CLI 身份：先剥掉其它 CLI 家族名下的所有头（含用户手填的动态头），再把
 * 所选 CLI 的整套静态身份头并入（同名覆盖）。所选 CLI 自家的动态头（如 Codex 的
 * session-id）保留用户手填值；不属于任何 CLI 家族的业务头原样不动。
 */
export function applyCliIdentity(
  current: readonly CustomHeader[],
  identity: CliIdentityProviderId,
): CliIdentityApplyResult {
  const own = new Set(CLI_IDENTITY_HEADER_FAMILIES[identity].map((key) => key.toLowerCase()));
  const foreign = new Set<string>();
  for (const id of CLI_IDENTITY_PROVIDER_IDS) {
    if (id === identity) continue;
    for (const key of CLI_IDENTITY_HEADER_FAMILIES[id]) {
      const lower = key.toLowerCase();
      if (!own.has(lower)) foreign.add(lower);
    }
  }
  const kept = current.filter((header) => !foreign.has(header.key.toLowerCase()));
  const merged = mergeImportedCustomHeaders(kept, buildCliIdentityHeaders(identity));
  return { ...merged, removedCount: current.length - kept.length };
}

function findHeaderKey(
  headers: Record<string, string | null | undefined>,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === expected);
}

export function isValidCustomHeaderKey(key: string): boolean {
  return HTTP_HEADER_TOKEN_PATTERN.test(key);
}

export function isValidCustomHeaderValue(value: string): boolean {
  return HTTP_HEADER_VALUE_PATTERN.test(value);
}

export function isReservedCustomHeaderKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    RESERVED_CUSTOM_HEADER_KEYS.has(normalized) ||
    normalized.startsWith(RESERVED_CUSTOM_HEADER_KEY_PREFIX)
  );
}
function issueKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value.replace(/[\r\n]+/g, " ").trim();
  return safe || undefined;
}

function addImportedHeader(
  headers: CustomHeader[],
  issues: CustomHeaderImportIssue[],
  keyValue: unknown,
  headerValue: unknown,
): void {
  if (typeof keyValue !== "string") {
    issues.push({ reason: "invalid-item" });
    return;
  }

  const key = keyValue;
  if (
    typeof headerValue !== "string" &&
    typeof headerValue !== "number" &&
    typeof headerValue !== "boolean"
  ) {
    issues.push({ key: issueKey(key), reason: "unsupported-value" });
    return;
  }
  if (!isValidCustomHeaderKey(key)) {
    issues.push({ key: issueKey(key), reason: "invalid-key" });
    return;
  }
  if (isReservedCustomHeaderKey(key)) {
    issues.push({ key, reason: "reserved" });
    return;
  }

  const value = String(headerValue);
  if (!isValidCustomHeaderValue(value)) {
    issues.push({ key, reason: "invalid-value" });
    return;
  }

  const existingIndex = headers.findIndex(
    (header) => header.key.toLowerCase() === key.toLowerCase(),
  );
  const next = { key, value };
  if (existingIndex >= 0) headers[existingIndex] = next;
  else headers.push(next);
}

function tokenizeCurl(command: string): string[] {
  const normalized = command.replace(/[\\`^][ \t]*\r?\n/g, " ");
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (
        character === "\\" &&
        quote === '"' &&
        index + 1 < normalized.length &&
        ['"', "\\"].includes(normalized[index + 1])
      ) {
        token += normalized[index + 1];
        index += 1;
        continue;
      }
      token += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    if (
      character === "\\" &&
      index + 1 < normalized.length &&
      (/\s/.test(normalized[index + 1]) ||
        normalized[index + 1] === "'" ||
        normalized[index + 1] === '"')
    ) {
      token += normalized[index + 1];
      started = true;
      index += 1;
      continue;
    }
    token += character;
    started = true;
  }

  if (quote) throw new CustomHeaderImportError("unterminated-quote");
  if (started) tokens.push(token);
  return tokens;
}

function parseCurlHeaders(input: string): CustomHeaderImportResult {
  const tokens = tokenizeCurl(input);
  const headers: CustomHeader[] = [];
  const issues: CustomHeaderImportIssue[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let rawHeader: string | undefined;
    if (token === "-H" || token === "--header") {
      rawHeader = tokens[index + 1];
      index += 1;
    } else if (token.startsWith("--header=")) {
      rawHeader = token.slice("--header=".length);
    } else {
      continue;
    }

    if (rawHeader === undefined) {
      issues.push({ reason: "malformed-header" });
      continue;
    }
    const separatorIndex = rawHeader.indexOf(":");
    if (separatorIndex < 0) {
      issues.push({ reason: "malformed-header" });
      continue;
    }
    addImportedHeader(
      headers,
      issues,
      rawHeader.slice(0, separatorIndex).trim(),
      rawHeader.slice(separatorIndex + 1).trim(),
    );
  }

  return { headers, issues };
}

export function parseCustomHeadersImport(input: string): CustomHeaderImportResult {
  const trimmed = input.trim();
  if (!trimmed) throw new CustomHeaderImportError("empty");

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new CustomHeaderImportError("invalid-json");
    }

    const headers: CustomHeader[] = [];
    const issues: CustomHeaderImportIssue[] = [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          issues.push({ reason: "invalid-item" });
          continue;
        }
        const record = item as Record<string, unknown>;
        addImportedHeader(headers, issues, record.key, record.value);
      }
    } else if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        addImportedHeader(headers, issues, key, value);
      }
    } else {
      throw new CustomHeaderImportError("unsupported-json");
    }
    return { headers, issues };
  }

  return parseCurlHeaders(trimmed);
}

export function mergeImportedCustomHeaders(
  current: readonly CustomHeader[],
  imported: readonly CustomHeader[],
): { headers: CustomHeader[]; importedCount: number; overwrittenCount: number } {
  let headers = current.map((header) => ({ ...header }));
  let overwrittenCount = 0;

  for (const importedHeader of imported) {
    const expected = importedHeader.key.toLowerCase();
    const firstIndex = headers.findIndex((header) => header.key.toLowerCase() === expected);
    if (firstIndex < 0) {
      headers.push({ ...importedHeader });
      continue;
    }

    overwrittenCount += 1;
    headers = headers.filter(
      (header, index) => index === firstIndex || header.key.toLowerCase() !== expected,
    );
    headers[firstIndex] = { ...importedHeader };
  }

  return { headers, importedCount: imported.length, overwrittenCount };
}
export function mergeCustomHeaders(
  base: Record<string, string>,
  customHeaders?: readonly CustomHeader[],
): Record<string, string> {
  const merged = { ...base };

  for (const header of customHeaders ?? []) {
    if (
      !isValidCustomHeaderKey(header.key) ||
      !isValidCustomHeaderValue(header.value) ||
      isReservedCustomHeaderKey(header.key)
    ) {
      continue;
    }

    const existingKey = findHeaderKey(merged, header.key);
    if (existingKey !== undefined) delete merged[existingKey];
    merged[header.key] = header.value;
  }

  return merged;
}
