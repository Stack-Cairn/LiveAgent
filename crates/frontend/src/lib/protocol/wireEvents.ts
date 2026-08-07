// 镜像 crates/core/src/protocol/wireEvents.ts（事件契约的唯一真相源在 core）。
// 前端只消费；除文末标注的前端本地 ui_stopping 外，此文件必须与 core 版逐字一致。
//
// core → backend → frontend 的事件契约。core 是唯一事件真相源:这里定义的
// `type` 就是 backend `emit_json` 扇出时用的事件名,也是前端订阅的名字。
// backend 不解释事件,前端不再猜结构 —— 中间不存在任何改名/重打包的翻译层。
//
// 字段命名规则:本协议自己的字段一律 snake_case;pi-ai 的消息对象
// (ToolCall / ToolResultMessage) 以及 core 自有的结构体(HostedSearchBlock、
// CompactionStatus)整体原样嵌套,不逐字段拍平 —— 拍平过一次,结果就是前端
// 拿 `payload.toolCall` 而 core 发的是 `payload.id`,谁都发现不了。
//
// 文案不进协议。tool_status 载荷是 tagged union(ToolStatus),中文由前端渲染
// 时映射;后端/引擎侧只描述"发生了什么"。

import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CompactionIntent, CompactionStatus } from "../chat/compaction/types";
import type { HostedSearchBlock } from "../chat/messages/hostedSearch";
import type { MemoryOrganizeTrigger } from "../memory/api";
import type { OrganizePhase } from "../memory/schema";

/** 运行终态。run_ended 之后本次 run 不再有任何事件。 */
export type RunEndedState = "completed" | "failed" | "cancelled";

/** 重试记录的 wire 形态(snake_case 化的 RetryAttemptRecord)。 */
export type WireRetryAttempt = {
  attempt: number;
  max_attempts: number;
  error_message: string;
};

/**
 * 工具/运行状态。取代原先直接下发的中文字符串:每个 kind 描述一个事实,
 * 渲染文案在前端。新增场景请加 kind,不要塞 `{ kind: "text", text }` 兜底
 * —— 那等于把字符串协议原样搬回来。
 */
export type ToolStatus =
  /** 第 N 轮:模型生成中。 */
  | { kind: "model_generating"; round: number }
  /** 第 N 轮:准备执行 tool_count 个工具。 */
  | { kind: "tools_preparing"; round: number; tool_count: number }
  /** 第 N 轮:恢复(断点续跑)执行 tool_count 个工具。 */
  | { kind: "tools_resuming"; round: number; tool_count: number }
  /** 流断开重试;round 为 null 表示 text 模式(无轮次概念)。 */
  | { kind: "stream_retrying"; round: number | null; attempt: number; max_attempts: number }
  /** 单个工具执行中;summary 是 summarizeToolCall 的技术摘要(如 `Read path=a.ts`)。 */
  | { kind: "tool_running"; summary: string }
  /** 同名工具并行批次执行中。 */
  | { kind: "parallel_tools_running"; tool_name: string; count: number }
  /** provider 原生联网搜索进行中。 */
  | { kind: "native_web_search" }
  /** 上下文压缩进行中。 */
  | {
      kind: "compaction_running";
      threshold_mode: "buffered-reserve" | "context-window";
      intent: CompactionIntent;
      total_tokens: number;
      context_window: number;
      near_model_limit: boolean;
    }
  /** 压缩失败,已裁剪旧工具输出降级继续。 */
  | { kind: "compaction_prune_fallback"; pruned_message_count: number }
  /** MCP 工具加载失败,已跳过并继续。 */
  | { kind: "mcp_load_error"; message: string }
  /**
   * 子代理运行期的阶段进展(创建 worktree / 检视改动 / 应用补丁 / 清理)。
   * phase 描述事实,agent_name 是该子代理的展示名;文案在前端生成。
   */
  | {
      kind: "subagent_progress";
      phase: "worktree_creating" | "worktree_inspecting" | "worktree_applying" | "worktree_cleanup";
      agent_name: string;
    }
  /**
   * 前端本地状态：停止请求已发出、等待 run_ended。不上 wire，引擎侧永不产生；
   * 若 core 的停止流将来需要下发同类事实，应把这个 kind 上移到 core 的协议文件。
   */
  | { kind: "ui_stopping" };

