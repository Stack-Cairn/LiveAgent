import type { ToolCall } from "@liveagent/app/lib/agentTypes";

import {
  ASK_USER_QUESTION_DEADLINE_ARG,
  ASK_USER_QUESTION_PENDING_ARG,
  ASK_USER_QUESTION_TOOL_NAME,
  readAskUserQuestionDeadlineAt,
} from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  EXIT_PLAN_MODE_APPROVED_ARG,
  EXIT_PLAN_MODE_PENDING_ARG,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@liveagent/ui/lib/chat/planMode";
import {
  clampApprovalRules,
  clampApprovalText,
  TOOL_APPROVAL_ALLOW_SESSION_ARG,
  TOOL_APPROVAL_DEADLINE_ARG,
  TOOL_APPROVAL_DEFAULT_SCOPE_ARG,
  TOOL_APPROVAL_NOTICE_ARG,
  TOOL_APPROVAL_PENDING_ARG,
  TOOL_APPROVAL_PREVIEW_ARG,
  TOOL_APPROVAL_REMEMBER_RULES_ARG,
  TOOL_APPROVAL_SESSION_SCOPE_ARG,
  TOOL_APPROVAL_SESSION_WIDE_ARG,
  TOOL_APPROVAL_SUMMARY_ARG,
  TOOL_APPROVAL_SYNTHETIC_ARG_KEYS,
  TOOL_PERMISSION_AUTO_RESOLVED_ARG,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";
import {
  countTextLines,
  FILE_TOOL_TEXT_FIELDS,
  LIVE_TOOL_PREVIEW_META_KEY,
  type PreviewFieldMetrics,
  type StreamPreviewMeta,
} from "@liveagent/ui/lib/chat/toolPreview";
import { summarizeToolCall } from "../../../lib/chat/messages/uiMessages";
import {
  ensureAskUserQuestionDeadlineAt,
  hasPendingAskUserQuestion,
} from "../../../lib/tools/askUserQuestionTools";
import { mcpElicitationArgsOverlay } from "../../../lib/tools/mcpElicitations";
import { getPermissionAutoResolved } from "../../../lib/tools/permissionAutoResolved";
import { isPlanApprovalToolCall, isPlanDecisionPending } from "../../../lib/tools/planModeTools";
import { getPendingToolApproval } from "../../../lib/tools/toolApproval";

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
    // 浏览器审批摘要必须按 action 精确取对应参数,不能取"第一个非空字段":
    // 模型可能同时传入与本 action 无关的字段(如 eval 带 url),那会把无害目标
    // 顶到摘要里、掩盖真实执行内容。type 的输入文本与 eval 的表达式属于
    // 高危信息,完整展示(审批栏 pre-wrap,超长由末尾统一截断兜底)。
    const pick = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const action = args.action;
    let target: string | undefined;
    if (action === "navigate") {
      target = pick(args.url);
    } else if (action === "click") {
      target = pick(args.ref);
    } else if (action === "type") {
      const typed = typeof args.text === "string" ? args.text : "";
      target = [
        pick(args.ref),
        `text: ${JSON.stringify(typed)}`,
        args.submit === true ? "+Enter" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    } else if (action === "eval") {
      target = typeof args.expression === "string" ? args.expression.trim() : undefined;
    } else if (action === "wait") {
      target =
        pick(args.selector) ?? (typeof args.timeMs === "number" ? `${args.timeMs}ms` : undefined);
    }
    text = [action, target].filter(Boolean).join(" ");
  } else {
    text = summarizeToolCall(toolCall as ToolCall, {
      includeName: false,
      includeManagerAction: false,
    })
      .replace(/\s+/g, " ")
      .trim();
  }
  return clampApprovalSummary(text);
}

// 同步给 WebUI 的审批摘要统一限长:K-brain 的 AI 审查会把完整工具参数放进
// command,登记摘要也可能很大,审批开始/落定各重推一次,不能不设上限。
function clampApprovalSummary(text: string): string {
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

/**
 * Approval markers come only from the desktop's own store: the same keys in the model's
 * arguments are dropped before anything is synced, or a model could fake the WebUI
 * approval card. Every tool_call sent to the Gateway goes through this.
 */
export function withoutApprovalSyntheticArgs(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args || {}).filter(([key]) => !TOOL_APPROVAL_SYNTHETIC_ARG_KEYS.includes(key)),
  );
}

