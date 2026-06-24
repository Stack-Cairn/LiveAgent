import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  type CompactionThrottleState,
  noteCompactionRound,
  type ProviderRuntimeConfig,
  shouldProtectionCompactConversation,
} from "../../../lib/chat/compaction/contextCompaction";
import { isAbortedAssistantMessage } from "../../../lib/chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  appendRenderOnlyMessagesToConversation,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type {
  ConversationHookLifecycle,
  GatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import type { HostedSearchBlock } from "../../../lib/chat/messages/hostedSearch";
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
} from "../../../lib/chat/messages/uiMessages";
import { runAssistantWithTools } from "../../../lib/chat/runner/agentRunner";
import {
  listSubagentIdentities,
  listSubagentMessages,
  listSubagentRuns,
  type SubagentIdentityRecord,
  type SubagentRunSummary,
} from "../../../lib/chat/subagent/subagentHistory";
import {
  renderSubagentMessageBusSnapshot,
  SUBAGENT_PARENT_AGENT_ID,
} from "../../../lib/chat/subagent/subagentMessageBus";
import { buildExistingSubagentsReminder } from "../../../lib/chat/subagent/subagentReminders";
import type { SubagentRuntimeManager } from "../../../lib/chat/subagent/subagentRuntimeManager";
import { createSubagentScheduler } from "../../../lib/chat/subagent/subagentScheduler";
import type { StreamDebugLogger } from "../../../lib/debug/agentDebug";
import { assistantMessageToText } from "../../../lib/providers/llm";
import { resolveRuntimePlatform } from "../../../lib/runtimePlatform";
import {
  type AppSettings,
  type ProviderId,
  type SshHostConfig,
  type SystemToolId,
  workspaceProjectPathKey,
} from "../../../lib/settings";
import { buildBuiltinToolRegistry } from "../../../lib/tools/builtinRegistry";
import type { BuiltinToolExecutionContext } from "../../../lib/tools/builtinTypes";
import { createFileToolState } from "../../../lib/tools/fileToolState";
import type { SkillAccessPolicy } from "../../../lib/tools/skillAccessPolicy";
import type { SshManagerSessionChange } from "../../../lib/tools/sshManagerTools";
import {
  TUNNEL_MANAGER_CHANGED_EVENT,
  type TunnelManagerChange,
} from "../../../lib/tools/tunnelManagerTools";
import {
  recordSilentMemoryTurnBoundary,
  type runSilentMemoryExtraction,
  type SilentMemoryExtractionModelConfig,
} from "../memory/silentMemoryExtraction";
import { runSilentMemoryExtractionWithFallback } from "../memory/silentMemoryExtractionFallback";
import {
  appendSystemPrompt,
  buildPartialAssistantMessage,
  type ConversationRuntimeEntry,
} from "../runtime/chatPageRuntime";
import { buildProtectionCompactionStatus } from "../runtime/compactionStatusText";
import { buildGatewayToolCallPreviewArguments } from "./gatewayToolPreview";

export type RuntimeModel = {
  api: AssistantMessage["api"];
  provider: AssistantMessage["provider"];
  id: string;
};

export type CompactDuringRun = (params: {
  trigger: "mid-stream" | "post-tool";
  state: ConversationViewState;
  requestContext: Context;
  budgetContext: Context;
  statusText: string;
  tools?: Context["tools"];
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
}) => Promise<Context | null>;

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
const TOOL_CALL_DELTA_RAF_FALLBACK_DELAY_MS = 64;

function perfNowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function scheduleToolCallDeltaFlush(callback: () => void) {
  let frameId: number | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let finished = false;

  const run = () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
    callback();
  };

  const canUseAnimationFrame =
    typeof requestAnimationFrame === "function" &&
    (typeof document === "undefined" || document.visibilityState === "visible");
  if (canUseAnimationFrame) {
    frameId = requestAnimationFrame(run);
  }

  if (typeof globalThis.setTimeout === "function") {
    timeoutId = globalThis.setTimeout(
      run,
      canUseAnimationFrame ? TOOL_CALL_DELTA_RAF_FALLBACK_DELAY_MS : 0,
    );
  } else if (!canUseAnimationFrame && typeof queueMicrotask === "function") {
    queueMicrotask(run);
  }

  return () => {
    if (finished) return;
    finished = true;
    if (frameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
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

function shouldShowToolEvent(toolCall: ToolCall) {
  return toolCall.name !== "Agent" || toolCall.arguments?.delegate_agent_card === true;
}

function isDelegateAgentCardToolCall(toolCall: ToolCall) {
  return toolCall.name === "Agent" && toolCall.arguments?.delegate_agent_card === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractConversationSubagentRuns(params: {
  state: ConversationViewState;
  conversationId: string;
  sessionId: string;
  providerId: ProviderId;
  model: string;
}): SubagentRunSummary[] {
  const runs: SubagentRunSummary[] = [];
  for (const segment of params.state.segments) {
    for (const message of segment.messages) {
      if (message.role !== "toolResult" || message.toolName !== "Agent") continue;
      const details = asRecord(message.details);
      if (details.kind !== "delegate_agent") continue;
      const agents = details.agents;
      if (!Array.isArray(agents)) continue;
      const timestamp = message.timestamp ?? Date.now();
      agents.forEach((rawAgent, index) => {
        const agent = asRecord(rawAgent);
        const logicalAgentId = optionalString(agent.id);
        if (!logicalAgentId) return;
        const mode = optionalString(agent.mode) ?? "worktree";
        const status = optionalString(agent.status) ?? "completed";
        runs.push({
          id:
            optionalString(agent.runId) ??
            `${message.toolCallId}:agent:${index + 1}:${logicalAgentId}:transcript`,
          parentConversationId: params.conversationId,
          parentToolCallId: message.toolCallId,
          parentToolName: message.toolName,
          agentIndex: index,
          agentTotal: agents.length,
          logicalAgentId,
          agentId: optionalString(agent.agentId),
          agentName: optionalString(agent.name) ?? optionalString(agent.agentName),
          description: optionalString(agent.prompt) ?? logicalAgentId,
          mode,
          status: status === "failed" ? "failed" : "completed",
          providerId: params.providerId,
          model: params.model,
          sessionId:
            optionalString(agent.sessionId) ?? `${params.sessionId}:subagent:${logicalAgentId}`,
          workdir: optionalString(agent.workdir),
          worktreeRoot: optionalString(agent.worktreeRoot),
          branchName: optionalString(agent.branchName),
          messageCount: 0,
          roundCount: optionalNumber(agent.rounds) ?? 0,
          toolCallCount: optionalNumber(agent.toolCalls) ?? 0,
          compactionCount: 0,
          summary: optionalString(agent.summary),
          error: optionalString(agent.error),
          startedAt: timestamp,
          endedAt: timestamp,
          updatedAt: timestamp,
        });
      });
    }
  }
  return runs;
}

async function loadStoredSubagentRuns(conversationId: string) {
  const parentConversationId = conversationId.trim();
  if (!parentConversationId) return [];
  try {
    return await listSubagentRuns({
      parentConversationId,
      limit: 50,
    });
  } catch (error) {
    console.warn("Failed to load stored delegated subagent runs", error);
    return [];
  }
}

async function loadStoredSubagentIdentities(conversationId: string) {
  try {
    return await listSubagentIdentities({
      parentConversationId: conversationId,
      limit: 200,
    });
  } catch (error) {
    console.warn("Failed to load stored delegated subagent identities", error);
    return [] satisfies SubagentIdentityRecord[];
  }
}

async function loadStoredSubagentMessages(conversationId: string) {
  try {
    return await listSubagentMessages({
      parentConversationId: conversationId,
      recipientAgentId: SUBAGENT_PARENT_AGENT_ID,
      includeShared: true,
      includeSent: true,
      limit: 100,
    });
  } catch (error) {
    console.warn("Failed to load stored delegated subagent messages", error);
    return [];
  }
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
  showSilentMemoryExtraction: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  agentTemplates: AppSettings["agents"];
  selectedSystemToolIds: SystemToolId[];
  mcpSettings: AppSettings["mcp"];
  updateMcpSettings?: (next: AppSettings["mcp"]) => void;
  enabledMcpServerIds: string[];
  selectableMcpServers: AppSettings["mcp"]["servers"];
  remoteWebTunnelsEnabled?: boolean;
  remoteGatewayOnline?: boolean;
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
  conversationThrottleState: CompactionThrottleState;
  conversationDebugLogger: StreamDebugLogger;
  compactionDebugLogger: StreamDebugLogger;
  subagentRuntimeManager?: SubagentRuntimeManager;
  getNextConversationState: () => ConversationViewState;
  applyConversationState: (state: ConversationViewState) => void;
  buildCompactionContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
  ) => Context;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
  ) => Context;
  maybeApplyPreCompaction: (params: {
    requestContext: Context;
    budgetContext: Context;
    tools?: Context["tools"];
    includeUploadedFilesMetadata?: boolean;
  }) => Promise<boolean>;
  compactDuringRun: CompactDuringRun;
  getRequestController: () => AbortController;
  renewRequestController: () => AbortController;
  resetLiveTranscript: (store: LiveTranscriptStore) => void;
  updateLiveRounds: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
    shouldAutoScroll?: boolean,
  ) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
    shouldAutoScroll?: boolean,
  ) => void;
  updateToolStatus: (status: string | null, store: LiveTranscriptStore, visible: boolean) => void;
  updateGatewayBridgeToolStatus: (
    status: string | null,
    visible: boolean,
    isCompaction?: boolean,
  ) => void;
  isConversationVisible: () => boolean;
  commitVisibleAbortedConversation: () => boolean;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => ConversationRuntimeEntry;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  memoryExtractionModel?: SilentMemoryExtractionModelConfig;
  onMemoryExtractionModelFailure?: (model: SilentMemoryExtractionModelConfig) => void;
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
    showSilentMemoryExtraction,
    skillsRootDir,
    skillAccessPolicy,
    onManagedSkillsChanged,
    agentTemplates,
    selectedSystemToolIds,
    mcpSettings,
    updateMcpSettings,
    enabledMcpServerIds,
    selectableMcpServers,
    remoteWebTunnelsEnabled,
    remoteGatewayOnline,
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
    conversationThrottleState,
    conversationDebugLogger,
    compactionDebugLogger,
    subagentRuntimeManager,
    getNextConversationState,
    applyConversationState,
    buildCompactionContext,
    buildPreparedContext,
    maybeApplyPreCompaction,
    compactDuringRun,
    getRequestController,
    renewRequestController,
    resetLiveTranscript,
    updateLiveRounds,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateGatewayBridgeToolStatus,
    isConversationVisible,
    commitVisibleAbortedConversation,
    updateConversationRuntimeEntry,
    persistConversationWithHistorySync,
    memoryExtractionModel,
    onMemoryExtractionModelFailure,
  } = params;

  if (!effectiveWorkdir) {
    throw new Error("Tool mode requires a project directory from the chat sidebar.");
  }

  // Clear the per-conversation slug tracker before a fresh user turn so the
  // <already-written-this-turn> block reflects only writes made in this turn.
  recordSilentMemoryTurnBoundary(conversationId);

  const transcriptSubagentRuns = extractConversationSubagentRuns({
    state: getNextConversationState(),
    conversationId,
    sessionId,
    providerId,
    model,
  });
  const loadStoredRunsStartedAt = perfNowMs();
  const [storedSubagentRuns, storedSubagentIdentities, storedSubagentMessages] = await Promise.all([
    loadStoredSubagentRuns(conversationId),
    loadStoredSubagentIdentities(conversationId),
    loadStoredSubagentMessages(conversationId),
  ]);
  finishAgentPerfSpan(
    conversationDebugLogger,
    "subagent_runs.load_stored",
    loadStoredRunsStartedAt,
    {
      conversationId,
      count: storedSubagentRuns.length,
      identityCount: storedSubagentIdentities.length,
      messageCount: storedSubagentMessages.length,
    },
  );
  const conversationSubagentRuns = [...transcriptSubagentRuns, ...storedSubagentRuns];
  const subagentReminder = buildExistingSubagentsReminder(
    storedSubagentIdentities,
    conversationSubagentRuns,
  );
  let parentMessageBusSnapshot = renderSubagentMessageBusSnapshot({
    messages: storedSubagentMessages,
    currentAgentId: SUBAGENT_PARENT_AGENT_ID,
    currentAgentName: "Parent Agent",
  });
  const refreshParentMessageBusSnapshot = async () => {
    parentMessageBusSnapshot = renderSubagentMessageBusSnapshot({
      messages: await loadStoredSubagentMessages(conversationId),
      currentAgentId: SUBAGENT_PARENT_AGENT_ID,
      currentAgentName: "Parent Agent",
    });
    return parentMessageBusSnapshot;
  };
  const withSubagentRuntimeContext = (context: Context): Context => {
    let systemPrompt = context.systemPrompt;
    if (subagentReminder) {
      systemPrompt = appendSystemPrompt(systemPrompt, subagentReminder);
    }
    if (parentMessageBusSnapshot) {
      systemPrompt = appendSystemPrompt(systemPrompt, parentMessageBusSnapshot);
    }
    return systemPrompt !== context.systemPrompt
      ? {
          ...context,
          systemPrompt,
        }
      : context;
  };
  const fileState = createFileToolState();
  const subagentScheduler = createSubagentScheduler();
  const runtimePlatform = await resolveRuntimePlatform();
  const buildRegistryStartedAt = perfNowMs();
  const builtinRegistry = await buildBuiltinToolRegistry({
    workdir: effectiveWorkdir,
    providerId,
    runtimePlatform,
    fileState,
    skillsEnabled: effectiveSkillsEnabled,
    skillsRootDir,
    skillAccessPolicy,
    onManagedSkillsChanged,
    runtimeScope: "chat",
    currentChatModel: selectedModel,
    selectedSystemToolIds,
    mcpSettings,
    updateMcpSettings,
    enabledMcpServerIds,
    selectableMcpServers,
    remoteWebTunnelsEnabled,
    remoteGatewayOnline,
    tunnelProjectPathKey: workspaceProjectPathKey(effectiveWorkdir),
    sshHosts,
    associatedSshHostIds,
    sshManagerRemoteAllowed,
    onSshSessionsChanged,
    onTunnelsChanged: (change) => {
      onTunnelsChanged?.(change);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(TUNNEL_MANAGER_CHANGED_EVENT));
      }
    },
    onMcpLoadError: (message) => {
      const warning = `MCP 工具加载失败，已跳过并继续对话：${message || "未知错误"}`;
      console.warn(warning);
      updateToolStatus(warning, transcriptStore, isConversationVisible());
    },
    delegateRuntime: {
      providerId,
      model,
      runtime,
      conversationId,
      sessionId,
      agentTemplates,
      conversationSubagentIdentities: storedSubagentIdentities,
      conversationSubagentRuns,
      subagentRuntimeManager,
      subagentScheduler,
    },
  });
  finishAgentPerfSpan(conversationDebugLogger, "builtin_registry.build", buildRegistryStartedAt, {
    toolCount: builtinRegistry.tools.length,
    enabledMcpServerCount: enabledMcpServerIds.length,
    subagentRunCount: conversationSubagentRuns.length,
  });
  const combinedTools = builtinRegistry.tools;

  const preCompactionStartedAt = perfNowMs();
  await maybeApplyPreCompaction({
    requestContext: buildCompactionContext(getNextConversationState(), combinedTools, {
      includeUploadedFilesMetadata: true,
    }),
    budgetContext: withSubagentRuntimeContext(
      buildPreparedContext(getNextConversationState(), combinedTools, {
        includeUploadedFilesMetadata: true,
      }),
    ),
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

  hookLifecycle.startAgent();
  let result: Awaited<ReturnType<typeof runAssistantWithTools>> | null = null;
  let latestAgentEmittedMessages: Message[] = [];
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

  function commitAssistantRoundMeta(assistant: AssistantMessage, round: number) {
    gatewayBridgeEvents.queueToken("", {
      round,
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
      isConversationVisible(),
    );
  }

  function updateHostedSearch(hostedSearch: HostedSearchBlock, round: number) {
    gatewayBridgeEvents.queueEvent({
      type: "hosted_search",
      id: hostedSearch.id,
      provider: hostedSearch.provider,
      status: hostedSearch.status,
      queries: hostedSearch.queries,
      sources: hostedSearch.sources,
      updatedAt: hostedSearch.updatedAt,
      round,
      conversation_id: conversationId,
    });
    batchLiveRoundsUpdate(
      (prev) => {
        const withRound = prev.some((item) => item.round === round)
          ? prev
          : [
              ...prev,
              {
                key: `${Date.now()}-${round}`,
                round,
                blocks: [],
                runningToolCallIds: [],
                thinkingOpen: false,
              },
            ];
        return updateLiveRound(withRound, round, (target) =>
          upsertHostedSearchToRound(collapseThinking(target), hostedSearch),
        );
      },
      transcriptStore,
      isConversationVisible(),
    );
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
        type: "tool_call_delta",
        id: toolCall.id,
        name: toolCall.name,
        arguments: buildGatewayToolCallPreviewArguments(toolCall),
        round,
        conversation_id: conversationId,
      });
    }

    batchLiveRoundsUpdate(
      (prev) => {
        let next = prev;
        for (const { round, toolCall } of deltas) {
          next = updateLiveRound(next, round, (target) => {
            const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
            return markToolCallRunningInRound(withToolCall, toolCall);
          });
        }
        return next;
      },
      transcriptStore,
      isConversationVisible(),
    );
  }

  function schedulePendingToolCallDeltaFlush() {
    if (cancelPendingToolCallDeltaFlush !== null) return;
    cancelPendingToolCallDeltaFlush = scheduleToolCallDeltaFlush(flushPendingToolCallDeltas);
  }

  function queueToolCallDelta(toolCall: ToolCall, round: number) {
    if (!shouldShowToolEvent(toolCall)) return;
    hookLifecycle.messageUpdated();
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

  while (!result) {
    let streamedAgentText = "";
    let protectionCheckChars = 0;
    let midStreamCompactionRequested = false;
    let midStreamCompactionStatusText: string | null = null;
    let sawToolCallInRound = false;
    const nativeWebSearchEnabled = runtime.nativeWebSearchEnabled !== false;
    const agentContext = withSubagentRuntimeContext(
      pendingAgentContext ??
        buildPreparedContext(getNextConversationState(), combinedTools, {
          includeUploadedFilesMetadata: true,
        }),
    );
    pendingAgentContext = null;

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
        onTurnStart: (round) => {
          activeAgentRound = round;
          streamedAgentText = "";
          protectionCheckChars = 0;
          sawToolCallInRound = false;
          hookLifecycle.startTurn(round);
          updateLiveRounds(
            (prev) => [
              ...prev,
              {
                key: `${Date.now()}-${round}`,
                round,
                blocks: [],
                runningToolCallIds: [],
                thinkingOpen: false,
              },
            ],
            transcriptStore,
            isConversationVisible(),
          );
        },
        onTextDelta: (delta, round) => {
          gatewayBridgeEvents.queueToken(delta, { round });
          hookLifecycle.messageUpdated();
          streamedAgentText += delta;
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const nextTarget = collapseThinking(target);
                return appendTextDeltaToRound(nextTarget, delta);
              }),
            transcriptStore,
            isConversationVisible(),
          );

          protectionCheckChars += delta.length;
          if (midStreamCompactionRequested || sawToolCallInRound || protectionCheckChars < 160) {
            return;
          }

          protectionCheckChars = 0;
          const partialAssistant = buildPartialAssistantMessage({
            model: runtimeModel,
            text: streamedAgentText,
            stopReason: "aborted",
          });
          if (!partialAssistant) return;

          const tempState = appendMessagesToConversation(getNextConversationState(), [
            ...latestAgentEmittedMessages,
            partialAssistant,
          ]);
          const tempContext = withSubagentRuntimeContext(
            buildPreparedContext(tempState, combinedTools, {
              includeAbortedMessages: true,
              includeUploadedFilesMetadata: true,
            }),
          );
          const decision = shouldProtectionCompactConversation({
            providerId,
            state: tempState,
            requestContext: tempContext,
            modelConfig: runtime.modelConfig,
            throttleState: conversationThrottleState,
            debugLogger: compactionDebugLogger,
          });
          if (!decision.shouldCompact) return;

          midStreamCompactionRequested = true;
          midStreamCompactionStatusText = buildProtectionCompactionStatus(decision);
          updateGatewayBridgeToolStatus(
            midStreamCompactionStatusText,
            isConversationVisible(),
            true,
          );
          getRequestController().abort();
        },
        onThinkingDelta: (delta, round) => {
          gatewayBridgeEvents.queueEvent({
            type: "thinking",
            text: delta,
            round,
            conversation_id: conversationId,
          });
          hookLifecycle.messageUpdated();
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => ({
                ...appendThinkingDeltaToRound(target, delta),
                thinkingOpen: true,
              })),
            transcriptStore,
            isConversationVisible(),
          );
        },
        onHostedSearch: (hostedSearch, round) => {
          hookLifecycle.messageUpdated();
          updateHostedSearch(hostedSearch, round);
        },
        onToolCall: (toolCall, round) => {
          sawToolCallInRound = true;
          discardPendingToolCallDelta(toolCall, round);
          if (!shouldShowToolEvent(toolCall)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_call",
            id: toolCall.id,
            name: toolCall.name,
            arguments: buildGatewayToolCallPreviewArguments(toolCall),
            round,
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
            isConversationVisible(),
          );
        },
        onToolCallDelta: (toolCall, round) => {
          sawToolCallInRound = true;
          queueToolCallDelta(toolCall, round);
        },
        onToolExecutionStart: (toolCall, round) => {
          sawToolCallInRound = true;
          discardPendingToolCallDelta(toolCall, round);
          if (!isDelegateAgentCardToolCall(toolCall)) {
            hookLifecycle.toolExecutionStarted();
          }
          if (!shouldShowToolEvent(toolCall)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_call",
            id: toolCall.id,
            name: toolCall.name,
            arguments: buildGatewayToolCallPreviewArguments(toolCall),
            round,
            conversation_id: conversationId,
          });
          batchLiveRoundsUpdate(
            (prev) =>
              updateLiveRound(prev, round, (target) => {
                const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
                return markToolCallRunningInRound(withToolCall, toolCall);
              }),
            transcriptStore,
            isConversationVisible(),
          );
        },
        onToolResult: (toolCall, toolResult, round) => {
          if (toolResult.role !== "toolResult") return;
          discardPendingToolCallDelta(toolCall, round);
          if (!isDelegateAgentCardToolCall(toolCall)) {
            hookLifecycle.toolResultReceived(round);
          }
          if (!shouldShowToolEvent(toolCall)) return;
          gatewayBridgeEvents.queueEvent({
            type: "tool_result",
            id: toolCall.id,
            name: toolCall.name,
            arguments: buildGatewayToolCallPreviewArguments(toolCall),
            content: toolResult.content,
            details: toolResult.details,
            isError: toolResult.isError ?? false,
            round,
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
            isConversationVisible(),
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
          updateToolStatus(s, transcriptStore, isConversationVisible());
        },
        onBeforeNextTurn: async ({ emittedMessages }) => {
          latestAgentEmittedMessages = emittedMessages.slice();
          noteCompactionRound(conversationThrottleState);
          await refreshParentMessageBusSnapshot();
          const tempState = appendMessagesToConversation(
            getNextConversationState(),
            emittedMessages,
          );
          const tempContext = withSubagentRuntimeContext(
            buildPreparedContext(tempState, combinedTools, {
              includeUploadedFilesMetadata: true,
            }),
          );
          const decision = shouldProtectionCompactConversation({
            providerId,
            state: tempState,
            requestContext: tempContext,
            modelConfig: runtime.modelConfig,
            throttleState: conversationThrottleState,
            debugLogger: compactionDebugLogger,
          });
          if (!decision.shouldCompact) {
            return parentMessageBusSnapshot
              ? {
                  context: tempContext,
                  emittedMessages,
                }
              : null;
          }

          const statusText = buildProtectionCompactionStatus(decision);
          const compactedContext = await compactDuringRun({
            trigger: "post-tool",
            state: tempState,
            requestContext: buildCompactionContext(tempState, combinedTools, {
              includeUploadedFilesMetadata: true,
            }),
            budgetContext: tempContext,
            statusText,
            tools: combinedTools,
            includeUploadedFilesMetadata: true,
          });
          if (!compactedContext) {
            return null;
          }
          latestAgentEmittedMessages = [];
          return {
            context: withSubagentRuntimeContext(compactedContext),
            emittedMessages: [],
          };
        },
        signal: getRequestController().signal,
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
      renewRequestController();

      const compactedContext = await compactDuringRun({
        trigger: "mid-stream",
        state: tempState,
        requestContext: buildCompactionContext(tempState, combinedTools, {
          includeAbortedMessages: true,
          includeUploadedFilesMetadata: true,
        }),
        budgetContext: withSubagentRuntimeContext(
          buildPreparedContext(tempState, combinedTools, {
            includeAbortedMessages: true,
            includeUploadedFilesMetadata: true,
          }),
        ),
        statusText: midStreamCompactionStatusText ?? "正在压缩上下文...",
        tools: combinedTools,
        includeAbortedMessages: true,
        includeUploadedFilesMetadata: true,
      });

      if (!compactedContext) {
        throw new Error("Context compaction failed and the tool session could not be restored");
      }

      pendingAgentContext = compactedContext;
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
  let completedState = finalState;
  const gatewayAssistantText = assistantMessageToText(result.assistant);
  if (!gatewayBridgeEvents.hasForwardedText() && gatewayAssistantText.length > 0) {
    gatewayBridgeEvents.queueToken(gatewayAssistantText, {
      round: activeAgentRound || 1,
    });
  }
  noteCompactionRound(conversationThrottleState);
  const shouldRunMemoryExtraction =
    assistantStopReason !== "error" && assistantStopReason !== "aborted";
  const memoryRoundOffset = Math.max(
    activeAgentRound || pendingTerminalAssistantMetaRef.current?.round || 1,
    1,
  );

  const runPostTurnMemoryExtraction = (
    visibleEvents?: Parameters<typeof runSilentMemoryExtraction>[0]["visibleEvents"],
  ) => {
    const currentMemoryExtractionModel: SilentMemoryExtractionModelConfig = {
      providerId,
      model,
      runtime,
      selectedModel,
    };
    return runSilentMemoryExtractionWithFallback({
      primary: memoryExtractionModel ?? currentMemoryExtractionModel,
      fallback: memoryExtractionModel ? currentMemoryExtractionModel : undefined,
      onPrimaryFailure: memoryExtractionModel ? onMemoryExtractionModelFailure : undefined,
      sessionId,
      conversationId,
      workdir: conversationCwd ?? effectiveWorkdir,
      buildContext: (tools) => buildPreparedContext(finalState, tools),
      signal: getRequestController().signal,
      debugLogger: conversationDebugLogger,
      visibleEvents,
    });
  };

  if (showSilentMemoryExtraction && shouldRunMemoryExtraction) {
    const extraction = await runPostTurnMemoryExtraction({
      roundOffset: memoryRoundOffset,
      onTurnStart: (round) => {
        updateLiveRounds(
          (prev) => [
            ...prev,
            {
              key: `${Date.now()}-${round}`,
              round,
              blocks: [],
              runningToolCallIds: [],
              thinkingOpen: false,
            },
          ],
          transcriptStore,
          isConversationVisible(),
        );
      },
      onTextDelta: (delta, round) => {
        gatewayBridgeEvents.queueToken(delta, { round });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) =>
              appendTextDeltaToRound(collapseThinking(target), delta),
            ),
          transcriptStore,
          isConversationVisible(),
        );
      },
      onThinkingDelta: (delta, round) => {
        gatewayBridgeEvents.queueEvent({
          type: "thinking",
          text: delta,
          round,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => ({
              ...appendThinkingDeltaToRound(target, delta),
              thinkingOpen: true,
            })),
          transcriptStore,
          isConversationVisible(),
        );
      },
      onToolCall: (toolCall, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          round,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
              return markToolCallRunningInRound(withToolCall, toolCall);
            }),
          transcriptStore,
          isConversationVisible(),
        );
      },
      onToolExecutionStart: (toolCall, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          round,
          conversation_id: conversationId,
        });
        batchLiveRoundsUpdate(
          (prev) =>
            updateLiveRound(prev, round, (target) => {
              const withToolCall = upsertToolCallToRound(collapseThinking(target), toolCall);
              return markToolCallRunningInRound(withToolCall, toolCall);
            }),
          transcriptStore,
          isConversationVisible(),
        );
      },
      onToolResult: (toolCall, toolResult, round) => {
        if (!shouldShowToolEvent(toolCall)) return;
        gatewayBridgeEvents.queueEvent({
          type: "tool_result",
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          content: toolResult.content,
          details: toolResult.details,
          isError: toolResult.isError ?? false,
          round,
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
          isConversationVisible(),
        );
      },
      onAssistantMessage: commitAssistantRoundMeta,
      onToolStatus: (s) => {
        gatewayBridgeEvents.queueToolStatus(s, false);
        updateToolStatus(s, transcriptStore, isConversationVisible());
      },
    });
    if (extraction.emittedMessages.length > 0) {
      completedState = appendRenderOnlyMessagesToConversation(
        finalState,
        extraction.emittedMessages,
      );
    }
  }
  const pendingTerminalAssistantMeta = pendingTerminalAssistantMetaRef.current;
  if (pendingTerminalAssistantMeta) {
    commitAssistantRoundMeta(
      pendingTerminalAssistantMeta.assistant,
      pendingTerminalAssistantMeta.round,
    );
  }
  hookLifecycle.endAgent();
  resetLiveTranscript(transcriptStore);
  updateConversationRuntimeEntry(conversationId, (prev) => ({
    ...prev,
    state: completedState,
  }));
  void persistConversationWithHistorySync({
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
  gatewayBridgeEvents.queueEvent({
    type: "done",
    conversation_id: conversationId,
  });
  gatewayBridgeEvents.close();
  if (!showSilentMemoryExtraction && shouldRunMemoryExtraction) {
    void runPostTurnMemoryExtraction();
  }
}
