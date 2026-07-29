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

const COMMON_CUSTOM_HEADER_KEY_PRESETS = [
  "X-Request-ID",
  "X-User-ID",
  "X-Environment",
  "HTTP-Referer",
  "X-Title",
] as const;

const ANTHROPIC_CUSTOM_HEADER_KEY_PRESETS: readonly string[] = [
  ...Object.keys(ANTHROPIC_DEFAULT_REQUEST_HEADERS),
  ...COMMON_CUSTOM_HEADER_KEY_PRESETS,
];

const CODEX_CUSTOM_HEADER_KEY_PRESETS: readonly string[] = [
  "User-Agent",
  CODEX_SESSION_ID_HEADER,
  CODEX_CONVERSATION_ID_HEADER,
  ...COMMON_CUSTOM_HEADER_KEY_PRESETS,
];

const XAI_CUSTOM_HEADER_KEY_PRESETS: readonly string[] = [
  "User-Agent",
  ...COMMON_CUSTOM_HEADER_KEY_PRESETS,
];

const CUSTOM_HEADER_KEY_PRESETS: Record<CustomProvider["type"], readonly string[]> = {
  claude_code: ANTHROPIC_CUSTOM_HEADER_KEY_PRESETS,
  codex: CODEX_CUSTOM_HEADER_KEY_PRESETS,
  gemini: COMMON_CUSTOM_HEADER_KEY_PRESETS,
  xai: XAI_CUSTOM_HEADER_KEY_PRESETS,
};

export function getCustomHeaderKeyPresets(providerId: CustomProvider["type"]): readonly string[] {
  return CUSTOM_HEADER_KEY_PRESETS[providerId];
}

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
