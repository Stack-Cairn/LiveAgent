// WebUI 端 AskUserQuestion 应答桥：卡片位于 transcript 深处，提交动作由
// GatewayApp 注册（经 gateway chat_queue.tool_answer 送达桌面端工具挂起表）。
// 模块级单例避免跨 5 层组件做 props 透传，模式同 uploadedImagePreview 缓存。
import type { AskUserQuestionAnswer } from "./askUserQuestion";

export type AskUserQuestionSubmitOutcome = { ok: boolean; message?: string };

type AskUserQuestionAnswerHandler = (
  toolCallId: string,
  answers: AskUserQuestionAnswer[],
) => Promise<AskUserQuestionSubmitOutcome>;

let handler: AskUserQuestionAnswerHandler | null = null;

export function registerAskUserQuestionAnswerHandler(next: AskUserQuestionAnswerHandler | null) {
  handler = next;
}

export function submitAskUserQuestionAnswer(
  toolCallId: string,
  answers: AskUserQuestionAnswer[],
): Promise<AskUserQuestionSubmitOutcome> {
  if (!handler) {
    return Promise.resolve({ ok: false, message: "Gateway connection is not ready." });
  }
  return handler(toolCallId, answers);
}
