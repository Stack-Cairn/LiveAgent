import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { ASK_USER_QUESTION_TOOL_NAME } from "../chat/askUserQuestion";
import type { CompactionController } from "../chat/compaction/controller";
import { estimateTextTokenUnits } from "../chat/compaction/tokenLedger";
import type { ProviderRuntimeConfig } from "../chat/compaction/types";
import {
  isAbortedAssistantMessage,
  type SuppressedToolTraceSnapshot,
} from "../chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  type ConversationViewState,
} from "../chat/conversation/conversationState";
import type {
  LiveTranscriptStore,
  RetryAttemptRecord,
} from "../chat/conversation/liveTranscriptStore";
import type {
  ConversationHookLifecycle,
  GatewayBridgeEventController,
} from "../chat/conversation/run";
import type { TurnCancellation } from "../chat/conversation/turnCancellation";
import { memoryExtraction } from "../chat/memory/extractionController";
import type {
  MemoryExtractionModelConfig,
  MemoryExtractionStatusText,
  MemoryExtractionVisibleEvents,
} from "../chat/memory/extractionEngine";
import type { HostedSearchBlock } from "../chat/messages/hostedSearch";
import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  attachToolResultToRound,
  collapseThinking,
  type LiveRound,
  markToolCallRunningInRound,
  updateLiveRound,
  upsertHostedSearchToRound,
  upsertToolCallToRound,
} from "../chat/messages/uiMessages";
import { runAssistantWithTools } from "../chat/runner/agentRunner";
import type { StreamDebugLogger } from "../debug/agentDebug";
import { assistantMessageToText } from "../providers/llm";
import type { ToolStatus } from "../protocol/wireEvents";
import { resolveRuntimePlatform } from "../runtimePlatform";
import {
  type AppSettings,
  type McpSettingsOp,
  type ProviderId,
  type SshHostConfig,
  selectEnabledMcpServers,
  workspaceProjectPathKey,
} from "../settings";
import {
  AGENT_TOOL_NAME,
  createSubagentScheduler,
  isSubagentCardToolCall,
  type SubagentConversationStore,
  type SubagentTemplate,
} from "../subagents";
import { buildBuiltinToolRegistry } from "../tools/builtinRegistry";
import type { BuiltinToolExecutionContext } from "../tools/builtinTypes";
import { createFileToolState } from "../tools/fileToolState";
import type { SkillAccessPolicy } from "../tools/skillAccessPolicy";
import type { SshManagerSessionChange } from "../tools/sshManagerTools";
import { getOrCreateTodoToolState } from "../tools/todoTools";
import { isSessionApproved, requestToolApproval } from "../tools/toolApproval";
import { resolveToolPolicy } from "../tools/toolPolicy";
import type { TunnelManagerChange } from "../tools/tunnelManagerTools";
import { buildPartialAssistantMessage } from "./chatPageRuntime";
import { buildWireToolCall, summarizeToolCallForApproval } from "./gatewayToolPreview";

export type RuntimeModel = {
  api: AssistantMessage["api"];
  provider: AssistantMessage["provider"];
  id: string;
};

export type PersistConversationParams = {
  conversationId: string;
  sessionId: string;
  providerId: string;
  model: string;
  cwd?: string;
  state: ConversationViewState;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
};

const AGENT_PERF_LOG_THRESHOLD_MS = 250;

function perfNowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function scheduleToolCallDeltaFlush(callback: () => void) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const run = () => {
    if (finished) return;
    finished = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    callback();
  };

  // Node 环境下简化为纯 setTimeout，无需 requestAnimationFrame 优化
  timeoutId = setTimeout(run, 0);

  return () => {
    if (finished) return;
    finished = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

function finishAgentPerfSpan(
  logger: StreamDebugLogger,
  span: string,
  startedAt: number,
  fields: Record<string, unknown> = {},
  thresholdMs = AGENT_PERF_LOG_THRESHOLD_MS,
) {
  const durationMs = Math.round(perfNowMs() - startedAt);
  const payload = {
    type: "perf_span",
    span,
    durationMs,
    ...fields,
  };
  if (logger.enabled) {
    logger.logResult(payload);
  }
  if (durationMs >= thresholdMs) {
    console.warn(`[Agent perf] ${span} took ${durationMs}ms`, fields);
  }
  return durationMs;
}

// The parent Agent call is suppressed in favor of the per-agent cards; a
// rejected batch (error result) stays visible so validation failures are
// never silent.
function shouldShowToolEvent(toolCall: ToolCall, toolResult?: ToolResultMessage) {
  if (toolCall.name !== AGENT_TOOL_NAME) return true;
  if (isSubagentCardToolCall(toolCall)) return true;
  return toolResult?.isError === true;
}

export type RunAgentConversationTurnParams = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  runtimeModel: RuntimeModel;
  selectedModel: {
    customProviderId: string;
    model: string;
  };
  effectiveWorkdir: string;
  effectiveSkillsEnabled: boolean;
  /** 缺省不注册 Agent/SendMessage(cron 等无人值守场景)。 */
  subagentStore?: SubagentConversationStore;
  subagentTemplates?: SubagentTemplate[];
  showSilentMemoryExtraction: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  getMcpSettings: () => AppSettings["mcp"];
  /** 工具审批策略的实时读取(权威 settingsRef,非 turn 级快照),缺省视为空表。 */
  getToolPolicies?: () => AppSettings["system"]["toolPolicies"];
  applyMcpOps?: (ops: McpSettingsOp[]) => void;
  remoteWebTunnelsEnabled?: boolean;
  tunnelPublicBaseUrl?: string;
  onTunnelsChanged?: (change: TunnelManagerChange) => void;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  sshManagerRemoteAllowed?: boolean;
  onSshSessionsChanged?: (change: SshManagerSessionChange) => void;
  sessionId: string;
  conversationId: string;
  conversationCwd?: string;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  transcriptStore: LiveTranscriptStore;
  gatewayBridgeEvents: GatewayBridgeEventController;
  hookLifecycle: ConversationHookLifecycle;
  conversationDebugLogger: StreamDebugLogger;
  getNextConversationState: () => ConversationViewState;
  applyConversationState: (state: ConversationViewState) => void;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
  ) => Context;
  compaction: CompactionController;
  cancellation: TurnCancellation;
  resetLiveTranscript: (store: LiveTranscriptStore) => void;
  settleLiveTranscript: (store: LiveTranscriptStore) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
  ) => void;
  updateToolStatus: (status: ToolStatus | null, store: LiveTranscriptStore) => void;
  updateRetryAttempts: (attempts: RetryAttemptRecord[], store: LiveTranscriptStore) => void;
  updatePersistableAgentProgress: (progress: {
    completedThroughRound: number;
    suppressedToolTrace: SuppressedToolTraceSnapshot[];
  }) => void;
  commitVisibleAbortedConversation: () => boolean;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  memoryExtractionModel?: MemoryExtractionModelConfig;
  onMemoryExtractionModelFailure?: (model: MemoryExtractionModelConfig) => void;
  memoryExtractionStatusText?: MemoryExtractionStatusText;
};

