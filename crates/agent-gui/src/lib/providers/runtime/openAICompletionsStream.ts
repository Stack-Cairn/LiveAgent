import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

// 措辞必须命中 pi-ai `isRetryableAssistantError` 的 `provider.?returned.?error`
// 模式：空响应是典型的上游瞬时抖动，应当由 withStreamRetry 重试掉，而不是直接
// 把一轮打死。改这句文案前先跑 utils/retry.ts 的模式表。
const EMPTY_RESPONSE_ERROR =
  "Provider returned error: the response contained no content (empty response)";

function hasUsableAssistantContent(message: AssistantMessage): boolean {
  const hasToolCall = message.content.some(
    (block) => block.type === "toolCall" && Boolean(block.id && block.name),
  );
  const hasText = message.content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
  // 思考块也算"上游确实产出了内容"。推理模型可能把 max_tokens 全烧在
  // reasoning 上、只留思考不留正文（pi-ai 的 supportsThinkingTokenBudget 就是
  // 为此而设）——那是预算问题，不是空响应，重试只会再烧一遍推理预算。
  const hasThinking = message.content.some(
    (block) => block.type === "thinking" && block.thinking.trim().length > 0,
  );
  return hasToolCall || hasText || hasThinking;
}

/**
 * 只有"正常终止但一个字都没吐"才算空响应。
 *
 * - `length`：截断是真实终止语义，下游截断工具调用链路要读它，不能改写。
 * - `aborted`：用户主动停止，改写会把取消伪装成上游故障（streamRetry 专门
 *   保住的那条语义）。
 * - `error`：上游已经给出真实错误，保留原文比换成"空响应"更有信息量。
 */
function shouldRejectAsEmptyResponse(message: AssistantMessage): boolean {
  if (message.stopReason === "length" || message.stopReason === "aborted") return false;
  if (message.stopReason === "error") return false;
  return !hasUsableAssistantContent(message);
}

function buildEmptyResponseError(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    stopReason: "error",
    errorMessage: EMPTY_RESPONSE_ERROR,
  };
}

export function rejectEmptyOpenAICompletionsResponse(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of source) {
      if (event.type === "done" && shouldRejectAsEmptyResponse(event.message)) {
        const error = buildEmptyResponseError(event.message);
        output.push({ type: "error", reason: "error", error });
        return;
      }

      output.push(event);
      if (event.type === "done" || event.type === "error") return;
    }

    const result = await source.result();
    if (shouldRejectAsEmptyResponse(result)) {
      const error = buildEmptyResponseError(result);
      output.push({ type: "error", reason: "error", error });
      return;
    }
    output.end(result);
  })();

  return output;
}
