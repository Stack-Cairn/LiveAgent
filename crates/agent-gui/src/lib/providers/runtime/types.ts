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

export type ProviderRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  customHeaders?: CustomProvider["customHeaders"];
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
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
};
