// 工具审批的网关同步契约:桌面端在同步给 WebUI 的工具参数上盖“待审批 + 截止
// 时间”标记(见 gatewayToolPreview),WebUI 据此渲染审批卡片并显示倒计时。
// 这些是 __ 前缀的合成参数,不参与展示(见 toolCallArgsForDisplay 过滤),也不
// 影响本地工具执行(执行用真实 arguments,非网关预览副本)。
// 本文件在 agent-gui 与 agent-gateway/web 之间逐字节镜像。

/** 工具调用正等待用户审批(真时 WebUI 渲染审批卡片)。 */
export const TOOL_APPROVAL_PENDING_ARG = "__toolApprovalPending";
/** 权威审批截止时间戳(毫秒);WebUI 倒计时与桌面计时同源。 */
export const TOOL_APPROVAL_DEADLINE_ARG = "__toolApprovalDeadlineAt";
/** 待审批工具的命令/参数摘要(桌面端算一次同步给 WebUI,审批栏统一展示)。 */
export const TOOL_APPROVAL_SUMMARY_ARG = "__toolApprovalSummary";

/** 审批决定:allow=本次放行;deny=本次拒绝;approve_session=本对话内该工具后续免审。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export function readToolApprovalPending(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)[TOOL_APPROVAL_PENDING_ARG] === true;
}

export function readToolApprovalDeadlineAt(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[TOOL_APPROVAL_DEADLINE_ARG];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readToolApprovalSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[TOOL_APPROVAL_SUMMARY_ARG];
  return typeof value === "string" ? value : "";
}
