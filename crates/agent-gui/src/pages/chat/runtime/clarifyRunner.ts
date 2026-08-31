import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type {
  ClarifyMessage,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { assistantMessageToText, streamAssistantMessage } from "../../../lib/providers/llm";
import type { EffectiveChatModelSelection } from "./modelSelection";

type RuntimeLike = Parameters<typeof streamAssistantMessage>[0]["runtime"];

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 澄清历史里的 assistant 消息 → pi-ai AssistantMessage。协议只关心文本；api/
 * usage 等字段是类型要求的占位（compaction summarizer 同款拼法），provider
 * 载荷装配只读取其中的 text 块。
 */
function toAssistantContextMessage(
  message: ClarifyMessage,
  timestamp: number,
  selection: EffectiveChatModelSelection,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    timestamp,
    api: "liveagent-clarify",
    provider: selection.providerId,
    model: selection.model,
    stopReason: "stop",
    usage: createZeroUsage(),
  } as AssistantMessage;
}

/**
 * 澄清消息 → pi-ai Context。pi-ai 的 Message 联合类型（user/assistant/
 * toolResult）没有 system 角色，直接塞进 messages 既过不了类型检查也会被各
 * provider 载荷装配丢弃；因此把 system 消息并入 systemPrompt，其余消息原样
 * 映射（text-only 后缀由 buildTextOnlyCallContext 统一追加）。
 */
function buildClarifyCallContext(
  messages: ClarifyMessage[],
  selection: EffectiveChatModelSelection,
): Context {
  const systemPrompts: string[] = [];
  const contextMessages: Context["messages"] = [];
  const timestamp = Date.now();
  for (const message of messages) {
    if (message.role === "system") {
      systemPrompts.push(message.content);
      continue;
    }
    contextMessages.push(
      message.role === "user"
        ? { role: "user", content: message.content, timestamp }
        : toAssistantContextMessage(message, timestamp, selection),
    );
  }
  return {
    systemPrompt: systemPrompts.length > 0 ? systemPrompts.join("\n\n") : undefined,
    messages: contextMessages,
  };
}

/**
 * 桌面宿主的澄清执行器：当前会话模型跑一次纯文本补全。模型/runtime 在每
 * 次调用时惰性解析（getter），保证澄清用的始终是面板打开当下的选择。
 */
export function createGuiClarifyRunner(
  getSelection: () => EffectiveChatModelSelection,
  getRuntime: () => RuntimeLike,
): RunClarifyTurn {
  return async (
    messages: ClarifyMessage[],
    signal: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ) => {
    const selection = getSelection();
    const assistant = await streamAssistantMessage({
      providerId: selection.providerId,
      model: selection.model,
      runtime: getRuntime(),
      signal,
      cacheRetention: "none",
      nativeWebSearch: false,
      context: buildClarifyCallContext(messages, selection),
      onTextDelta: (delta) => onTextDelta?.(delta),
    });
    return assistantMessageToText(assistant);
  };
}
