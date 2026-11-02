type SimpleStreamOptions = {
  signal?: AbortSignal;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

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
export type ProviderRuntimeBackend = "kbrain";

export type ProviderRuntimeConfig = {
  readonly [PROVIDER_RUNTIME_CONFIG_BRAND]: true;
  backend: ProviderRuntimeBackend;
  /** Opaque K-brain catalog provider ID; never a vendor credential. */
  backendModelProvider?: string;
  baseUrl: string;
  isFullUrl: boolean;
  apiKey: string;
  customHeaders?: CustomProvider["customHeaders"];
  requestFormat?: CodexRequestFormat;
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

export type StreamOptionsEx = SimpleStreamOptions & {
  toolChoice?: ToolChoice;
  workdir?: string;
  streamRetry?: StreamRetryConfig;
};
