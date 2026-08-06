import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  ModelThinkingLevel,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { buildStreamRequestDebugPayload, type StreamDebugLogger } from "../../debug/agentDebug";
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
import type { RetryAttemptRecord } from "../../providers/runtime/streamRetry";
import type { RuntimePlatform } from "../../runtimePlatform";
import type { ProviderId, ReasoningLevel } from "../../settings";
import type { ToolStatus } from "../../protocol/wireEvents";
import { createSubagentScheduler, type SubagentScheduler } from "../../subagents/scheduler";
import { withPowerActivity } from "../../system/powerActivity";
import { sanitizeContextForModelRequest } from "../context/requestContextSanitizer";
import {
  appendHostedSearchBlocksToAssistant,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
  mergeHostedSearchBlocks,
} from "../messages/hostedSearch";
import { summarizeToolCall } from "../messages/uiMessages";
import {
  createDeferredProviderNativeWebSearchStatus,
  resolveProviderNativeWebSearchStatus,
} from "../search/providerNativeSearchStatus";
import { comparableToolCall } from "./flattenedToolCallText";
import { recoverAssistantSeedToolCalls, stripSeedToolCallMarkup } from "./seedToolCalls";
import { wrapStreamWithToolCallArgumentGuard } from "./toolCallArgumentGuard";
import { buildToolsSuffix } from "./toolsPrompt";

// 提示词模板已移到 ./toolsPrompt，这里保持原有导出名以免影响既有引用。
export { buildToolsSuffix };

function throwIfRunnerCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Cancelled");
  }
}

// 0 个信号返回 undefined（调用方据此完全不传 signal），1 个原样透传避免多包一层，
// 2 个以上交给平台的 AbortSignal.any——它自行管理监听器生命周期，无需手工 cleanup。
function linkAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = Array.from(
    new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal))),
  );
  return activeSignals.length <= 1 ? activeSignals[0] : AbortSignal.any(activeSignals);
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runLoop = async () => {
    for (let idx = nextIndex++; idx < items.length; idx = nextIndex++) {
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runLoop));
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

