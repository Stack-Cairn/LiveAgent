import type {
  CodexRequestFormat,
  CustomProvider,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
} from "../../settings";

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
  customHeaders?: CustomProvider["customHeaders"];
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled?: boolean;
  useSystemProxy?: boolean;
  modelConfig?: ProviderModelConfig;
};
