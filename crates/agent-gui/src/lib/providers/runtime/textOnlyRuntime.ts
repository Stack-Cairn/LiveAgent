import type { Api, AssistantMessage, CacheRetention, Context, Model } from "@earendil-works/pi-ai";
import {
  appendHostedSearchBlocksToAssistant,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
  mergeHostedSearchBlocks,
} from "@liveagent/ui/lib/chat/hostedSearch";
import { raceWithAbort } from "../../cancellation/abortRace";
import {
  buildStreamRequestDebugPayload,
  flushDebugLoggerInBackground,
  type StreamDebugLogger,
} from "../../debug/agentDebug";
import type { ProviderId } from "../../settings";
import { withPowerActivity } from "../../system/powerActivity";
import {
  createHostedSearchEventAggregator,
  createHostedSearchProbeId,
  startHostedSearchFetchProbe,
  withHostedSearchProbeHeader,
} from "../hostedSearchEvents";
import { providerSupportsNativeWebSearch } from "../nativeWebSearch";
import { appendSystemPrompt, normalizeSessionId } from "./common";
import { normalizeErrorMessage } from "./errors";
import { createStreamingTextReconciler } from "./messageUtils";
import { createModelFromConfig } from "./modelFactory";
import { finalizeProviderStreamOptions } from "./payloadPipeline";
import {
  failoverBreakerKey,
  type ModelFailoverRuntimeConfig,
  type ProviderFailoverCandidate,
  withProviderFailover,
} from "./providerFailover";
import {
  buildProviderRequestMetadata,
  prepareProviderRequest,
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
  model: Model<Api>;
  context?: Context;
  workdir?: string;
  headers: Record<string, string>;
  hostedSearchProbeId?: string;
  signal?: AbortSignal;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  nativeWebSearch?: boolean;
  debugLogger?: StreamDebugLogger;
  onRetryStatus?: (attempt: number, maxAttempts: number, errorMessage: string) => void;
  onRetryRecovered?: () => void;
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
      params.runtime.promptCacheRetention,
    ),
    metadata: buildProviderRequestMetadata(params.providerId, sessionId),
    reasoning:
      ((params.providerId === "codex" || params.providerId === "xai") &&
        (params.model.api === "openai-responses" || params.model.api === "openai-completions")) ||
      (params.providerId === "claude_code" && params.model.api === "anthropic-messages") ||
      (params.providerId === "gemini" && params.model.api === "google-generative-ai") ||
      params.providerId === "deepseek"
        ? toSimpleStreamReasoning(params.runtime.reasoning)
        : undefined,
    deepSeekThinking:
      params.providerId === "deepseek" && params.runtime.reasoning === "off"
        ? "disabled"
        : undefined,
    workdir: params.workdir,
    // Text-only mode cannot execute local tools. Provider-native web search is
    // hosted by the upstream provider, so it can stay on auto when explicitly enabled.
    toolChoice: usesOpenAIChatNativeWebSearch ? undefined : nativeWebSearch ? "auto" : "none",
    streamRetry: {
      onRetry: params.onRetryStatus,
      onRetryRecovered: params.onRetryRecovered,
    },
  };
  return finalizeProviderStreamOptions({
    providerId: params.providerId,
    baseUrl: params.runtime.baseUrl,
    options,
    context: params.context,
    model: params.model,
    workdir: params.workdir,
    nativeWebSearch: params.nativeWebSearch,
    promptCacheHintMode:
      params.runtime.modelConfig?.promptCacheHintMode ?? params.runtime.promptCacheHintMode,
    debugLogger: params.debugLogger,
    extra: { sessionId },
  });
}

export type TextStreamFailoverTarget = {
  /** Stable identity used for breaker keys and switch callbacks. */
  selectedModel: { customProviderId: string; model: string };
  providerId: ProviderId;
  model: string;
  /** Display label, e.g. "PackyCode · claude-sonnet-4-5". */
  label: string;
  runtime: ProviderRuntimeConfig;
};

