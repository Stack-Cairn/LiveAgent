// Plan Mode 桌面端权威实现:ExitPlanMode 工具 + 计划审批挂起表。
// 与 AskUserQuestion / 工具审批同构的挂起/落定/超时/中止模型
// (见 askUserQuestionTools.ts / toolApproval.ts),差异有三:
//   1. 超时缺省为"未批准"(计划批准是执行闸门,绝不能默认放行,与工具审批同取向)。
//   2. 批准触发 onPlanApproved 回调(宿主关闭 plan 开关并入队"开始执行"续轮),
//      并标记该调用已获批——runner 的工具级终止谓词据此直接结束本轮 run,
//      不再跑"收尾话"模型轮;续轮由队列 drain 在 run 结束后自动发送。
//   3. 拒绝不结束等待链路:模型收到反馈后继续留在 plan mode 完善计划。
// 远端(WebUI)应答经 gateway chat_queue.plan_decision 转发到桌面后走同一入口
// answerPlanDecision。

import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  EXIT_PLAN_MODE_TIMEOUT_MS,
  EXIT_PLAN_MODE_TOOL_NAME,
  type ExitPlanModeResultDetails,
  type PlanDecisionAnswer,
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

type PlanDecisionSettlement =
  | { kind: "decided"; answer: PlanDecisionAnswer }
  | { kind: "timeout" }
  | { kind: "cancelled" };

type PendingPlanDecision = {
  conversationId: string;
  plan: string;
  /** 权威应答截止时间戳(毫秒);卡片倒计时与超时兜底同源。 */
  deadlineAt: number;
  settle: (settlement: PlanDecisionSettlement) => void;
};

// 全局 pending 表(toolCallId 全局唯一):本地卡片直接应答,WebUI 应答经
// gateway chat_queue.plan_decision 转发到桌面端后走同一入口。
const pendingByToolCallId = new Map<string, PendingPlanDecision>();

// 网关工具参数上报先于 execute 挂起:deadline 在首次上报时预置,execute 复用
// 同一值,保证 WebUI 卡片倒计时与桌面权威计时对齐(机制同 askUserQuestionTools)。
const presetDeadlineByToolCallId = new Map<string, number>();

function sweepStalePresetDeadlines(now: number) {
  for (const [toolCallId, deadlineAt] of presetDeadlineByToolCallId) {
    if (deadlineAt + 60_000 < now) {
      presetDeadlineByToolCallId.delete(toolCallId);
    }
  }
}

/** 网关侧上报工具参数时取(必要时预置)应答截止时间;挂起后与工具内计时同源。 */
export function ensureExitPlanModeDeadlineAt(toolCallId: string): number {
  const trimmed = toolCallId.trim();
  const pending = pendingByToolCallId.get(trimmed);
  if (pending) return pending.deadlineAt;
  const now = Date.now();
  sweepStalePresetDeadlines(now);
  const preset = presetDeadlineByToolCallId.get(trimmed);
  if (preset !== undefined) return preset;
  const deadlineAt = now + EXIT_PLAN_MODE_TIMEOUT_MS;
  presetDeadlineByToolCallId.set(trimmed, deadlineAt);
  return deadlineAt;
}

/** GUI 卡片读取权威截止时间;无挂起且无预置(已落定/历史数据)时返回 null。 */
export function getExitPlanModeDeadlineAt(toolCallId: string): number | null {
  const trimmed = toolCallId.trim();
  return (
    pendingByToolCallId.get(trimmed)?.deadlineAt ?? presetDeadlineByToolCallId.get(trimmed) ?? null
  );
}

export type AnswerPlanDecisionOutcome = { ok: boolean; message?: string };

/** 应答一个挂起的计划审批;远端通道必须带 conversationId 防串会话应答。 */
export function answerPlanDecision(
  toolCallId: string,
  rawAnswer: unknown,
  options?: { conversationId?: string },
): AnswerPlanDecisionOutcome {
  const pending = pendingByToolCallId.get(toolCallId.trim());
  if (!pending) {
    return { ok: false, message: "Plan is not pending (already decided or cancelled)." };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, message: "Plan belongs to a different conversation." };
  }
  const answer = resolvePlanDecisionAnswer(rawAnswer);
  if (!answer) {
    return { ok: false, message: 'Decision must be "approve" or "reject".' };
  }
  pending.settle({ kind: "decided", answer });
  return { ok: true };
}