// The canonical producer of streaming tool previews: bridge events
// (tool_call / tool_call_delta / tool_result) and runtime snapshot entries
// all pass through here, so every remote representation of a file tool's
// args carries the same truncated text + true metrics + monotonic progress.
export function buildGatewayToolCallPreviewArguments(
  toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
) {
  // MCP elicitation forms of the call, from the desktop's pending store only (the same
  // keys in the model's arguments were just dropped).
  const sourceArgs = {
    ...withoutApprovalSyntheticArgs(toolCall.arguments),
    ...(toolCall.id ? mcpElicitationArgsOverlay(toolCall.id) : {}),
  };
  // 待审批标记:任意工具在 beforeToolCall 处挂起等待批准时,盖到同步给 WebUI 的
  // 参数上,让远端渲染审批卡片并显示与桌面同源的倒计时。审批消解后重发的快照
  // 不再带此标记,卡片随之隐藏。__ 前缀合成参数不入展示、不影响本地执行。
  // 授权范围随标记同步,远端审批栏与桌面一致地说明"允许"的效果、决定是否提供
  // "本会话始终允许";摘要优先用审批登记的文本(K-brain 下含 AI 审查说明)。
  // K-brain 审批不设截止时间(deadlineAt 为 null),不发截止标记,远端也不显示倒计时;
  // 有可记住的规则时带上规则与默认作用域,远端审批栏据此提供"允许并记住"。
  // 后端没有询问就放行的调用(permission.auto_resolved)带上来源标记。
  const pending = toolCall.id ? getPendingToolApproval(toolCall.id) : null;
  const autoResolved = toolCall.id ? getPermissionAutoResolved(toolCall.id) : null;
  const approvalOverlay: Record<string, unknown> | null = pending
    ? {
        [TOOL_APPROVAL_PENDING_ARG]: true,
        ...(pending.deadlineAt === null
          ? {}
          : { [TOOL_APPROVAL_DEADLINE_ARG]: pending.deadlineAt }),
        [TOOL_APPROVAL_SUMMARY_ARG]: pending.summary
          ? clampApprovalSummary(pending.summary)
          : summarizeToolCallForApproval(toolCall),
        [TOOL_APPROVAL_ALLOW_SESSION_ARG]: pending.allowSession,
        [TOOL_APPROVAL_SESSION_WIDE_ARG]: pending.sessionWide,
        ...(pending.sessionScope
          ? {
              [TOOL_APPROVAL_SESSION_SCOPE_ARG]: clampApprovalText(
                pending.sessionScope,
                TOOL_APPROVAL_SUMMARY_MAX_CHARS,
              ),
            }
          : {}),
        ...(pending.rememberRules.length > 0
          ? {
              [TOOL_APPROVAL_REMEMBER_RULES_ARG]: clampApprovalRules(
                pending.rememberRules,
                TOOL_APPROVAL_SUMMARY_MAX_CHARS,
              ),
              [TOOL_APPROVAL_DEFAULT_SCOPE_ARG]: pending.defaultScope,
            }
          : {}),
        ...(pending.preview ? { [TOOL_APPROVAL_PREVIEW_ARG]: pending.preview } : {}),
        ...(pending.notice
          ? {
              [TOOL_APPROVAL_NOTICE_ARG]: clampApprovalText(
                pending.notice,
                TOOL_APPROVAL_SUMMARY_MAX_CHARS,
              ),
            }
          : {}),
        ...(autoResolved ? { [TOOL_PERMISSION_AUTO_RESOLVED_ARG]: autoResolved } : {}),
      }
    : autoResolved
      ? { [TOOL_PERMISSION_AUTO_RESOLVED_ARG]: autoResolved }
      : null;
  // AskUserQuestion：附带权威应答截止时间，WebUI 卡片倒计时与桌面计时同源
  //（execute 挂起时复用同一预置值；见 askUserQuestionTools），以及提问是否已
  // 登记——之前卡片不可作答。K-brain 的 AI 审查判定需人工确认时，提问也会先
  // 进审批门，所以同样叠加 approvalOverlay。
  // K-brain 的提问请求自带截止时间，未登记时也优先用它，不另行预置。
  if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) {
    const pending = hasPendingAskUserQuestion(toolCall.id);
    return {
      ...sourceArgs,
      ...(approvalOverlay ?? {}),
      [ASK_USER_QUESTION_DEADLINE_ARG]:
        (pending ? null : readAskUserQuestionDeadlineAt(sourceArgs)) ??
        ensureAskUserQuestionDeadlineAt(toolCall.id),
      [ASK_USER_QUESTION_PENDING_ARG]: pending,
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