export type TextStreamFailoverParams = {
  config: ModelFailoverRuntimeConfig;
  /** Identity of the primary target described by params.providerId/model/runtime. */
  primary: { selectedModel?: { customProviderId: string; model: string }; label: string };
  /** Fallback targets in failover-queue order, primary duplicates removed. */
  fallbacks: TextStreamFailoverTarget[];
  /** Fired when an attempt commits on a different target than the previous ones. */
  onSwitched?: (event: { target: TextStreamFailoverTarget | null; errorMessage: string }) => void;
  /** Fired before each switch, including a skip of an open-breaker primary. */
  onFailover?: (event: { fromLabel: string; toLabel: string; errorMessage: string }) => void;
};

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
  onRetryStatus?: (attempt: number, maxAttempts: number, errorMessage: string) => void;
  onRetryRecovered?: () => void;
  /** Exact text-only provider boundary after its mandatory system suffix is appended. */
  onRequestStart?: (info: { context: Context; systemSuffix: string }) => void;
  failover?: TextStreamFailoverParams;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");

  const systemSuffix = buildTextOnlySystemSuffix(params.allowJsonOutput);
  const callContext = buildTextOnlyCallContext(params.context, {
    allowJsonOutput: params.allowJsonOutput,
  });
  try {
    params.onRequestStart?.({ context: callContext, systemSuffix });
  } catch (error) {
    // Diagnostic observers must never stop the provider request.
    console.warn("text-only request observer failed; continuing without diagnostics", error);
  }

  const proxyRequest = await prepareProviderRequest(params.providerId, params.runtime, {
    sessionId: params.sessionId,
  });

  const m = createModelFromConfig(
    params.providerId,
    modelId,
    proxyRequest.baseUrl,
    params.runtime.requestFormat,
    params.runtime.modelConfig,
    params.runtime.baseUrl.trim(),
  );

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
    onRetryStatus: params.onRetryStatus,
    onRetryRecovered: params.onRetryRecovered,
  });

  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context: callContext,
      options,
    }),
  );

  // ---- Provider auto-failover (text mode) --------------------------------
  // Mirrors runAssistantWithTools' per-round wiring: target 0 is the primary
  // (params.providerId/model/runtime), the rest map to failover.fallbacks in
  // queue order. Fallback proxy/model preparation is lazy so unused fallbacks
  // never touch the hot path. Sticky winner: recovery turns within this call
  // start on the target that actually answered.
  const failover = params.failover;
  const primaryFailoverKey = failover?.primary.selectedModel
    ? failoverBreakerKey(
        failover.primary.selectedModel.customProviderId,
        failover.primary.selectedModel.model,
      )
    : failoverBreakerKey(params.providerId, modelId);
  const primaryFailoverLabel = failover?.primary.label ?? `${params.providerId} · ${modelId}`;

  type PreparedTextFailoverTarget = {
    model: ReturnType<typeof createModelFromConfig>;
    options: StreamOptionsEx;
  };
  const preparedFallbackTargets = new Map<number, Promise<PreparedTextFailoverTarget>>();
  const prepareFallbackTarget = (index: number): Promise<PreparedTextFailoverTarget> => {
    const existing = preparedFallbackTargets.get(index);
    if (existing) return existing;
    const fallback = failover?.fallbacks[index - 1];
    if (!fallback) {
      return Promise.reject(new Error(`Unknown failover target index: ${index}`));
    }
    const prepared = (async () => {
      const fallbackProxyRequest = await prepareProviderRequest(
        fallback.providerId,
        fallback.runtime,
        { sessionId: params.sessionId },
      );
      const fallbackModel = createModelFromConfig(
        fallback.providerId,
        fallback.model,
        fallbackProxyRequest.baseUrl,
        fallback.runtime.requestFormat,
        fallback.runtime.modelConfig,
        fallback.runtime.baseUrl.trim(),
      );
      return {
        model: fallbackModel,
        options: buildTextOnlyStreamOptions({
          providerId: fallback.providerId,
          runtime: fallback.runtime,
          model: fallbackModel,
          context: callContext,
          workdir: params.workdir,
          headers: fallbackProxyRequest.headers,
          hostedSearchProbeId,
          signal: params.signal,
          sessionId: params.sessionId,
          cacheRetention: params.cacheRetention,
          nativeWebSearch: params.nativeWebSearch,
          debugLogger: params.debugLogger,
          onRetryStatus: params.onRetryStatus,
          onRetryRecovered: params.onRetryRecovered,
        }),
      } satisfies PreparedTextFailoverTarget;
    })();
    // A failed preparation must not be cached forever; allow later retries.
    preparedFallbackTargets.set(
      index,
      prepared.catch((error) => {
        preparedFallbackTargets.delete(index);
        throw error;
      }),
    );
    return preparedFallbackTargets.get(index) as Promise<PreparedTextFailoverTarget>;
  };

  /** Cheap, IO-free model identity for failover bookkeeping/synthesis. */
  const fallbackTargetIdentity = (index: number) => {
    const fallback = failover?.fallbacks[index - 1];
    if (!fallback) return { api: m.api, provider: m.provider, id: m.id };
    const identity = createModelFromConfig(
      fallback.providerId,
      fallback.model,
      fallback.runtime.baseUrl.trim(),
      fallback.runtime.requestFormat,
      fallback.runtime.modelConfig,
      fallback.runtime.baseUrl.trim(),
    );
    return { api: identity.api, provider: identity.provider, id: identity.id };
  };

  let activeFailoverTargetIndex = 0;
  let lastFailoverErrorMessage = "";

  const startAttemptStream = (activeContext: Context) => {
    if (!failover || failover.fallbacks.length === 0) {
      return streamSimpleByApi(m, activeContext, options);
    }
    // Candidate order: sticky active target first, then the rest in
    // primary→queue order. Breaker-open targets are skipped inside
    // withProviderFailover.
    const totalTargets = failover.fallbacks.length + 1;
    const targetOrder = [
      activeFailoverTargetIndex,
      ...Array.from({ length: totalTargets }, (_, i) => i).filter(
        (i) => i !== activeFailoverTargetIndex,
      ),
    ];
    const candidates = targetOrder.map((targetIndex) => {
      const fallback = targetIndex === 0 ? null : failover.fallbacks[targetIndex - 1];
      return {
        key:
          targetIndex === 0
            ? primaryFailoverKey
            : failoverBreakerKey(
                fallback?.selectedModel.customProviderId ?? "",
                fallback?.selectedModel.model ?? "",
              ),
        label: targetIndex === 0 ? primaryFailoverLabel : (fallback?.label ?? ""),
        model:
          targetIndex === 0
            ? { api: m.api, provider: m.provider, id: m.id }
            : fallbackTargetIdentity(targetIndex),
        start: async () => {
          if (targetIndex === 0 || !fallback) {
            return streamSimpleByApi(m, activeContext, options);
          }
          const prepared = await prepareFallbackTarget(targetIndex);
          params.debugLogger?.logRequest(
            buildStreamRequestDebugPayload({
              runtime: fallback.runtime,
              context: callContext,
              options: prepared.options,
            }),
          );
          return streamSimpleByApi(prepared.model, activeContext, prepared.options);
        },
      } satisfies ProviderFailoverCandidate;
    });
    return withProviderFailover(candidates, {
      config: failover.config,
      signal: params.signal,
      onFailover: (event) => {
        lastFailoverErrorMessage = event.errorMessage;
        failover.onFailover?.({
          fromLabel: event.fromLabel,
          toLabel: event.toLabel,
          errorMessage: event.errorMessage,
        });
      },
      onCommitted: (candidateIndex) => {
        const targetIndex = targetOrder[candidateIndex] ?? activeFailoverTargetIndex;
        if (targetIndex === activeFailoverTargetIndex) return;
        activeFailoverTargetIndex = targetIndex;
        failover.onSwitched?.({
          target: targetIndex === 0 ? null : (failover.fallbacks[targetIndex - 1] ?? null),
          errorMessage: lastFailoverErrorMessage,
        });
      },
    });
  };
  // ------------------------------------------------------------------------

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
    let hostedSearchProbeFinalization: Promise<void> | undefined;
    const finishHostedSearchProbe = () =>
      (hostedSearchProbeFinalization ??= hostedSearchProbe.finish());
    const finishHostedSearchProbeWithAbort = () =>
      raceWithAbort(finishHostedSearchProbe(), params.signal);
    try {
      let activeContext = callContext;
      for (let toolRecoveryTurn = 0; toolRecoveryTurn < 4; toolRecoveryTurn += 1) {
        const s = startAttemptStream(activeContext);
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

        await finishHostedSearchProbeWithAbort();
        final = appendHostedSearchBlocksToAssistant(
          final as AssistantMessage & { content: unknown[] },
          hostedSearchAggregator.complete(),
          { orderedBlocks },
        ) as AssistantMessage;
        params.debugLogger?.logResult(final);
        flushDebugLoggerInBackground(params.debugLogger, "text stream");
        return final;
      }

      throw new Error("Too many text-mode tool-call recovery attempts");
    } catch (error) {
      if (params.signal?.aborted) {
        // finish() unregisters the probe before it waits for its clone reader.
        // Do not make cancellation wait for a broken network stream to close.
        void finishHostedSearchProbe().catch(() => undefined);
        hostedSearchAggregator.dispose();
      } else {
        await finishHostedSearchProbe();
        hostedSearchAggregator.fail();
      }
      params.debugLogger?.logError(error);
      flushDebugLoggerInBackground(params.debugLogger, "text stream");
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

  const proxyRequest = await prepareProviderRequest(params.providerId, params.runtime, {
    sessionId: params.sessionId,
  });

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
      flushDebugLoggerInBackground(params.debugLogger, "text completion");
      return final;
    } catch (error) {
      params.debugLogger?.logError(error);
      flushDebugLoggerInBackground(params.debugLogger, "text completion");
      throw error;
    }
  });
}
