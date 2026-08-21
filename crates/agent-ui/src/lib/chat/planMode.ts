// Plan Mode 的共享纯逻辑：工具名、计划审批的类型与容错解析。
// 该共享模块必须保持零依赖纯数据逻辑（对标 askUserQuestion.ts）。

export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

/** 计划 markdown 的长度上限；超出部分截断（防御模型异常输出撑爆持久化）。 */
export const EXIT_PLAN_MODE_PLAN_MAX_LENGTH = 64_000;

/** 拒绝计划时用户反馈的最大长度；超出部分截断。 */
export const EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH = 4_000;

/**
 * 桌面端在网关上报的工具参数上附带的待决/已批准标记（`__` 前缀合成参数，
 * 不入展示、不影响执行）；WebUI 卡片据此渲染批准按钮/落定态。
 */
export const EXIT_PLAN_MODE_PENDING_ARG = "__exitPlanModePending";
export const EXIT_PLAN_MODE_APPROVED_ARG = "__exitPlanModeApproved";

export function readPlanPendingMarker(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)[EXIT_PLAN_MODE_PENDING_ARG] === true;
}

export function readPlanApprovedMarker(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)[EXIT_PLAN_MODE_APPROVED_ARG] === true;
}

/** approve：批准计划并开始执行；reject：反馈作为普通消息发回，模型修订后重提。 */
export type PlanDecision = "approve" | "reject";

export type PlanDecisionAnswer = {
  decision: PlanDecision;
  /** 拒绝时的修改意见；作为普通用户消息发送给模型。 */
  feedback?: string;
};

export type ExitPlanModeResultDetails = {
  kind: "exit_plan_mode";
  plan: string;
  decision?: PlanDecision;
  feedback?: string;
  cancelled?: boolean;
  /** 应答窗口超时、按“不批准”落定时为 true。 */
  timedOut?: boolean;
};

/** 提取并截断计划 markdown；非字符串/空白返回空串（调用方按参数错误处理）。 */
export function sanitizePlanMarkdown(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > EXIT_PLAN_MODE_PLAN_MAX_LENGTH
    ? trimmed.slice(0, EXIT_PLAN_MODE_PLAN_MAX_LENGTH)
    : trimmed;
}

/** 归一化一次计划审批应答；非法输入返回 null（远端通道的原始 JSON 不可信）。 */
export function resolvePlanDecisionAnswer(raw: unknown): PlanDecisionAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.decision !== "approve" && obj.decision !== "reject") return null;
  const feedbackRaw = typeof obj.feedback === "string" ? obj.feedback.trim() : "";
  const feedback =
    feedbackRaw.length > EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH
      ? feedbackRaw.slice(0, EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH)
      : feedbackRaw;
  return {
    decision: obj.decision,
    ...(feedback ? { feedback } : {}),
  };
}

/** 解析 ExitPlanMode 工具结果的 details；历史/降级数据非法时返回 null。 */
export function parseExitPlanModeResultDetails(value: unknown): ExitPlanModeResultDetails | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.kind !== "exit_plan_mode" || typeof obj.plan !== "string") return null;
  return {
    kind: "exit_plan_mode",
    plan: obj.plan,
    ...(obj.decision === "approve" || obj.decision === "reject" ? { decision: obj.decision } : {}),
    ...(typeof obj.feedback === "string" && obj.feedback ? { feedback: obj.feedback } : {}),
    ...(obj.cancelled === true ? { cancelled: true } : {}),
    ...(obj.timedOut === true ? { timedOut: true } : {}),
  };
}
