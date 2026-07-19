import type {
  CodexRequestFormat,
  CustomProvider,
  ProviderModelConfig,
  ReasoningLevel,
} from "../../settings";

export type CompactionTrigger = "pre-send" | "mid-stream" | "post-tool";

// optimization = 发送前的从容压缩（阈值更宽），protection = 运行中的保护性压缩（阈值更紧）。
export type CompactionIntent = "optimization" | "protection";

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

export type CompactionStatus =
  | { phase: "idle" }
  | {
      phase: "running";
      trigger: CompactionTrigger;
      startedAt: number;
      sourceSegmentIndex: number;
    }
  | {
      phase: "completed";
      trigger: CompactionTrigger;
      newSegmentIndex: number;
      completedAt: number;
    }
  | {
      phase: "failed";
      trigger: CompactionTrigger;
      failedAt: number;
      message: string;
    };

export type CompactionDecisionReason =
  | "disabled"
  | "no-active-messages"
  | "in-flight"
  | "below-threshold"
  | "cooldown"
  | "threshold-exceeded";

export type CompactionDecision = {
  shouldCompact: boolean;
  intent: CompactionIntent;
  reason: CompactionDecisionReason;
  totalTokens: number;
  threshold: number;
  thresholdMode: "buffered-reserve" | "context-window";
  contextWindow: number;
  maxOutputToken: number;
};
