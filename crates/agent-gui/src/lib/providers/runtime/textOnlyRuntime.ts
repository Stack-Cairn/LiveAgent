import type { Api, AssistantMessage, Context } from "@liveagent/app/lib/agentTypes";

type CacheRetention = "none" | "short" | "long";

import { buildStreamRequestDebugPayload, type StreamDebugLogger } from "../../debug/agentDebug";
import { createKBrainClient } from "../../kbrain/client";
import type { KBrainMessage, KBrainModelRef } from "../../kbrain/types";
import type { ProviderId } from "../../settings";
import { appendSystemPrompt } from "./common";
import { getProviderRuntimeBackend } from "./providerRuntimeConfig";
import type { ProviderRuntimeConfig } from "./types";

function canonicalTextMessages(context: Context): KBrainMessage[] {
  const messages: KBrainMessage[] = [];
  if (context.systemPrompt?.trim()) {
    messages.push({ role: "system", content: [{ type: "text", text: context.systemPrompt }] });
  }
  for (const message of context.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => ({ type: "text" as const, text: part.text }));
    if (content.some((part) => part.text.trim())) messages.push({ role: message.role, content });
  }
  if (messages.length === 0) throw new Error("Text generation context is empty");
  return messages;
}

function kbrainTextModel(runtime: ProviderRuntimeConfig, model: string): KBrainModelRef {
  const provider = runtime.backendModelProvider?.trim();
  if (!provider) throw new Error("K-brain model provider is not configured");
  const modelId = model.trim();
  if (!modelId) throw new Error("No model selected");
  return { provider, model: modelId };
}

async function generateKBrainText(params: {
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  signal?: AbortSignal;
  output?: "text" | "json";
}) {
  if (params.runtime.backend !== "kbrain" && getProviderRuntimeBackend() !== "kbrain") {
    throw new Error("K-brain backend is required for text generation");
  }
  const client = createKBrainClient();
  const response = await client.generateText(
    {
      model: kbrainTextModel(params.runtime, params.model),
      messages: canonicalTextMessages(params.context),
      ...(params.output ? { output: params.output } : {}),
    },
    params.signal,
  );
  if (response.version !== "kbrain.agent.v1" || typeof response.text !== "string") {
    throw new Error("Malformed K-brain text-generation response");
  }
  return response;
}

function kbrainUsage(response: Awaited<ReturnType<typeof generateKBrainText>>) {
  const input = response.usage?.input_tokens ?? 0;
  const output = response.usage?.output_tokens ?? 0;
  const cacheRead = response.usage?.cached_tokens ?? 0;
  const cacheWrite = response.usage?.cache_write_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function buildTextOnlySystemSuffix(allowJsonOutput = false) {
  return [
    "Important Rules:",
    allowJsonOutput
      ? "- Your final user-visible output must be plain text. Markdown or valid JSON is allowed."
      : "- Your final user-visible output must be plain text. Markdown is allowed.",
    allowJsonOutput
      ? "- Do not output event streams or raw tool-call structures."
      : "- Do not output event streams, raw JSON, or raw tool-call structures.",
    "- You are currently in text-only mode: do not make any tool calls.",
  ].join("\n");
}

function buildTextOnlyCallContext(context: Context, allowJsonOutput = false): Context {
  return {
    ...context,
    systemPrompt: appendSystemPrompt(
      context.systemPrompt,
      buildTextOnlySystemSuffix(allowJsonOutput),
    ),
  };
}

function toAssistantMessage(
  response: Awaited<ReturnType<typeof generateKBrainText>>,
  runtime: ProviderRuntimeConfig,
  model: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: response.text }],
    timestamp: Date.now(),
    api: "kbrain-text" as Api,
    provider: response.model.provider || runtime.backendModelProvider || "kbrain",
    model: response.model.model || model,
    stopReason: "stop",
    usage: kbrainUsage(response),
  };
}

export async function streamAssistantMessage(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  workdir?: string;
  onTextDelta: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  allowJsonOutput?: boolean;
  nativeWebSearch?: boolean;
  onHostedSearch?: (block: never) => void;
  onRetryStatus?: (
    attempt: number,
    maxAttempts: number,
    errorMessage: string,
    plannedDelayMs?: number,
    providerLabel?: string,
  ) => void;
  onRetryRecovered?: () => void;
  onTransportAttempt?: (snapshot: { providerLabel: string }) => void;
  onRequestStart?: (info: { context: Context; systemSuffix: string }) => void;
  failover?: unknown;
}) {
  const context = buildTextOnlyCallContext(params.context, params.allowJsonOutput);
  const systemSuffix = buildTextOnlySystemSuffix(params.allowJsonOutput);
  try {
    params.onRequestStart?.({ context, systemSuffix });
  } catch (error) {
    console.warn("text-only request observer failed; continuing without diagnostics", error);
  }
  params.onTransportAttempt?.({ providerLabel: `${params.providerId} · ${params.model}` });
  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context,
      options: { model: params.model, backend: "kbrain" },
    }),
  );
  const generated = await generateKBrainText({
    model: params.model,
    runtime: params.runtime,
    context,
    signal: params.signal,
    output: params.allowJsonOutput ? "json" : "text",
  });
  if (generated.text) params.onTextDelta(generated.text);
  const assistant = toAssistantMessage(generated, params.runtime, params.model);
  params.debugLogger?.logResult(assistant);
  await params.debugLogger?.flush();
  return assistant;
}

export async function completeAssistantMessage(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  allowJsonOutput?: boolean;
}) {
  const context = buildTextOnlyCallContext(params.context, params.allowJsonOutput);
  const generated = await generateKBrainText({
    model: params.model,
    runtime: params.runtime,
    context,
    signal: params.signal,
    output: params.allowJsonOutput ? "json" : "text",
  });
  return toAssistantMessage(generated, params.runtime, params.model);
}
