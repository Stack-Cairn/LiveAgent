// 自桌面版 lib/chat/page/chatPageHelpers.ts 摘取引擎需要的纯函数。
// 原文件其余部分(排序偏好、标题任务、pending 历史项)是页面 UI 逻辑,不随引擎迁移。

import type { Context } from "@earendil-works/pi-ai";
import { getMessageText } from "../messages/uiMessages";

const FALLBACK_TITLE_MAX_CHARS = 48;

export function buildFallbackConversationTitle(content: string) {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (!singleLine) return "新对话";
  if (singleLine.length <= FALLBACK_TITLE_MAX_CHARS) return singleLine;
  return `${singleLine.slice(0, FALLBACK_TITLE_MAX_CHARS).trimEnd()}...`;
}

export function getFirstUserMessageText(context: Context) {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    const text = getMessageText(message).trim();
    if (text) return text;
  }
  return "";
}

export function isAbortLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("已取消") || normalized.includes("abort") || normalized.includes("aborted")
  );
}
