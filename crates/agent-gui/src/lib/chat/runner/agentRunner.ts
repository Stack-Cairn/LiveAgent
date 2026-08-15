import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  ModelThinkingLevel,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  appendHostedSearchBlocksToAssistant,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
  mergeHostedSearchBlocks,
} from "@liveagent/ui/lib/chat/hostedSearch";
import type { PreparedProxyRequest } from "@liveagent/ui/lib/providers/proxy";
import { buildStreamRequestDebugPayload, type StreamDebugLogger } from "../../debug/agentDebug";
import { capturePrefixShape, comparePrefixShape } from "../../debug/prefixCacheShape";
import { readPreviousPrefixShape, recordPrefixShape } from "../../debug/prefixShapeStore";
import {
  createHostedSearchEventAggregator,
  createHostedSearchProbeId,
  startHostedSearchFetchProbe,
  withHostedSearchProbeHeader,
} from "../../providers/hostedSearchEvents";
import {
  buildProviderRequestMetadata,
  createModelFromConfig,
  createStreamingTextReconciler,
  describeProviderCacheShape,
  finalizeProviderStreamOptions,
  normalizeErrorMessage,
  type ProviderRuntimeConfig,
  prepareProviderRequest,
  resolveProviderCacheRetention,
  type StreamOptionsEx,
  streamSimpleByApi,
  toSimpleStreamReasoning,
} from "../../providers/llm";
import {
  buildProviderNativeWebFetchBridgeResult,
  buildProviderNativeWebSearchBridgeResult,
  HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES,
  HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES,
  isProviderNativeWebFetchToolName,
  isProviderNativeWebSearchToolName,
} from "../../providers/nativeWebSearch";
import {
  failoverBreakerKey,
  type ModelFailoverRuntimeConfig,
  type ProviderFailoverCandidate,
  withProviderFailover,
} from "../../providers/runtime/providerFailover";
import type { RetryAttemptRecord } from "../../providers/runtime/streamRetry";
import type { RuntimePlatform } from "../../runtimePlatform";
import type { ProviderId, ReasoningLevel, SelectedModel } from "../../settings";
import { createSubagentScheduler, type SubagentScheduler } from "../../subagents/scheduler";
import { withPowerActivity } from "../../system/powerActivity";
import type { AdditionalProjectRoot } from "../../tools/additionalProjectRoots";
import { appendToolResultTailBlock } from "../context/contextTailBlock";
import { sanitizeContextForModelRequest } from "../context/requestContextSanitizer";
import { summarizeToolCall } from "../messages/uiMessages";
import {
  createDeferredProviderNativeWebSearchStatus,
  resolveProviderNativeWebSearchStatus,
} from "../search/providerNativeSearchStatus";
import { comparableToolCall } from "./flattenedToolCallText";
import { recoverAssistantSeedToolCalls, stripSeedToolCallMarkup } from "./seedToolCalls";
import { wrapStreamWithToolCallArgumentGuard } from "./toolCallArgumentGuard";
import { buildToolsSuffix } from "./toolExecutionPrompt";

export { buildToolsSuffix } from "./toolExecutionPrompt";

function throwIfRunnerCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Cancelled");
  }
}

function createLinkedAbortSignal(signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = Array.from(
    new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal))),
  );
  if (activeSignals.length <= 1) {
    return { signal: activeSignals[0], cleanup: () => undefined };
  }

  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  const cleanup = () => {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  for (const sourceSignal of activeSignals) {
    if (sourceSignal.aborted) {
      abort();
      break;
    }
    sourceSignal.addEventListener("abort", abort, { once: true });
    cleanupFns.push(() => sourceSignal.removeEventListener("abort", abort));
  }

  return { signal: controller.signal, cleanup };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results: R[] = new Array(n);
  let nextIndex = 0;

  async function runLoop() {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= n) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = new Array(Math.min(limit, n)).fill(0).map(() => runLoop());
  await Promise.all(runners);
  return results;
}

function toolNameLookupKey(name: string) {
  return name.trim().toLowerCase();
}

function buildToolNameCanonicalizer(tools: readonly { name: string }[]) {
  const canonicalByKey = new Map<string, string | null>();
  for (const tool of tools) {
    const key = toolNameLookupKey(tool.name);
    if (!key) continue;
    const existing = canonicalByKey.get(key);
    if (existing === undefined) {
      canonicalByKey.set(key, tool.name);
    } else if (existing !== tool.name) {
      canonicalByKey.set(key, null);
    }
  }

  return (name: string) => {
    const canonical = canonicalByKey.get(toolNameLookupKey(name));
    return canonical ?? name;
  };
}

function normalizeToolCallName(toolCall: ToolCall, canonicalizeToolName: (name: string) => string) {
  const canonicalName = canonicalizeToolName(toolCall.name);
  if (canonicalName === toolCall.name) return toolCall;
  return {
    ...toolCall,
    name: canonicalName,
  };
}

function normalizeAssistantToolCallNames(
  assistant: AssistantMessage,
  canonicalizeToolName: (name: string) => string,
) {
  let changed = false;
  const nextContent = assistant.content.map((block) => {
    if (block.type !== "toolCall") return block;
    const nextBlock = normalizeToolCallName(block, canonicalizeToolName);
    if (nextBlock !== block) changed = true;
    return nextBlock;
  });

  if (changed) {
    assistant.content = nextContent;
  }
  return assistant;
}

function getComparableCanonicalToolCall(
  toolCall: ToolCall,
  canonicalizeToolName: (name: string) => string,
) {
  return comparableToolCall(normalizeToolCallName(toolCall, canonicalizeToolName));
}

function dedupeRecoveredToolCallsAgainstExisting(params: {
  existingAssistant: AssistantMessage;
  recoveredToolCalls: ToolCall[];
  canonicalizeToolName: (name: string) => string;
}) {
  const seen = new Set(
    params.existingAssistant.content
      .filter((block): block is ToolCall => block.type === "toolCall")
      .map((toolCall) => getComparableCanonicalToolCall(toolCall, params.canonicalizeToolName)),
  );
  const uniqueToolCalls: ToolCall[] = [];
  const duplicateToolCallIds = new Set<string>();

  for (const toolCall of params.recoveredToolCalls) {
    const normalizedToolCall = normalizeToolCallName(toolCall, params.canonicalizeToolName);
    const comparable = comparableToolCall(normalizedToolCall);
    if (seen.has(comparable)) {
      duplicateToolCallIds.add(normalizedToolCall.id);
      continue;
    }
    seen.add(comparable);
    uniqueToolCalls.push(normalizedToolCall);
  }

  return {
    uniqueToolCalls,
    duplicateToolCallIds,
  };
}

function buildSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  if (!head) return suffix;
  return `${head}\n\n${suffix}`;
}

function toSyntheticToolCall(params: {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}): ToolCall {
  return {
    type: "toolCall",
    id: params.id,
    name: params.name,
    arguments: params.arguments ?? {},
  };
}

function toAssistantThinkingLevel(params: {
  providerId: ProviderId;
  reasoning?: ReasoningLevel;
  api: string;
}): ModelThinkingLevel {
  if (params.providerId === "claude_code") {
    return params.reasoning && params.reasoning !== "off" ? params.reasoning : "off";
  }
  if (params.providerId === "gemini") {
    if (!params.reasoning || params.reasoning === "off") return "off";
    return params.reasoning === "xhigh" || params.reasoning === "max" ? "high" : params.reasoning;
  }
  if (params.api !== "openai-responses" && params.api !== "openai-completions") {
    return "off";
  }
  return params.reasoning && params.reasoning !== "off" ? params.reasoning : "off";
}

