import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
  CodexRequestFormat,
  CustomProvider,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
} from "../../settings";
import type { StreamRetryConfig } from "./streamRetry";

export type ModelOption = {
  value: string; // encodes customProviderId::model
  label: string; // model id
  providerId: string; // stable custom provider identity (for grouping)
  providerName: string; // provider display name
  providerType: ProviderId; // routes Claude Code, Codex, Gemini, etc.
  model: string;
};

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
  apiKey: string;
  /** 故障转移候选 Key 列表（主 Key 在前，即 apiKey）；单 Key 时为 [apiKey]。 */
  apiKeys: string[];
  customHeaders?: CustomProvider["customHeaders"];
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled?: boolean;
  useSystemProxy?: boolean;
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

export type StreamOptionsEx = SimpleStreamOptions & {
  /**
   * 注意：pi-ai 的 streamSimpleAnthropic() 在内部会通过 buildBaseOptions() 丢弃 toolChoice，
   * 所以这里我们自己调用 streamAnthropic() 并把 toolChoice 显式传下去。
   */
  toolChoice?: ToolChoice;
  /**
   * DeepSeek 的 Anthropic 兼容端点偶尔会把工具调用泄漏成 DSML 文本。
   * 开启后在事件流层把 DSML 转回结构化 toolCall，避免 stop 截断工具循环。
   */
  deepSeekDsmlToolCallRepair?: boolean;
  deepSeekProviderAdapter?: boolean;
  deepSeekAnthropicPayloadToolBlockFlattening?: boolean;
  /** Escape hatch for the unified provider stream retry in streamByApi.ts. */
  streamRetry?: StreamRetryConfig;
  recoverMissingFinishReason?: boolean;
  /**
   * 多 Key 故障转移的当次尝试凭据（mutable holder）。streamByApi 的 factory 在
   * 每次 factory() 调用时从这里读 apiKey/headers，withStreamRetry 在重试前通过
   * streamRetry.apiKeyFailover.rotate 更新它，让重试落到下一个 Key。未配置多 Key
   * 时缺省，factory 回退到 options.apiKey/options.headers（兼容旧链路）。
   */
  attemptAuth?: { apiKey: string; headers: Record<string, string> };
};
