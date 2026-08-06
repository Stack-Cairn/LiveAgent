import type { CustomProvider } from "../settings";
import {
  CLI_IDENTITY_METADATA,
  type CliIdentitySettings,
  formatCliIdentityUserAgent,
  getAppliedCliIdentityVersion,
  isManagedCliIdentityProviderId,
} from "./cliIdentityCore";

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

export const ANTHROPIC_DEFAULT_REQUEST_HEADERS = {
  "x-app": "cli",
  "User-Agent": formatCliIdentityUserAgent(
    "claude_code",
    CLI_IDENTITY_METADATA.claude_code.builtinVersion,
  ),
  "Content-Type": "application/json",
  "X-Stainless-OS": "MacOS",
  "X-Stainless-Arch": "arm64",
  "X-Stainless-Lang": "js",
  "anthropic-version": "2023-06-01",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Timeout": "600",
  "x-stainless-retry-count": "0",
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Runtime-Version": "v22.19.0",
  "anthropic-dangerous-direct-browser-access": "true",
} as const;

export const CODEX_DEFAULT_USER_AGENT = formatCliIdentityUserAgent(
  "codex",
  CLI_IDENTITY_METADATA.codex.builtinVersion,
);
export const CODEX_SESSION_ID_HEADER = "session_id";
export const CODEX_CONVERSATION_ID_HEADER = "conversation_id";

export const XAI_DEFAULT_USER_AGENT = formatCliIdentityUserAgent(
  "xai",
  CLI_IDENTITY_METADATA.xai.builtinVersion,
);

export function isAnthropicOAuthApiKey(apiKey: string | undefined): boolean {
  return Boolean(apiKey?.includes("sk-ant-oat"));
}

function findHeaderKey(
  headers: Record<string, string | null | undefined>,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === expected);
}

export function readCustomHeaderValue(
  headers: CustomProvider["customHeaders"] | undefined,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (let index = (headers?.length ?? 0) - 1; index >= 0; index -= 1) {
    const header = headers?.[index];
    if (
      header?.key.toLowerCase() === expected &&
      isValidCustomHeaderKey(header.key) &&
      isValidCustomHeaderValue(header.value)
    ) {
      return header.value;
    }
  }
  return undefined;
}

export function resolveProviderCustomHeaders(
  provider: Pick<CustomProvider, "type" | "apiKey" | "requestFormat" | "customHeaders">,
  identities: CliIdentitySettings,
): CustomProvider["customHeaders"] {
  const customHeaders = provider.customHeaders ?? [];
  if (!isManagedCliIdentityProviderId(provider.type)) return customHeaders;
  const customUserAgent = readCustomHeaderValue(customHeaders, "User-Agent");
  if (customUserAgent !== undefined && isValidCustomHeaderValue(customUserAgent)) {
    return customHeaders;
  }
  if (provider.type === "claude_code" && isAnthropicOAuthApiKey(provider.apiKey)) {
    return customHeaders;
  }
  if (provider.type === "codex" && provider.requestFormat === "openai-completions") {
    return customHeaders;
  }
  const profile = identities[provider.type];
  return [
    {
      key: "User-Agent",
      value: formatCliIdentityUserAgent(
        provider.type,
        getAppliedCliIdentityVersion(provider.type, profile),
      ),
    },
    ...customHeaders,
  ];
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

export function mergeCustomHeaders(
  base: Record<string, string>,
  customHeaders?: CustomProvider["customHeaders"],
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
