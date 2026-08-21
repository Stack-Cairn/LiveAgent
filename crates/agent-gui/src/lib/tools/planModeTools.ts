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

import type { Message, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  type ExitPlanModeResultDetails,
  resolvePlanDecisionAnswer,
  sanitizePlanMarkdown,
} from "@liveagent/ui/lib/chat/planMode";
import { Type } from "typebox";
import type { ToolChoice } from "../providers/runtime/types";
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
// 已获批准的 ExitPlanMode 调用(卡片落定态展示用;随会话销毁清理)。批准会先清
// pending 登记,故清理不能经由 pending 反查——按会话另记一份,销毁时整组删除。
const approvedToolCallIds = new Set<string>();
const approvedToolCallIdsByConversation = new Map<string, Set<string>>();

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

export type AnswerPlanDecisionOutcome = {
  ok: boolean;
  message?: string;
  /** 失败分类:not_pending(已决定/被新提交覆盖——卡片应落定而非报错)/
   * invalid(参数或会话不符)/unavailable(宿主 handler 未就绪)。 */
  code?: "not_pending" | "invalid" | "unavailable";
};

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
    return {
      ok: false,
      code: "not_pending",
      message: "Plan is not pending (already decided or superseded).",
    };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, code: "invalid", message: "Plan belongs to a different conversation." };
  }
  const answer = resolvePlanDecisionAnswer(rawAnswer);
  if (!answer) {
    return { ok: false, code: "invalid", message: 'Decision must be "approve" or "reject".' };
  }
  if (!decisionHandlers) {
    return { ok: false, code: "unavailable", message: "Plan decision handlers are not ready." };
  }
  if (answer.decision === "approve") {
    pendingPlanByConversation.delete(pending.conversationId);
    approvedToolCallIds.add(pending.toolCallId);
    let conversationApproved = approvedToolCallIdsByConversation.get(pending.conversationId);
    if (!conversationApproved) {
      conversationApproved = new Set();
      approvedToolCallIdsByConversation.set(pending.conversationId, conversationApproved);
    }
    conversationApproved.add(pending.toolCallId);
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

/** 会话销毁/放弃计划模式的兜底清理。批准态也一并清:批准发生时 pending 已删,
 *  只按 pending 反查会让 approvedToolCallIds 随进程无限增长。 */
export function cancelPendingPlanDecisionsForConversation(conversationId: string) {
  const target = conversationId.trim();
  const pending = pendingPlanByConversation.get(target);
  const approved = approvedToolCallIdsByConversation.get(target);
  if (!pending && !approved) return;
  if (pending) {
    pendingPlanByConversation.delete(target);
    approvedToolCallIds.delete(pending.toolCallId);
  }
  if (approved) {
    approvedToolCallIdsByConversation.delete(target);
    for (const toolCallId of approved) {
      approvedToolCallIds.delete(toolCallId);
    }
  }
  emitChange();
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

/** Plan mode 的 system prompt 段;run 内恒定文本,冻结注入以保护前缀缓存。
 *  plan mode 规则的唯一权威表述——toolsSuffix 与工具 description 只作指引,
 *  不再复述,避免三处漂移与 token 浪费。措辞刻意不用"MUST before this turn
 *  ends"式高压:那会抬高提交门槛、诱导模型为求"完整"而无限调研。 */
export function buildPlanModeSystemPromptSection(): string {
  return [
    "<plan-mode>",
    "Plan mode is ACTIVE. This is a read-only planning phase:",
    "- Research with the available read-only tools (and readonly subagents). Stop researching once you can produce the deliverable — do not re-read files you have already read; a re-read returns an unchanged stub, never new information.",
    "- Mutation is impossible this turn: write-capable tools are not in your tool list. Do not promise edits you cannot make here.",
    `- Submit every complete answer through ${EXIT_PLAN_MODE_TOOL_NAME} — implementation plans, architecture summaries, research findings, Q&A, and recommendations alike — instead of plain assistant text. If no code changes are needed, the plan states that and carries the findings.`,
    "- Submitting ends this turn immediately; the user replies with approval or feedback as a normal message. On feedback, revise the plan and submit again.",
    "- If the user asks to save the plan to a file, make that write the first step of the plan itself — the execution turn (full tools) will do it.",
    "- On approval, execution starts automatically in the next turn with full tools — begin that turn by turning the plan into a task list (TaskCreate), then implement. If the plan needs no file changes, confirm that briefly and stop.",
    "- Keep implementation plans concrete: files to touch, ordered steps, risks, and how to verify.",
    "</plan-mode>",
  ].join("\n");
}

// 只述工具自身的调用契约;plan mode 的行为规则统一由 <plan-mode> system 段承载。
const EXIT_PLAN_MODE_TOOL_DESCRIPTION = `Present the complete user-facing deliverable for this turn (every finished answer, not only implementation plans). Only available in plan mode; call it once your research is complete.

Submitting ends this turn immediately. The user replies as a normal message: approval starts execution automatically in the next turn (full tools); anything else is feedback — revise the plan and submit again.

Rules:
- \`plan\` must be the complete, self-contained markdown deliverable. Do not reference earlier messages ("as discussed above").
- Implementation work: goals, files to change, ordered steps, risks, verification. Analysis/Q&A: the full findings, plus whether any follow-up code changes are needed.
- If the user asked to save the plan to a file, include that write as the first step of the plan.`;

const exitPlanModeParameters = Type.Object({
  plan: Type.String({
    description:
      "The complete user-facing deliverable in markdown. Implementation work: goals, files to change, ordered steps, risks, verification. Analysis/Q&A: the full findings, plus whether any follow-up code changes are needed.",
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
        "plan is required: pass the complete markdown deliverable.",
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

// ---------------------------------------------------------------------------
// Plan mode 运行策略:有界升级状态机。
//
// 原则:绝不无界强制。常态 toolChoice=auto,模型可自由文本收尾;终止性由四道
// **有界**防线保证:
//   1. 终止谓词 —— ExitPlanMode 提交即结束本轮 run(runner resolveToolTermination);
//   2. 轮数上限 —— 研究阶段 maxRounds 熔断,防失控循环(runner maxRounds);
//   3. 补提交轮 —— run 以文本收尾且未提交时,追加一次 wire-only 提醒消息并定向
//      强制 ExitPlanMode,只重试一次(nudging 态);
//   4. 文本兜底 —— 补提交仍未产出时,把最后的助手文本注册为待决计划(合成
//      ExitPlanMode 调用对),计划卡/审批/持久化零改动复用。
// 任何模型行为都在有限步内收敛到计划卡。
// ---------------------------------------------------------------------------

/** 研究阶段的模型轮数熔断值(含);达到后当前批执行完即优雅终止,进入补提交。 */
export const PLAN_MODE_MAX_RESEARCH_ROUNDS = 32;
/** 补提交轮的轮数上限:定向强制下 1 轮即提交,留余量兜供应商降级为 auto 的情况。 */
export const PLAN_MODE_MAX_NUDGE_ROUNDS = 4;
/** 同一 (工具名, 参数) 的重复调用放行次数;超过即拦截,引导提交计划。 */
export const PLAN_MODE_REPEAT_CALL_LIMIT = 2;

/** 补提交轮注入的 wire-only 提醒(只进出站请求,不持久化、不进 UI)。 */
export const PLAN_MODE_NUDGE_REMINDER = [
  "[plan-mode reminder] Your previous turn ended without submitting the deliverable.",
  `Call ${EXIT_PLAN_MODE_TOOL_NAME} now with the complete user-facing deliverable in markdown,`,
  "based on the research you already completed. Do not run more research tools first.",
].join(" ");

export type PlanModeRunDecision =
  | { kind: "submitted" }
  | { kind: "nudge"; reminderText: string }
  | { kind: "fallback" };

export type PlanModeFallbackPlan = {
  toolCall: ToolCall;
  toolResult: ToolResultMessage;
};

export type PlanModeRunPolicy = {
  /** ExitPlanMode 提交即终止本轮 run(交给 runner resolveToolTermination)。 */
  resolveToolTermination: (toolCall: ToolCall) => boolean;
  /** 当前 run 的 tool_choice:常态 undefined(缺省 auto);补提交轮定向强制。 */
  resolveToolChoice: () => ToolChoice | undefined;
  /** 当前 run 的轮数熔断值(交给 runner maxRounds)。 */
  maxRounds: () => number;
  /** 防空转守卫:同参重复的研究调用超过放行次数即拦截(接入 resolveToolGate)。 */
  guardRepeatedToolCall: (toolCall: ToolCall) => { allow: true } | { allow: false; reason: string };
  /** run 结束后的升级裁决:已提交 → done;首次未提交 → nudge;再次 → fallback。 */
  decideAfterRun: (input: { emittedMessages: readonly Message[] }) => PlanModeRunDecision;
  /** 文本兜底:把助手文本注册为待决计划并返回合成的 ExitPlanMode 调用对;
   *  文本经 sanitize 后为空时返回 null(此时本轮无计划,turn 正常结束)。 */
  registerFallbackPlan: (input: { planText: string }) => PlanModeFallbackPlan | null;
};

/** 递归键排序的稳定序列化:重复调用判定不受对象键序影响。模型参数来自 JSON,无环。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hasSuccessfulPlanSubmission(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
      !message.isError,
  );
}

export function createPlanModeRunPolicy(params: { conversationId: string }): PlanModeRunPolicy {
  let phase: "researching" | "nudging" = "researching";
  const repeatCounts = new Map<string, number>();

  return {
    resolveToolTermination: (toolCall) => toolCall.name === EXIT_PLAN_MODE_TOOL_NAME,

    resolveToolChoice: () =>
      // 定向强制只出现在有界的补提交轮;供应商不支持时(如 Anthropic thinking、
      // Google)由 provider 层降级为 auto,提醒消息仍然生效。
      phase === "nudging" ? { type: "tool" as const, name: EXIT_PLAN_MODE_TOOL_NAME } : undefined,

    maxRounds: () =>
      phase === "nudging" ? PLAN_MODE_MAX_NUDGE_ROUNDS : PLAN_MODE_MAX_RESEARCH_ROUNDS,

    guardRepeatedToolCall: (toolCall) => {
      if (toolCall.name === EXIT_PLAN_MODE_TOOL_NAME) return { allow: true };
      const key = `${toolCall.name}\u0000${stableStringify(toolCall.arguments ?? {})}`;
      const count = (repeatCounts.get(key) ?? 0) + 1;
      repeatCounts.set(key, count);
      if (count <= PLAN_MODE_REPEAT_CALL_LIMIT) return { allow: true };
      return {
        allow: false,
        reason:
          `You already made this exact ${toolCall.name} call in this planning turn and its result has not changed. ` +
          `Use the content you already gathered, or submit the deliverable via ${EXIT_PLAN_MODE_TOOL_NAME}.`,
      };
    },

    decideAfterRun: ({ emittedMessages }) => {
      if (hasSuccessfulPlanSubmission(emittedMessages)) {
        return { kind: "submitted" };
      }
      if (phase === "researching") {
        phase = "nudging";
        return { kind: "nudge", reminderText: PLAN_MODE_NUDGE_REMINDER };
      }
      return { kind: "fallback" };
    },

    registerFallbackPlan: ({ planText }) => {
      const plan = sanitizePlanMarkdown(planText);
      if (!plan) return null;
      const toolCallId = `call_plan_fallback_${crypto.randomUUID().replaceAll("-", "")}`;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: toolCallId,
        name: EXIT_PLAN_MODE_TOOL_NAME,
        arguments: { plan },
      };
      // 与真实 ExitPlanMode 执行完全同构:登记待决计划(覆盖旧登记)并通知订阅方,
      // 计划卡按钮态、WebUI 预览、审批入口全部零改动复用。
      pendingPlanByConversation.set(params.conversationId, {
        conversationId: params.conversationId,
        toolCallId,
        plan,
      });
      emitChange();
      const details: ExitPlanModeResultDetails = { kind: "exit_plan_mode", plan };
      return {
        toolCall,
        toolResult: {
          role: "toolResult",
          toolCallId,
          toolName: EXIT_PLAN_MODE_TOOL_NAME,
          content: [
            {
              type: "text",
              text: "Plan captured from the assistant's final text; the user will reply with approval or feedback.",
            },
          ],
          details,
          isError: false,
          timestamp: Date.now(),
        },
      };
    },
  };
}
