// 压缩执行引擎在 crates/core（core 是唯一引擎）。前端不再有压缩流水线，只保留
// wire 契约与状态展示需要的类型：core 通过 compaction_status / tool_status 事件
// 把这些结构原样发上来，前端渲染。字段必须与 core 的
// crates/core/src/chat/compaction/types.ts 同名类型保持一致。

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
