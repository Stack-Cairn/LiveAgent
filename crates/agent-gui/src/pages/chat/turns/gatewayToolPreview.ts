import type { ToolCall } from "@earendil-works/pi-ai";

import {
  ASK_USER_QUESTION_DEADLINE_ARG,
  ASK_USER_QUESTION_TOOL_NAME,
} from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  EXIT_PLAN_MODE_APPROVED_ARG,
  EXIT_PLAN_MODE_PENDING_ARG,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@liveagent/ui/lib/chat/planMode";
import {
  TOOL_APPROVAL_DEADLINE_ARG,
  TOOL_APPROVAL_PENDING_ARG,
  TOOL_APPROVAL_SUMMARY_ARG,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";
import {
  countTextLines,
  FILE_TOOL_TEXT_FIELDS,
  LIVE_TOOL_PREVIEW_META_KEY,
  type PreviewFieldMetrics,
  type StreamPreviewMeta,
} from "@liveagent/ui/lib/chat/toolPreview";
import { summarizeToolCall } from "../../../lib/chat/messages/uiMessages";
import { ensureAskUserQuestionDeadlineAt } from "../../../lib/tools/askUserQuestionTools";
import { isPlanApprovalToolCall, isPlanDecisionPending } from "../../../lib/tools/planModeTools";
import { getToolApprovalDeadlineAt, hasPendingToolApproval } from "../../../lib/tools/toolApproval";

const GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS = 4000;

// 审批栏摘要上限:够绝大多数命令完整展示,同时防止同步标记载荷过大;
// 极端超长时截断兜底(审批栏内命令块另有 max-height + 滚动)。
const TOOL_APPROVAL_SUMMARY_MAX_CHARS = 2000;

// 待审批工具的摘要,供审批栏统一完整展示(Bash/ManagedProcess 保留原始命令含换行,
// 其余工具复用 summarizeToolCall 的参数摘要)。仅在极端超长时截断。
export function summarizeToolCallForApproval(
  toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
): string {
  const args = toolCall.arguments || {};
  let text = "";
  if (
    (toolCall.name === "Bash" || toolCall.name === "ManagedProcess") &&
    typeof args.command === "string"
  ) {
    // 命令保留原始换行(审批栏以 pre-wrap 完整展示),不折叠空白。
    text = args.command.trim();
  } else if (toolCall.name === "Browser" && typeof args.action === "string") {
    // 浏览器操作显式标出 action 与关键目标(URL/ref/表达式),让用户在审批时
    // 一眼看到即将发生什么,尤其是 eval 这类高危 action。
    const target =
      [args.url, args.ref, args.expression, args.selector].find(
        (value) => typeof value === "string" && value.trim(),
      ) ?? "";
    text = [args.action, typeof target === "string" ? target.trim() : ""].filter(Boolean).join(" ");
  } else {
    text = summarizeToolCall(toolCall as ToolCall, {
      includeName: false,
      includeManagerAction: false,
    })
      .replace(/\s+/g, " ")
      .trim();
  }
  if (text.length > TOOL_APPROVAL_SUMMARY_MAX_CHARS) {
    return `${text.slice(0, TOOL_APPROVAL_SUMMARY_MAX_CHARS - 1)}…`;
  }
  return text;
}

function buildHeadTailPreview(input: string, maxChars = GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS) {
  if (input.length <= maxChars) {
    return {
      text: input,
      metrics: {
        chars: input.length,
        lines: countTextLines(input),
        truncated: false,
      } satisfies PreviewFieldMetrics,
    };
  }

  const omittedChars = Math.max(0, input.length - maxChars);
  const marker = `\n...[truncated ${omittedChars} chars]...\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const headChars = Math.max(0, Math.floor(budget * 0.68));
  const tailChars = Math.max(0, budget - headChars);
  const text =
    budget > 0
      ? `${input.slice(0, headChars)}${marker}${tailChars > 0 ? input.slice(-tailChars) : ""}`
      : input.slice(0, maxChars);

  return {
    text,
    metrics: {
      chars: input.length,
      lines: countTextLines(input),
      truncated: true,
    } satisfies PreviewFieldMetrics,
  };
}

// The canonical producer of streaming tool previews: bridge events
// (tool_call / tool_call_delta / tool_result) and runtime snapshot entries
// all pass through here, so every remote representation of a file tool's
// args carries the same truncated text + true metrics + monotonic progress.
export function buildGatewayToolCallPreviewArguments(
  toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
) {
  const sourceArgs = toolCall.arguments || {};
  // 待审批标记:任意工具在 beforeToolCall 处挂起等待批准时,盖到同步给 WebUI 的
  // 参数上,让远端渲染审批卡片并显示与桌面同源的倒计时。审批消解后重发的快照
  // 不再带此标记,卡片随之隐藏。__ 前缀合成参数不入展示、不影响本地执行。
  const approvalOverlay: Record<string, unknown> | null =
    toolCall.id && hasPendingToolApproval(toolCall.id)
      ? {
          [TOOL_APPROVAL_PENDING_ARG]: true,
          [TOOL_APPROVAL_DEADLINE_ARG]: getToolApprovalDeadlineAt(toolCall.id) ?? undefined,
          [TOOL_APPROVAL_SUMMARY_ARG]: summarizeToolCallForApproval(toolCall),
        }
      : null;
  // AskUserQuestion：附带权威应答截止时间，WebUI 卡片倒计时与桌面计时同源
  //（execute 挂起时复用同一预置值；见 askUserQuestionTools）。ask 工具只读、
  // 永不进入审批门,故此处无需叠加 approvalOverlay。
  if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) {
    return {
      ...sourceArgs,
      [ASK_USER_QUESTION_DEADLINE_ARG]: ensureAskUserQuestionDeadlineAt(toolCall.id),
    };
  }
  // ExitPlanMode：附带待决/已批准标记(桌面登记表权威),WebUI 卡片据此渲染
  // 批准按钮与落定态;快照/事件每次经此重建,状态翻转随补发事件同步。
  if (toolCall.name === EXIT_PLAN_MODE_TOOL_NAME) {
    return {
      ...sourceArgs,
      [EXIT_PLAN_MODE_PENDING_ARG]: isPlanDecisionPending(toolCall.id),
      [EXIT_PLAN_MODE_APPROVED_ARG]: isPlanApprovalToolCall(toolCall.id),
    };
  }
  const fieldsToPreview = FILE_TOOL_TEXT_FIELDS[toolCall.name];
  if (!fieldsToPreview) {
    return approvalOverlay ? { ...sourceArgs, ...approvalOverlay } : sourceArgs;
  }

  const args: Record<string, unknown> = { ...sourceArgs, ...(approvalOverlay ?? {}) };
  const fields: Record<string, PreviewFieldMetrics> = {};
  let progress = 0;

  for (const field of fieldsToPreview) {
    const value = args[field];
    if (typeof value !== "string") continue;
    const preview = buildHeadTailPreview(value);
    args[field] = preview.text;
    fields[field] = preview.metrics;
    progress += preview.metrics.chars;
  }

  if (Object.keys(fields).length > 0) {
    args[LIVE_TOOL_PREVIEW_META_KEY] = { v: 2, progress, fields } satisfies StreamPreviewMeta;
  }

  return args;
}
