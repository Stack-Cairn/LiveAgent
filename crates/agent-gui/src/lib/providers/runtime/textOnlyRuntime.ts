import type { Api, AssistantMessage, CacheRetention, Context, Model } from "@earendil-works/pi-ai";
import {
  appendHostedSearchBlocksToAssistant,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
  mergeHostedSearchBlocks,
} from "@liveagent/ui/lib/chat/hostedSearch";
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
import { llm } from "../service/llmService";
import { appendSystemPrompt, normalizeSessionId } from "./common";
import { normalizeErrorMessage } from "./errors";
import { createStreamingTextReconciler, sanitizeAssistantMessage } from "./messageUtils";
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
import { resolveStreamRetryConfig } from "./retryPolicy";
import { buildTextModeToolResultsForAssistant } from "./textModeToolRecovery";
import { captureTransportSnapshot, type TransportSnapshot } from "./transportSnapshot";
import type { ProviderRuntimeConfig, StreamOptionsEx } from "./types";

// 导出供 turn runner 估算 provider 边界追加段（用量环 fixed 校准），非请求路径。
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
  /** 本组 options 所属候选的展示标签（"Provider · model"），随 onRetryStatus 回传。 */
  providerLabel?: string;
  onRetryStatus?: (
    attempt: number,
    maxAttempts: number,
    errorMessage: string,
    plannedDelayMs?: number,
    providerLabel?: string,
  ) => void;
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
  const onRetryStatus = params.onRetryStatus;
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
      ...resolveStreamRetryConfig(params.runtime.retryPolicy),
      // 绑定当前候选标签：failover 下备用供应商的流内重试才能在轨迹里归属
      // 到具体候选，与 agent 模式 retryAttempts 携带 providerLabel 的口径一致。
      onRetry: onRetryStatus
        ? (attempt, maxAttempts, errorMessage, plannedDelayMs) =>
            onRetryStatus(attempt, maxAttempts, errorMessage, plannedDelayMs, params.providerLabel)
        : undefined,
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
  onFailover?: (event: {
    fromLabel: string;
    toLabel: string;
    /** Stable candidate index of the switch target (0 = primary). */
    targetIndex: number;
    errorMessage: string;
  }) => void;
};

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
  onHostedSearch?: (block: HostedSearchBlock) => void;
  /** `providerLabel` 是产生本次重试的候选标签；failover 下用于区分各候选。 */
  onRetryStatus?: (
    attempt: number,
    maxAttempts: number,
    errorMessage: string,
    plannedDelayMs?: number,
    providerLabel?: string,
  ) => void;
  onRetryRecovered?: () => void;
  /** 每个实际尝试的候选各 fire 一次：脱敏后的传输装配快照（只含头名，不含值）。 */
  onTransportAttempt?: (snapshot: TransportSnapshot & { providerLabel: string }) => void;
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
  const primaryFailoverLabel =
    params.failover?.primary.label ?? `${params.providerId} · ${modelId}`;
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
    providerLabel: primaryFailoverLabel,
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
          providerLabel: fallback.label,
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

  /** 逐候选独立采样；观察失败不影响请求。 */
  const noteTransportAttempt = (
    label: string,
    attemptOptions: StreamOptionsEx | undefined,
  ): void => {
    try {
      params.onTransportAttempt?.({
        ...captureTransportSnapshot(attemptOptions?.headers),
        providerLabel: label,
      });
    } catch (error) {
      console.warn("text-only transport observer failed; continuing without diagnostics", error);
    }
  };

  const startAttemptStream = (activeContext: Context) => {
    if (!failover || failover.fallbacks.length === 0) {
      noteTransportAttempt(primaryFailoverLabel, options);
      return llm.stream({ model: m, context: activeContext, options });
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
            noteTransportAttempt(primaryFailoverLabel, options);
            return llm.stream({ model: m, context: activeContext, options });
          }
          const prepared = await prepareFallbackTarget(targetIndex);
          params.debugLogger?.logRequest(
            buildStreamRequestDebugPayload({
              runtime: fallback.runtime,
              context: callContext,
              options: prepared.options,
            }),
          );
          noteTransportAttempt(fallback.label, prepared.options);
          return llm.stream({
            model: prepared.model,
            context: activeContext,
            options: prepared.options,
          });
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
          // Map the per-call candidates index back to the stable target index
          // (0 = primary) so sticky reordering can't skew the audit trail.
          targetIndex: targetOrder[event.toIndex] ?? event.toIndex,
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
          } else if (event.type === "thinking_delta") {
            // 思考内容不进 orderedBlocks——那套排序只服务于正文与 hosted search 的交织。
            params.onThinkingDelta?.(event.delta);
          }
        }

        let final = sanitizeAssistantMessage(await s.result());
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
      const s = llm.stream({ model: m, context: callContext, options });
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