/** 状态去重键。tagged union 是对象,引用比较会把每次同状态都当成变化。 */
export function toolStatusKey(status: ToolStatus | null): string {
  return status === null ? "" : JSON.stringify(status);
}

/** 历史消息引用的 wire 形态,与持久化 JSON 的 (segment_index, message_index) 主键同构。 */
export type WireMessageRef = {
  segment_index: number;
  message_index: number;
  segment_id: string;
  message_id: string;
  role: string;
  content_hash: string;
};

type WithConversation = {
  conversation_id: string;
};

/** 助手正文增量。thinking 不走这里(契约:思维链只进 liveRounds)。 */
export type TokenDeltaEvent = WithConversation & {
  type: "token_delta";
  round: number;
  delta: string;
};

/** 思维链增量。 */
export type ThinkingDeltaEvent = WithConversation & {
  type: "thinking_delta";
  round: number;
  delta: string;
};

/** 一轮助手消息落定时的元信息(provider/model/usage 等),用于渲染轮次页脚。 */
export type RoundMetaEvent = WithConversation & {
  type: "round_meta";
  round: number;
  provider?: string;
  model?: string;
  api?: string;
  stop_reason?: string;
  usage?: unknown;
};

/**
 * 工具调用出现/更新。流式增量、正式 onToolCall、执行开始、审批标记补发全部
 * 走这一个事件 —— 消费端的动作完全相同(upsert + 标记运行中),分成四种事件
 * 只会让四份等价的 handler 慢慢长歪。
 */
export type ToolCallEvent = WithConversation & {
  type: "tool_call";
  round: number;
  tool_call: ToolCall;
};

/** 工具结果。tool_call 一并带上,消费端不必从轮次里反查名字与参数。 */
export type ToolResultEvent = WithConversation & {
  type: "tool_result";
  round: number;
  tool_call: ToolCall;
  tool_result: ToolResultMessage;
};

/** provider 原生托管搜索块的增量更新。 */
export type HostedSearchEvent = WithConversation & {
  type: "hosted_search";
  round: number;
  hosted_search: HostedSearchBlock;
};

/** 工具/运行状态变化。status 为 null 表示清空。 */
export type ToolStatusChangeEvent = WithConversation & {
  type: "tool_status_change";
  status: ToolStatus | null;
  is_compaction: boolean;
  retry_attempts?: WireRetryAttempt[];
};

/** 用户消息入队(供其他已连接的客户端对齐 transcript)。 */
export type UserMessageEvent = WithConversation & {
  type: "user_message";
  message: string;
  message_id?: string;
  uploaded_files: unknown[];
  message_ref?: WireMessageRef;
  base_message_ref?: WireMessageRef;
  reason?: "edit_resend";
};

/** 会话标题确定/更新。final 为 true 表示不会再变。 */
export type ConversationTitleEvent = WithConversation & {
  type: "conversation_title";
  title: string;
  final: boolean;
};

/** 压缩产出的 checkpoint 摘要。 */
export type CompactionCheckpointEvent = WithConversation & {
  type: "compaction_checkpoint";
  summary_text: string;
  checkpoint: {
    summary_id: string;
    segment_index: number;
    covered_message_count: number;
    covers_through_message_id?: string;
    timestamp: number;
    generated_by: {
      provider_id: string;
      model: string;
      prompt_version?: string;
    };
  };
};

/** 压缩阶段状态机。 */
export type CompactionStatusEvent = WithConversation & {
  type: "compaction_status";
  status: CompactionStatus;
};

/** hook 执行告警(不致命,仅提示)。 */
export type HookWarningEvent = WithConversation & {
  type: "hook_warning";
  hook_name: string;
  hook_type: string;
  event: string;
  message: string;
};

/** run 内错误。终态另由 run_ended 给出。 */
export type ErrorEvent = WithConversation & {
  type: "error";
  message: string;
};

/** 运行终态。本次 run 的最后一条事件。 */
export type RunEndedEvent = WithConversation & {
  type: "run_ended";
  state: RunEndedState;
  error_message?: string;
};

