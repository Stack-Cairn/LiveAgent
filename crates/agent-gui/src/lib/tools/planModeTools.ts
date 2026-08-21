// Plan Mode 桌面端权威实现:ExitPlanMode 工具 + 待决计划登记。
//
// 交互范式(对话式,对齐 Codex plan mode——无挂起等待):
//   1. 模型调用 ExitPlanMode(plan) → 工具立即返回并登记"待决计划",runner 的
//      终止谓词使本轮 run 就地结束——没有转圈等待,没有审批超时。
//   2. 用户以消息回复:纯批准短语("同意/开始/ok"等,见 isPlanApprovalMessage)
//      或点卡片按钮 → 宿主批准 handler(关 plan 开关 + 直发执行续轮);
//      其他任何消息 = 修改意见,作为普通用户消息发送,模型在 plan mode 修订
//      计划后重新提交(新提交覆盖旧登记)。
//   3. "保存计划到文件"等诉求同样走对话:模型把保存步骤写进计划,执行轮落盘。
// 远端(WebUI)按钮经 gateway chat_queue.plan_decision 转发到桌面后走同一入口
// answerPlanDecision(approve → 宿主批准 handler;reject → 反馈作为消息发送)。

import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  type ExitPlanModeResultDetails,
  resolvePlanDecisionAnswer,
  sanitizePlanMarkdown,
} from "@liveagent/ui/lib/chat/planMode";
import { Type } from "typebox";
import { AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../subagents/types";
import {
  type BuiltinToolBundle,
  type BuiltinToolMetadata,
  createBuiltinMetadataMap,
} from "./builtinTypes";

type PendingPlan = {
  conversationId: string;
  toolCallId: string;
  plan: string;
};

// 每会话至多一个待决计划(新提交覆盖旧的——旧计划随之失效)。
const pendingPlanByConversation = new Map<string, PendingPlan>();
// 已获批准的 ExitPlanMode 调用(卡片落定态展示用;随会话销毁清理)。
const approvedToolCallIds = new Set<string>();

// useSyncExternalStore 订阅:登记/批准/覆盖时通知,驱动计划卡按钮态刷新。
const listeners = new Set<() => void>();
let version = 0;
function emitChange() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribePlanDecisions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPlanDecisionVersion(): number {
  return version;
}

/** 该 ExitPlanMode 调用当前是否待决(卡片据此启用批准按钮)。 */
export function isPlanDecisionPending(toolCallId: string): boolean {
  const trimmed = toolCallId.trim();
  for (const pending of pendingPlanByConversation.values()) {
    if (pending.toolCallId === trimmed) return true;
  }
  return false;
}

/** 该 ExitPlanMode 调用是否已获批准(卡片落定态)。 */
export function isPlanApprovalToolCall(toolCallId: string): boolean {
  return approvedToolCallIds.has(toolCallId.trim());
}

/** 某会话当前的待决计划;无则 null。 */
export function getPendingPlanForConversation(
  conversationId: string,
): { toolCallId: string; plan: string } | null {
  const pending = pendingPlanByConversation.get(conversationId.trim());
  return pending ? { toolCallId: pending.toolCallId, plan: pending.plan } : null;
}

/**
 * 纯批准短语判定:整条输入(去空白/尾部标点后)是常见的"同意"表达才算批准。
 * 带任何附加内容("同意,但把第二步改一下")都不算——那是修改意见,应发给模型。
 */
const PLAN_APPROVAL_PHRASES = new Set([
  "同意",
  "批准",
  "可以",
  "好",
  "好的",
  "行",
  "开始",
  "开始吧",
  "开始执行",
  "执行",
  "执行吧",
  "开干",
  "干吧",
  "去吧",
  "没问题",
  "ok",
  "okay",
  "yes",
  "yep",
  "y",
  "go",
  "go ahead",
  "do it",
  "proceed",
  "approve",
  "approved",
  "lgtm",
]);

export function isPlanApprovalMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s。．.,，!！~～…]+$/u, "");
  return normalized.length > 0 && PLAN_APPROVAL_PHRASES.has(normalized);
}

/** 宿主批准/退回动作(ChatPage 注册):批准 = 关 plan 开关 + 直发执行续轮;
 *  退回 = 把反馈作为普通用户消息发送。模块级单例,模式同 WebUI 的 bridge。 */
export type PlanDecisionHandlers = {
  onApprove: (input: { conversationId: string; plan: string }) => void;
  onReject: (input: { conversationId: string; feedback: string }) => void;
};

let decisionHandlers: PlanDecisionHandlers | null = null;

export function registerPlanDecisionHandlers(next: PlanDecisionHandlers | null) {
  decisionHandlers = next;
}

export type AnswerPlanDecisionOutcome = { ok: boolean; message?: string };

/**
 * 应答某调用的待决计划(卡片按钮/批准短语/WebUI plan_decision 共用入口)。
 * approve → 宿主批准 handler;reject → 反馈经宿主作为消息发送(缺反馈则拒)。
 * 远端通道必须带 conversationId 防串会话应答。
 */
