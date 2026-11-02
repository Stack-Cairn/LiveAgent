// 回答分享：把一条助手回答（可选带上对应的提问）整理成可分享的 Markdown 文本，
// 以及生成保存时的默认文件名。图片格式由 AssistantReplyShareDialog 渲染后截图。

export type ReplyShareScope = "answer" | "conversation";
export type ReplyShareFormat = "text" | "image";

export type ReplyShareSource = {
  reply: string;
  prompt?: string;
  timestamp?: number;
};

export type ReplyShareLabels = {
  prompt: string;
  answer: string;
};

// 没有提问（旧历史、首条就是助手消息）时只能分享回答本身。
export function resolveReplyShareScope(
  scope: ReplyShareScope,
  source: ReplyShareSource,
): ReplyShareScope {
  return scope === "conversation" && source.prompt?.trim() ? "conversation" : "answer";
}

// 提问逐行加引用前缀，保证多段提问在 Markdown 里仍是一个整体，不会和回答混在一起。
function quoteMarkdown(text: string) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

export function buildReplyShareText(
  source: ReplyShareSource,
  scope: ReplyShareScope,
  labels: ReplyShareLabels,
) {
  const reply = source.reply.trim();
  if (resolveReplyShareScope(scope, source) === "answer") return reply;
  const prompt = source.prompt?.trim() ?? "";
  return `**${labels.prompt}**\n\n${quoteMarkdown(prompt)}\n\n**${labels.answer}**\n\n${reply}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

// liveagent-reply-20261004-1203.png；时间取回答时间，没有就用当前时间。
export function buildReplyShareFileName(format: ReplyShareFormat, timestamp?: number) {
  const date = new Date(timestamp && Number.isFinite(timestamp) ? timestamp : Date.now());
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `liveagent-reply-${stamp}.${format === "image" ? "png" : "md"}`;
}

const BASE64_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function textToBase64(text: string) {
  return bytesToBase64(new TextEncoder().encode(text));
}
