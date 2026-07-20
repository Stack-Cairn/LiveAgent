import type { ToolCall } from "@earendil-works/pi-ai";
import type { ToolApprovalMode } from "../../settings";

export type ToolApprovalPolicy = {
  mode: ToolApprovalMode;
  workdir: string;
};

export type DangerousToolKind = "delete" | "ssh-mutation" | "external-cwd";

export type DangerousToolAssessment = {
  kind: DangerousToolKind;
  /** 展示给用户的关键参数摘要（路径 / 命令等），已截断。 */
  detail: string;
};

export type ToolApprovalRequest = {
  toolCall: ToolCall;
  assessment: DangerousToolAssessment;
  /** 运行被取消时中止等待；UI 应据此撤下确认卡片并按拒绝处理。 */
  signal?: AbortSignal;
};

export type ToolApprovalDecision = {
  approved: boolean;
};

export type RequestToolApproval = (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

const DETAIL_MAX_CHARS = 200;

// SSHManager 中会改变远端（或本地磁盘）状态的 action；只读查询不需要审批。
const DANGEROUS_SSH_ACTIONS = new Set([
  "exec",
  "send_input",
  "sftp_mkdir",
  "sftp_delete",
  "sftp_rename",
  "sftp_upload",
  "sftp_download",
  "sftp_write_text",
]);

function truncateDetail(input: string): string {
  const text = input.trim();
  if (text.length <= DETAIL_MAX_CHARS) return text;
  return `${text.slice(0, DETAIL_MAX_CHARS)}…`;
}

function argsOf(toolCall: ToolCall): Record<string, unknown> {
  return toolCall.arguments && typeof toolCall.arguments === "object"
    ? (toolCall.arguments as Record<string, unknown>)
    : {};
}

function normalizePathForComparison(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 同步的保守判定：Bash/ManagedProcess 的 cwd 是否可能落在工作区外。
 * 真正的解析在工具执行期由 ToolPathResolver 完成；这里只需要一个无 IO 的
 * 近似来决定"是否需要用户确认"，宁可多问一次也不漏过逃逸路径。
 */
export function isLikelyExternalCwd(cwd: unknown, workdir: string): boolean {
  if (typeof cwd !== "string") return false;
  const trimmed = cwd.trim();
  if (!trimmed) return false;
  // Skill 路径有独立的访问策略约束，不按外部处理。
  if (trimmed.startsWith("skill://")) return false;

  const normalized = normalizePathForComparison(trimmed);
  if (normalized.startsWith("~") || normalized.startsWith("file://")) return true;

  const isAbsolute = normalized.startsWith("/") || /^[a-z]:\//.test(normalized);
  if (isAbsolute) {
    const workdirNormalized = normalizePathForComparison(workdir);
    if (!workdirNormalized) return true;
    return !(normalized === workdirNormalized || normalized.startsWith(`${workdirNormalized}/`));
  }

  // 相对路径由解析器锚定在工作区内，但 ".." 可以向上逃逸——保守地要求确认。
  return normalized.split("/").some((segment) => segment === "..");
}

/**
 * 判定一次工具调用是否属于需要用户确认的危险操作。
 * 返回 null 表示无需确认（策略关闭或调用不危险）。
 */
export function assessDangerousToolCall(
  policy: ToolApprovalPolicy,
  toolCall: ToolCall,
): DangerousToolAssessment | null {
  if (policy.mode !== "dangerous") return null;
  const args = argsOf(toolCall);

  if (toolCall.name === "Delete") {
    return {
      kind: "delete",
      detail: truncateDetail(typeof args.path === "string" ? args.path : ""),
    };
  }

  if (toolCall.name === "SSHManager") {
    const action = typeof args.action === "string" ? args.action : "";
    if (!DANGEROUS_SSH_ACTIONS.has(action)) return null;
    const command = typeof args.command === "string" ? args.command : "";
    const input = typeof args.input === "string" ? args.input : "";
    const remotePath = typeof args.remote_path === "string" ? args.remote_path : "";
    const extra = command || input || remotePath;
    return {
      kind: "ssh-mutation",
      detail: truncateDetail(extra ? `${action}: ${extra}` : action),
    };
  }

  if (toolCall.name === "Bash" || toolCall.name === "ManagedProcess") {
    if (!isLikelyExternalCwd(args.cwd, policy.workdir)) return null;
    const command = typeof args.command === "string" ? args.command : "";
    return {
      kind: "external-cwd",
      detail: truncateDetail(`cwd=${String(args.cwd)}${command ? ` · ${command}` : ""}`),
    };
  }

  return null;
}

/** 拒绝后的教学文案：让模型改方案或询问用户，而不是原样重试。 */
export function buildApprovalDeniedText(toolCall: ToolCall, assessment: DangerousToolAssessment) {
  return (
    `The user declined this ${toolCall.name} call (${assessment.kind}: ${assessment.detail}). ` +
    "Do not retry the same call. Adjust your approach, or ask the user how they want to proceed."
  );
}

/** 无人值守会话（远程 / 子代理）里直接拒绝危险调用的说明文案。 */
export function buildUnattendedDenialText(toolCall: ToolCall, assessment: DangerousToolAssessment) {
  return (
    `${toolCall.name} was blocked by the tool approval policy (${assessment.kind}: ${assessment.detail}). ` +
    "This session has no one available to approve dangerous tool calls (remote or delegated run). " +
    "Continue without this operation, or ask the user to run it from the desktop chat / relax the approval setting."
  );
}