export function hasPendingPlanDecision(toolCallId: string) {
  return pendingByToolCallId.has(toolCallId.trim());
}

/** 某会话当前挂起的计划审批(至多一个;ExitPlanMode 串行执行)。
 *  发送入口据此把"计划挂起时输入的消息"直接作为退回意见落到计划卡,
 *  而不是让它排进队列干等。 */
export function getPendingPlanDecisionToolCallId(conversationId: string): string | null {
  const target = conversationId.trim();
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === target) return toolCallId;
  }
  return null;
}

// 本会话进程内已获批准的 ExitPlanMode 调用:runner 的工具级终止谓词据此在
// 批准后直接结束本轮 run(不再跑"收尾话"模型轮——批准事实由卡片展示,执行由
// 续轮承接)。只存内存,随进程生命周期;会话销毁时随 cancel 清理。
const approvedToolCallIds = new Set<string>();

/** 该 ExitPlanMode 调用是否已获批准(runner 终止谓词用)。 */
export function isPlanApprovalToolCall(toolCallId: string): boolean {
  return approvedToolCallIds.has(toolCallId.trim());
}

/** 会话销毁兜底:挂起中的审批按"取消(未批准)"落定(正常路径由 AbortSignal 取消)。 */
export function cancelPendingPlanDecisionsForConversation(conversationId: string) {
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === conversationId) {
      pendingByToolCallId.delete(toolCallId);
      approvedToolCallIds.delete(toolCallId);
      pending.settle({ kind: "cancelled" });
    }
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
    `- When the plan is ready, call ${EXIT_PLAN_MODE_TOOL_NAME} with the complete plan (markdown) and wait for the user's decision.`,
    "- If the user rejects the plan, revise it per their feedback and submit again.",
    "- Approval ends this turn immediately; execution starts automatically in the next turn with full tools — begin that turn by turning the plan into a task list (TaskCreate), then implement.",
    "- Keep the plan concrete: files to touch, ordered steps, risks, and how to verify.",
    `- The plan lives in the ${EXIT_PLAN_MODE_TOOL_NAME} card. Do NOT offer to save it as a file (plan.md etc.) or ask where to store it — writing files is impossible here and unnecessary.`,
    "</plan-mode>",
  ].join("\n");
}

const EXIT_PLAN_MODE_TIMEOUT_MINUTES = Math.round(EXIT_PLAN_MODE_TIMEOUT_MS / 60_000);

const EXIT_PLAN_MODE_TOOL_DESCRIPTION = `Present your implementation plan to the user for approval and wait for their decision. Only available in plan mode; call it once your research is complete and the plan is ready for review.

The plan renders as an interactive card; execution pauses until the user approves or rejects. If the user does not decide within ${EXIT_PLAN_MODE_TIMEOUT_MINUTES} minutes, the plan counts as NOT approved and you stay in plan mode.

Rules:
- \`plan\` must be the complete, self-contained plan in markdown — goals, files to change, ordered steps, risks, and verification. Do not reference earlier messages ("as discussed above").
- On approval: this turn ends immediately; execution continues automatically in the next turn with full tools.
- On rejection: the user's feedback comes back as the tool result. Stay in plan mode, revise, and call ${EXIT_PLAN_MODE_TOOL_NAME} again.`;

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

