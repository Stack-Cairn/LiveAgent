// 自桌面版 lib/chat/page/chatPageHelpers.ts 摘取引擎需要的纯函数。
// 原文件其余部分(排序偏好、标题任务、pending 历史项)是页面 UI 逻辑,不随引擎迁移。

import type { Context } from "@earendil-works/pi-ai";
import { getMessageText } from "../messages/uiMessages";

const FALLBACK_TITLE_MAX_CHARS = 48;
const TITLE_MAX_LATIN_WORDS = 10;
const TITLE_MAX_CJK_CHARS = 24;
const TITLE_MAX_CHARS = 80;
// Global on purpose: only ever used with String#match below, never with #test
// (a sticky lastIndex would make alternating calls disagree).
const CJK_CHAR_PATTERN = /[぀-ヿ㐀-鿿豈-﫿]/g;

/** System prompt for the lightweight first-turn title job. */
export function buildConversationTitleSystemPrompt() {
  return "You generate concise conversation titles. Match the language of the content. Output the title only, with no extra explanation or quotes.";
}

export function buildConversationTitlePrompt(content: string) {
  return `Generate a concise title (under 10 words) for this conversation. Match the language of the content. Output only the title:\n${content}`;
}

/**
 * Shared title normalizer: also used to sanitize titles the user types in the
 * sidebar rename box, so it must never shorten a title more than the historical
 * latin word/char caps did.
 */
export function normalizeConversationTitle(raw: string) {
  const singleLine = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[`"'""‘’]+|[`"'""‘’]+$/g, "")
    .trim();

  if (!singleLine) return "";

  const words = singleLine.split(" ").filter(Boolean);
  const limitedWords =
    words.length > TITLE_MAX_LATIN_WORDS
      ? words.slice(0, TITLE_MAX_LATIN_WORDS).join(" ")
      : singleLine;
  return limitedWords.slice(0, TITLE_MAX_CHARS).trim();
}

/**
 * Normalizer for model-generated titles only. CJK titles are character-dense
 * and usually unspaced, so the latin word cap would let them run the full 80
 * chars; cap those by character count instead. Applies only when the title is
 * predominantly CJK, so a latin title containing a stray CJK token keeps the
 * word cap. Never used on user-typed renames.
 */
export function normalizeGeneratedConversationTitle(raw: string) {
  const title = normalizeConversationTitle(raw);
  if (!title) return "";

  // Code points, not UTF-16 units: slicing mid-surrogate would leave a lone
  // half that renders as U+FFFD.
  const chars = Array.from(title);
  const cjkCount = title.match(CJK_CHAR_PATTERN)?.length ?? 0;
  if (cjkCount * 2 < chars.length) return title;

  return chars.length > TITLE_MAX_CJK_CHARS
    ? chars.slice(0, TITLE_MAX_CJK_CHARS).join("").trim()
    : title;
}

export function buildFallbackConversationTitle(content: string) {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
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