function getParallelToolBatchStatus(batch: ParallelToolBatch): ToolStatus {
  return {
    kind: "parallel_tools_running",
    tool_name: batch.toolName,
    count: batch.toolCalls.length,
  };
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

type ToolExecutionEventContext = {
  parentToolCall: ToolCall;
  subagentScheduler: SubagentScheduler;
  emitToolCall: (toolCall: ToolCall) => void;
  emitToolExecutionStart: (toolCall: ToolCall) => void;
  emitToolResult: (toolCall: ToolCall, toolResult: ToolResultMessage) => void;
  emitToolStatus: (status: ToolStatus | null) => void;
};

function findLastAssistantMessage(messages: Message[]): AssistantMessage | null {
  return (
    [...messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant") ?? null
  );
}

export async function runAssistantWithTools(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  runtimePlatform?: RuntimePlatform;
  context: Context;
  workdir: string;
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
  } | null>;
  onToolStatus?: (status: ToolStatus | null) => void;
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
      const linkedSignal = linkAbortSignals([signal, params.signal]);
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
            params.executeToolCall(effectiveToolCall, linkedSignal, {
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
              ? subagentScheduler.runBash(execute, linkedSignal)
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
      }
      throwIfRunnerCancelled(linkedSignal);

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
    );
    let currentSystemPrompt = params.context.systemPrompt;
    // Set once onBeforeNextTurn replaces the transcript; until then the emitted
    // tail is simply the loop's newMessages.
    let overriddenEmittedMessages: Message[] | null = null;
    // How much of the loop's newMessages the caller had already seen at the
    // moment of the last override; everything past it is still ours to report.
    let overriddenNewMessagesIndex = 0;
    let latestAgentEndMessages: Message[] = [];
    let agentTools: AgentTool<any>[] = [];
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

    // pi-agent-core hands listeners the live message object: the loop keeps it in
    // its own context array, Agent pushes the same reference into state.messages,
    // and the post-message_end tool-call scan reads it once more. Mutating the
    // message in place therefore reaches every holder at once — which is why no
    // code below ever replaces an entry of either message array.
    function applyHostedSearchBlocksToAssistant(
      assistant: AssistantMessage,
      round: number,
      hostedSearchBlocks: HostedSearchBlock[],
    ) {
      const next = appendHostedSearchBlocksToAssistant(
        assistant as AssistantMessage & { content: unknown[] },
        hostedSearchBlocks,
        {
          orderedBlocks: hostedSearchOrderedBlocksByRound.get(round),
        },
      ) as AssistantMessage;
      if (next !== assistant) {
        assistant.content = next.content;
      }
      return assistant;
    }

    function queueHostedSearchFinalization(
      round: number,
      mode: "completed" | "failed" | "dispose",
      assistant?: AssistantMessage,
    ) {
      const finalization = finishHostedSearchRound(round, mode)
        .then((hostedSearchBlocks) => {
          if (!assistant) return;
          applyHostedSearchBlocksToAssistant(assistant, round, hostedSearchBlocks);
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

    // The loop owns the transcript. `prepareNextTurnWithContext` reports the
    // context it will use for the next request, so out-params read from here
    // rather than from agent.state (which the loop only syncs at message_end).
    let currentLoopMessages: Message[] = params.context.messages.slice();

    function getRuntimeMessages(): Message[] {
      return currentLoopMessages;
    }

    // What this run appended on top of the caller's starting context. Normally
    // that is the loop's own newMessages; after an onBeforeNextTurn override
    // replaced the transcript, it is the tail the caller kept plus everything
    // the loop has appended since that point.
    function getEmittedMessages(): Message[] {
      if (overriddenEmittedMessages === null) return latestAgentEndMessages.slice();
      return [
        ...overriddenEmittedMessages,
        ...latestAgentEndMessages.slice(overriddenNewMessagesIndex),
      ];
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
      const effectiveContext = sanitizeContextForModelRequest({
        ...streamContext,
        // Keep the runtime-only tool rules out of compaction and persistence,
        // then reattach them at the provider boundary on every model round.
        systemPrompt: buildSystemPrompt(currentSystemPrompt, toolsSuffix),
        messages: streamContext.messages.slice(),
        tools: filterRequestTools(streamTools),
      });
      const fallbackReasoning =
        params.providerId === "claude_code" || params.providerId === "gemini"
          ? toSimpleStreamReasoning(params.runtime.reasoning)
          : streamModel.api === "openai-responses" || streamModel.api === "openai-completions"
            ? toSimpleStreamReasoning(params.runtime.reasoning)
            : undefined;
      const shouldProbeHostedSearch = Boolean(nativeWebSearchStatus);
      const hostedSearchProbeId = shouldProbeHostedSearch
        ? createHostedSearchProbeId(params.providerId)
        : undefined;
      let streamOptions: StreamOptionsEx = {
        ...(options ?? {}),
        apiKey: options?.apiKey ?? params.runtime.apiKey,
        headers: withHostedSearchProbeHeader(
          {
            ...(options?.headers ?? {}),
            ...proxyRequest.headers,
          },
          hostedSearchProbeId,
        ),
        signal: options?.signal,
        sessionId: options?.sessionId ?? params.sessionId,
        cacheRetention:
          options?.cacheRetention ??
          resolveProviderCacheRetention(
            params.providerId,
            params.runtime.promptCachingEnabled,
            undefined,
            params.runtime.promptCacheRetention,
          ),
        metadata: buildProviderRequestMetadata(params.providerId, params.sessionId),
        toolChoice: options?.toolChoice ?? (effectiveContext.tools?.length ? "auto" : undefined),
        reasoning: normalizeStreamReasoning(options?.reasoning) ?? fallbackReasoning,
        streamRetry: {
          onRetry: (attempt, maxAttempts, errorMessage) => {
            params.onToolStatus?.({
              kind: "stream_retrying",
              round,
              attempt,
              max_attempts: maxAttempts,
            });
            retryAttemptsForRound.push({ attempt, maxAttempts, errorMessage });
            params.onRetryAttempts?.(round, retryAttemptsForRound.slice());
          },
          onRetryRecovered: () => {
            params.onToolStatus?.({ kind: "model_generating", round });
          },
        },
      };

      streamOptions = finalizeProviderStreamOptions({
        providerId: params.providerId,
        baseUrl: params.runtime.baseUrl,
        options: streamOptions,
        context: effectiveContext,
        model: streamModel,
        workdir: params.workdir,
        nativeWebSearch: params.nativeWebSearch,
        debugLogger: params.debugLogger,
        extra: {
          round,
          sessionId: params.sessionId,
        },
      });

      const hostedSearchAggregator = createHostedSearchEventAggregator({
        providerId: params.providerId,
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
        providerId: params.providerId,
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
          runtime: params.runtime,
          context: effectiveContext,
          options: streamOptions,
          round,
        }),
      );

      const sourceStream = streamSimpleByApi(streamModel, effectiveContext, streamOptions);
      return wrapStreamWithToolCallArgumentGuard(sourceStream, (toolCall, reason) => {
        incompleteToolCallArguments.set(toolCall.id, reason);
      });
    };

    // A truncated call whose repaired arguments also fail schema validation
    // never reaches beforeToolCall (pi-agent-core validates first), so the
    // model would see a schema error blaming its own call. Rewrite such tool
    // results into the truthful transport-error teaching before the next turn.
    // Pure: the rewrite only shapes the outgoing request, so it maps the
    // messages the loop hands us instead of writing back into agent.state.
    const reconcileTruncatedToolResults = (messages: Message[]): Message[] => {
      if (incompleteToolCallArguments.size === 0) return messages;
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
      return changed ? next : messages;
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
      transformContext: async (messages, _signal) => {
        currentLoopMessages = messages as Message[];
        return reconcileTruncatedToolResults(messages as Message[]);
      },
      // Fires right after turn_end, before the loop decides on another request.
      // Returning a context here replaces the loop's own transcript wholesale,
      // which is exactly what mid-run compaction needs — no state rewriting.
      prepareNextTurnWithContext: async (turnContext) => {
        const assistant = turnContext.message;
        const toolResults = turnContext.toolResults;
        currentLoopMessages = turnContext.context.messages as Message[];
        if (
          !params.onBeforeNextTurn ||
          assistant.role !== "assistant" ||
          assistant.stopReason !== "toolUse" ||
          toolResults.length === 0
        ) {
          return undefined;
        }

        const override = await params.onBeforeNextTurn({
          round: currentRound,
          assistant,
          toolResults,
          runtimeContext: {
            systemPrompt: currentSystemPrompt,
            messages: (turnContext.context.messages as Message[]).slice(),
            tools: llmTools,
          },
          emittedMessages: (turnContext.newMessages as Message[]).slice(),
          signal: params.signal,
        });
        if (!override) return undefined;

        currentSystemPrompt = override.context.systemPrompt;
        currentLoopMessages = override.context.messages.slice();
        // newMessages keeps accumulating across the whole run, so it can no
        // longer serve as the "since baseline" cursor once the transcript is
        // replaced. Track the emitted tail explicitly from here on.
        overriddenEmittedMessages = override.emittedMessages.slice();
        overriddenNewMessagesIndex = turnContext.newMessages.length;
        return {
          context: {
            systemPrompt: buildSystemPrompt(currentSystemPrompt, toolsSuffix),
            messages: currentLoopMessages,
            tools: agentTools,
          },
        };
      },
    });

    const textReconciler = createStreamingTextReconciler();

    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          currentRound += 1;
          params.onTurnStart?.(currentRound);
          params.onToolStatus?.({ kind: "model_generating", round: currentRound });
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
            // Every helper below mutates this one object; the loop reads it back
            // immediately after this listener returns to decide what to execute.
            const assistantMessage = event.message as AssistantMessage;
            normalizeAssistantToolCallNamesForExecution(assistantMessage);
            applyHostedSearchBlocksToAssistant(
              assistantMessage,
              currentRound,
              hostedSearchBlocks,
            );

            // Text-shaped tool calls (seed / DeepSeek DSML) are parsed out of the
            // message and spliced in as real toolCall blocks. Because the loop
            // scans this same object once we return, it executes them natively —
            // through beforeToolCall, so the approval gate and the truncated-
            // argument guard apply exactly as they do to structured calls.
            const normalizedSeedTurn = recoverAssistantSeedToolCalls(assistantMessage);
            let recoveredSeedToolCalls: ToolCall[] = [];
            if (normalizedSeedTurn) {
              const deduped = dedupeRecoveredToolCallsAgainstExisting({
                existingAssistant: assistantMessage,
                recoveredToolCalls: normalizedSeedTurn.toolCalls,
                canonicalizeToolName,
              });
              recoveredSeedToolCalls = deduped.uniqueToolCalls;
              assistantMessage.content = normalizedSeedTurn.assistant.content.filter(
                (block) =>
                  block.type !== "toolCall" || !deduped.duplicateToolCallIds.has(block.id),
              );
              normalizeAssistantToolCallNamesForExecution(assistantMessage);
              if (recoveredSeedToolCalls.length > 0) {
                // A "length" stop means the response was cut off, so the markup
                // we just parsed may itself be incomplete — leave that stop
                // reason alone and let the loop refuse the batch.
                if (assistantMessage.stopReason !== "length") {
                  assistantMessage.stopReason = "toolUse";
                }
                params.debugLogger?.logResponse({
                  type: "seed_tool_call_recovery",
                  round: currentRound,
                  toolCalls: recoveredSeedToolCalls,
                });
              }
            }
            queueHostedSearchFinalization(
              currentRound,
              hostedSearchFinishMode,
              assistantMessage,
            );
            params.debugLogger?.logResult({
              round: currentRound,
              assistant: assistantMessage,
            });
            const visibleToolCalls = getAssistantToolCalls(assistantMessage).filter(
              (toolCall) => !shouldSilenceProviderNativeToolCall(toolCall),
            );
            if (visibleToolCalls.length > 0) {
              nativeWebSearchStatusController.pause();
              const visibleRecoveredCount = recoveredSeedToolCalls.filter(
                (toolCall) => !shouldSilenceProviderNativeToolCall(toolCall),
              ).length;
              params.onToolStatus?.(
                visibleRecoveredCount > 0
                  ? {
                      kind: "tools_resuming",
                      round: currentRound,
                      tool_count: visibleRecoveredCount,
                    }
                  : {
                      kind: "tools_preparing",
                      round: currentRound,
                      tool_count: visibleToolCalls.length,
                    },
              );
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
            params.onToolStatus?.({ kind: "tool_running", summary: summarizeToolCall(toolCall) });
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
      throwIfRunnerCancelled(params.signal);
      // One call. Recovered text tool calls, mid-run compaction and follow-up
      // turns are all handled inside the library loop now.
      await agent.continue();
      throwIfRunnerCancelled(params.signal);

      await waitForHostedSearchFinalizations();
      throwIfRunnerCancelled(params.signal);

      const messages = getRuntimeMessages().slice();
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
        emittedMessages: getEmittedMessages(),
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
