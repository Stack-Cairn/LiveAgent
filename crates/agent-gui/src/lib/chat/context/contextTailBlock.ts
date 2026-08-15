import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * display-image 工具结果不能当锚点：requestContextSanitizer 会把这类消息的
 * content 整体替换为单个 text 块（见其 isDisplayImageToolResult 分支），
 * 追加在尾部的增量块会在下一次净化时被静默销毁。
 */
function isDisplayImageToolResult(message: ToolResultMessage) {
  if (message.isError) return false;
  if (message.toolName === "Image") return true;
  return isRecord(message.details) && message.details.kind === "display_image";
}

/**
 * subagent 卡片工具结果不能当锚点：净化时整条被过滤掉，挂上去的内容随之消失。
 */
function isSubagentCardToolResult(message: ToolResultMessage) {
  return isRecord(message.details) && message.details.kind === "subagent_card";
}

/**
 * 紧跟在 aborted assistant 之后的工具结果不能当锚点：
 * stripAbortedMessagesForModelContext 会连同它们一起丢弃。
 */
function followsAbortedAssistant(messages: Message[], index: number) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message.role === "toolResult") continue;
    return message.role === "assistant" && message.stopReason === "aborted";
  }
  return false;
}

/**
 * 把一段文本追加到最后一条“安全”工具结果消息的内容尾部，用于把 run 内产生的
 * 动态内容后置投递，而不去改写 systemPrompt。
 *
 * 锚点只在最后一条 user 消息之后寻找：缓存断点最多写到最后一条 user 消息，
 * 其后的工具循环消息每轮本就重读，追加不额外损失命中率；越过 user 消息则会
 * 改写已缓存前缀，比不改还糟。
 *
 * 不做原地修改——消息对象与运行时状态、会话状态共享引用。
 * 找不到安全锚点时原样返回入参数组（引用相等），调用方据此判定“本轮没挂上”，
 * 不推进游标、下一轮重试。
 */
export function appendToolResultTailBlock(messages: Message[], text: string): Message[] {
  if (!text) return messages;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    if (isDisplayImageToolResult(message)) continue;
    if (isSubagentCardToolResult(message)) continue;
    if (followsAbortedAssistant(messages, index)) continue;

    const block: TextContent = { type: "text", text };
    const next = messages.slice();
    next[index] = { ...message, content: [...message.content, block] };
    return next;
  }

  return messages;
}
