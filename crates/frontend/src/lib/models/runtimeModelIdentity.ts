import type { CodexRequestFormat, ProviderId } from "../settings";

/**
 * 落库消息需要的模型三元组（api/provider/model 字符串）。请求装配已整体归
 * crates/core：前端不再持有 pi-ai 模型目录，三元组的权威值由 core 经
 * round_meta 事件逐轮报上来（见 lib/protocol/wireEvents.ts 的 RoundMetaEvent，
 * chatAbort 落库时优先用它）。这里只提供"该轮还没有 round_meta"（如首轮即被
 * 中止）时的兜底推断——按 providerId 静态映射，不做目录回查。
 */
export type RuntimeModelIdentity = {
  api: string;
  provider: string;
  id: string;
};

export function resolveRuntimeModelIdentity(
  providerId: ProviderId,
  modelId: string,
  requestFormat?: CodexRequestFormat,
): RuntimeModelIdentity {
  if (providerId === "claude_code") {
    return { api: "anthropic-messages", provider: "anthropic", id: modelId };
  }
  if (providerId === "gemini") {
    return { api: "google-generative-ai", provider: "google", id: modelId };
  }
  // codex 默认 Responses（与 core modelFactory 的 inferCodexApi 缺省一致）；
  // xai 固定 Responses。
  return {
    api: providerId === "xai" ? "openai-responses" : (requestFormat ?? "openai-responses"),
    provider: "openai",
    id: modelId,
  };
}
