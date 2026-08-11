export type { ProviderRuntimeConfig } from "../../providers/runtime/types";

export type CompactionTrigger = "pre-send" | "mid-stream" | "post-tool" | "manual";

// optimization = 发送前的从容压缩（阈值更宽），protection = 运行中的保护性压缩（阈值更紧）。
export type CompactionIntent = "optimization" | "protection";

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
  | "below-manual-threshold"
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
