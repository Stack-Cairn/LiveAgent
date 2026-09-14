// 四类聊天接口、厂商方言与请求头档（docs/design/provider-registry-and-model-routing.md 2.2 / 4.3）。
//
// 协议决定请求体结构、流解析、端点路径和 pi-ai 的 Model.api；方言决定同一协议下
// 的字段取舍、鉴权附加头、思考参数映射。四个协议字面量与 pi-ai 一致，不做翻译。

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

export function isProviderProtocolFamily(value: unknown): value is ProviderProtocolFamily {
  return PROVIDER_PROTOCOL_FAMILIES.includes(value as ProviderProtocolFamily);
}

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
  if (PROVIDER_PROTOCOL_FAMILY[protocol] !== "openai" || !baseUrl) return undefined;
  let host = "";
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
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
  const prefix = override?.prefix ?? spec.prefix ?? "";
  const headers: Record<string, string> = { [headerName]: `${prefix}${apiKey}` };
  if (protocol === "anthropic-messages") {
    headers[ANTHROPIC_API_VERSION_HEADER] = ANTHROPIC_API_VERSION;
  }
  return headers;
}

/** 大小写不敏感的头合并：后者覆盖前者，保留后者的键写法。 */
export function mergeHeaderLayers(
  ...layers: (Record<string, string> | undefined | null)[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      const existing = Object.keys(out).find((k) => k.toLowerCase() === key.toLowerCase());
      if (existing && existing !== key) delete out[existing];
      out[key] = value;
    }
  }
  return out;
}
