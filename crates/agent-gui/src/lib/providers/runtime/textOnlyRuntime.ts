import type { AssistantMessage, CacheRetention, Context, Model } from "@earendil-works/pi-ai";
import {
  appendHostedSearchBlocksToAssistant,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
  mergeHostedSearchBlocks,
} from "../../chat/messages/hostedSearch";
import { buildStreamRequestDebugPayload, type StreamDebugLogger } from "../../debug/agentDebug";
import type { ProviderId } from "../../settings";
import { withPowerActivity } from "../../system/powerActivity";
import {
  createHostedSearchEventAggregator,
  createHostedSearchProbeId,
  startHostedSearchFetchProbe,
  withHostedSearchProbeHeader,
} from "../hostedSearchEvents";
import { providerSupportsNativeWebSearch } from "../nativeWebSearch";
import { prepareProxyRequest } from "../proxy";
import { appendSystemPrompt, normalizeSessionId } from "./common";
import { normalizeErrorMessage } from "./errors";
import { createStreamingTextReconciler } from "./messageUtils";
import { createModelFromConfig } from "./modelFactory";
import { finalizeProviderStreamOptions } from "./payloadPipeline";
import {
  buildProviderAuthHeaders,
  buildProviderRequestMetadata,
  mergeCustomHeaders,
  resolveProviderCacheRetention,
  toSimpleStreamReasoning,
} from "./requestOptions";
import { streamSimpleByApi } from "./streamByApi";
import { buildTextModeToolResultsForAssistant } from "./textModeToolRecovery";
import type { ProviderRuntimeConfig, StreamOptionsEx } from "./types";

