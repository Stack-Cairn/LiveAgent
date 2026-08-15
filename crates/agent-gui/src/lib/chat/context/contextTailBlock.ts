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
 * 找出可以承载尾部块的那条工具结果消息，返回它的 toolCallId。
 *
 * 锚点只在最后一条 user 消息之后寻找：缓存断点最多写到最后一条 user 消息，
 * 其后的工具循环消息每轮本就重读，追加不额外损失命中率；越过 user 消息则会
 * 改写已缓存前缀，比不改还糟。
 *
 * toolCallId 为空的消息不能当锚点：钉不住的锚点等于没有锚点，后续轮次会退化成
 * 重新搜索，正是本模块要消灭的漂移。返回 null 表示本轮没有安全锚点，调用方据此
 * 判定“挂不上”，不推进游标、下一轮重试。
 */
export function resolveTailBlockAnchorId(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    if (typeof message.toolCallId !== "string" || !message.toolCallId) continue;
    if (isDisplayImageToolResult(message)) continue;
    if (isSubagentCardToolResult(message)) continue;
    if (followsAbortedAssistant(messages, index)) continue;
    return message.toolCallId;
  }
  return null;
}

/** 一段已经投递过的尾部内容，连同它首次挂上的那条消息的 toolCallId。 */
export type PinnedTailBlock = {
  /** 首次挂上时解析到的锚点；后续轮次原样重挂到同一条消息。 */
  anchorToolCallId: string;
  text: string;
};

/**
 * 把已钉住的尾部块重挂到各自的锚点消息上。
 *
 * **锚点必须钉死，不能每轮重新搜索**：工具循环推进后“最后一条工具结果”会变，
 * 重新搜索会让块从上一轮的消息搬到新消息上——那条旧消息的字节随之变回去，
 * 前缀从它开始整段作废。这正是把内容移出 systemPrompt 想躲的问题，换个位置
 * 再犯一遍没有意义（实测：3 轮工具循环里第 2 轮起每轮都在旧消息处分叉）。
 *
 * 同一锚点上的多个块按投递顺序拼成独立 text 块，顺序固定即字节固定。
 * 锚点已不在消息列表里（压缩截断等）时，该块本轮不挂——调用方在压缩边界本就
 * 会清空累积并重新冻结，不需要在这里兜底搬家。
 *
 * 不做原地修改——消息对象与运行时状态、会话状态共享引用。
 * 一个块都没挂上时原样返回入参数组（引用相等）。
 */
export function attachPinnedTailBlocks(
  messages: Message[],
  blocks: readonly PinnedTailBlock[],
): Message[] {
  if (blocks.length === 0) return messages;

  const byAnchor = new Map<string, string[]>();
  for (const block of blocks) {
    if (!block.text) continue;
    const existing = byAnchor.get(block.anchorToolCallId);
    if (existing) existing.push(block.text);
    else byAnchor.set(block.anchorToolCallId, [block.text]);
  }
  if (byAnchor.size === 0) return messages;

  let next: Message[] | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    const texts = byAnchor.get(message.toolCallId);
    if (!texts) continue;

    const appended: TextContent[] = texts.map((text) => ({ type: "text", text }));
    if (!next) next = messages.slice();
    next[index] = { ...message, content: [...message.content, ...appended] };
  }

  return next ?? messages;
}
