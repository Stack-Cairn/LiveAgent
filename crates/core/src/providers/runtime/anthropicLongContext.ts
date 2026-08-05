import type { Context, Model } from "@earendil-works/pi-ai";
import type { ProviderId } from "../../settings";
import {
  ANTHROPIC_STANDARD_CONTEXT_WINDOW,
  getAnthropicCompat,
  shouldSendAnthropicLongContextHeader,
} from "../anthropicModels";
import { isAnthropicOAuthApiKey } from "../customHeaders";
import type { StreamOptionsEx } from "./types";

// ---------------------------------------------------------------------------
// Anthropic 1M 长上下文请求信号
// ---------------------------------------------------------------------------
// 模型有效 contextWindow > 200K 是启用 1M 的唯一开关（压缩预算同源）。对需要
// HTTP beta 信号的 Anthropic 兼容中转携带 `context-1m-2025-08-07`；官方 GA、
// Vertex、DeepSeek、Bedrock 等端点由端点策略决定，不发送这个 HTTP 头。

export const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const ANTHROPIC_INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const ANTHROPIC_FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";

// pi-ai 的 mergeHeaders 对 options.headers 是整键覆盖而非追加，因此这里必须
// 复现 createClient() 为非 OAuth 请求计算的基础 beta 集（顺序一致），再追加
// context-1m。两个镜像条件与 pi-ai dist/api/anthropic-messages.js 逐字对应，
// 由 anthropic-long-context 测试锁定；pi-ai 升级新增 beta 时需同步。
function buildAnthropicBetaHeaderValue(
  model: Model<"anthropic-messages">,
  context: Context | undefined,
): string {
  const compat = getAnthropicCompat(model);
  const betas: string[] = [];
  if (context?.tools?.length && compat?.supportsEagerToolInputStreaming === false) {
    betas.push(ANTHROPIC_FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (compat?.forceAdaptiveThinking !== true) {
    betas.push(ANTHROPIC_INTERLEAVED_THINKING_BETA);
  }
  betas.push(ANTHROPIC_CONTEXT_1M_BETA);
  return betas.join(",");
}

export function attachAnthropicLongContextBeta(
  options: StreamOptionsEx,
  params: {
    providerId: ProviderId;
    baseUrl: string;
    model?: Model<"anthropic-messages">;
    context?: Context;
  },
): StreamOptionsEx {
  const model = params.model;
  if (params.providerId !== "claude_code") return options;
  if (model?.api !== "anthropic-messages") return options;
  if (!shouldSendAnthropicLongContextHeader(params.baseUrl)) return options;
  if ((model.contextWindow ?? 0) <= ANTHROPIC_STANDARD_CONTEXT_WINDOW) return options;
  if (isAnthropicOAuthApiKey(options.apiKey)) return options;

  const headers = { ...options.headers };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "anthropic-beta") delete headers[key];
  }
  headers["anthropic-beta"] = buildAnthropicBetaHeaderValue(model, params.context);

  return {
    ...options,
    headers,
  };
}
