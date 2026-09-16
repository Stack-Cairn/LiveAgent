// 四类聊天接口、厂商方言与请求头档（docs/design/provider-registry-and-model-routing.md 2.2 / 4.3）。
//
// 协议决定请求体结构、流解析、端点路径和 pi-ai 的 Model.api；方言决定同一协议下
// 的字段取舍、鉴权附加头、思考参数映射。四个协议字面量与 pi-ai 一致，不做翻译。

import { endpointHostOf } from "./hosts";

export const PROVIDER_CHAT_PROTOCOLS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
] as const;

export type ProviderChatProtocol = (typeof PROVIDER_CHAT_PROTOCOLS)[number];

export function isProviderChatProtocol(value: unknown): value is ProviderChatProtocol {
  return PROVIDER_CHAT_PROTOCOLS.includes(value as ProviderChatProtocol);
}

/** 接口家族：故障转移分组依据。Completions 与 Responses 同属 OpenAI 家族。 */
export const PROVIDER_PROTOCOL_FAMILIES = ["anthropic", "openai", "gemini"] as const;

export type ProviderProtocolFamily = (typeof PROVIDER_PROTOCOL_FAMILIES)[number];

export const PROVIDER_PROTOCOL_FAMILY: Record<ProviderChatProtocol, ProviderProtocolFamily> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "google-generative-ai": "gemini",
};

export const PROVIDER_CHAT_PROTOCOL_LABELS: Record<ProviderChatProtocol, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "google-generative-ai": "Gemini generateContent",
};

export const PROVIDER_PROTOCOL_FAMILY_LABELS: Record<ProviderProtocolFamily, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
};

/** 各接口在 API 根地址之后的实际请求路径（界面展示用；真实拼接由适配器完成）。 */
export const PROVIDER_PROTOCOL_REQUEST_PATH: Record<ProviderChatProtocol, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "google-generative-ai": "/models/{model}:generateContent",
};

/** 地址以它结尾 = 原样使用，不补版本段（去掉标记本身）。 */
export const ENDPOINT_VERBATIM_MARKER = "#";

export function isVerbatimEndpointBaseUrl(baseUrl: string | undefined): boolean {
  return (baseUrl ?? "").trim().endsWith(ENDPOINT_VERBATIM_MARKER);
}

/** 去掉末尾的 `#` 标记与尾斜杠；不改其它内容。 */
export function stripEndpointVerbatimMarker(baseUrl: string): string {
  let root = baseUrl.trim();
  if (root.endsWith(ENDPOINT_VERBATIM_MARKER)) root = root.slice(0, -1);
  return root.replace(/\/+$/, "");
}

/** 路径里是否已有版本段（/v1、/v3、/v4、/v1beta …，只看路径，不看主机）。 */
export function hasApiVersionSegment(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  let path = trimmed;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    path = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  }
  return /(^|\/)v\d+[a-z]*(?=\/|$)/i.test(path);
}

export type ResolvedEndpointRequestBase = {
  /** 规范化后的请求根地址（已补版本段 / 已去 # 标记）；存档原值不改。 */
  base: string;
  /** 该接口的实际请求地址（Gemini 保留 {model} 占位）。 */
  requestUrl: string;
  /** 用户以 # 结尾要求原样使用。 */
  verbatim: boolean;
};

/**
 * 端点地址的版本段规则（设置页预览、路由结果、模型列表推导共用同一口径）：
 * - OpenAI 家族：路径无版本段时补 /v1；以 # 结尾原样使用；完整 URL 原样。
 * - Anthropic Messages：地址不改；路径已以 /v1 结尾时请求 {base}/messages，否则 {base}/v1/messages。
 * - Gemini：无版本段时补 /v1beta。
 */
