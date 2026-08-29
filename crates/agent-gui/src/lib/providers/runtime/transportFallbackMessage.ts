import type { StreamTransportFallbackInfo, StreamTransportFallbackReason } from "./types";

/**
 * 回退提示文案。与 gateway bridge 的其它状态提示同口径：中英双语、单条纯文本。
 *
 * 之所以按 reason 分文案而不是统一说「连接失败」：`not-eligible` 是用户改配置就能
 * 解决的问题，而 `message-too-big` / `upstream-replay-required` 改配置没有用。把两
 * 类混为一谈会让用户在设置页反复折腾一个根本不在设置里的问题。
 */
const FALLBACK_MESSAGES: Record<StreamTransportFallbackReason, string> = {
  "not-eligible":
    "当前端点或凭证不支持 WebSocket，本轮使用 SSE。\nWebSocket is unavailable for this endpoint or credential; this turn used SSE.",
  "handshake-failed":
    "WebSocket 建连失败，已回退到 SSE。\nWebSocket handshake failed; fell back to SSE.",
  "message-too-big":
    "请求体超出上游 WebSocket 单帧上限，已回退到 SSE。\nRequest exceeded the upstream WebSocket frame limit; fell back to SSE.",
  "upstream-replay-required":
    "上游要求改用 HTTP 重放本轮，已回退到 SSE。\nUpstream required an HTTP replay for this turn; fell back to SSE.",
  "stream-incomplete":
    "WebSocket 在产出内容前中断，已回退到 SSE。\nWebSocket ended before producing content; fell back to SSE.",
};

export function describeTransportFallback(info: StreamTransportFallbackInfo): string {
  return FALLBACK_MESSAGES[info.reason] ?? FALLBACK_MESSAGES["handshake-failed"];
}
