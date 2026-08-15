/**
 * 前缀归因的 provider 缓存参数统一入口。按协议族分发:anthropic 记断点策略与
 * TTL;codex 的缓存是隐式前缀匹配,可变的是分片路由键(prompt_cache_key /
 * x-session-id)与 retention。分发与 modelApi 的类型收敛都留在 providers 层,
 * runner 不再内联 if/else,也不再对 model.api 做强转。
 */
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { PrefixShapeCacheControl } from "../../debug/prefixCacheShape";
import type { CodexRequestFormat, PromptCacheHintMode, ProviderId } from "../../settings";
import { describeAnthropicCacheShape } from "./anthropicCache";
import { describeCodexCacheShape } from "./codexPromptCache";
import type { StreamOptionsEx } from "./types";

const CODEX_REQUEST_FORMATS: readonly CodexRequestFormat[] = [
  "openai-completions",
  "openai-responses",
];

/**
 * model.api 来自 pi-ai 的 Api 全集(还包含 anthropic-messages 等),codex 判定
 * 只认识两种 openai 格式。在这里收窄而不是在调用方强转:非 codex 格式落成
 * undefined,让 resolvePromptCacheHintMode 走自己的域名兜底,而不是拿一个
 * 谎报的类型进分支。
 */
function toCodexRequestFormat(modelApi: string | undefined): CodexRequestFormat | undefined {
  return CODEX_REQUEST_FORMATS.find((format) => format === modelApi);
}

export function describeProviderCacheShape(params: {
  providerId: ProviderId;
  baseUrl: string;
  promptCacheHintMode?: PromptCacheHintMode;
  modelApi?: string;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  headers?: StreamOptionsEx["headers"];
}): PrefixShapeCacheControl {
  if (params.providerId === "codex") {
    return describeCodexCacheShape(
      params.providerId,
      params.baseUrl,
      params.promptCacheHintMode,
      toCodexRequestFormat(params.modelApi),
      params.sessionId,
      params.cacheRetention,
      params.headers,
    );
  }
  return describeAnthropicCacheShape(params.providerId, params.baseUrl, params.cacheRetention);
}