// ---------------------------------------------------------------------------
// 非会话事件。后台任务(记忆整理、定时任务)不属于任何会话,所以没有
// conversation_id —— 消费端按 type 分流,不要为了统一形状塞一个假的会话号。
// ---------------------------------------------------------------------------

/**
 * 记忆整理阶段推进。run 记录本身由 Rust 库持有(memory_organize_run_*),
 * 这里只说明「进到哪一阶段了」,UI 据此刷新,不必轮询。
 */
export type MemoryOrganizeProgressEvent = {
  type: "memory_organize_progress";
  run_id: string;
  phase: OrganizePhase;
  input_count?: number;
  cluster_count?: number;
};

/**
 * 记忆整理终态成因:
 * - nothing_to_organize:没有可整理的普通记忆,未写入
 * - pending_review:生成了待确认的安全建议
 * - applied:安全建议已应用
 * - all_clusters_failed:所有分组都未提交有效计划
 * - error:其他失败(error_message 为原始错误)
 */
export type MemoryOrganizeSummaryKind =
  | "nothing_to_organize"
  | "pending_review"
  | "applied"
  | "all_clusters_failed"
  | "error";

export type MemoryOrganizeOutcome = {
  input_count: number;
  cluster_count: number;
  safe_applied: number;
  pending_safe_decisions: number;
  review_skipped: number;
  created_count: number;
  updated_count: number;
  deleted_count: number;
  parse_failures: number;
};

/** 记忆整理终态。本次整理的最后一条事件。 */
export type MemoryOrganizeEndedEvent = {
  type: "memory_organize_ended";
  run_id: string;
  /** scheduled 的终态才推进下次运行时间(设置归前端所有)。 */
  trigger: MemoryOrganizeTrigger;
  status: "succeeded" | "failed" | "skipped";
  /**
   * 结构化终态成因。前端应据此 + outcome 里的计数自行组句;final_summary 只是
   * 尚未适配的前端的兜底文案,新代码不要解析它。
   */
  summary_kind?: MemoryOrganizeSummaryKind;
  /** 组句所需的计数,与 summary_kind 配套。 */
  outcome?: MemoryOrganizeOutcome;
  /** 展示文案(遗留)。文案不属于协议,适配完成后删。 */
  final_summary?: string;
  error_message?: string;
};

/** 定时任务(Auto Prompt)开始执行。 */
export type CronPromptStartedEvent = {
  type: "cron_prompt_started";
  execution_id: string;
  task_id: string;
  task_name: string;
};

/**
 * 定时任务终态。运行记录本身由 Rust 的 automation store 持有,这里只通知
 * 「跑完了」——UI 据此刷新运行历史,不必轮询。
 */
export type CronPromptEndedEvent = {
  type: "cron_prompt_ended";
  execution_id: string;
  task_id: string;
  task_name: string;
  success: boolean;
  duration_ms: number;
  /** 成功时是结论正文,失败时是错误信息。 */
  output: string;
};

/**
 * Skills 目录变更(agent 经 SkillsManager 安装/创建/删除)。skills 是全局资源,
 * 不属于任何会话;前端据此强制刷新 skills 发现缓存与列表,不必轮询。
 */
export type SkillsChangedEvent = {
  type: "skills_changed";
  action: "install" | "create" | "delete";
  /** 受影响的 skill 名称。当前前端整体重扫,names 仅供日志与定点优化。 */
  names: string[];
};

export type WireEvent =
  | TokenDeltaEvent
  | ThinkingDeltaEvent
  | RoundMetaEvent
  | ToolCallEvent
  | ToolResultEvent
  | HostedSearchEvent
  | ToolStatusChangeEvent
  | UserMessageEvent
  | ConversationTitleEvent
  | CompactionCheckpointEvent
  | CompactionStatusEvent
  | HookWarningEvent
  | ErrorEvent
  | RunEndedEvent
  | MemoryOrganizeProgressEvent
  | MemoryOrganizeEndedEvent
  | CronPromptStartedEvent
  | CronPromptEndedEvent
  | SkillsChangedEvent;

export type WireEventName = WireEvent["type"];
