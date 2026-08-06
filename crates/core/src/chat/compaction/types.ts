// 本目录的压缩流水线与 pi-agent-core 的 dist/harness/compaction 是**有意分叉**，
// 不是待迁移的重复实现：库按 entry id 寻址 SessionTreeEntry，这里按
// (segmentIndex, messageIndex) 寻址，而该键已是 SQLite 主键与 gateway wire 契约。
// 库的 compaction/session API 变更可无视；升级只需检查 Agent/AgentTool 与 pi-ai
// 消息类型。理由、成本数字与升级检查面见 docs/adr/0001-segment-session-model.md。
export type { ProviderRuntimeConfig } from "../../providers/runtime/types";

export type CompactionTrigger = "pre-send" | "mid-stream" | "post-tool";

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
