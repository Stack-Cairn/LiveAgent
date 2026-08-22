import { DEEPSEEK_RESPONSES_API, streamDeepSeekResponses } from "../deepSeekNative";
import { withStreamRetry } from "../runtime/streamRetry";
import type { LlmAdapter } from "./types";

/**
 * DeepSeek 原生协议适配器。
 *
 * streamByApi.ts 中 DEEPSEEK_RESPONSES_API 分支的原样搬移（PR-1 行为等价
 * 不变量）：withStreamRetry 包装位置与参数逐字保持。
 */
export const deepSeekAdapter: LlmAdapter = {
  apis: [DEEPSEEK_RESPONSES_API] as const,
  stream(model, context, options) {
    return withStreamRetry(() => streamDeepSeekResponses(model, context, options), {
      signal: options.signal,
      ...options.streamRetry,
    });
  },
};
