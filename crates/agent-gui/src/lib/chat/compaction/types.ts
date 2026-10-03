export type { ProviderRuntimeConfig } from "../../providers/runtime/types";

// overflow = 供应商报上下文溢出后的反应式压缩（取代已删除的 mid-stream 中止）。
export type CompactionTrigger = "pre-send" | "overflow" | "post-tool" | "manual";

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
      /** LLM 档全部失败、由 deterministic 兜底时的失败说明。 */
      degraded?: string;
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
  | "prefix-too-large"
  | "circuit-open"
  | "threshold-exceeded";
