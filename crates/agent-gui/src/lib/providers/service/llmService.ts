import type { AssistantMessageEventStream } from "@liveagent/app/lib/agentTypes";
import { createKBrainClient } from "../../kbrain/client";
import { contextToKBrainMessages } from "../../kbrain/turn";
import { getProviderRuntimeBackend } from "../runtime/providerRuntimeConfig";
import type { LlmStreamRequest } from "./types";

function createStream(request: LlmStreamRequest): AssistantMessageEventStream {
  const events: Array<import("@liveagent/app/lib/agentTypes").AssistantMessageEvent> = [];
  let resultPromise: Promise<Awaited<ReturnType<typeof generate>>>;

  async function generate() {
    if (getProviderRuntimeBackend() !== "kbrain") {
      throw new Error("K-brain backend is required for model generation");
    }
    const provider = request.model.provider.trim();
    const model = request.model.id.trim();
    if (!provider || !model) throw new Error("K-brain model identity is incomplete");
    const response = await createKBrainClient().generateText(
      {
        model: { provider, model },
        messages: contextToKBrainMessages(request.context),
      },
      request.options.signal,
    );
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: response.text }],
      timestamp: Date.now(),
      api: "kbrain" as const,
      provider: response.model.provider,
      model: response.model.model,
      stopReason: "stop" as const,
      usage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
        cacheRead: response.usage?.cached_tokens ?? 0,
        cacheWrite: response.usage?.cache_write_tokens ?? 0,
        totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    events.push(
      { type: "start", partial: assistant },
      { type: "text_start", contentIndex: 0, partial: assistant },
      { type: "text_delta", contentIndex: 0, partial: assistant, delta: response.text },
      { type: "text_end", contentIndex: 0, partial: assistant, content: response.text },
      { type: "done", reason: "stop", message: assistant },
    );
    return assistant;
  }

  resultPromise = generate();
  return {
    async *[Symbol.asyncIterator]() {
      const result = await resultPromise;
      for (const event of events) yield event;
      return result;
    },
    result: () => resultPromise,
  };
}

export function llmStream(request: LlmStreamRequest): AssistantMessageEventStream {
  return createStream(request);
}

export function setLlmServiceDevModeForTest(_value: boolean | undefined): void {
  // Retained for callers that control the old service seam; K-brain has no mutable payload seam.
}

export const llm = {
  stream: llmStream,
};
