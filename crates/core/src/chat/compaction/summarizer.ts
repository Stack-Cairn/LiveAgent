import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

import type { StreamDebugLogger } from "../../debug/agentDebug";
import { assistantMessageToText, completeAssistantMessage } from "../../providers/llm";
import type { ProviderId } from "../../settings";
import {
  COMPACTION_PAYLOAD_TOKEN_CAP,
  type CompactionPayload,
  estimateCompactionPayloadTokens,
  shrinkCompactionPayload,
  stringifyCompactionPayload,
} from "./payload";
import { detectCompactionSummaryLanguage } from "./summaryLanguage";
import { buildCompactionSystemPrompt, buildRepairPromptText } from "./summaryPrompt";
import { estimateTextTokens } from "./tokenLedger";
import type { ProviderRuntimeConfig } from "./types";
import { buildVerificationSignals, validateCompactionSummary } from "./validate";

export type CompleteAssistantFn = typeof completeAssistantMessage;

export type SummarizeConversationResult = {
  summaryText: string;
  responseId?: string;
  timestamp: number;
  summarizerUsage: { inputTokens?: number; outputTokens?: number };
  payloadTokens: number;
};

export function createCompactionAbortError() {
  const error = new Error("compaction aborted");
  error.name = "AbortError";
  return error;
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (signal?.aborted) throw createCompactionAbortError();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createCompactionAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getRetryDelayMs(attempt: number) {
  return Math.min(1_500, 400 * 2 ** Math.max(0, attempt));
}

function isOverflowError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /context|token|too long|maximum context|input.*too large|overflow/i.test(message);
}

function isNonRetryableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unauthorized|authentication|invalid api key|quota|rate limit|insufficient|forbidden/i.test(
    message,
  );
}

function isTransientError(error: unknown) {
  if (isNonRetryableError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|network|socket|econn|5\d\d|temporar/i.test(message);
}

function buildSummarizerRuntime(providerId: ProviderId, runtime: ProviderRuntimeConfig) {
  // Codex 用 medium 档做摘要，避免长思考挤占摘要预算；不能用 minimal——
  // GPT-5.6 世代已砍掉该档且 pi-ai 目录未标 null，clamp 不会兜底，API 会直接 400。
  return providerId === "codex" ? { ...runtime, reasoning: "medium" as const } : runtime;
}

type SummarizerRequest = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  payload: CompactionPayload;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  complete: CompleteAssistantFn;
  repair?: { invalidOutput: string; validationError: string };
};

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function requestSummary(params: SummarizerRequest): Promise<AssistantMessage> {
  const serializedPayload = stringifyCompactionPayload(params.payload);
  const summaryLanguage = detectCompactionSummaryLanguage(params.payload);
  params.debugLogger?.logResult({
    event: "compaction_payload_prepared",
    payloadChars: serializedPayload.length,
    payloadTokens: estimateTextTokens(serializedPayload),
    hardCapTokens: COMPACTION_PAYLOAD_TOKEN_CAP,
    messageCount: params.payload.active_segment_messages.length,
    summaryLanguage: summaryLanguage ?? "english-default",
    repair: Boolean(params.repair),
  });

  const messages: Context["messages"] = [
    { role: "user", content: serializedPayload, timestamp: Date.now() },
  ];
  if (params.repair) {
    messages.push(
      {
        role: "assistant",
        content: [{ type: "text", text: params.repair.invalidOutput }],
        timestamp: Date.now() + 1,
        api: "liveagent-compaction",
        provider: params.providerId,
        model: params.model,
        stopReason: "stop",
        usage: createZeroUsage(),
      } as AssistantMessage,
      {
        role: "user",
        content: buildRepairPromptText(
          params.repair.validationError,
          buildVerificationSignals(params.payload),
        ),
        timestamp: Date.now() + 2,
      },
    );
  }

  return params.complete({
    providerId: params.providerId,
    model: params.model,
    runtime: buildSummarizerRuntime(params.providerId, params.runtime),
    context: { systemPrompt: buildCompactionSystemPrompt(summaryLanguage), messages },
    cacheRetention: "none",
    signal: params.signal,
    debugLogger: params.debugLogger,
  });
}

/**
 * 摘要请求 + 恢复流水线：溢出 → 收缩 payload 重试（一次）；瞬态错误 → 退避重试
 * （一次）；校验失败 → 把无效输出回喂做一次 self-repair。所有 attempt 间检查 abort。
 */
export async function summarizeConversation(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  payload: CompactionPayload;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  complete?: CompleteAssistantFn;
}): Promise<SummarizeConversationResult> {
  const complete = params.complete ?? completeAssistantMessage;
  let payload = params.payload;
  let networkRetryUsed = false;
  let shrinkRetryUsed = false;

  const tryShrink = () => {
    if (shrinkRetryUsed) return false;
    const shrunk = shrinkCompactionPayload(payload);
    if (!shrunk) return false;
    shrinkRetryUsed = true;
    payload = shrunk;
    params.debugLogger?.logResult({
      event: "compaction_payload_shrunk",
      omittedMessageCount: shrunk.compaction_reason.omitted_message_count,
    });
    return true;
  };

  while (true) {
    let assistant: AssistantMessage;
    try {
      assistant = await requestSummary({ ...params, complete, payload });
    } catch (error) {
      if (params.signal?.aborted) throw error;
      if (isOverflowError(error) && tryShrink()) continue;
      if (!networkRetryUsed && isTransientError(error)) {
        networkRetryUsed = true;
        params.debugLogger?.logResult({
          event: "compaction_request_retry",
          reason: error instanceof Error ? error.message : String(error),
        });
        await sleepWithAbort(getRetryDelayMs(0), params.signal);
        continue;
      }
      throw error;
    }

    const payloadTokens = estimateCompactionPayloadTokens(payload);
    const finalize = (validated: AssistantMessage): SummarizeConversationResult => {
      const { summaryText } = validateCompactionSummary(
        assistantMessageToText(validated),
        payloadTokens,
        payload,
      );
      return {
        summaryText,
        responseId: validated.responseId,
        timestamp: validated.timestamp ?? Date.now(),
        summarizerUsage: {
          inputTokens: validated.usage?.input,
          outputTokens: validated.usage?.output,
        },
        payloadTokens,
      };
    };

    try {
      return finalize(assistant);
    } catch (validationError) {
      if (params.signal?.aborted) throw validationError;
      try {
        const repaired = await requestSummary({
          ...params,
          complete,
          payload,
          repair: {
            invalidOutput: assistantMessageToText(assistant).trim(),
            validationError:
              validationError instanceof Error ? validationError.message : String(validationError),
          },
        });
        return finalize(repaired);
      } catch (repairError) {
        if (params.signal?.aborted) throw repairError;
        if (isOverflowError(repairError) && tryShrink()) continue;
        throw repairError;
      }
    }
  }
}
