import type { ComposerTurnCommand } from "@liveagent/ui/lib/chat/composerCommands";
import type { ChatRuntimeControls } from "@/lib/settings";
import type { SendChatFn } from "./types";

/**
 * WebUI 的“/”指令发送一轮：把指令语义映射成聊天请求字段。发送没有被接受
 * （会话已有待确认的请求、没有连接或请求失败）时抛错，输入框据此保留草稿并
 * 显示原因，而不是静默吞掉指令。
 *
 * 会话在跑时直接报忙、不发送，与桌面端一致：否则网关按 queuePolicy "auto"
 * 把指令排进等待队列，上一轮一结束（包括出错结束）就自动执行。
 */
export async function sendComposerCommandTurn(
  sendChat: SendChatFn,
  t: (key: string) => string,
  text: string,
  command: ComposerTurnCommand | undefined,
  options: {
    conversationId?: string;
    runtimeControls?: ChatRuntimeControls;
    isBusy: () => boolean;
  },
) {
  if (options.isBusy()) throw new Error(t("chat.commands.busy"));
  const outcome = await sendChat(text, {
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    goalAction: command?.kind === "goal" ? command.action : undefined,
    goalText: command?.kind === "goal" && command.action === "set" ? command.goal : undefined,
    promptCommand: command?.kind === "prompt" ? true : undefined,
    planCommand: command?.kind === "plan" ? true : undefined,
    waitForStart: true,
    optimisticEcho: false,
    runtimeControls:
      command?.kind === "plan"
        ? {
            thinkingEnabled: false,
            nativeWebSearchEnabled: false,
            reasoning: "off",
            reasoningByProvider: {},
            reasoningByModel: {},
            ...options.runtimeControls,
            planModeEnabled: true,
          }
        : options.runtimeControls,
  });
  if (outcome === null) throw new Error(t("chat.commands.busy"));
  if (outcome.kind === "failed") {
    throw new Error(
      outcome.errorCode === "conversation_busy"
        ? t("chat.commands.busy")
        : outcome.message || t("chat.commands.failed"),
    );
  }
  return outcome;
}