function buildTextOnlySystemSuffix(allowJsonOutput = false) {
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

function buildTextOnlyCallContext(
  context: Context,
  options?: { allowJsonOutput?: boolean },
): Context {
  return {
    ...context,
    systemPrompt: appendSystemPrompt(
      context.systemPrompt,
      buildTextOnlySystemSuffix(options?.allowJsonOutput),
    ),
  };
}

function buildTextOnlyStreamOptions(params: {
  providerId: ProviderId;
  runtime: ProviderRuntimeConfig;
  model: Model<any>;
  context?: Context;
  workdir?: string;
  headers: Record<string, string>;
  hostedSearchProbeId?: string;
  signal?: AbortSignal;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  nativeWebSearch?: boolean;
  debugLogger?: StreamDebugLogger;
}): StreamOptionsEx {
  const sessionId = normalizeSessionId(params.sessionId);
  const nativeWebSearch =
    providerSupportsNativeWebSearch(params.providerId, params.model.api, {
      baseUrl: params.runtime.baseUrl,
      modelId: params.model.id,
    }) && params.nativeWebSearch;
  const usesOpenAIChatNativeWebSearch =
    nativeWebSearch && params.providerId === "codex" && params.model.api === "openai-completions";
  const options: StreamOptionsEx = {
    apiKey: params.runtime.apiKey,
    headers: withHostedSearchProbeHeader(params.headers, params.hostedSearchProbeId),
    signal: params.signal,
    sessionId,
    cacheRetention: resolveProviderCacheRetention(
      params.providerId,
      params.runtime.promptCachingEnabled,
      params.cacheRetention,
    ),
    metadata: buildProviderRequestMetadata(params.providerId, sessionId),
    reasoning:
      (params.providerId === "codex" &&
        (params.model.api === "openai-responses" || params.model.api === "openai-completions")) ||
      (params.providerId === "claude_code" && params.model.api === "anthropic-messages") ||
      (params.providerId === "gemini" && params.model.api === "google-generative-ai")
        ? toSimpleStreamReasoning(params.runtime.reasoning)
        : undefined,
    // Text-only mode cannot execute local tools. Provider-native web search is
    // hosted by the upstream provider, so it can stay on auto when explicitly enabled.
    toolChoice: usesOpenAIChatNativeWebSearch ? undefined : nativeWebSearch ? "auto" : "none",
  };
  return finalizeProviderStreamOptions({
    providerId: params.providerId,
    baseUrl: params.runtime.baseUrl,
    options,
    context: params.context,
    model: params.model,
    workdir: params.workdir,
    nativeWebSearch: params.nativeWebSearch,
    debugLogger: params.debugLogger,
    extra: { sessionId },
  });
}

export async function streamAssistantMessage(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  workdir?: string;
  onTextDelta: (delta: string) => void;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  allowJsonOutput?: boolean;
  nativeWebSearch?: boolean;
  onHostedSearch?: (block: HostedSearchBlock) => void;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");

  const proxyRequest = await prepareProxyRequest(
    params.providerId,
    params.runtime.baseUrl.trim(),
    mergeCustomHeaders(
      buildProviderAuthHeaders(params.providerId, params.runtime.apiKey),
      params.runtime.customHeaders,
    ),
    { useSystemProxy: params.runtime.useSystemProxy === true },
  );

  const m = createModelFromConfig(
    params.providerId,
    modelId,
    proxyRequest.baseUrl,
    params.runtime.requestFormat,
    params.runtime.modelConfig,
    params.runtime.baseUrl.trim(),
  );

  const callContext = buildTextOnlyCallContext(params.context, {
    allowJsonOutput: params.allowJsonOutput,
  });
  const shouldProbeHostedSearch =
    Boolean(params.nativeWebSearch) &&
    providerSupportsNativeWebSearch(params.providerId, m.api, {
      baseUrl: params.runtime.baseUrl,
      modelId: m.id,
    });
  const hostedSearchProbeId = shouldProbeHostedSearch
    ? createHostedSearchProbeId(params.providerId)
    : undefined;
  const options = buildTextOnlyStreamOptions({
    providerId: params.providerId,
    runtime: params.runtime,
    model: m,
    context: callContext,
    workdir: params.workdir,
    headers: proxyRequest.headers,
    hostedSearchProbeId,
    signal: params.signal,
    sessionId: params.sessionId,
    cacheRetention: params.cacheRetention,
    nativeWebSearch: params.nativeWebSearch,
    debugLogger: params.debugLogger,
  });

  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context: callContext,
      options,
    }),
  );

  return withPowerActivity("assistant-stream", `${params.providerId}:${modelId}`, async () => {
    const orderedBlocks: HostedSearchOrderedBlock[] = [];
    const appendOrderedText = (delta: string) => {
      if (!delta) return;
      const last = orderedBlocks[orderedBlocks.length - 1];
      if (last?.kind === "text") {
        orderedBlocks[orderedBlocks.length - 1] = {
          kind: "text",
          text: last.text + delta,
        };
      } else {
        orderedBlocks.push({ kind: "text", text: delta });
      }
    };
    const upsertOrderedHostedSearch = (hostedSearch: HostedSearchBlock) => {
      const idx = orderedBlocks.findIndex(
        (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
      );
      if (idx >= 0) {
        const existing = orderedBlocks[idx];
        if (existing?.kind === "hostedSearch") {
          orderedBlocks[idx] = {
            kind: "hostedSearch",
            item: mergeHostedSearchBlocks(existing.item, hostedSearch),
          };
        }
        return;
      }
      orderedBlocks.push({ kind: "hostedSearch", item: hostedSearch });
    };
    const hostedSearchAggregator = createHostedSearchEventAggregator({
      providerId: params.providerId,
      onHostedSearch: (hostedSearch) => {
        upsertOrderedHostedSearch(hostedSearch);
        params.onHostedSearch?.(hostedSearch);
      },
    });
    const hostedSearchProbe = startHostedSearchFetchProbe({
      providerId: params.providerId,
      sessionId: normalizeSessionId(params.sessionId),
      requestId: hostedSearchProbeId,
      enabled: shouldProbeHostedSearch,
      onRawEvent: hostedSearchAggregator.accept,
    });
    try {
      let activeContext = callContext;
      for (let toolRecoveryTurn = 0; toolRecoveryTurn < 4; toolRecoveryTurn += 1) {
        const s = streamSimpleByApi(m, activeContext, options);
        const textReconciler = createStreamingTextReconciler();

        for await (const event of s) {
          params.debugLogger?.logResponse(event);
          if (event.type === "text_delta") {
            const delta = textReconciler.appendDelta(String(event.contentIndex), event.delta);
            if (delta) {
              appendOrderedText(delta);
              params.onTextDelta(delta);
            }
          } else if (event.type === "text_end") {
            const delta = textReconciler.reconcileFinalText(
              String(event.contentIndex),
              event.content,
            );
            if (delta) {
              appendOrderedText(delta);
              params.onTextDelta(delta);
            }
          }
        }

        let final = await s.result();
        if (final.stopReason === "error" || final.stopReason === "aborted") {
          throw new Error(
            normalizeErrorMessage(
              final.errorMessage,
              final.stopReason === "aborted" ? "Cancelled" : "Request failed",
            ),
          );
        }

        const textModeToolResults = buildTextModeToolResultsForAssistant(
          final,
          hostedSearchAggregator.getBlocks(),
        );
        if (textModeToolResults.length > 0) {
          params.debugLogger?.logResponse({
            type: "text_mode_tool_result_recovery",
            toolRecoveryTurn,
            toolResults: textModeToolResults,
          });
          activeContext = {
            ...activeContext,
            messages: [...activeContext.messages, final, ...textModeToolResults],
          };
          continue;
        }

        await hostedSearchProbe.finish();
        final = appendHostedSearchBlocksToAssistant(
          final as AssistantMessage & { content: unknown[] },
          hostedSearchAggregator.complete(),
          { orderedBlocks },
        ) as AssistantMessage;
        params.debugLogger?.logResult(final);
        await params.debugLogger?.flush();
        return final;
      }

      throw new Error("Too many text-mode tool-call recovery attempts");
    } catch (error) {
      await hostedSearchProbe.finish();
      if (params.signal?.aborted) {
        hostedSearchAggregator.dispose();
      } else {
        hostedSearchAggregator.fail();
      }
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    }
  });
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
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");

  const proxyRequest = await prepareProxyRequest(
    params.providerId,
    params.runtime.baseUrl.trim(),
    mergeCustomHeaders(
      buildProviderAuthHeaders(params.providerId, params.runtime.apiKey),
      params.runtime.customHeaders,
    ),
    { useSystemProxy: params.runtime.useSystemProxy === true },
  );

  const m = createModelFromConfig(
    params.providerId,
    modelId,
    proxyRequest.baseUrl,
    params.runtime.requestFormat,
    params.runtime.modelConfig,
    params.runtime.baseUrl.trim(),
  );

  const callContext = buildTextOnlyCallContext(params.context, {
    allowJsonOutput: params.allowJsonOutput,
  });
  const options = buildTextOnlyStreamOptions({
    providerId: params.providerId,
    runtime: params.runtime,
    model: m,
    context: callContext,
    headers: proxyRequest.headers,
    signal: params.signal,
    sessionId: params.sessionId,
    cacheRetention: params.cacheRetention,
    debugLogger: params.debugLogger,
  });

  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context: callContext,
      options,
    }),
  );

  return withPowerActivity("assistant-complete", `${params.providerId}:${modelId}`, async () => {
    try {
      const s = streamSimpleByApi(m, callContext, options);
      const final = await s.result();

      if (final.stopReason === "error" || final.stopReason === "aborted") {
        throw new Error(
          normalizeErrorMessage(
            final.errorMessage,
            final.stopReason === "aborted" ? "Cancelled" : "Request failed",
          ),
        );
      }

      params.debugLogger?.logResult(final);
      await params.debugLogger?.flush();
      return final;
    } catch (error) {
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    }
  });
}
