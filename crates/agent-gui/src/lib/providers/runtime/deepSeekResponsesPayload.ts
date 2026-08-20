import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ProviderId } from "../../settings";
import { DEEPSEEK_RESPONSES_API, type DeepSeekAssistantMessage } from "../deepSeekNative";
import { isRecord } from "./common";
import type { StreamOptionsEx } from "./types";

const DEEPSEEK_UNSUPPORTED_RESPONSES_FIELDS = [
  "previous_response_id",
  "conversation",
  "store",
  "background",
  "metadata",
  "include",
  "prompt",
  "truncation",
  "service_tier",
  "safety_identifier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
  "context_management",
  "stream_options",
] as const;

function responseOutput(message: DeepSeekAssistantMessage) {
  if (
    message.provider !== "deepseek" ||
    message.api !== DEEPSEEK_RESPONSES_API ||
    !Array.isArray(message.deepSeekResponseState?.output)
  ) {
    return undefined;
  }
  const output = message.deepSeekResponseState.output.filter(isRecord);
  return output.some((item) => item.type === "web_search_call") ? output : undefined;
}

function transformedAssistantItemCount(message: DeepSeekAssistantMessage, model: Model<Api>) {
  const isSameModel =
    message.provider === model.provider && message.api === model.api && message.model === model.id;
  let count = 0;
  for (const block of message.content) {
    if (block.type === "text" || block.type === "toolCall") {
      count += 1;
      continue;
    }
    if (block.type !== "thinking") continue;
    if (isSameModel) {
      if (block.thinkingSignature) count += 1;
    } else if (!block.redacted && block.thinking.trim()) {
      count += 1;
    }
  }
  return count;
}

function collectFunctionCallIdMappings(
  generatedItems: unknown[],
  originalOutput: Record<string, unknown>[],
  mappings: Map<string, string>,
) {
  const generatedCalls = generatedItems.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === "function_call",
  );
  const originalCalls = originalOutput.filter((item) => item.type === "function_call");
  for (let index = 0; index < Math.min(generatedCalls.length, originalCalls.length); index += 1) {
    const generatedId = generatedCalls[index]?.call_id;
    const originalId = originalCalls[index]?.call_id;
    if (typeof generatedId === "string" && typeof originalId === "string") {
      mappings.set(generatedId, originalId);
    }
  }
}

function replayDeepSeekResponseOutput(
  payload: Record<string, unknown>,
  context: Context | undefined,
  model: Model<Api> | undefined,
) {
  if (!Array.isArray(payload.input) || !context || !model) return payload;

  const input = [...payload.input];
  const functionCallIdMappings = new Map<string, string>();
  let cursor = context.systemPrompt ? 1 : 0;
  let pendingToolCallIds: string[] = [];
  let existingToolResultIds = new Set<string>();

  const flushSyntheticToolResults = () => {
    for (const toolCallId of pendingToolCallIds) {
      if (!existingToolResultIds.has(toolCallId)) cursor += 1;
    }
    pendingToolCallIds = [];
    existingToolResultIds = new Set();
  };

  for (const message of context.messages) {
    if (message.role === "user") {
      flushSyntheticToolResults();
      if (typeof message.content === "string" || message.content.length > 0) cursor += 1;
      continue;
    }
    if (message.role === "toolResult") {
      existingToolResultIds.add(message.toolCallId);
      cursor += 1;
      continue;
    }
    flushSyntheticToolResults();
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;

    const assistant = message as DeepSeekAssistantMessage;
    const generatedCount = transformedAssistantItemCount(assistant, model);
    const originalOutput = responseOutput(assistant);
    pendingToolCallIds = assistant.content.flatMap((block) =>
      block.type === "toolCall" ? [block.id] : [],
    );
    if (!originalOutput) {
      cursor += generatedCount;
      continue;
    }

    const generatedItems = input.slice(cursor, cursor + generatedCount);
    collectFunctionCallIdMappings(generatedItems, originalOutput, functionCallIdMappings);
    input.splice(cursor, generatedCount, ...originalOutput);
    cursor += originalOutput.length;
  }
  flushSyntheticToolResults();

  const remappedInput = input.map((item) => {
    if (!isRecord(item) || item.type !== "function_call_output") return item;
    const mappedId =
      typeof item.call_id === "string" ? functionCallIdMappings.get(item.call_id) : undefined;
    return mappedId ? { ...item, call_id: mappedId } : item;
  });
  return { ...payload, input: remappedInput };
}

export function normalizeDeepSeekResponsesPayload(
  payload: unknown,
  context?: Context,
  model?: Model<Api>,
): unknown {
  if (!isRecord(payload)) return payload;
  const next: Record<string, unknown> = { ...payload };
  for (const field of DEEPSEEK_UNSUPPORTED_RESPONSES_FIELDS) delete next[field];

  if (isRecord(next.reasoning)) {
    const effort = next.reasoning.effort;
    if (typeof effort === "string" && effort) {
      next.reasoning = { effort };
    } else {
      delete next.reasoning;
    }
  }
  return replayDeepSeekResponseOutput(next, context, model);
}

export function attachDeepSeekResponsesPayloadCompat(
  options: StreamOptionsEx,
  params: {
    providerId: ProviderId;
    model?: Model<Api>;
    context?: Context;
  },
): StreamOptionsEx {
  if (params.providerId !== "deepseek" || params.model?.api !== DEEPSEEK_RESPONSES_API) {
    return options;
  }
  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) nextPayload = overridden;
      }
      return normalizeDeepSeekResponsesPayload(nextPayload, params.context, params.model);
    },
  };
}