export function resolveEndpointRequestBase(
  protocol: ProviderChatProtocol,
  baseUrl: string | undefined,
  isFullUrl = false,
): ResolvedEndpointRequestBase {
  // 网关侧可能拿到归一化前的快照（baseUrl 缺省），这里同样容错。
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!trimmed) return { base: "", requestUrl: "", verbatim: false };
  if (isFullUrl) return { base: trimmed, requestUrl: trimmed, verbatim: false };
  const verbatim = isVerbatimEndpointBaseUrl(trimmed);
  const root = stripEndpointVerbatimMarker(trimmed);
  const requestPath = PROVIDER_PROTOCOL_REQUEST_PATH[protocol];
  if (protocol === "anthropic-messages") {
    const requestUrl = /\/v1$/i.test(root) ? `${root}/messages` : `${root}${requestPath}`;
    return { base: root, requestUrl, verbatim };
  }
  const versionSegment = protocol === "google-generative-ai" ? "/v1beta" : "/v1";
  const base = verbatim || hasApiVersionSegment(root) ? root : `${root}${versionSegment}`;
  return { base, requestUrl: `${base}${requestPath}`, verbatim };
}

/** 各接口模型列表路径（探测用）。 */
export const PROVIDER_PROTOCOL_MODELS_PATH: Record<ProviderChatProtocol, string> = {
  "anthropic-messages": "/v1/models",
  "openai-completions": "/models",
  "openai-responses": "/models",
  "google-generative-ai": "/models",
};

// ---------------------------------------------------------------------------
// 方言
// ---------------------------------------------------------------------------

export const PROVIDER_WIRE_DIALECTS = ["generic", "openai", "xai", "deepseek"] as const;

export type ProviderWireDialect = (typeof PROVIDER_WIRE_DIALECTS)[number];

export function isProviderWireDialect(value: unknown): value is ProviderWireDialect {
  return PROVIDER_WIRE_DIALECTS.includes(value as ProviderWireDialect);
}

export const PROVIDER_WIRE_DIALECT_LABELS: Record<ProviderWireDialect, string> = {
  generic: "generic",
  openai: "OpenAI 官方",
  xai: "xAI",
  deepseek: "DeepSeek",
};

/** 每个协议允许的方言；不在列表里的组合在归一化时退回 generic。 */
export const PROVIDER_PROTOCOL_DIALECTS: Record<
  ProviderChatProtocol,
  readonly ProviderWireDialect[]
> = {
  "anthropic-messages": ["generic"],
  "openai-completions": ["generic", "openai", "xai", "deepseek"],
  "openai-responses": ["generic", "openai", "xai", "deepseek"],
  "google-generative-ai": ["generic"],
};

export function coerceDialectForProtocol(
  protocol: ProviderChatProtocol,
  dialect: ProviderWireDialect | undefined,
): ProviderWireDialect {
  if (!dialect) return "generic";
  return PROVIDER_PROTOCOL_DIALECTS[protocol].includes(dialect) ? dialect : "generic";
}

/** 官方域名 → 方言推导（只对 OpenAI 家族有意义）。 */
const OFFICIAL_HOST_DIALECTS: readonly [RegExp, ProviderWireDialect][] = [
  [/(^|\.)api\.x\.ai$/i, "xai"],
  [/(^|\.)api\.deepseek\.com$/i, "deepseek"],
  [/(^|\.)api\.openai\.com$/i, "openai"],
];

