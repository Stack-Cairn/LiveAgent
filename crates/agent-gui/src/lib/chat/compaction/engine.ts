import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { ProviderId } from "../../settings";
import {
  applyCompactionCheckpoint,
  type CompactionCheckpointStats,
  type ConversationViewState,
  getActiveSegment,
  INTERNAL_RESUME_MESSAGE_TEXT,
} from "../conversation/conversationState";
import { buildCompactionPayload, fitCompactionPayloadToBudget } from "./payload";
import { type CompleteAssistantFn, summarizeConversation } from "./summarizer";
import { COMPACTION_PROMPT_VERSION } from "./summaryPrompt";
import type { CompactionIntent, ProviderRuntimeConfig } from "./types";

export type CompactionCheckpointMessage = AssistantMessage & {
  promptVersion: string;
  compactionStats: CompactionCheckpointStats;
};

export type CompactionOutcome = {
  state: ConversationViewState;
  checkpointMessage: CompactionCheckpointMessage;
  newSegmentIndex: number;
};

export function createSyntheticContinueUserMessage(
  timestamp = Date.now(),
): UserMessage & { id: string } {
  return {
    role: "user",
    id: `user-${createUuid()}`,
    // 必须与 conversationState 的常量逐字节一致：normalizeSegment 依赖它过滤持久化。
    content: INTERNAL_RESUME_MESSAGE_TEXT,
    timestamp,
  };
}

function buildCheckpointMessage(params: {
  summaryText: string;
  providerId: ProviderId;
  model: string;
  responseId?: string;
  timestamp: number;
  conversationTokens: number;
  summarizerUsage: { inputTokens?: number; outputTokens?: number };
}): CompactionCheckpointMessage {
  return {
    role: "assistant",
    api: "liveagent-compaction",
    provider: params.providerId,
    model: params.model,
    promptVersion: COMPACTION_PROMPT_VERSION,
    content: [{ type: "text", text: params.summaryText }],
    stopReason: "stop",
    timestamp: params.timestamp,
    responseId: params.responseId || `liveagent-compaction-${params.timestamp}-${createUuid()}`,
    // checkpoint 消息自身的 usage 恒为零：summarizer 请求的真实用量走 compactionStats，
    // 绝不冒充会话上下文规模（旧实现的 usage 污染即源于此）。
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    compactionStats: {
      conversationTokens: params.conversationTokens,
      summarizer: params.summarizerUsage,
    },
  } as CompactionCheckpointMessage;
}

/**
 * 执行一次完整压缩：payload 构建 → 预算裁剪 → 摘要（含恢复）→ 校验 →
 * 零 usage checkpoint 消息 → 追加新 segment。无决策、无状态标记、无持久化——
 * 那些属于 controller。
 */
export async function runCompaction(params: {
  state: ConversationViewState;
  incomingUserText?: string;
  intent: CompactionIntent;
  contextTokens: number;
  threshold: number;
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  complete?: CompleteAssistantFn;
}): Promise<CompactionOutcome> {
  const payload = fitCompactionPayloadToBudget({
    payload: buildCompactionPayload({
      state: params.state,
      incomingUserText: params.incomingUserText,
      intent: params.intent,
      contextTokens: params.contextTokens,
      threshold: params.threshold,
    }),
    modelConfig: params.runtime.modelConfig,
    debugLogger: params.debugLogger,
  });

  const summary = await summarizeConversation({
    providerId: params.providerId,
    model: params.model,
    runtime: params.runtime,
    payload,
    signal: params.signal,
    debugLogger: params.debugLogger,
    complete: params.complete,
  });

  const checkpointMessage = buildCheckpointMessage({
    summaryText: summary.summaryText,
    providerId: params.providerId,
    model: params.model,
    responseId: summary.responseId,
    timestamp: summary.timestamp,
    conversationTokens: params.contextTokens,
    summarizerUsage: summary.summarizerUsage,
  });

  const nextState = applyCompactionCheckpoint(params.state, checkpointMessage);
  if (nextState === params.state) {
    throw new Error("compaction checkpoint was not applied to the conversation state");
  }

  params.debugLogger?.logResult({
    event: "compaction_applied",
    intent: params.intent,
    contextTokens: params.contextTokens,
    threshold: params.threshold,
    newSegmentIndex: getActiveSegment(nextState)?.segmentIndex ?? nextState.meta.activeSegmentIndex,
    summaryChars: summary.summaryText.length,
  });

  return {
    state: nextState,
    checkpointMessage,
    newSegmentIndex: getActiveSegment(nextState)?.segmentIndex ?? nextState.meta.activeSegmentIndex,
  };
}