export function answerPlanDecision(
  toolCallId: string,
  rawAnswer: unknown,
  options?: { conversationId?: string },
): AnswerPlanDecisionOutcome {
  const trimmed = toolCallId.trim();
  let pending: PendingPlan | null = null;
  for (const candidate of pendingPlanByConversation.values()) {
    if (candidate.toolCallId === trimmed) {
      pending = candidate;
      break;
    }
  }
  if (!pending) {
    return { ok: false, message: "Plan is not pending (already decided or superseded)." };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, message: "Plan belongs to a different conversation." };
  }
  const answer = resolvePlanDecisionAnswer(rawAnswer);
  if (!answer) {
    return { ok: false, message: 'Decision must be "approve" or "reject".' };
  }
  if (!decisionHandlers) {
    return { ok: false, message: "Plan decision handlers are not ready." };
  }
  if (answer.decision === "approve") {
    pendingPlanByConversation.delete(pending.conversationId);
    approvedToolCallIds.add(pending.toolCallId);
    emitChange();
    try {
      decisionHandlers.onApprove({ conversationId: pending.conversationId, plan: pending.plan });
    } catch (error) {
      console.warn("plan approve handler failed", error);
    }
    return { ok: true };
  }
  const feedback = answer.feedback?.trim() ?? "";
  if (!feedback) {
    return {
      ok: false,
      message: "Rejection needs feedback — just type your changes as a message.",
    };
  }
  // 反馈发出后旧计划即失效(模型将修订并重新提交,新提交重新登记)。
  pendingPlanByConversation.delete(pending.conversationId);
  emitChange();
  try {
    decisionHandlers.onReject({ conversationId: pending.conversationId, feedback });
  } catch (error) {
    console.warn("plan reject handler failed", error);
  }
  return { ok: true };
}

/** 会话销毁/放弃计划模式的兜底清理。 */
export function cancelPendingPlanDecisionsForConversation(conversationId: string) {
  const target = conversationId.trim();
  const pending = pendingPlanByConversation.get(target);
  if (pending) {
    pendingPlanByConversation.delete(target);
    approvedToolCallIds.delete(pending.toolCallId);
    emitChange();
  }
}

/**
 * Plan mode 的工具白名单谓词:只读工具放行,另放行计划提交与只读子代理协作。
 * Agent 工具在 plan mode 下由 parseSubagentBatch 强制 readonly(validate.ts),
 * SendMessage 只写会话内消息总线,不触及工作区。其余(Bash/Write/MCP/管理器
 * 写操作…)一律不进模型工具表——比"deny 再拦"更省 token,也绝无泄漏面。
 */
export function isPlanModeAllowedTool(
  toolName: string,
  metadata: BuiltinToolMetadata | undefined,
): boolean {
  if (metadata?.isReadOnly) return true;
  return (
    toolName === EXIT_PLAN_MODE_TOOL_NAME ||
    toolName === AGENT_TOOL_NAME ||
    toolName === SEND_MESSAGE_TOOL_NAME
  );
}

/** Plan mode 的 system prompt 段;run 内恒定文本,冻结注入以保护前缀缓存。 */
export function buildPlanModeSystemPromptSection(): string {
  return [
    "<plan-mode>",
    "Plan mode is ACTIVE. This is a read-only planning phase:",
    "- Research the task with the available read-only tools (and readonly subagents), then design an implementation plan.",
    "- Mutation is impossible this turn: write-capable tools are not in your tool list. Do not promise edits you cannot make here.",
    `- When the plan is ready, call ${EXIT_PLAN_MODE_TOOL_NAME} with the complete plan (markdown). Submitting ends this turn immediately — the user replies with approval or feedback as a normal message.`,
    "- If the user replies with feedback instead of approval, revise the plan accordingly and submit again.",
    "- If the user asks to save the plan to a file, make writing that file the first step of the plan itself — the execution turn (full tools) will do it.",
    "- On approval, execution starts automatically in the next turn with full tools — begin that turn by turning the plan into a task list (TaskCreate), then implement.",
    "- Keep the plan concrete: files to touch, ordered steps, risks, and how to verify.",
    "</plan-mode>",
  ].join("\n");
}

const EXIT_PLAN_MODE_TOOL_DESCRIPTION = `Present your implementation plan to the user. Only available in plan mode; call it once your research is complete and the plan is ready for review.

Submitting the plan ends this turn immediately. The user then replies as a normal message: approval starts execution automatically in the next turn (full tools); anything else is feedback — revise the plan and submit again.

Rules:
- \`plan\` must be the complete, self-contained plan in markdown — goals, files to change, ordered steps, risks, and verification. Do not reference earlier messages ("as discussed above").
- If the user asked to save the plan to a file, include that write as the first step of the plan.`;

const exitPlanModeParameters = Type.Object({
  plan: Type.String({
    description:
      "The complete implementation plan in markdown: goals, files to change, ordered steps, risks, verification.",
  }),
});

function buildErrorResult(toolCall: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

export function createExitPlanModeTools(params: { conversationId: string }): BuiltinToolBundle {
  const toolExitPlanMode: Tool = {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: EXIT_PLAN_MODE_TOOL_DESCRIPTION,
    parameters: exitPlanModeParameters,
  };

  async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
    if (toolCall.name !== EXIT_PLAN_MODE_TOOL_NAME) {
      return buildErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    const plan = sanitizePlanMarkdown(toolCall.arguments?.plan);
    if (!plan) {
      return buildErrorResult(
        toolCall,
        "plan is required: pass the complete implementation plan in markdown.",
      );
    }

    // 登记待决计划并立即返回——runner 的终止谓词随后结束本轮 run。
    // 新提交覆盖同会话旧登记(修订后的计划取代旧版)。
    pendingPlanByConversation.set(params.conversationId, {
      conversationId: params.conversationId,
      toolCallId: toolCall.id,
      plan,
    });
    emitChange();

    const details: ExitPlanModeResultDetails = {
      kind: "exit_plan_mode",
      plan,
    };
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: "text",
          text: "Plan submitted; this turn ends here. The user will reply with approval or feedback.",
        },
      ],
      details,
      isError: false,
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "system",
    tools: [toolExitPlanMode],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        EXIT_PLAN_MODE_TOOL_NAME,
        {
          groupId: "system",
          kind: "exit_plan_mode",
          // 只读:仅登记待决计划,不触碰任何外部状态;计划卡即审批面,不叠工具审批。
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