export function inferDialectFromBaseUrl(
  protocol: ProviderChatProtocol,
  baseUrl: string | undefined,
): ProviderWireDialect | undefined {
  if (PROVIDER_PROTOCOL_FAMILY[protocol] !== "openai") return undefined;
  const host = endpointHostOf(baseUrl);
  if (!host) return undefined;
  for (const [pattern, dialect] of OFFICIAL_HOST_DIALECTS) {
    if (pattern.test(host)) return dialect;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 请求头档
// ---------------------------------------------------------------------------

export type ProviderAuthHeaderSpec = {
  headerName: string;
  /** 例如 "Bearer "；缺省无前缀。 */
  prefix?: string;
};

/** 协议头档中的鉴权头。端点可用 auth.headerName / auth.prefix 覆盖。 */
export const PROVIDER_PROTOCOL_AUTH_HEADER: Record<ProviderChatProtocol, ProviderAuthHeaderSpec> = {
  "anthropic-messages": { headerName: "x-api-key" },
  "openai-completions": { headerName: "Authorization", prefix: "Bearer " },
  "openai-responses": { headerName: "Authorization", prefix: "Bearer " },
  "google-generative-ai": { headerName: "x-goog-api-key" },
};

export const ANTHROPIC_API_VERSION_HEADER = "anthropic-version";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * 协议头档：鉴权头与协议版本头。不含厂商方言头、不含用户头。
 * 返回值中的键顺序稳定，便于 Golden 对比。
 */
export function buildProtocolAuthHeaders(
  protocol: ProviderChatProtocol,
  apiKey: string,
  override?: Partial<ProviderAuthHeaderSpec>,
): Record<string, string> {
  const spec = PROVIDER_PROTOCOL_AUTH_HEADER[protocol];
  const headerName = override?.headerName?.trim() || spec.headerName;
  // 改了头名但没给前缀：按无前缀处理（api-key / X-Api-Key 类头不带 Bearer）；
  // 沿用协议默认头名时才继承默认前缀。
  const renamed = headerName.toLowerCase() !== spec.headerName.toLowerCase();
  const prefix = override?.prefix ?? (renamed ? "" : (spec.prefix ?? ""));
  const headers: Record<string, string> = { [headerName]: `${prefix}${apiKey}` };
  if (protocol === "anthropic-messages") {
    headers[ANTHROPIC_API_VERSION_HEADER] = ANTHROPIC_API_VERSION;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// 网关实现偏差推导（pi-ai 隔着本地反代看不到真实域名，这里按端点地址补上）
// ---------------------------------------------------------------------------

export type InferredEndpointQuirks = {
  supportsUsageInStreaming?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsStore?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen";
  maxTokensField?: "max_completion_tokens" | "max_tokens";
};

const KNOWN_HOST_QUIRKS: readonly [RegExp, InferredEndpointQuirks][] = [
  [
    /(^|\.)(api\.z\.ai|open\.bigmodel\.cn)$/i,
    {
      thinkingFormat: "zai",
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  ],
  [/(^|\.)openrouter\.ai$/i, { thinkingFormat: "openrouter", supportsStore: false }],
  [
    /(^|\.)api\.together\.(ai|xyz)$/i,
    {
      thinkingFormat: "together",
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  ],
  [/(^|\.)chutes\.ai$/i, { supportsStore: false, maxTokensField: "max_tokens" }],
  [/(^|\.)dashscope(-intl)?\.aliyuncs\.com$/i, { thinkingFormat: "qwen", supportsStore: false }],
  [
    /(^|\.)api\.moonshot\.(cn|ai)$/i,
    { supportsReasoningEffort: false, supportsStore: false, maxTokensField: "max_tokens" },
  ],
  [
    /(^|\.)integrate\.api\.nvidia\.com$/i,
    { supportsReasoningEffort: false, supportsStore: false, maxTokensField: "max_tokens" },
  ],
  [/(^|\.)cerebras\.ai$/i, { supportsStore: false }],
  // 旧 modelFactory 对 groq 还有一条 qwen/qwen3-32b 的档位特判（thinkingLevelMap 全部
  // 映射到 "default"）；那是按模型而非按网关的偏差，不属于端点 quirks，这里不恢复。
  [/(^|\.)groq\.com$/i, { supportsStore: false }],
];

/**
 * 按端点地址推导已知网关的 Completions 实现偏差。只对 openai-completions 生效；
 * 用户或预设显式声明的 quirks 覆盖推导值。
 */
export function inferEndpointQuirksFromBaseUrl(
  protocol: ProviderChatProtocol,
  baseUrl: string | undefined,
): InferredEndpointQuirks | undefined {
  if (protocol !== "openai-completions") return undefined;
  const host = endpointHostOf(baseUrl);
  if (!host) return undefined;
  for (const [pattern, quirks] of KNOWN_HOST_QUIRKS) {
    if (pattern.test(host)) return { ...quirks };
  }
  return undefined;
}
