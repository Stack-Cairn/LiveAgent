import type { ProviderId } from "../../settings";
import { isRecord } from "./common";
import type { StreamOptionsEx } from "./types";

// xAI Responses 端点严格校验请求体：OpenAI 专属的存储/缓存/系统元数据字段
// （store、prompt_cache_*、instructions、metadata 等）不被接受。
// reasoning 保留，但会规范化为 xAI 支持的 effort 档位（无 summary）。
const XAI_UNSUPPORTED_RESPONSES_PAYLOAD_KEYS = [
  "background",
  "instructions",
  "metadata",
  "prompt",
  "prompt_cache_key",
  "prompt_cache_retention",
  "service_tier",
  "store",
  "stream_options",
  "text",
] as const;

/** UI / OpenAI 风格 effort → xAI 官方 effort（low|medium|high|xhigh|none）。 */
export function mapUiEffortToXaiEffort(
  effort: string | undefined,
  modelId?: string,
): "none" | "low" | "medium" | "high" | "xhigh" | undefined {
  const normalized = effort?.trim().toLowerCase() ?? "";
  if (!normalized) return undefined;

  const id = modelId?.trim().toLowerCase() ?? "";
  const supportsNone = id.includes("grok-4.3") || id.includes("grok-3");

  switch (normalized) {
    case "off":
    case "none":
      return supportsNone ? "none" : undefined;
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    case "max":
      return "high";
    default:
      return undefined;
  }
}

export function isXaiDirectBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim() ?? "";
  if (!trimmed) return false;
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase() === "api.x.ai";
  } catch {
    return false;
  }
}

export function isXaiProviderTarget(params: { providerId: ProviderId; baseUrl?: string }): boolean {
  return params.providerId === "xai" || isXaiDirectBaseUrl(params.baseUrl);
}

// grok 的服务端工具（web_search / x_search / code_interpreter）只有显式
// include 才会回传搜索来源与执行输出；reasoning.encrypted_content 则是
// store 关闭时跨轮回放推理项的前提，始终请求。
function xaiResponsesIncludeValues(tools: unknown): string[] {
  const values = ["reasoning.encrypted_content"];
  if (!Array.isArray(tools)) return values;
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.type !== "string") continue;
    switch (tool.type.trim()) {
      case "web_search":
        values.push("web_search_call.action.sources");
        break;
      case "file_search":
        values.push("file_search_call.results");
        break;
      case "code_interpreter":
        values.push("code_interpreter_call.outputs");
        break;
    }
  }
  return values;
}

function mergeUniqueIncludeValues(defaults: string[], existing: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };
  for (const value of defaults) push(value);
  if (Array.isArray(existing)) {
    for (const value of existing) push(value);
  }
  return result;
}

function readPayloadEffort(reasoning: unknown): string | undefined {
  if (!isRecord(reasoning)) return undefined;
  return typeof reasoning.effort === "string" ? reasoning.effort : undefined;
}

function applyXaiReasoningField(
  sanitized: Record<string, unknown>,
  previousReasoning: unknown,
  modelId: string | undefined,
) {
  const mapped = mapUiEffortToXaiEffort(readPayloadEffort(previousReasoning), modelId);
  if (mapped) {
    sanitized.reasoning = { effort: mapped };
  } else {
    delete sanitized.reasoning;
  }
}

export function attachXaiResponsesPayloadCompat(
  options: StreamOptionsEx,
  params: {
    providerId: ProviderId;
    baseUrl?: string;
  },
): StreamOptionsEx {
  // 正式 xai 供应商，或 Codex 直连 api.x.ai 的兼容路径。
  if (params.providerId !== "xai" && params.providerId !== "codex") {
    return options;
  }
  if (params.providerId === "codex" && !isXaiDirectBaseUrl(params.baseUrl)) {
    return options;
  }

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (model.api !== "openai-responses" || !isRecord(nextPayload)) {
        return nextPayload;
      }

      const previousReasoning = nextPayload.reasoning;
      const sanitized: Record<string, unknown> = { ...nextPayload };
      for (const key of XAI_UNSUPPORTED_RESPONSES_PAYLOAD_KEYS) {
        delete sanitized[key];
      }
      applyXaiReasoningField(sanitized, previousReasoning, model.id);
      sanitized.include = mergeUniqueIncludeValues(
        xaiResponsesIncludeValues(sanitized.tools),
        nextPayload.include,
      );
      return sanitized;
    },
  };
}
