import { DEEPSEEK_RESPONSES_API, streamDeepSeekResponses } from "../deepSeekNative";
import { withAttemptSignal, withStreamRetry } from "../runtime/streamRetry";
import type { LlmAdapter } from "./types";

/**
 * DeepSeek 原生协议适配器。
 *
 * streamByApi.ts 中 DEEPSEEK_RESPONSES_API 分支的原样搬移（PR-1 行为等价
 * 不变量）：withStreamRetry 包装位置与参数逐字保持。传输层 P0 起工厂接收
 * attemptSignal（经 withAttemptSignal 注入）；未启用 watchdog 时请求选项逐字不变。
 */
export const deepSeekAdapter: LlmAdapter = {
  apis: [DEEPSEEK_RESPONSES_API] as const,
  stream(model, context, options) {
    return withStreamRetry(
      (attemptSignal) =>
        streamDeepSeekResponses(model, context, withAttemptSignal(options, attemptSignal)),
      {
        signal: options.signal,
        ...options.streamRetry,
      },
    );
  },
};