function normalizeStreamReasoning(value: unknown): StreamOptionsEx["reasoning"] | undefined {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

function getAssistantToolCalls(assistant: AssistantMessage): ToolCall[] {
  return assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function findConsecutiveToolGroup(
  assistant: AssistantMessage,
  toolCallId: string,
  toolName: string,
): ToolCall[] | null {
  const toolCalls = getAssistantToolCalls(assistant);
  const idx = toolCalls.findIndex((call) => call.id === toolCallId);
  if (idx < 0 || toolCalls[idx].name !== toolName) return null;

  let start = idx;
  while (start > 0 && toolCalls[start - 1].name === toolName) start -= 1;

  let end = idx;
  while (end + 1 < toolCalls.length && toolCalls[end + 1].name === toolName) end += 1;

  return toolCalls.slice(start, end + 1);
}

function buildParallelToolBatchKey(group: ToolCall[]) {
  return group.map((call) => call.id).join("|");
}

type ParallelToolBatch = {
  toolName: string;
  toolCalls: ToolCall[];
  started: boolean;
  announced: boolean;
  resultPromises: Map<string, Promise<ToolResultMessage>>;
};

function getParallelToolBatch(
  toolCallId: string,
  parallelBatchKeyByToolCallId: Map<string, string>,
  parallelToolBatches: Map<string, ParallelToolBatch>,
) {
  const batchKey = parallelBatchKeyByToolCallId.get(toolCallId);
  if (!batchKey) return null;
  return parallelToolBatches.get(batchKey) ?? null;
}

function getParallelToolBatchStatus(batch: ParallelToolBatch) {
  if (batch.toolName === "Bash") {
    return `正在并行执行 ${batch.toolCalls.length} 个 Bash 命令...`;
  }
  if (batch.toolName === "Agent") {
    return `正在并行执行 ${batch.toolCalls.length} 个 Agent 调用...`;
  }
  return `正在并行执行 ${batch.toolCalls.length} 个 ${batch.toolName} 调用...`;
}

function toMessageToolResult(message: Message, toolCall: ToolCall): ToolResultMessage {
  if (message.role === "toolResult") return message;
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: "Tool did not return a toolResult message" }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

type TurnContextOverride = {
  context: Context;
  emittedMessages: Message[];
  /**
   * 只随出站请求投递的尾部文本（bus 增量、roster 运行状态等易变内容）。
   * 不写入 agent.state.messages：写进去会经 emittedMessages 泄漏到持久化、
   * UI 与记忆抽取。runner 逐次累积并在每次出站请求上重挂。
   */
  wireTailText?: string;
} | null;

type ToolExecutionEventContext = {
  parentToolCall: ToolCall;
  subagentScheduler: SubagentScheduler;
  emitToolCall: (toolCall: ToolCall) => void;
  emitToolExecutionStart: (toolCall: ToolCall) => void;
  emitToolResult: (toolCall: ToolCall, toolResult: ToolResultMessage) => void;
  emitToolStatus: (status: string | null) => void;
};

function getAgentMessages(agent: Agent | null): Message[] {
  return agent ? (agent.state.messages as Message[]) : [];
}

function getMessagesSinceBaseline(agent: Agent | null, baselineIndex: number): Message[] {
  const messages = getAgentMessages(agent);
  if (baselineIndex <= 0) return messages.slice();
  if (baselineIndex >= messages.length) return [];
  return messages.slice(baselineIndex);
}

function findLastAssistantMessage(messages: Message[]): AssistantMessage | null {
  return (
    [...messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant") ?? null
  );
}

export type AgentRunnerFailoverTarget = {
  /** Stable identity used for breaker keys and switch callbacks. */
  selectedModel: SelectedModel;
  providerId: ProviderId;
  model: string;
  /** Display label, e.g. "PackyCode · claude-sonnet-4-5". */
  label: string;
  runtime: ProviderRuntimeConfig;
};

export type AgentRunnerFailoverSwitchEvent = {
  /** The fallback target now active, or null when back on the primary. */
  target: AgentRunnerFailoverTarget | null;
  round: number;
  errorMessage: string;
};

export type AgentRunnerFailoverParams = {
  config: ModelFailoverRuntimeConfig;
  /** Identity of the primary target described by params.providerId/model/runtime. */
  primary: { selectedModel?: SelectedModel; label: string };
  /** Fallback targets in failover-queue order, primary duplicates removed. */
  fallbacks: AgentRunnerFailoverTarget[];
  /** Fired when a round commits on a different target than the previous rounds. */
  onSwitched?: (event: AgentRunnerFailoverSwitchEvent) => void;
};

export async function runAssistantWithTools(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  failover?: AgentRunnerFailoverParams;
  runtimePlatform?: RuntimePlatform;
  context: Context;
  workdir: string;
  /** Structured file-tool roots, also documented in the generated tool prompt. */
  additionalRoots?: readonly AdditionalProjectRoot[];
  sessionId?: string;
  nativeWebSearch?: boolean;
  tools: Context["tools"];
  executeToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: ToolExecutionEventContext,
  ) => Promise<Message>;
  onTurnStart?: (round: number) => void;
  onTextDelta: (delta: string, round: number) => void;
  onThinkingDelta?: (delta: string, round: number) => void;
  onToolCall?: (toolCall: ToolCall, round: number) => void;
  onToolCallDelta?: (toolCall: ToolCall, round: number) => void;
  onHostedSearch?: (hostedSearch: HostedSearchBlock, round: number) => void;
  onToolExecutionStart?: (toolCall: ToolCall, round: number) => void;
  onToolResult?: (toolCall: ToolCall, toolResult: Message, round: number) => void;
  onAssistantMessage?: (assistant: Message, round: number) => void;
  onBeforeNextTurn?: (params: {
    round: number;
    assistant: AssistantMessage;
    toolResults: ToolResultMessage[];
    runtimeContext: Context;
    emittedMessages: Message[];
    signal?: AbortSignal;
  }) => Promise<{
    context: Context;
    emittedMessages: Message[];
    wireTailText?: string;
  } | null>;
  onToolStatus?: (status: string | null) => void;
  onRetryAttempts?: (round: number, attempts: RetryAttemptRecord[]) => void;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  subagentScheduler?: SubagentScheduler;
  allowEmptyWorkdir?: boolean;
  /**
   * 工具审批门:每次工具执行前(截断校验之后)对规范化后的调用调用一次。
   * 返回 allow:false 时该调用被拦截,reason 作为 toolResult 交给模型(与截断
   * 拒绝同渲染路径)。回调可 await(交互式审批),被 turn 中止时应 reject/拒绝。
   * 与策略/元数据实现解耦:runner 只认这个结果,不感知 toolPolicies 细节。
   */
  resolveToolGate?: (
    toolCall: ToolCall,
    signal?: AbortSignal,
  ) => Promise<{ allow: true } | { allow: false; reason: string }>;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");
  if (!params.workdir.trim() && !params.allowEmptyWorkdir) {
    throw new Error("A working directory must be configured for tool mode");
  }
  throwIfRunnerCancelled(params.signal);

  const subagentScheduler = params.subagentScheduler ?? createSubagentScheduler();

  return withPowerActivity("assistant-tools", `${params.providerId}:${modelId}`, async () => {
    const proxyRequest = await prepareProviderRequest(params.providerId, params.runtime, {
      sessionId: params.sessionId,
    });

    const model = createModelFromConfig(
      params.providerId,
      modelId,
      proxyRequest.baseUrl,
      params.runtime.requestFormat,
      params.runtime.modelConfig,
      params.runtime.baseUrl.trim(),
    );
    const nativeWebSearchStatus = resolveProviderNativeWebSearchStatus({
      providerId: params.providerId,
      api: model.api,
      enabled: params.nativeWebSearch,
      baseUrl: params.runtime.baseUrl,
      modelId,
    });
    const nativeWebSearchStatusController = createDeferredProviderNativeWebSearchStatus({
      status: nativeWebSearchStatus,
      onStatus: (status) => params.onToolStatus?.(status),
    });

    const thinkingLevel = toAssistantThinkingLevel({
      providerId: params.providerId,
      reasoning: params.runtime.reasoning,
      api: model.api,
    });

    // ---- Provider auto-failover targets -----------------------------------
    // Target 0 is the primary (params.providerId/model/runtime); the rest map
    // to params.failover.fallbacks in queue order. Fallback proxy/model
    // preparation is lazy so unused fallbacks never touch the hot path.
    type PreparedFailoverTarget = {
      index: number;
      key: string;
      label: string;
      selectedModel?: SelectedModel;
      providerId: ProviderId;
      modelId: string;
      runtime: ProviderRuntimeConfig;
      proxyRequest: PreparedProxyRequest;
      model: ReturnType<typeof createModelFromConfig>;
    };

    const failoverParams = params.failover;
    const primaryTarget: PreparedFailoverTarget = {
      index: 0,
      key: failoverParams?.primary.selectedModel
        ? failoverBreakerKey(
            failoverParams.primary.selectedModel.customProviderId,
            failoverParams.primary.selectedModel.model,
          )
        : failoverBreakerKey(params.providerId, modelId),
      label: failoverParams?.primary.label ?? `${params.providerId} · ${modelId}`,
      selectedModel: failoverParams?.primary.selectedModel,
      providerId: params.providerId,
      modelId,
      runtime: params.runtime,
      proxyRequest,
      model,
    };

    const preparedFallbackTargets = new Map<number, Promise<PreparedFailoverTarget>>();
    const prepareFallbackTarget = (index: number): Promise<PreparedFailoverTarget> => {
      const existing = preparedFallbackTargets.get(index);
      if (existing) return existing;
      const fallback = failoverParams?.fallbacks[index - 1];
      if (!fallback) {
        return Promise.reject(new Error(`Unknown failover target index: ${index}`));
      }
      const prepared = (async () => {
        const fallbackProxyRequest = await prepareProviderRequest(
          fallback.providerId,
          fallback.runtime,
          { sessionId: params.sessionId },
        );
        return {
          index,
          key: failoverBreakerKey(
            fallback.selectedModel.customProviderId,
            fallback.selectedModel.model,
          ),
          label: fallback.label,
          selectedModel: fallback.selectedModel,
          providerId: fallback.providerId,
          modelId: fallback.model,
          runtime: fallback.runtime,
          proxyRequest: fallbackProxyRequest,
          model: createModelFromConfig(
            fallback.providerId,
            fallback.model,
            fallbackProxyRequest.baseUrl,
            fallback.runtime.requestFormat,
            fallback.runtime.modelConfig,
            fallback.runtime.baseUrl.trim(),
          ),
        } satisfies PreparedFailoverTarget;
      })();
      // A failed preparation must not be cached forever; allow later retries.
      preparedFallbackTargets.set(
        index,
        prepared.catch((error) => {
          preparedFallbackTargets.delete(index);
          throw error;
        }),
      );
      return preparedFallbackTargets.get(index) as Promise<PreparedFailoverTarget>;
    };

    /** Cheap, IO-free model identity for failover bookkeeping/synthesis. */
    const fallbackTargetIdentity = (index: number) => {
      const fallback = failoverParams?.fallbacks[index - 1];
      if (!fallback) return { api: model.api, provider: model.provider, id: modelId };
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

    // Sticky winner: rounds after a successful failover start on the target
    // that actually answered, mirroring cc-switch's hot switch semantics.
    let activeFailoverTargetIndex = 0;
    let lastFailoverErrorMessage = "";
    // ------------------------------------------------------------------------

    const toolResultErrorFlags = new Map<string, boolean>();
    const toolCallsById = new Map<string, ToolCall>();
    const incompleteToolCallArguments = new Map<string, string>();
    const refusedTruncatedToolCallIds = new Set<string>();
    const buildTruncatedToolCallText = (toolName: string, reason: string) =>
      `${toolName} was not executed: its arguments were truncated in transit (${reason}). ` +
      `This is a transport error, not a mistake in your call — re-issue the complete ${toolName} call with full arguments.`;
    const parallelBatchKeyByToolCallId = new Map<string, string>();
    const parallelToolBatches = new Map<string, ParallelToolBatch>();
    const llmTools = params.tools ?? [];
    const canonicalizeToolName = buildToolNameCanonicalizer(llmTools);
    const normalizeToolCallNameForExecution = (toolCall: ToolCall) =>
      normalizeToolCallName(toolCall, canonicalizeToolName);
    const normalizeAssistantToolCallNamesForExecution = (assistant: AssistantMessage) =>
      normalizeAssistantToolCallNames(assistant, canonicalizeToolName);
    let currentRound = 0;

    const executeSingleToolCall = async (
      toolCall: ToolCall,
      signal?: AbortSignal,
    ): Promise<{ content: ToolResultMessage["content"]; details: unknown }> => {
      throwIfRunnerCancelled(signal ?? params.signal);
      const effectiveToolCall = normalizeToolCallNameForExecution(toolCall);
      if (effectiveToolCall !== toolCall) {
        toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
      }
      let toolResult: ToolResultMessage;
      const linkedSignal = createLinkedAbortSignal([signal, params.signal]);
      try {
        if (shouldSilenceProviderNativeWebSearchToolCall(effectiveToolCall)) {
          toolResult = buildProviderNativeWebSearchBridgeResult({
            toolCall: effectiveToolCall,
            hostedSearchBlocks: hostedSearchBlocksByRound.get(currentRound) ?? [],
            sourcesIntro: "Hosted search sources already captured in this round:",
            fallbackText:
              "No local web_search executor is available. Continue from existing context, or request provider-native web search through the model/tool protocol instead of printing raw tool-call markup.",
            extraInstructions: ["Do not repeat raw tool-call markup in the final answer."],
          });
        } else if (shouldSilenceProviderNativeWebFetchToolCall(effectiveToolCall)) {
          toolResult = buildProviderNativeWebFetchBridgeResult({
            toolCall: effectiveToolCall,
            hostedSearchBlocks: hostedSearchBlocksByRound.get(currentRound) ?? [],
            sourcesIntro: "Hosted search sources already captured in this round:",
            fallbackText:
              "No hosted search sources were captured in this round. Continue from existing context.",
            extraInstructions: ["Do not repeat raw tool-call markup in the final answer."],
          });
        } else {
          const execute = () =>
            params.executeToolCall(effectiveToolCall, linkedSignal.signal, {
              parentToolCall: effectiveToolCall,
              subagentScheduler,
              emitToolCall: (emittedToolCall) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                params.onToolCall?.(emittedToolCall, currentRound);
              },
              emitToolExecutionStart: (emittedToolCall) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                params.onToolExecutionStart?.(emittedToolCall, currentRound);
              },
              emitToolResult: (emittedToolCall, emittedToolResult) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                toolResultErrorFlags.set(emittedToolCall.id, Boolean(emittedToolResult.isError));
                params.onToolResult?.(emittedToolCall, emittedToolResult, currentRound);
              },
              emitToolStatus: (status) => params.onToolStatus?.(status),
            });
          toolResult = toMessageToolResult(
            await (effectiveToolCall.name === "Bash"
              ? subagentScheduler.runBash(execute, linkedSignal.signal)
              : execute()),
            effectiveToolCall,
          );
        }
      } catch (error) {
        toolResult = {
          role: "toolResult",
          toolCallId: effectiveToolCall.id,
          toolName: effectiveToolCall.name,
          content: [
            {
              type: "text",
              text: normalizeErrorMessage(
                error instanceof Error ? error.message : String(error),
                "Tool execution failed",
              ),
            },
          ],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      } finally {
        linkedSignal.cleanup();
      }
      throwIfRunnerCancelled(linkedSignal.signal);

      toolResultErrorFlags.set(effectiveToolCall.id, Boolean(toolResult.isError));
      return {
        content: toolResult.content,
        details: toolResult.details ?? {},
      };
    };

    const startParallelToolBatchIfNeeded = (batchKey: string, signal?: AbortSignal) => {
      const batch = parallelToolBatches.get(batchKey);
      if (!batch || batch.started) return batch;

      batch.started = true;
      if (batch.toolCalls.length > 1 && !batch.announced) {
        batch.announced = true;
        params.onToolStatus?.(getParallelToolBatchStatus(batch));
      }

      const allResultsPromise = runWithConcurrency(
        batch.toolCalls,
        subagentScheduler.getParallelToolLimit(batch.toolName),
        async (call) => {
          const result = await executeSingleToolCall(call, signal);
          return {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            details: result.details,
            isError: toolResultErrorFlags.get(call.id) ?? false,
            timestamp: Date.now(),
          } satisfies ToolResultMessage;
        },
      );

      batch.resultPromises = new Map(
        batch.toolCalls.map((call, index) => [
          call.id,
          allResultsPromise.then((results) => results[index]),
        ]),
      );

      return batch;
    };

    const localToolNames = new Set(llmTools.map((tool) => tool.name));
    const hiddenProviderNativeWebSearchToolNames = new Set<string>(
      nativeWebSearchStatus
        ? HIDDEN_PROVIDER_NATIVE_WEB_SEARCH_TOOL_NAMES.filter((name) => !localToolNames.has(name))
        : [],
    );
    const hiddenProviderNativeWebFetchToolNames = new Set<string>(
      nativeWebSearchStatus
        ? HIDDEN_PROVIDER_NATIVE_WEB_FETCH_TOOL_NAMES.filter((name) => !localToolNames.has(name))
        : [],
    );
    const shouldSilenceProviderNativeWebSearchToolCall = (toolCall: ToolCall) =>
      Boolean(
        nativeWebSearchStatus &&
          !localToolNames.has(toolCall.name) &&
          isProviderNativeWebSearchToolName(toolCall.name),
      );
    const shouldSilenceProviderNativeWebFetchToolCall = (toolCall: ToolCall) =>
      Boolean(
        nativeWebSearchStatus &&
          !localToolNames.has(toolCall.name) &&
          isProviderNativeWebFetchToolName(toolCall.name),
      );
    // Single gate for every tool-event suppression site: bridged web_search and
    // web_fetch calls must never surface as tool rows/status lines in the UI.
    const shouldSilenceProviderNativeToolCall = (toolCall: ToolCall) =>
      shouldSilenceProviderNativeWebSearchToolCall(toolCall) ||
      shouldSilenceProviderNativeWebFetchToolCall(toolCall);
    const filterRequestTools = (
      tools: Context["tools"] | undefined,
    ): Context["tools"] | undefined =>
      tools?.filter(
        (tool) =>
          !hiddenProviderNativeWebSearchToolNames.has(tool.name) &&
          !hiddenProviderNativeWebFetchToolNames.has(tool.name),
      );

    const assistantVisibleAnswerText = (assistant: AssistantMessage) =>
      stripSeedToolCallMarkup(
        assistant.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
        { recoverFlattenedText: true },
      ).trim();

    // Relays that execute Anthropic server tools in-band can leak the original
    // tool_use blocks with stop_reason end_turn *after* the model has already
    // written its final answer (the server results streamed mid-generation, so
    // the answer text follows them in the same message). Bridging those calls
    // and letting pi-agent-core run another model turn makes Claude answer the
    // same question again — duplicate output after every web search. Marking
    // every bridged call of such a batch as terminate keeps the bridge results
    // in history (the next request stays protocol-consistent) but ends the run
    // on the answer the user already has. Guards: the model must have finished
    // normally with visible answer text, and a leaked search call additionally
    // needs completed in-round hosted-search sources — a model that is still
    // waiting for results (raw-markup recovery, relays that execute nothing)
    // keeps its follow-up turn.
    const shouldTerminateBridgedProviderNativeToolCall = async (
      assistant: AssistantMessage,
      toolCall: ToolCall,
    ) => {
      if (!shouldSilenceProviderNativeToolCall(toolCall)) return false;
      if (assistant.stopReason !== "stop") return false;
      if (assistantVisibleAnswerText(assistant).length === 0) return false;
      if (isProviderNativeWebSearchToolName(toolCall.name)) {
        // Await the round's probe finalization (message_end already queued this
        // exact promise) so the coverage decision reads the complete in-band
        // search metadata instead of racing the response-clone parser.
        const blocks = await finishHostedSearchRound(currentRound, "completed");
        return blocks.some((block) => block.status === "completed" && block.sources.length > 0);
      }
      // web_fetch bridges never add new information; once the model has
      // delivered its answer there is nothing for a follow-up turn to do.
      return true;
    };
    const toolsSuffix = buildToolsSuffix(
      params.workdir,
      llmTools.map((tool) => tool.name),
      params.runtimePlatform,
      params.additionalRoots,
    );
    let currentSystemPrompt = params.context.systemPrompt;
    let pendingTurnOverridePromise: Promise<TurnContextOverride> | null = null;
    let emittedBaselineIndex = params.context.messages.length;
    let latestAgentEndMessages: Message[] = [];
    // 尾部投递文本的累积器：只进出站请求，永不进 agent.state.messages。
    // 语义：带 wireTailText 的 override 追加（按到达顺序、\n\n 连接）；不带
    // wireTailText 的 override 清空——不带的只有压缩/重冻结分支，此时快照已
    // 重算进 systemPrompt，旧尾部内容已被快照覆盖，继续挂只会重复投递。
    let accumulatedWireTailText = "";
    let agentTools: AgentTool<any>[] = [];
    const pendingRecoveredSeedTurnRef: {
      current: {
        round: number;
        assistant: AssistantMessage;
        toolCalls: ToolCall[];
      } | null;
    } = {
      current: null,
    };
    let agent: Agent | null = null;
    const hostedSearchBlocksByRound = new Map<number, HostedSearchBlock[]>();
    const hostedSearchOrderedBlocksByRound = new Map<number, HostedSearchOrderedBlock[]>();
    const hostedSearchProbeByRound = new Map<
      number,
      {
        finishProbe: () => Promise<void>;
        completeAggregator: () => HostedSearchBlock[];
        failAggregator: () => HostedSearchBlock[];
        disposeAggregator: () => HostedSearchBlock[];
        finalization?: Promise<HostedSearchBlock[]>;
      }
    >();
    const hostedSearchFinalizations = new Set<Promise<void>>();

    function upsertHostedSearchBlockForRound(round: number, hostedSearch: HostedSearchBlock) {
      const blocks = hostedSearchBlocksByRound.get(round) ?? [];
      const idx = blocks.findIndex((block) => block.id === hostedSearch.id);
      const next = blocks.slice();
      if (idx >= 0) {
        next[idx] = mergeHostedSearchBlocks(next[idx], hostedSearch);
      } else {
        next.push(hostedSearch);
      }
      hostedSearchBlocksByRound.set(round, next);
    }

    function getHostedSearchOrderedBlocksForRound(round: number) {
      const blocks = hostedSearchOrderedBlocksByRound.get(round) ?? [];
      if (!hostedSearchOrderedBlocksByRound.has(round)) {
        hostedSearchOrderedBlocksByRound.set(round, blocks);
      }
      return blocks;
    }

    function appendHostedSearchOrderedTextForRound(round: number, delta: string) {
      if (!delta) return;
      const blocks = getHostedSearchOrderedBlocksForRound(round);
      const last = blocks[blocks.length - 1];
      if (last?.kind === "text") {
        blocks[blocks.length - 1] = {
          kind: "text",
          text: last.text + delta,
        };
      } else {
        blocks.push({ kind: "text", text: delta });
      }
    }

    function upsertHostedSearchOrderedBlockForRound(
      round: number,
      hostedSearch: HostedSearchBlock,
    ) {
      const blocks = getHostedSearchOrderedBlocksForRound(round);
      const idx = blocks.findIndex(
        (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
      );
      if (idx >= 0) {
        const existing = blocks[idx];
        if (existing?.kind === "hostedSearch") {
          blocks[idx] = {
            kind: "hostedSearch",
            item: mergeHostedSearchBlocks(existing.item, hostedSearch),
          };
        }
        return;
      }
      blocks.push({ kind: "hostedSearch", item: hostedSearch });
    }

    function getHostedSearchBlocksForRound(round: number) {
      return hostedSearchBlocksByRound.get(round) ?? [];
    }

    function finishHostedSearchRound(
      round: number,
      mode: "completed" | "failed" | "dispose",
    ): Promise<HostedSearchBlock[]> {
      const controller = hostedSearchProbeByRound.get(round);
      if (!controller) return Promise.resolve(getHostedSearchBlocksForRound(round));
      if (!controller.finalization) {
        controller.finalization = (async () => {
          await controller.finishProbe();
          const blocks =
            mode === "completed"
              ? controller.completeAggregator()
              : mode === "failed"
                ? controller.failAggregator()
                : controller.disposeAggregator();
          hostedSearchProbeByRound.delete(round);
          if (blocks.length > 0) {
            hostedSearchBlocksByRound.set(round, blocks);
          }
          return getHostedSearchBlocksForRound(round);
        })();
      }
      return controller.finalization;
    }

    function replaceAgentStateMessage(target: Message, replacement: Message) {
      const currentAgent = agent;
      if (!currentAgent) return false;
      const stateMessages = getAgentMessages(currentAgent);
      let targetIndex = stateMessages.lastIndexOf(target);
      if (targetIndex < 0) {
        for (let index = stateMessages.length - 1; index >= 0; index -= 1) {
          const message = stateMessages[index];
          if (!message) continue;
          if (message.role !== target.role) continue;
          if (message.role !== "assistant" || target.role !== "assistant") continue;
          if (
            typeof message.timestamp === "number" &&
            typeof target.timestamp === "number" &&
            message.timestamp === target.timestamp
          ) {
            targetIndex = index;
            break;
          }
        }
      }
      if (targetIndex < 0) return false;
      currentAgent.state.messages = [
        ...stateMessages.slice(0, targetIndex),
        replacement,
        ...stateMessages.slice(targetIndex + 1),
      ];
      return true;
    }

    function applyHostedSearchBlocksToAssistant(
      assistant: AssistantMessage,
      round: number,
      hostedSearchBlocks: HostedSearchBlock[],
    ) {
      return appendHostedSearchBlocksToAssistant(
        assistant as AssistantMessage & { content: unknown[] },
        hostedSearchBlocks,
        {
          orderedBlocks: hostedSearchOrderedBlocksByRound.get(round),
        },
      ) as AssistantMessage;
    }

    function queueHostedSearchFinalization(
      round: number,
      mode: "completed" | "failed" | "dispose",
      assistantRef?: { current: AssistantMessage },
    ) {
      const finalization = finishHostedSearchRound(round, mode)
        .then((hostedSearchBlocks) => {
          if (!assistantRef) return;
          const nextAssistant = applyHostedSearchBlocksToAssistant(
            assistantRef.current,
            round,
            hostedSearchBlocks,
          );
          if (nextAssistant === assistantRef.current) return;
          if (replaceAgentStateMessage(assistantRef.current, nextAssistant)) {
            assistantRef.current = nextAssistant;
          }
        })
        .catch(() => undefined);
      hostedSearchFinalizations.add(finalization);
      void finalization.finally(() => {
        hostedSearchFinalizations.delete(finalization);
      });
    }

    function queueAllHostedSearchFinalizations(mode: "completed" | "failed" | "dispose") {
      for (const round of [...hostedSearchProbeByRound.keys()]) {
        queueHostedSearchFinalization(round, mode);
      }
    }

    async function waitForHostedSearchFinalizations() {
      while (hostedSearchFinalizations.size > 0) {
        await Promise.allSettled([...hostedSearchFinalizations]);
      }
    }

    async function consumePendingTurnOverride(): Promise<TurnContextOverride> {
      const pending = pendingTurnOverridePromise;
      if (!pending) return null;
      pendingTurnOverridePromise = null;
      return pending;
    }

    function applyTurnContextOverride(override: Exclude<TurnContextOverride, null>) {
      if (!agent) return;
      if (override.wireTailText) {
        accumulatedWireTailText = accumulatedWireTailText
          ? `${accumulatedWireTailText}\n\n${override.wireTailText}`
          : override.wireTailText;
      } else {
        // 见 accumulatedWireTailText 声明处的语义说明：压缩/重冻结分支不带
        // wireTailText，旧尾部内容已并入重算后的快照，累积必须清空。
        accumulatedWireTailText = "";
      }
      currentSystemPrompt = override.context.systemPrompt;
      agent.state.systemPrompt = buildSystemPrompt(currentSystemPrompt, toolsSuffix);
      agent.state.messages = override.context.messages.slice();
      agent.state.tools = agentTools;
      emittedBaselineIndex = Math.max(
        0,
        override.context.messages.length - override.emittedMessages.length,
      );
      latestAgentEndMessages = [];
    }

    const visibleAgentTools: AgentTool<any>[] = llmTools.map((tool) => ({
      ...tool,
      label: tool.name,
      async execute(toolCallId, toolArgs, signal) {
        const toolCall = toSyntheticToolCall({
          id: toolCallId,
          name: tool.name,
          arguments: (toolArgs ?? {}) as Record<string, unknown>,
        });
        toolCallsById.set(toolCall.id, toolCall);

        if (tool.name === "Bash" || tool.name === "Agent") {
          const batchKey = parallelBatchKeyByToolCallId.get(toolCallId);
          if (batchKey) {
            const batch = startParallelToolBatchIfNeeded(batchKey, signal);
            const toolResult = batch?.resultPromises.get(toolCallId);
            if (toolResult) {
              const resolved = await toolResult;
              toolResultErrorFlags.set(toolCallId, Boolean(resolved.isError));
              return {
                content: resolved.content,
                details: resolved.details ?? {},
              };
            }
          }
        }

        return executeSingleToolCall(toolCall, signal);
      },
    }));
    const hiddenProviderNativeWebSearchAgentTools: AgentTool<any>[] = [
      ...hiddenProviderNativeWebSearchToolNames,
    ].map((name) => ({
      name,
      label: name,
      description: "Internal provider-native web search bridge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          search_query: { type: "string" },
          additionalContext: { type: "string" },
        },
        additionalProperties: true,
      },
      async execute(toolCallId, toolArgs, signal) {
        const toolCall = toSyntheticToolCall({
          id: toolCallId,
          name,
          arguments: (toolArgs ?? {}) as Record<string, unknown>,
        });
        toolCallsById.set(toolCall.id, toolCall);
        return executeSingleToolCall(toolCall, signal);
      },
    }));
    // Registered so pi-agent-core resolves leaked provider-native web_fetch
    // calls instead of erroring with "Tool web_fetch not found"; execution
    // routes into the silent bridge above.
    const hiddenProviderNativeWebFetchAgentTools: AgentTool<any>[] = [
      ...hiddenProviderNativeWebFetchToolNames,
    ].map((name) => ({
      name,
      label: name,
      description: "Internal provider-native web fetch bridge.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        additionalProperties: true,
      },
      async execute(toolCallId, toolArgs, signal) {
        const toolCall = toSyntheticToolCall({
          id: toolCallId,
          name,
          arguments: (toolArgs ?? {}) as Record<string, unknown>,
        });
        toolCallsById.set(toolCall.id, toolCall);
        return executeSingleToolCall(toolCall, signal);
      },
    }));
    agentTools = [
      ...visibleAgentTools,
      ...hiddenProviderNativeWebSearchAgentTools,
      ...hiddenProviderNativeWebFetchAgentTools,
    ];

    let streamRound = 0;
    const streamFn = (streamModel: typeof model, streamContext: Context, options?: any) => {
      const round = ++streamRound;
      const retryAttemptsForRound: RetryAttemptRecord[] = [];
      params.onRetryAttempts?.(round, retryAttemptsForRound);
      const streamTools =
        streamContext.tools ?? (agent?.state.tools as Context["tools"] | undefined) ?? llmTools;
      // 尾部投递内容只存在于出站请求：每次请求在此重挂（与记忆增量的逐请求
      // 重建同口径），agent.state.messages 始终不含它。挂在 sanitize 之前、
      // capturePrefixShape 之后读取 effectiveContext，归因看到的就是真实出站字节。
      const outboundMessages = accumulatedWireTailText
        ? appendToolResultTailBlock(streamContext.messages.slice(), accumulatedWireTailText)
        : streamContext.messages.slice();
      const effectiveContext = sanitizeContextForModelRequest({
        ...streamContext,
        // Keep the runtime-only tool rules out of compaction and persistence,
        // then reattach them at the provider boundary on every model round.
        systemPrompt: buildSystemPrompt(currentSystemPrompt, toolsSuffix),
        messages: outboundMessages,
        tools: filterRequestTools(streamTools),
      });

      // pi-agent-core passes the agent-state model; honor it for the primary
      // target so external model swaps keep working through the failover path.
      const primaryRoundTarget: PreparedFailoverTarget =
        streamModel === model ? primaryTarget : { ...primaryTarget, model: streamModel };

      // 哈希只在请求边界算一次:同一轮内的 failover / 重试复用同一份归因,
      // 更不能进流式回调 —— 那会让开销随 token 数放大。
      //
      // 缓存参数按主目标口径入账:TTL 或断点策略变化会真实作废缓存,而 system 与
      // tools 的字节可以一模一样,不单独记这一维就会在真出事时报 unchanged。
      // 协议族分发在 providers 层的 describeProviderCacheShape 里收敛,这里只
      // 负责把与注入侧同源的输入(含请求头,x-session-id 已有则以头值为准)递进去。
      const roundCacheRetention =
        options?.cacheRetention ??
        resolveProviderCacheRetention(
          primaryRoundTarget.providerId,
          primaryRoundTarget.runtime.promptCachingEnabled,
          undefined,
          primaryRoundTarget.runtime.promptCacheRetention,
        );
      const roundSessionId = options?.sessionId ?? params.sessionId;
      const prefixShape = capturePrefixShape({
        systemPrompt: effectiveContext.systemPrompt,
        tools: effectiveContext.tools,
        cacheControl: describeProviderCacheShape({
          providerId: primaryRoundTarget.providerId,
          baseUrl: primaryRoundTarget.runtime.baseUrl,
          promptCacheHintMode:
            primaryRoundTarget.runtime.modelConfig?.promptCacheHintMode ??
            primaryRoundTarget.runtime.promptCacheHintMode,
          modelApi: primaryRoundTarget.model.api,
          sessionId: roundSessionId,
          cacheRetention: roundCacheRetention,
          // 与下方 streamOptions 的 headers 合并口径一致:注入侧看到的就是这份。
          headers: {
            ...(options?.headers ?? {}),
            ...primaryRoundTarget.proxyRequest.headers,
          },
        }),
      });
      const prefixCacheDiagnostics = comparePrefixShape(
        readPreviousPrefixShape(roundSessionId),
        prefixShape,
      );
      recordPrefixShape(roundSessionId, prefixShape);

      const buildTargetRoundStream = (target: PreparedFailoverTarget) => {
        const targetModel = target.model;
        const fallbackReasoning =
          target.providerId === "claude_code" || target.providerId === "gemini"
            ? toSimpleStreamReasoning(target.runtime.reasoning)
            : targetModel.api === "openai-responses" || targetModel.api === "openai-completions"
              ? toSimpleStreamReasoning(target.runtime.reasoning)
              : undefined;
        const targetNativeWebSearchStatus =
          target.index === 0
            ? nativeWebSearchStatus
            : resolveProviderNativeWebSearchStatus({
                providerId: target.providerId,
                api: targetModel.api,
                enabled: params.nativeWebSearch,
                baseUrl: target.runtime.baseUrl,
                modelId: target.modelId,
              });
        const shouldProbeHostedSearch = Boolean(targetNativeWebSearchStatus);
        const hostedSearchProbeId = shouldProbeHostedSearch
          ? createHostedSearchProbeId(target.providerId)
          : undefined;
        let streamOptions: StreamOptionsEx = {
          ...(options ?? {}),
          apiKey: options?.apiKey ?? target.runtime.apiKey,
          headers: withHostedSearchProbeHeader(
            {
              ...(options?.headers ?? {}),
              ...target.proxyRequest.headers,
            },
            hostedSearchProbeId,
          ),
          signal: options?.signal,
          sessionId: options?.sessionId ?? params.sessionId,
          cacheRetention:
            options?.cacheRetention ??
            resolveProviderCacheRetention(
              target.providerId,
              target.runtime.promptCachingEnabled,
              undefined,
              target.runtime.promptCacheRetention,
            ),
          metadata: buildProviderRequestMetadata(target.providerId, params.sessionId),
          toolChoice: options?.toolChoice ?? (effectiveContext.tools?.length ? "auto" : undefined),
          reasoning: normalizeStreamReasoning(options?.reasoning) ?? fallbackReasoning,
          streamRetry: {
            onRetry: (attempt, maxAttempts, errorMessage) => {
              params.onToolStatus?.(
                `第 ${round} 轮：连接已断开，正在重试 (${attempt}/${maxAttempts})...`,
              );
              retryAttemptsForRound.push({ attempt, maxAttempts, errorMessage });
              params.onRetryAttempts?.(round, retryAttemptsForRound.slice());
            },
            onRetryRecovered: () => {
              params.onToolStatus?.(`第 ${round} 轮：模型生成中...`);
            },
          },
        };

        streamOptions = finalizeProviderStreamOptions({
          providerId: target.providerId,
          baseUrl: target.runtime.baseUrl,
          options: streamOptions,
          context: effectiveContext,
          model: targetModel,
          workdir: params.workdir,
          nativeWebSearch: params.nativeWebSearch,
          promptCacheHintMode:
            target.runtime.modelConfig?.promptCacheHintMode ?? target.runtime.promptCacheHintMode,
          debugLogger: params.debugLogger,
          extra: {
            round,
            sessionId: params.sessionId,
          },
        });

        // A discarded failover attempt for this round may have left a live
        // probe/aggregator behind; finish it quietly and drop its blocks so
        // the winning attempt starts from a clean slate.
        const staleProbe = hostedSearchProbeByRound.get(round);
        if (staleProbe) {
          hostedSearchProbeByRound.delete(round);
          hostedSearchBlocksByRound.delete(round);
          hostedSearchOrderedBlocksByRound.delete(round);
          void staleProbe
            .finishProbe()
            .then(() => staleProbe.disposeAggregator())
            .catch(() => undefined);
        }

        const hostedSearchAggregator = createHostedSearchEventAggregator({
          providerId: target.providerId,
          onHostedSearch: (hostedSearch) => {
            if (hostedSearch.status === "searching") {
              nativeWebSearchStatusController.schedule();
            } else {
              nativeWebSearchStatusController.pause();
            }
            upsertHostedSearchBlockForRound(round, hostedSearch);
            upsertHostedSearchOrderedBlockForRound(round, hostedSearch);
            params.onHostedSearch?.(hostedSearch, round);
          },
        });
        const hostedSearchProbe = startHostedSearchFetchProbe({
          providerId: target.providerId,
          sessionId: params.sessionId,
          requestId: hostedSearchProbeId,
          enabled: shouldProbeHostedSearch,
          onRawEvent: hostedSearchAggregator.accept,
        });
        hostedSearchProbeByRound.set(round, {
          finishProbe: hostedSearchProbe.finish,
          completeAggregator: hostedSearchAggregator.complete,
          failAggregator: hostedSearchAggregator.fail,
          disposeAggregator: hostedSearchAggregator.dispose,
        });

        params.debugLogger?.logRequest(
          buildStreamRequestDebugPayload({
            runtime: target.runtime,
            context: effectiveContext,
            options: streamOptions,
            round,
            prefixCache: prefixCacheDiagnostics,
          }),
        );

        return streamSimpleByApi(targetModel, effectiveContext, streamOptions);
      };

      const wrapWithGuard = (stream: ReturnType<typeof streamSimpleByApi>) =>
        wrapStreamWithToolCallArgumentGuard(stream, (toolCall, reason) => {
          incompleteToolCallArguments.set(toolCall.id, reason);
        });

      if (!failoverParams || failoverParams.fallbacks.length === 0) {
        return wrapWithGuard(buildTargetRoundStream(primaryRoundTarget));
      }

      // Candidate order: sticky active target first, then the rest in
      // primary→queue order. Breaker-open targets are skipped inside
      // withProviderFailover.
      const totalTargets = failoverParams.fallbacks.length + 1;
      const targetOrder = [
        activeFailoverTargetIndex,
        ...Array.from({ length: totalTargets }, (_, i) => i).filter(
          (i) => i !== activeFailoverTargetIndex,
        ),
      ];
      const candidates = targetOrder.map((targetIndex) => {
        const fallback = targetIndex === 0 ? null : failoverParams.fallbacks[targetIndex - 1];
        return {
          key:
            targetIndex === 0
              ? primaryTarget.key
              : failoverBreakerKey(
                  fallback?.selectedModel.customProviderId ?? "",
                  fallback?.selectedModel.model ?? "",
                ),
          label: targetIndex === 0 ? primaryTarget.label : (fallback?.label ?? ""),
          model:
            targetIndex === 0
              ? { api: model.api, provider: model.provider, id: model.id }
              : fallbackTargetIdentity(targetIndex),
          start: async () => {
            const target =
              targetIndex === 0 ? primaryRoundTarget : await prepareFallbackTarget(targetIndex);
            return buildTargetRoundStream(target);
          },
        } satisfies ProviderFailoverCandidate;
      });

      const failoverStream = withProviderFailover(candidates, {
        config: failoverParams.config,
        signal: options?.signal,
        onFailover: ({ fromLabel, toLabel, errorMessage }) => {
          lastFailoverErrorMessage = errorMessage;
          params.onToolStatus?.(`第 ${round} 轮：${fromLabel} 不可用，正在切换到 ${toLabel}...`);
        },
        onCommitted: (candidateIndex) => {
          const targetIndex = targetOrder[candidateIndex] ?? activeFailoverTargetIndex;
          if (targetIndex === activeFailoverTargetIndex) return;
          activeFailoverTargetIndex = targetIndex;
          failoverParams.onSwitched?.({
            target: targetIndex === 0 ? null : (failoverParams.fallbacks[targetIndex - 1] ?? null),
            round,
            errorMessage: lastFailoverErrorMessage,
          });
        },
      });
      return wrapWithGuard(failoverStream);
    };

    // A truncated call whose repaired arguments also fail schema validation
    // never reaches beforeToolCall (pi-agent-core validates first), so the
    // model would see a schema error blaming its own call. Rewrite such tool
    // results into the truthful transport-error teaching before the next turn.
    const reconcileTruncatedToolResults = () => {
      if (incompleteToolCallArguments.size === 0) return;
      const messages = getAgentMessages(agent);
      let changed = false;
      const next = messages.map((message) => {
        if (message.role !== "toolResult" || !message.isError) return message;
        const reason = incompleteToolCallArguments.get(message.toolCallId);
        if (!reason) return message;
        incompleteToolCallArguments.delete(message.toolCallId);
        refusedTruncatedToolCallIds.add(message.toolCallId);
        changed = true;
        return {
          ...message,
          content: [
            { type: "text" as const, text: buildTruncatedToolCallText(message.toolName, reason) },
          ],
        };
      });
      if (changed && agent) {
        agent.state.messages = next;
      }
    };

    agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(currentSystemPrompt, toolsSuffix),
        model,
        thinkingLevel,
        tools: agentTools,
        messages: params.context.messages.slice(),
      },
      sessionId: params.sessionId,
      streamFn,
      toolExecution: "sequential",
      afterToolCall: async ({ assistantMessage, toolCall }) => ({
        isError: toolResultErrorFlags.get(toolCall.id) ?? false,
        // The batch only terminates when *every* call terminates, so a real
        // local tool call mixed into the same message keeps the loop running.
        terminate: await shouldTerminateBridgedProviderNativeToolCall(assistantMessage, toolCall),
      }),
      beforeToolCall: async ({ assistantMessage, toolCall }) => {
        const effectiveToolCall = normalizeToolCallNameForExecution(toolCall);
        const effectiveAssistantMessage =
          normalizeAssistantToolCallNamesForExecution(assistantMessage);
        toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
        const truncationReason = incompleteToolCallArguments.get(effectiveToolCall.id);
        if (truncationReason) {
          refusedTruncatedToolCallIds.add(effectiveToolCall.id);
          incompleteToolCallArguments.delete(effectiveToolCall.id);
          return {
            block: true,
            reason: buildTruncatedToolCallText(effectiveToolCall.name, truncationReason),
          };
        }
        // 审批门:对每个工具调用(含 Bash/Agent 批处理成员,均先逐个过此处)在
        // 执行前裁决。deny/未批准 → block,reason 成为该调用的 toolResult。
        // 传入 turn 信号:ask 策略下的挂起审批在 turn 停止时应被中止。
        if (params.resolveToolGate) {
          const gate = await params.resolveToolGate(effectiveToolCall, params.signal);
          if (!gate.allow) {
            return { block: true, reason: gate.reason };
          }
        }
        if (effectiveToolCall.name !== "Agent") {
          return undefined;
        }
        const rawGroup = findConsecutiveToolGroup(
          effectiveAssistantMessage,
          effectiveToolCall.id,
          effectiveToolCall.name,
        );
        if (!rawGroup || rawGroup.length <= 1) return undefined;
        // A member with truncated arguments must not ride into execution on a
        // sibling's batch — it is refused individually by the guard above.
        const group = rawGroup
          .map(normalizeToolCallNameForExecution)
          .filter(
            (call) =>
              !incompleteToolCallArguments.has(call.id) &&
              !refusedTruncatedToolCallIds.has(call.id),
          );
        if (group.length <= 1) return undefined;

        const batchKey = buildParallelToolBatchKey(group);
        if (!parallelToolBatches.has(batchKey)) {
          parallelToolBatches.set(batchKey, {
            toolName: effectiveToolCall.name,
            toolCalls: group,
            started: false,
            announced: false,
            resultPromises: new Map(),
          });
        }
        for (const call of group) {
          parallelBatchKeyByToolCallId.set(call.id, batchKey);
        }
        return undefined;
      },
      transformContext: async (_messages, _signal) => {
        const override = await consumePendingTurnOverride();
        if (override) {
          applyTurnContextOverride(override);
        }
        reconcileTruncatedToolResults();
        return getAgentMessages(agent).slice();
      },
    });

    const textReconciler = createStreamingTextReconciler();

    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          currentRound += 1;
          params.onTurnStart?.(currentRound);
          params.onToolStatus?.(`第 ${currentRound} 轮：模型生成中...`);
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") {
            nativeWebSearchStatusController.noteVisibleActivity();
            const delta = textReconciler.appendDelta(
              `${currentRound}:${streamEvent.contentIndex}`,
              streamEvent.delta,
            );
            if (delta) {
              appendHostedSearchOrderedTextForRound(currentRound, delta);
              params.onTextDelta(delta, currentRound);
            }
          } else if (streamEvent.type === "text_end") {
            const delta = textReconciler.reconcileFinalText(
              `${currentRound}:${streamEvent.contentIndex}`,
              streamEvent.content,
            );
            nativeWebSearchStatusController.pause();
            if (delta) {
              appendHostedSearchOrderedTextForRound(currentRound, delta);
              params.onTextDelta(delta, currentRound);
            }
          } else if (streamEvent.type === "thinking_delta") {
            nativeWebSearchStatusController.noteVisibleActivity();
            params.onThinkingDelta?.(streamEvent.delta, currentRound);
          } else if (streamEvent.type === "thinking_end") {
            nativeWebSearchStatusController.pause();
          } else if (streamEvent.type === "toolcall_start") {
            nativeWebSearchStatusController.pause();
            const block = streamEvent.partial.content[streamEvent.contentIndex];
            if (block && block.type === "toolCall") {
              const effectiveToolCall = normalizeToolCallNameForExecution(block);
              if (effectiveToolCall !== block) {
                streamEvent.partial.content[streamEvent.contentIndex] = effectiveToolCall;
              }
              toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
              if (!shouldSilenceProviderNativeToolCall(effectiveToolCall)) {
                params.onToolCall?.(effectiveToolCall, currentRound);
              }
            }
          } else if (streamEvent.type === "toolcall_delta") {
            nativeWebSearchStatusController.pause();
            const block = streamEvent.partial.content[streamEvent.contentIndex];
            if (block && block.type === "toolCall") {
              const effectiveToolCall = normalizeToolCallNameForExecution(block);
              if (effectiveToolCall !== block) {
                streamEvent.partial.content[streamEvent.contentIndex] = effectiveToolCall;
              }
              toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
              if (!shouldSilenceProviderNativeToolCall(effectiveToolCall)) {
                params.onToolCallDelta?.(effectiveToolCall, currentRound);
              }
            }
          } else if (streamEvent.type === "toolcall_end") {
            nativeWebSearchStatusController.pause();
            const effectiveToolCall = normalizeToolCallNameForExecution(streamEvent.toolCall);
            toolCallsById.set(effectiveToolCall.id, effectiveToolCall);
            if (!shouldSilenceProviderNativeToolCall(effectiveToolCall)) {
              params.onToolCall?.(effectiveToolCall, currentRound);
            }
          }
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") {
            const hostedSearchFinishMode =
              event.message.stopReason === "aborted"
                ? "dispose"
                : event.message.stopReason === "error"
                  ? "failed"
                  : "completed";
            const hostedSearchBlocks = getHostedSearchBlocksForRound(currentRound);
            const assistantWithCanonicalToolNames = normalizeAssistantToolCallNamesForExecution(
              event.message as AssistantMessage,
            );
            const assistantWithHostedSearch = applyHostedSearchBlocksToAssistant(
              assistantWithCanonicalToolNames,
              currentRound,
              hostedSearchBlocks,
            );
            const normalizedSeedTurn = recoverAssistantSeedToolCalls(assistantWithHostedSearch);
            let recoveredSeedToolCalls: ToolCall[] = [];
            let assistantWithRecoveredToolCalls =
              normalizedSeedTurn?.assistant ?? assistantWithHostedSearch;
            if (normalizedSeedTurn) {
              const deduped = dedupeRecoveredToolCallsAgainstExisting({
                existingAssistant: assistantWithHostedSearch,
                recoveredToolCalls: normalizedSeedTurn.toolCalls,
                canonicalizeToolName,
              });
              recoveredSeedToolCalls = deduped.uniqueToolCalls;
              if (deduped.duplicateToolCallIds.size > 0) {
                assistantWithRecoveredToolCalls = {
                  ...assistantWithRecoveredToolCalls,
                  content: assistantWithRecoveredToolCalls.content.filter(
                    (block) =>
                      block.type !== "toolCall" || !deduped.duplicateToolCallIds.has(block.id),
                  ),
                };
              }
            }
            const assistantMessage = normalizeAssistantToolCallNamesForExecution(
              assistantWithRecoveredToolCalls,
            );
            if (
              normalizedSeedTurn ||
              assistantMessage !== event.message ||
              assistantWithHostedSearch !== event.message
            ) {
              const stateMessages = getAgentMessages(agent);
              if (stateMessages.length > 0) {
                agent.state.messages = [...stateMessages.slice(0, -1), assistantMessage];
              }
            }
            if (normalizedSeedTurn && recoveredSeedToolCalls.length > 0) {
              pendingRecoveredSeedTurnRef.current = {
                round: currentRound,
                assistant: assistantMessage,
                toolCalls: recoveredSeedToolCalls,
              };
              params.debugLogger?.logResponse({
                type: "seed_tool_call_recovery",
                round: currentRound,
                toolCalls: recoveredSeedToolCalls,
              });
            }
            queueHostedSearchFinalization(currentRound, hostedSearchFinishMode, {
              current: assistantMessage,
            });
            params.debugLogger?.logResult({
              round: currentRound,
              assistant: assistantMessage,
            });
            const toolCallCount = getAssistantToolCalls(assistantMessage).filter(
              (toolCall) => !shouldSilenceProviderNativeToolCall(toolCall),
            ).length;
            if (toolCallCount > 0) {
              nativeWebSearchStatusController.pause();
              params.onToolStatus?.(`第 ${currentRound} 轮：准备执行 ${toolCallCount} 个工具...`);
            }
            params.onAssistantMessage?.(assistantMessage, currentRound);
          } else if (event.message.role === "toolResult") {
            const toolCall =
              toolCallsById.get(event.message.toolCallId) ??
              toSyntheticToolCall({
                id: event.message.toolCallId,
                name: event.message.toolName,
              });
            if (!shouldSilenceProviderNativeToolCall(toolCall)) {
              params.onToolResult?.(toolCall, event.message, currentRound);
            }
          }
          break;
        case "turn_end": {
          const toolResults = event.toolResults.filter(
            (message): message is ToolResultMessage => message.role === "toolResult",
          );
          if (
            params.onBeforeNextTurn &&
            event.message.role === "assistant" &&
            event.message.stopReason === "toolUse" &&
            toolResults.length > 0
          ) {
            const runtimeMessages = getAgentMessages(agent);
            const runtimeSnapshot: Context = {
              systemPrompt: currentSystemPrompt,
              messages: runtimeMessages.slice(),
              tools: llmTools,
            };
            const emittedSnapshot = getMessagesSinceBaseline(agent, emittedBaselineIndex);
            const assistant = event.message;
            pendingTurnOverridePromise = params.onBeforeNextTurn({
              round: currentRound,
              assistant,
              toolResults,
              runtimeContext: runtimeSnapshot,
              emittedMessages: emittedSnapshot,
              signal: params.signal,
            });
          }
          break;
        }
        case "tool_execution_start": {
          nativeWebSearchStatusController.pause();
          const toolCall =
            toolCallsById.get(event.toolCallId) ??
            toSyntheticToolCall({
              id: event.toolCallId,
              name: event.toolName,
              arguments: event.args ?? {},
            });
          toolCallsById.set(toolCall.id, toolCall);
          if (shouldSilenceProviderNativeToolCall(toolCall)) {
            break;
          }
          const parallelBatch = getParallelToolBatch(
            toolCall.id,
            parallelBatchKeyByToolCallId,
            parallelToolBatches,
          );
          if (parallelBatch && parallelBatch.toolCalls.length > 1) {
            params.onToolStatus?.(getParallelToolBatchStatus(parallelBatch));
          } else {
            params.onToolStatus?.(`正在执行：${summarizeToolCall(toolCall)}`);
          }
          params.onToolExecutionStart?.(toolCall, currentRound);
          break;
        }
        case "agent_end":
          latestAgentEndMessages = event.messages as Message[];
          {
            const assistant = findLastAssistantMessage(latestAgentEndMessages);
            const hostedSearchFinishMode =
              assistant?.stopReason === "aborted"
                ? "dispose"
                : assistant?.stopReason === "error"
                  ? "failed"
                  : "completed";
            queueAllHostedSearchFinalizations(hostedSearchFinishMode);
          }
          nativeWebSearchStatusController.finish();
          params.onToolStatus?.(null);
          break;
      }
    });

    let abortListener: (() => void) | undefined;
    if (params.signal) {
      const onAbort = () => agent.abort();
      params.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => params.signal?.removeEventListener("abort", onAbort);
    }

    try {
      let recoveredSeedTurnCount = 0;
      while (true) {
        throwIfRunnerCancelled(params.signal);
        await agent.continue();
        throwIfRunnerCancelled(params.signal);

        const override = await consumePendingTurnOverride();
        throwIfRunnerCancelled(params.signal);
        if (override) {
          applyTurnContextOverride(override);
        }

        const recoveredSeedTurn = pendingRecoveredSeedTurnRef.current;
        pendingRecoveredSeedTurnRef.current = null;
        if (recoveredSeedTurn === null) {
          break;
        }
        const recoveredSeedRound = recoveredSeedTurn.round;
        const recoveredSeedAssistant = recoveredSeedTurn.assistant;
        const recoveredSeedToolCalls = recoveredSeedTurn.toolCalls;

        recoveredSeedTurnCount += 1;
        if (recoveredSeedTurnCount > 8) {
          throw new Error("Too many seed tool-call recovery attempts");
        }

        const visibleRecoveredSeedToolCalls = recoveredSeedToolCalls.filter(
          (toolCall) => !shouldSilenceProviderNativeToolCall(toolCall),
        );
        if (visibleRecoveredSeedToolCalls.length > 0) {
          params.onToolStatus?.(
            `第 ${recoveredSeedRound} 轮：恢复执行 ${visibleRecoveredSeedToolCalls.length} 个工具...`,
          );
        }

        const syntheticToolResults: ToolResultMessage[] = [];
        for (const toolCall of recoveredSeedToolCalls) {
          throwIfRunnerCancelled(params.signal);
          toolCallsById.set(toolCall.id, toolCall);
          const shouldSilenceToolCall = shouldSilenceProviderNativeToolCall(toolCall);
          if (!shouldSilenceToolCall) {
            params.onToolCall?.(toolCall, recoveredSeedRound);
            params.onToolStatus?.(`正在执行：${summarizeToolCall(toolCall)}`);
            params.onToolExecutionStart?.(toolCall, recoveredSeedRound);
          }

          const result = await executeSingleToolCall(toolCall, params.signal);
          throwIfRunnerCancelled(params.signal);
          const toolResult = {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            details: result.details,
            isError: toolResultErrorFlags.get(toolCall.id) ?? false,
            timestamp: Date.now(),
          } satisfies ToolResultMessage;

          syntheticToolResults.push(toolResult);
          if (!shouldSilenceToolCall) {
            params.onToolResult?.(toolCall, toolResult, recoveredSeedRound);
          }
        }

        if (syntheticToolResults.length > 0) {
          agent.state.messages = [...getAgentMessages(agent), ...syntheticToolResults];
        }

        if (params.onBeforeNextTurn) {
          throwIfRunnerCancelled(params.signal);
          pendingTurnOverridePromise = params.onBeforeNextTurn({
            round: recoveredSeedRound,
            assistant: recoveredSeedAssistant,
            toolResults: syntheticToolResults,
            runtimeContext: {
              systemPrompt: currentSystemPrompt,
              messages: getAgentMessages(agent).slice(),
              tools: llmTools,
            },
            emittedMessages: getMessagesSinceBaseline(agent, emittedBaselineIndex),
            signal: params.signal,
          });
        }
      }

      throwIfRunnerCancelled(params.signal);
      await waitForHostedSearchFinalizations();
      throwIfRunnerCancelled(params.signal);

      const messages = getAgentMessages(agent).slice();
      const assistant =
        findLastAssistantMessage(messages) ?? findLastAssistantMessage(latestAgentEndMessages);

      if (!assistant) {
        throw new Error("Model did not return an assistant message");
      }

      if (assistant.stopReason === "error") {
        throw new Error(normalizeErrorMessage(assistant.errorMessage, "Request failed"));
      }
      if (assistant.stopReason === "aborted") {
        throw new Error(normalizeErrorMessage(assistant.errorMessage, "Cancelled"));
      }

      await params.debugLogger?.flush();
      return {
        messages,
        assistant,
        emittedMessages: getMessagesSinceBaseline(agent, emittedBaselineIndex),
      };
    } catch (error) {
      queueAllHostedSearchFinalizations(params.signal?.aborted ? "dispose" : "failed");
      await waitForHostedSearchFinalizations();
      nativeWebSearchStatusController.finish();
      params.onToolStatus?.(null);
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    } finally {
      queueAllHostedSearchFinalizations("dispose");
      await waitForHostedSearchFinalizations();
      nativeWebSearchStatusController.finish();
      abortListener?.();
      unsubscribe();
    }
  });
}
