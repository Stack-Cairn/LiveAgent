import type { Locale } from "@liveagent/app/i18n/config";

export type CuaErrorPayload = {
  kind: string;
  message: string;
  params?: Record<string, unknown> | null;
};

/**
 * 把 Rust CUA 错误按 locale 翻译成人类可读消息。
 *
 * 后端仅返回稳定的 `kind` + i18n 模板参数 + 英文兜底；这里照 key 查 i18n
 * map，并按 `{xxx}` 占位填参数（CUA-006）。模板语法与现有 i18n 一致：
 * 见 `sharedTranslations.ts`。
 *
 * 如果 `t` 函数查不到对应 key（理论不会发生，前端 i18n 完整覆盖），回到
 * `error.message`（英文）保证用户至少能看到原因。
 */
export function formatCuaError(
  error: CuaErrorPayload | null | undefined,
  t: (key: string, locale: Locale) => string,
  locale: Locale,
): string {
  if (!error) return "";
  const template = t(error.kind, locale);
  if (!template || template === error.kind) {
    // fallback: 整段透传英文 message
    return error.message;
  }
  if (!error.params) return template;
  return interpolate(template, error.params);
}

function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) return match;
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "string" || typeof value === "number") return String(value);
    return JSON.stringify(value);
  });
}

/**
 * Tauri 2 收到 Rust 侧的 `Err(E)` 后会把 `E` JSON 化返回；
 * `window.__TAURI_INTERNALS__.invoke` 拒绝时附的是原生 JS `Error`，
 * `message` 是 JSON 字符串。在另外一些路径上调用方直接拿到了对象本身。
 * 两种 shape 都要认，按类型嗅探后归一化为 `CuaErrorPayload | null`。
 */
export function normalizeCuaError(input: unknown): CuaErrorPayload | null {
  if (input == null) return null;
  if (typeof input === "object" && typeof (input as CuaErrorPayload).kind === "string") {
    return input as CuaErrorPayload;
  }
  if (input instanceof Error) {
    return parseErrorMessage(input.message);
  }
  if (typeof input === "string") {
    return parseErrorMessage(input);
  }
  return null;
}

function parseErrorMessage(raw: string): CuaErrorPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { kind?: unknown; message?: unknown };
    if (typeof parsed.kind === "string" && typeof parsed.message === "string") {
      return parsed as CuaErrorPayload;
    }
  } catch {
    // 不是 JSON，忽略。
  }
  return null;
}

/**
 * 把任意错误输入收敛成人类可读文本：先尝试解析成结构化错误后翻译；
 * 退到 `String(input)` 用于 mock / 测试 fixture。
 */
export function formatUnknownCuaError(
  input: unknown,
  t: (key: string, locale: Locale) => string,
  locale: Locale,
): string {
  const structured = normalizeCuaError(input);
  if (structured) {
    return formatCuaError(structured, t, locale);
  }
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  return String(input);
}