export function createExitPlanModeTools(params: {
  conversationId: string;
  /** 计划获批时同步触发:宿主据此关闭 plan 开关并入队"开始执行"续轮。 */
  onPlanApproved?: (input: { plan: string }) => void;
  /** 应答窗口毫秒数;仅测试注入,生产始终用默认值。 */
  timeoutMs?: number;
}): BuiltinToolBundle {
  const timeoutMs = params.timeoutMs ?? EXIT_PLAN_MODE_TIMEOUT_MS;
  const toolExitPlanMode: Tool = {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: EXIT_PLAN_MODE_TOOL_DESCRIPTION,
    parameters: exitPlanModeParameters,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    if (toolCall.name !== EXIT_PLAN_MODE_TOOL_NAME) {
      return buildErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    if (signal?.aborted) {
      return buildErrorResult(toolCall, "Cancelled");
    }
    const plan = sanitizePlanMarkdown((toolCall.arguments || {}).plan);
    if (!plan) {
      return buildErrorResult(
        toolCall,
        "plan is required: pass the complete implementation plan in markdown.",
      );
    }

    // 挂起等待用户在计划卡片里作出决定;停止按钮(AbortSignal)以"未决定"落定,
    // 超过应答窗口按"未批准"落定(留在 plan mode)。deadline 优先复用网关参数
    // 上报时的预置值(WebUI 倒计时与之同源);测试注入 timeoutMs 时忽略预置。
    const presetDeadlineAt = presetDeadlineByToolCallId.get(toolCall.id);
    presetDeadlineByToolCallId.delete(toolCall.id);
    const deadlineAt =
      params.timeoutMs !== undefined || presetDeadlineAt === undefined
        ? Date.now() + timeoutMs
        : presetDeadlineAt;
    const settlement = await new Promise<PlanDecisionSettlement>((resolve) => {
      const settle = (value: PlanDecisionSettlement) => {
        pendingByToolCallId.delete(toolCall.id);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timeoutId);
        resolve(value);
      };
      const onAbort = () => settle({ kind: "cancelled" });
      const timeoutId = setTimeout(
        () => settle({ kind: "timeout" }),
        Math.max(0, deadlineAt - Date.now()),
      );
      pendingByToolCallId.set(toolCall.id, {
        conversationId: params.conversationId,
        plan,
        deadlineAt,
        settle,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    if (settlement.kind === "cancelled") {
      const details: ExitPlanModeResultDetails = {
        kind: "exit_plan_mode",
        plan,
        cancelled: true,
      };
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: "The user stopped the turn before deciding on the plan. Do not assume approval.",
          },
        ],
        details,
        isError: true,
        timestamp: Date.now(),
      };
    }

    if (settlement.kind === "timeout") {
      const details: ExitPlanModeResultDetails = {
        kind: "exit_plan_mode",
        plan,
        timedOut: true,
      };
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: "No decision arrived within the approval window; the plan counts as NOT approved. Stay in plan mode — you may refine the plan or ask the user how to proceed.",
          },
        ],
        details,
        isError: false,
        timestamp: Date.now(),
      };
    }

    const { answer } = settlement;
    if (answer.decision === "approve") {
      // 标记获批:runner 的终止谓词读到后直接结束本轮 run,跳过收尾模型轮。
      approvedToolCallIds.add(toolCall.id);
      // 同步触发回调:宿主关闭 plan 开关并入队续轮。回调异常绝不能污染工具
      // 结果——计划批准的事实已经落定,续轮入队失败由宿主自行提示。
      try {
        params.onPlanApproved?.({ plan });
      } catch (error) {
        console.warn("onPlanApproved callback failed", error);
      }
      const details: ExitPlanModeResultDetails = {
        kind: "exit_plan_mode",
        plan,
        decision: "approve",
        ...(answer.feedback ? { feedback: answer.feedback } : {}),
      };
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: [
              "The user APPROVED the plan. This turn ends here; execution starts automatically in the next turn with full tools.",
              ...(answer.feedback ? [`User note: ${answer.feedback}`] : []),
            ].join("\n"),
          },
        ],
        details,
        isError: false,
        timestamp: Date.now(),
      };
    }

    const details: ExitPlanModeResultDetails = {
      kind: "exit_plan_mode",
      plan,
      decision: "reject",
      ...(answer.feedback ? { feedback: answer.feedback } : {}),
    };
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: "text",
          text: [
            "The user REJECTED the plan and asked for changes.",
            ...(answer.feedback ? [`Feedback:\n${answer.feedback}`] : []),
            `Stay in plan mode: revise the plan based on this feedback and call ${EXIT_PLAN_MODE_TOOL_NAME} again when ready.`,
          ].join("\n"),
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
          // 只读:工具本身不产生任何副作用(仅挂起等待决定),计划卡片即审批门,
          // 不应再叠一层工具审批;也因此天然通过 plan mode 的只读过滤。
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
