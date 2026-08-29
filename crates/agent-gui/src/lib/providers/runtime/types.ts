import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import type {
  CodexRequestFormat,
  CustomProvider,
  PromptCacheHintMode,
  ProviderId,
  ProviderModelConfig,
  ProviderRetryPolicy,
  ReasoningLevel,
} from "../../settings";
import type { StreamRetryConfig } from "./streamRetry";

export type ModelOption = SharedModelOption<ProviderId>;

declare const PROVIDER_RUNTIME_CONFIG_BRAND: unique symbol;

/**
 * 供应商请求运行时配置——全仓唯一定义，唯一构造点是
 * createProviderRuntimeConfig()（见 ./providerRuntimeConfig）。
 *
 * 品牌字段让手写对象字面量一律编译不过：字段几乎全是可选的，逐字段转抄漏掉
 * customHeaders / promptCacheRetention 时 TypeScript 不会报警，而那正是自定义
 * 请求头在聊天全链路上失效的根因。需要派生请用展开（{...runtime, reasoning}），
 * 品牌随展开保留。
 */
export type ProviderRuntimeConfig = {
  readonly [PROVIDER_RUNTIME_CONFIG_BRAND]: true;
  baseUrl: string;
  isFullUrl: boolean;
  apiKey: string;
  customHeaders?: CustomProvider["customHeaders"];
  requestFormat?: CodexRequestFormat;
  /** 仅 Responses 格式：优先尝试 WebSocket，首个内容产生前失败时回退 SSE。 */
  enableWebSocket?: boolean;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled?: boolean;
  useSystemProxy?: boolean;
  /** 供应商级流内重试策略；缺省 = 全局默认。failover 逐候选独立携带。 */
  retryPolicy?: ProviderRetryPolicy;
  modelConfig?: ProviderModelConfig;
};

export type ToolChoice =
  | "auto"
  | "any"
  | "none"
  | {
      type: "tool";
      name: string;
    };

/**
 * 回退到 SSE 的判别原因。UI 必须能区分「压根没尝试连接」与「连上后被上游关闭」——
 * 前者是配置问题（用户改设置就能解决），后者是运行时问题（改设置没用）。
 */
export type StreamTransportFallbackReason =
  /** 端点/凭证不满足任何 WebSocket 通路，从未发起连接。 */
  | "not-eligible"
  /** 建连阶段失败：握手被拒、超时或上游不可达。 */
  | "handshake-failed"
  /** 上游以 1009 关闭：单帧超出上游体积上限。 */
  | "message-too-big"
  /** 上游以 1012 关闭并声明需要 HTTP 重放。 */
  | "upstream-replay-required"
  /** 已建连但在首个内容产生前异常结束。 */
  | "stream-incomplete";

export type StreamTransportFallbackInfo = {
  from: "websocket";
  to: "sse";
  reason: StreamTransportFallbackReason;
  errorMessage: string;
};

export type StreamOptionsEx = SimpleStreamOptions & {
  /** Invoked when a Responses WebSocket transport falls back to SSE before content starts. */
  onTransportFallback?: (info: StreamTransportFallbackInfo) => void;
  /**
   * 注意：pi-ai 的 streamSimpleAnthropic() 在内部会通过 buildBaseOptions() 丢弃 toolChoice，
   * 所以这里我们自己调用 streamAnthropic() 并把 toolChoice 显式传下去。
   */
  toolChoice?: ToolChoice;
  /** DeepSeek-only wire override for callers that must explicitly disable thinking. */
  deepSeekThinking?: "disabled";
  /** Conversation workdir used to resolve provider-native local attachments. */
  workdir?: string;
  /** Escape hatch for the unified provider stream retry in streamByApi.ts. */
  streamRetry?: StreamRetryConfig;
};