export async function runAgentConversationTurn(params: RunAgentConversationTurnParams) {
  const {
    providerId,
    model,
    runtime,
    runtimeModel,
    selectedModel,
    effectiveWorkdir,
    effectiveSkillsEnabled,
    subagentStore,
    subagentTemplates,
    showSilentMemoryExtraction,
    skillsRootDir,
    skillAccessPolicy,
    onManagedSkillsChanged,
    getMcpSettings,
    getToolPolicies,
    applyMcpOps,
    remoteWebTunnelsEnabled,
    tunnelPublicBaseUrl,
    onTunnelsChanged,
    sshHosts,
    associatedSshHostIds,
    sshManagerRemoteAllowed,
    onSshSessionsChanged,
    sessionId,
    conversationId,
    conversationCwd,
    fallbackTitle,
    createdAt,
    titlePromise,
    transcriptStore,
    gatewayBridgeEvents,
    hookLifecycle,
    conversationDebugLogger,
    getNextConversationState,
    applyConversationState,
    buildPreparedContext,
    compaction,
    cancellation,
    resetLiveTranscript,
    settleLiveTranscript,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
    updatePersistableAgentProgress,
    commitVisibleAbortedConversation,
    persistConversationWithHistorySync,
    memoryExtractionModel,
    onMemoryExtractionModelFailure,
    memoryExtractionStatusText,
  } = params;

  if (!effectiveWorkdir) {
    throw new Error("Tool mode requires a project directory from the chat sidebar.");
  }

  // Reset per-turn dedup state so <already-written-this-turn> reflects only
  // this turn. In-flight extraction from the previous turn keeps running.
  memoryExtraction.noteTurnBoundary(conversationId);

  const fileState = createFileToolState();
  const todoState = getOrCreateTodoToolState(conversationId);
  const subagentScheduler = createSubagentScheduler();
  const runtimePlatform = await resolveRuntimePlatform();
  const buildRegistryStartedAt = perfNowMs();
  const builtinRegistry = await buildBuiltinToolRegistry({
    workdir: effectiveWorkdir,
    providerId,
    runtimePlatform,
    fileState,
    todoState,
    askUserQuestionConversationId: conversationId,
    skillsEnabled: effectiveSkillsEnabled,
    skillsRootDir,
    skillAccessPolicy,
    onManagedSkillsChanged,
    runtimeScope: "chat",
    subagents: subagentStore
      ? {
          model,
          runtime,
          sessionId,
          templates: subagentTemplates,
          store: subagentStore,
          scheduler: subagentScheduler,
        }
      : undefined,
    currentChatModel: selectedModel,
    getMcpSettings,
    applyMcpOps,
    remoteWebTunnelsEnabled,
    tunnelProjectPathKey: workspaceProjectPathKey(effectiveWorkdir),
    tunnelPublicBaseUrl,
    sshHosts,
    associatedSshHostIds,
    sshManagerRemoteAllowed,
    onSshSessionsChanged,
    onTunnelsChanged,
    onMcpLoadError: (message) => {
      console.warn(`[mcp] 工具加载失败，已跳过并继续对话：${message || "未知错误"}`);
      updateToolStatus({ kind: "mcp_load_error", message }, transcriptStore);
    },
  });
  finishAgentPerfSpan(conversationDebugLogger, "builtin_registry.build", buildRegistryStartedAt, {
    toolCount: builtinRegistry.tools.length,
    enabledMcpServerCount: selectEnabledMcpServers(getMcpSettings()).length,
  });
  // 策略为 deny 的工具干脆不发给模型:省 token,且模型不会白白尝试再被拦。
  // resolveToolGate 的 deny 分支保留为后备(理论上模型已看不到,不会触发)。
  const toolPoliciesSnapshot = getToolPolicies?.();
  const combinedTools = builtinRegistry.tools.filter(
    (tool) =>
      resolveToolPolicy(
        tool.name,
        builtinRegistry.metadataByName.get(tool.name),
        toolPoliciesSnapshot,
      ) !== "deny",
  );

  const preCompactionStartedAt = perfNowMs();
  await compaction.maybeCompactPreSend({
    budgetContext: buildPreparedContext(getNextConversationState(), combinedTools, {
      includeUploadedFilesMetadata: true,
    }),
    tools: combinedTools,
    includeUploadedFilesMetadata: true,
  });
  finishAgentPerfSpan(
    conversationDebugLogger,
    "conversation.pre_compaction",
    preCompactionStartedAt,
    {
      toolCount: combinedTools.length,
    },
  );

  const combinedExecutor: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: BuiltinToolExecutionContext,
  ) => Promise<Message> = (tc, signal, context) =>
    builtinRegistry.executeToolCall(tc, signal, context);

  // 工具审批门:按实时策略裁决每次调用。deny → 直接拦;ask → 挂起等用户在
  // 聊天审批卡片作决定(本会话已“记住”的工具免审);allow → 放行。
  const resolveToolGate = async (
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<{ allow: true } | { allow: false; reason: string }> => {
    const policy = resolveToolPolicy(
      toolCall.name,
      builtinRegistry.metadataByName.get(toolCall.name),
      getToolPolicies?.(),
    );
    if (policy === "deny") {
      return {
        allow: false,
        reason: `工具 ${toolCall.name} 已被用户的权限策略禁止(deny)。不要重试;如确需使用,请让用户在设置的工具权限中放行。`,
      };
    }
    if (policy !== "ask") {
      return { allow: true };
    }
    if (isSessionApproved(conversationId, toolCall.name)) {
      return { allow: true };
    }
    // 待审批标记必须走事件流下发,不能只靠运行时快照:审批在 beforeToolCall 处
    // 挂起、不追加任何聊天事件,快照的 as_of_seq 停在上一条 tool_call 事件处,
    // 会被 WebUI「陈旧快照不回滚」的 seq 门丢弃(transcriptStore snapshot 分支)。
    // 补发一条 tool_call 事件即可拿到新 seq:pending 已登记时参数带标记 → 远端
    // 渲染审批卡片;消解后再补发一条(pending 已清)覆盖回无标记 → 卡片隐藏。
    // 桌面本地由 pending 表经 useSyncExternalStore 响应式驱动,不依赖此事件。
    const emitApprovalMarkerEvent = () => {
      if (!shouldShowToolEvent(toolCall)) return;
      gatewayBridgeEvents.queueEvent({
        type: "tool_call",
        round: activeAgentRound,
        tool_call: buildWireToolCall(toolCall),
        conversation_id: conversationId,
      });
    };
    // requestToolApproval 在返回 Promise 前已同步登记 pending,故紧接着的补发
    // 即可读到 pending 并盖上标记;settle 会先删 pending 再 resolve,finally
    // 里的补发因而必得到无标记参数。
    const approvalPromise = requestToolApproval({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      summary: summarizeToolCallForApproval(toolCall),
      conversationId,
      signal,
    });
    emitApprovalMarkerEvent();
    const settlement = await approvalPromise.finally(emitApprovalMarkerEvent);
    if (settlement.kind === "decided" && settlement.decision !== "deny") {
      return { allow: true };
    }
    const reason =
      settlement.kind === "timeout"
        ? `工具 ${toolCall.name} 的审批在等待窗口内未获用户确认,已按拒绝处理。不要重试。`
        : settlement.kind === "cancelled"
          ? `用户在批准 ${toolCall.name} 前停止了本轮。不要假设已获批准。`
          : `用户拒绝了工具 ${toolCall.name} 的执行。不要重试;可改用其他方式或询问用户。`;
    return { allow: false, reason };
  };

  hookLifecycle.startAgent();
  let result: Awaited<ReturnType<typeof runAssistantWithTools>> | null = null;
  let latestAgentEmittedMessages: Message[] = [];
  let suppressedToolTrace: SuppressedToolTraceSnapshot[] = [];
  let activeAgentRound = 0;
  let pendingAgentContext: Context | null = null;
  const pendingTerminalAssistantMetaRef: {
    current: {
      assistant: AssistantMessage;
      round: number;
    } | null;
  } = {
    current: null,
  };

  function publishPersistableAgentProgress(
    round: number,
    assistant: AssistantMessage,
    toolResults: ToolResultMessage[],
  ) {
    const toolResultsById = new Map(
      toolResults.map((toolResult) => [toolResult.toolCallId, toolResult]),
    );
    const roundTrace = assistant.content
      .filter(
        (block): block is ToolCall =>
          block.type === "toolCall" &&
          block.name === AGENT_TOOL_NAME &&
          !isSubagentCardToolCall(block),
      )
      .map((toolCall) => ({
        round,
        toolCall,
        toolResult: toolResultsById.get(toolCall.id),
      }));

    suppressedToolTrace = [
      ...suppressedToolTrace.filter((item) => item.round !== round),
      ...roundTrace,
    ];
    updatePersistableAgentProgress({
      completedThroughRound: round,
      suppressedToolTrace: suppressedToolTrace.slice(),
    });
  }

  function clearPersistableAgentProgress() {
    suppressedToolTrace = [];
    updatePersistableAgentProgress({
      completedThroughRound: 0,
      suppressedToolTrace: [],
    });
  }

  function commitAssistantRoundMeta(assistant: AssistantMessage, round: number) {
    gatewayBridgeEvents.queueRoundMeta(round, {
      provider: assistant.provider,
      model: assistant.model,
      api: assistant.api,
      stopReason: assistant.stopReason,
      usage: assistant.usage,
    });
    batchLiveRoundsUpdate(
      (prev) =>
        updateLiveRound(prev, round, (target) => ({
          ...collapseThinking(target),
          meta: {
            provider: String(assistant.provider ?? ""),
            model: String(assistant.model ?? ""),
            api: String(assistant.api ?? ""),
            stopReason: String(assistant.stopReason ?? ""),
            usage: assistant.usage,
            usageTotalTokens: assistant.usage?.totalTokens,
          },
        })),
      transcriptStore,
    );
  }

  function updateHostedSearch(hostedSearch: HostedSearchBlock, round: number) {
    gatewayBridgeEvents.queueEvent({
      type: "hosted_search",
      round,
      hosted_search: hostedSearch,
      conversation_id: conversationId,
    });
    batchLiveRoundsUpdate((prev) => {
      const withRound = prev.some((item) => item.round === round)
        ? prev
        : [
            ...prev,
            {
              key: `r${round}`,
              round,
              blocks: [],
              runningToolCallIds: [],
              thinkingOpen: false,
            },
          ];
      return updateLiveRound(withRound, round, (target) =>
        upsertHostedSearchToRound(collapseThinking(target), hostedSearch),
      );
    }, transcriptStore);
  }

  const pendingToolCallDeltas = new Map<string, { round: number; toolCall: ToolCall }>();
  let cancelPendingToolCallDeltaFlush: (() => void) | null = null;

  function toolCallDeltaKey(round: number, toolCallId: string) {
    return `${round}:${toolCallId}`;
  }

  function flushPendingToolCallDeltas() {
    cancelPendingToolCallDeltaFlush?.();
    cancelPendingToolCallDeltaFlush = null;
    if (pendingToolCallDeltas.size === 0) return;

    const deltas = Array.from(pendingToolCallDeltas.values());
    pendingToolCallDeltas.clear();

    for (const { round, toolCall } of deltas) {
      gatewayBridgeEvents.queueEvent({
        type: "tool_call",
        round,
        tool_call: buildWireToolCall(toolCall),
        conversation_id: conversationId,
      });
    }

    batchLiveRoundsUpdate((prev) => {
      let next = prev;
      for (const { round, toolCall } of deltas) {
        next = updateLiveRound(next, round, (target) => {
          const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
          return markToolCallRunningInRound(withToolCall, toolCall);
        });
      }
      return next;
    }, transcriptStore);
  }

  function schedulePendingToolCallDeltaFlush() {
    if (cancelPendingToolCallDeltaFlush !== null) return;
    cancelPendingToolCallDeltaFlush = scheduleToolCallDeltaFlush(flushPendingToolCallDeltas);
  }

  function queueToolCallDelta(toolCall: ToolCall, round: number) {
    if (!shouldShowToolEvent(toolCall)) return;
    // 提问卡必须等问题与选项全部生成完毕且工具真正开始执行后再显示：
    // 流式增量与 onToolCall 都只做内部记账，双端统一由
    // onToolExecutionStart 发布可交互卡片。
    if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) return;
    pendingToolCallDeltas.set(toolCallDeltaKey(round, toolCall.id), { round, toolCall });
    schedulePendingToolCallDeltaFlush();
  }

  function discardPendingToolCallDelta(toolCall: ToolCall, round: number) {
    pendingToolCallDeltas.delete(toolCallDeltaKey(round, toolCall.id));
    if (pendingToolCallDeltas.size === 0) {
      cancelPendingToolCallDeltaFlush?.();
      cancelPendingToolCallDeltaFlush = null;
    }
  }

  let midStreamProtectionDisabled = false;
  while (!result) {
    let streamedAgentText = "";
    let streamedAgentTokenUnits = 0;
    let protectionCheckChars = 0;
    let midStreamCompactionRequested = false;
    let sawToolCallInRound = false;
    const nativeWebSearchEnabled = runtime.nativeWebSearchEnabled !== false;
    const agentContext =
      pendingAgentContext ??
      buildPreparedContext(getNextConversationState(), combinedTools, {
        includeUploadedFilesMetadata: true,
      });
    pendingAgentContext = null;
    // 主请求跑在派生 scope 上：mid-stream 压缩只 abort 该 scope，用户停止
    // （userStop）随时链式传导，不存在换代窗口。
    const scope = cancellation.deriveScope();
    compaction.beginRequest(agentContext, getNextConversationState());

    try {
      const assistantRunStartedAt = perfNowMs();
      result = await runAssistantWithTools({
        providerId,
        model,
        runtime,
        runtimePlatform,
        context: agentContext,
        workdir: effectiveWorkdir,
        sessionId,
        nativeWebSearch: nativeWebSearchEnabled,
        tools: combinedTools,
        subagentScheduler,
        executeToolCall: combinedExecutor,
        resolveToolGate,
        onTurnStart: (round) => {
          activeAgentRound = round;
          streamedAgentText = "";
          streamedAgentTokenUnits = 0;
          protectionCheckChars = 0;
          sawToolCallInRound = false;
          hookLifecycle.startTurn(round);
          batchLiveRoundsUpdate(
            (prev) => [
              ...prev,
              {
                key: `r${round}`,
                round,
                blocks: [],
                runningToolCallIds: [],
                thinkingOpen: false,
              },
            ],
            transcriptStore,
          );
        },
        onTextDelta: (delta, round) => {
          gatewayBridgeEvents.queueToken(delta, round);
          streamedAgentText += delta;
          streamedAgentTokenUnits += estimateTextTokenUnits(delta);
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const nextTarget = collapseThinking(target);
                return appendTextDeltaToRound(nextTarget, delta);
              }),
            transcriptStore,
          );

          protectionCheckChars += delta.length;
          if (
            midStreamCompactionRequested ||
            midStreamProtectionDisabled ||
            sawToolCallInRound ||
            protectionCheckChars < 160
          ) {
            return;
          }

          protectionCheckChars = 0;
          // O(1) 账本判定，触发时才 abort 本地 scope 并在 catch 中构建压缩输入。
          if (!compaction.shouldProtectMidStream(streamedAgentTokenUnits)) return;
          midStreamCompactionRequested = true;
          scope.controller.abort();
        },
        onThinkingDelta: (delta, round) => {
          gatewayBridgeEvents.queueEvent({
            type: "thinking_delta",
            round,
            delta,
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => ({
                ...appendThinkingDeltaToRound(target, delta),
                thinkingOpen: true,
              })),
            transcriptStore,
          );
        },
        onHostedSearch: (hostedSearch, round) => {
          updateHostedSearch(hostedSearch, round);
        },
        onToolCall: (toolCall, round) => {
          sawToolCallInRound = true;
          discardPendingToolCallDelta(toolCall, round);
          // isRunning 只表示工具已出现在当前轮次，不代表提问已经进入权威
          // pending 表。提问卡延迟到 onToolExecutionStart，避免用户在
          // executeToolCall 建立 pending 前抢先提交。
          if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) return;
          if (!shouldShowToolEvent(toolCall)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_call",
            round,
            tool_call: buildWireToolCall(toolCall),
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const nextTarget = collapseThinking(target);
                const withToolCall = upsertToolCallToRound(nextTarget, toolCall);
                return markToolCallRunningInRound(withToolCall, toolCall);
              }),
            transcriptStore,
          );
        },
        onToolCallDelta: (toolCall, round) => {
          sawToolCallInRound = true;
          queueToolCallDelta(toolCall, round);
        },
        onToolExecutionStart: (toolCall, round) => {
          sawToolCallInRound = true;
          discardPendingToolCallDelta(toolCall, round);
          if (!isSubagentCardToolCall(toolCall)) {
            hookLifecycle.toolExecutionStarted();
          }
          if (!shouldShowToolEvent(toolCall)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_call",
            round,
            tool_call: buildWireToolCall(toolCall),
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
                return markToolCallRunningInRound(withToolCall, toolCall);
              }),
            transcriptStore,
          );
        },
        onToolResult: (toolCall, toolResult, round) => {
          if (toolResult.role !== "toolResult") return;
          discardPendingToolCallDelta(toolCall, round);
          if (!isSubagentCardToolCall(toolCall)) {
            hookLifecycle.toolResultReceived(round);
          }
          if (!shouldShowToolEvent(toolCall, toolResult)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_result",
            round,
            tool_call: buildWireToolCall(toolCall),
            tool_result: toolResult as ToolResultMessage,
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const tr: ToolResultMessage = toolResult as ToolResultMessage;
                const nextTarget = attachToolResultToRound(collapseThinking(target), toolCall, tr);

                return {
                  ...nextTarget,
                  runningToolCallIds: (nextTarget.runningToolCallIds || []).filter(
                    (id) => id !== toolCall.id,
                  ),
                };
              }),
            transcriptStore,
          );
        },
        onAssistantMessage: (assistant, round) => {
          if (assistant.role !== "assistant") return;
          hookLifecycle.ensureMessageEnded();
          const toolCallCount = assistant.content.filter(
            (block) => block.type === "toolCall",
          ).length;
          hookLifecycle.assistantMessageCompleted(round, toolCallCount);
          if (toolCallCount === 0 && assistant.stopReason !== "toolUse") {
            pendingTerminalAssistantMetaRef.current = { assistant, round };
            return;
          }
          commitAssistantRoundMeta(assistant, round);
        },
        onToolStatus: (s) => {
          gatewayBridgeEvents.queueToolStatus(s, false);
          updateToolStatus(s, transcriptStore);
        },
        onRetryAttempts: (_round, attempts) => {
          updateRetryAttempts(attempts, transcriptStore);
        },
        onBeforeNextTurn: async ({ round, assistant, toolResults, emittedMessages }) => {
          publishPersistableAgentProgress(round, assistant, toolResults);
          latestAgentEmittedMessages = emittedMessages.slice();
          const tempState = appendMessagesToConversation(
            getNextConversationState(),
            emittedMessages,
          );
          const { context: compactedContext } = await compaction.compactDuringRun({
            trigger: "post-tool",
            state: tempState,
            budgetContext: buildPreparedContext(tempState, combinedTools, {
              includeUploadedFilesMetadata: true,
            }),
            tools: combinedTools,
            includeUploadedFilesMetadata: true,
          });
          if (!compactedContext) return null;
          latestAgentEmittedMessages = [];
          clearPersistableAgentProgress();
          return {
            context: compactedContext,
            emittedMessages: [],
          };
        },
        signal: scope.controller.signal,
        debugLogger: conversationDebugLogger,
      });
      finishAgentPerfSpan(
        conversationDebugLogger,
        "assistant.run_with_tools",
        assistantRunStartedAt,
        {
          emittedMessageCount: result.emittedMessages.length,
          messageCount: result.messages.length,
        },
      );
    } catch (error) {
      if (!midStreamCompactionRequested) {
        throw error;
      }

      hookLifecycle.ensureMessageEnded();
      if (activeAgentRound > 0) {
        hookLifecycle.endTurn(activeAgentRound);
      }
      resetLiveTranscript(transcriptStore);

      const partialAssistant = buildPartialAssistantMessage({
        model: runtimeModel,
        text: streamedAgentText,
        stopReason: "aborted",
      });
      const tempState = appendMessagesToConversation(getNextConversationState(), [
        ...latestAgentEmittedMessages,
        ...(partialAssistant ? [partialAssistant] : []),
      ]);
      latestAgentEmittedMessages = [];
      applyConversationState(tempState);
      clearPersistableAgentProgress();

      const compactionResult = await compaction.compactDuringRun({
        trigger: "mid-stream",
        state: tempState,
        budgetContext: buildPreparedContext(tempState, combinedTools, {
          includeAbortedMessages: true,
          includeUploadedFilesMetadata: true,
        }),
        tools: combinedTools,
        includeAbortedMessages: true,
        includeUploadedFilesMetadata: true,
      });

      if (!compactionResult.context) {
        throw new Error("Mid-stream compaction did not provide a continuation context.");
      }
      pendingAgentContext = compactionResult.context;
      if (compactionResult.shouldDisableProtection) {
        midStreamProtectionDisabled = true;
      }
    } finally {
      scope.release();
    }
  }

  const assistantStopReason = result.assistant.stopReason;
  if (
    isAbortedAssistantMessage(result.assistant) ||
    isAbortedAssistantMessage(result.messages[result.messages.length - 1])
  ) {
    if (commitVisibleAbortedConversation()) {
      return;
    }
    throw new Error("Cancelled");
  }

  const finalState = appendMessagesToConversation(
    getNextConversationState(),
    result.emittedMessages,
  );
  const completedState = finalState;
  const gatewayAssistantText = assistantMessageToText(result.assistant);
  if (!gatewayBridgeEvents.hasForwardedText() && gatewayAssistantText.length > 0) {
    gatewayBridgeEvents.queueToken(gatewayAssistantText, activeAgentRound || 1);
  }
  const shouldRunMemoryExtraction =
    assistantStopReason !== "error" && assistantStopReason !== "aborted";
  const memoryRoundOffset = Math.max(
    activeAgentRound || pendingTerminalAssistantMetaRef.current?.round || 1,
    1,
  );

  const runPostTurnMemoryExtraction = (visibleEvents?: MemoryExtractionVisibleEvents) => {
    const currentMemoryExtractionModel: MemoryExtractionModelConfig = {
      providerId,
      model,
      runtime,
      selectedModel,
    };
    // The controller owns the extraction scope and links this stable turn-level
    // userStop signal, so request-scope churn cannot detach cancellation.
    return memoryExtraction.requestExtraction({
      primary: memoryExtractionModel ?? currentMemoryExtractionModel,
      fallback: memoryExtractionModel ? currentMemoryExtractionModel : undefined,
      onPrimaryFailure: memoryExtractionModel ? onMemoryExtractionModelFailure : undefined,
      sessionId,
      conversationId,
      workdir: conversationCwd ?? effectiveWorkdir,
      messages: buildPreparedContext(finalState).messages,
      statusText: memoryExtractionStatusText,
      signal: cancellation.userStop.signal,
      debugLogger: conversationDebugLogger,
      visibleEvents,
    });
  };

  if (showSilentMemoryExtraction && shouldRunMemoryExtraction) {
    const extraction = await runPostTurnMemoryExtraction({
      roundOffset: memoryRoundOffset,
      onTurnStart: (round) => {
        batchLiveRoundsUpdate(
          (prev) => [
            ...prev,
            {
              key: `r${round}`,
              round,
              blocks: [],
              runningToolCallIds: [],
              thinkingOpen: false,
            },
          ],
          transcriptStore,
        );
      },
      onTextDelta: (delta, round) => {
        gatewayBridgeEvents.queueToken(delta, round);
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) =>
              appendTextDeltaToRound(collapseThinking(target), delta),
            ),
          transcriptStore,
        );
      },
      onThinkingDelta: (delta, round) => {
        gatewayBridgeEvents.queueEvent({
          type: "thinking_delta",
          round,
          delta,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => ({
              ...appendThinkingDeltaToRound(target, delta),
              thinkingOpen: true,
            })),
          transcriptStore,
        );
      },
      onToolCall: (toolCall, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_call",
          round,
          tool_call: toolCall,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
              return markToolCallRunningInRound(withToolCall, toolCall);
            }),
          transcriptStore,
        );
      },
      onToolExecutionStart: (toolCall, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_call",
          round,
          tool_call: toolCall,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
              return markToolCallRunningInRound(withToolCall, toolCall);
            }),
          transcriptStore,
        );
      },
      onToolResult: (toolCall, toolResult, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_result",
          round,
          tool_call: toolCall,
          tool_result: toolResult,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const nextTarget = attachToolResultToRound(
                collapseThinking(target),
                toolCall,
                toolResult,
              );

              return {
                ...nextTarget,
                runningToolCallIds: (nextTarget.runningToolCallIds || []).filter(
                  (id) => id !== toolCall.id,
                ),
              };
            }),
          transcriptStore,
        );
      },
      onAssistantMessage: commitAssistantRoundMeta,
      onToolStatus: (s) => {
        gatewayBridgeEvents.queueToolStatus(s, false);
        updateToolStatus(s, transcriptStore);
      },
    });
  }
  const pendingTerminalAssistantMeta = pendingTerminalAssistantMetaRef.current;
  if (pendingTerminalAssistantMeta) {
    commitAssistantRoundMeta(
      pendingTerminalAssistantMeta.assistant,
      pendingTerminalAssistantMeta.round,
    );
  }
  hookLifecycle.endAgent();
  applyConversationState(completedState);
  settleLiveTranscript(transcriptStore);
  await persistConversationWithHistorySync({
    conversationId,
    sessionId,
    providerId,
    model,
    cwd: conversationCwd,
    state: completedState,
    fallbackTitle,
    createdAt,
    titlePromise,
  });
  if (!showSilentMemoryExtraction && shouldRunMemoryExtraction) {
    void runPostTurnMemoryExtraction();
  }
}
