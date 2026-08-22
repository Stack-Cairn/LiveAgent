import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import type { StreamRetryConfig } from "../runtime/streamRetry";
import type { StreamOptionsEx } from "../runtime/types";

/**
 * 一次 LLM 流式请求的完整信封。
 *
 * `model.api` 决定路由到哪个适配器；`context` 与 `options` 不做任何解释，
 * 原样交给适配器——传输路由字段（headers 里的 x-liveagent-*、useSystemProxy
 * 派生头）对 seam 不透明透传，seam 不读取、不判断、不缓存。
 */
export type LlmStreamRequest = {
  model: Model<Api>;
  context: Context;
  options: StreamOptionsEx;
};

/**
 * LLM 适配器：把一组 wire 协议接到统一分发入口 llm.stream() 上。
 *
 * PR-1 只要求 stream()（行为与被包装的原实现逐行等价）；resolveModel /
 * retryPolicy 是 PR-2（策略归属权反转）预留的可选能力，当前没有实现者，
 * 重试策略仍由调用方通过 options.streamRetry 携带。
 */
export type LlmAdapter = {
  /** 本适配器承接的 wire 协议 id 集合（即 model.api 的取值）。 */
  readonly apis: readonly string[];
  /** 发起一次流式请求。必须保持被包装实现的语义，包括流内重试的包装位置。 */
  stream(
    model: Model<Api>,
    context: Context,
    options: StreamOptionsEx,
  ): AssistantMessageEventStream;
  /** PR-2 预留：路由时机的模型解析。 */
  resolveModel?(model: Model<Api>): Model<Api>;
  /** PR-2 预留：供应商级重试策略查询。 */
  retryPolicy?(model: Model<Api>): StreamRetryConfig | undefined;
};
