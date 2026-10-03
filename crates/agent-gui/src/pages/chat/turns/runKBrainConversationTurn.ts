import type { AssistantMessage, ToolCall, ToolResultMessage } from "@liveagent/app/lib/agentTypes";
import { appendMessagesToConversation } from "../../../lib/chat/conversation/conversationState";
import { buildConversationStateFromWindow } from "../../../lib/chat/history/chatHistory";
import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  attachToolResultToRound,
  collapseThinking,
  type LiveRound,
  updateLiveRound,
  upsertHostedSearchToRound,
  upsertToolCallToRound,
} from "../../../lib/chat/messages/uiMessages";
import { getKBrainHistoryWindow } from "../../../lib/kbrain/history";
import { getConfiguredKBrainConnection } from "../../../lib/kbrain/runtimeConnection";
import { runKBrainTurn } from "../../../lib/kbrain/turn";
import type {
  KBrainClientToolDefinition,
  KBrainClientToolRequest,
  KBrainClientToolResult,
  KBrainQuestionAnswer,
  KBrainQuestionRequest,
  KBrainRunOptions,
} from "../../../lib/kbrain/types";
import { requestBackendQuestion } from "../../../lib/tools/askUserQuestionTools";
import { createBrowserTools } from "../../../lib/tools/browserTools";
import { createExitPlanModeTools } from "../../../lib/tools/planModeTools";
import { requestToolApproval } from "../../../lib/tools/toolApproval";
import type { RunAgentConversationTurnParams } from "./runAgentConversationTurn";
import type { RunTextConversationTurnParams } from "./runTextConversationTurn";

type Params = RunAgentConversationTurnParams | RunTextConversationTurnParams;

// Desktop-only tools K-brain cannot run itself. They are declared per run as client tools;
// K-brain offers them to the model and hands each call back through client_tool.requested.
function createDesktopClientTools() {
  return createBrowserTools({});
}

function clientToolDefinitions(
  bundle: ReturnType<typeof createDesktopClientTools>,
): KBrainClientToolDefinition[] {
  return bundle.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
  }));
}

async function executeDesktopClientTool(
  bundle: ReturnType<typeof createDesktopClientTools>,
  request: KBrainClientToolRequest,
  signal?: AbortSignal,
): Promise<KBrainClientToolResult> {
  const result = await bundle.executeToolCall(
    {
      type: "toolCall",
      id: request.tool_call_id,
      name: request.tool,
      arguments: request.arguments,
    },
    signal,
  );
  const text: string[] = [];
  const images: NonNullable<KBrainClientToolResult["images"]> = [];
  for (const part of result.content) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "image") images.push({ mime_type: part.mimeType, data: part.data });
  }
  return {
    text: text.join("\n"),
    ...(images.length ? { images } : {}),
    ...(result.isError ? { is_error: true } : {}),
  };
}

function canonicalRunOptions(
  params: Params,
  clientTools: KBrainClientToolDefinition[] = [],
): KBrainRunOptions {
  const agentMode = "effectiveWorkdir" in params;
  const roots = [
    {
      path: agentMode ? params.effectiveWorkdir : (params.conversationCwd ?? ""),
      access: "write" as const,
    },
    ...(agentMode
      ? (params.additionalRoots ?? []).map((root) => ({ path: root.path, access: root.access }))
      : []),
  ].filter((root) => root.path.trim());
  const configured = agentMode ? params.getToolPolicies?.() : undefined;
  const policies = Object.fromEntries(
    Object.entries(configured ?? {})
      .filter(
        ([name, policy]) =>
          !name.startsWith("group:") &&
          !name.startsWith("server:") &&
          (policy === "ask" || policy === "allow" || policy === "deny"),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, "ask" | "allow" | "deny">;
  const safety = agentMode ? params.commandSafetyMode : undefined;
  const reasoning = params.runtime.reasoning;
  return {
    mode: agentMode ? "agent" : "chat",
    ...(reasoning ? { reasoning } : {}),
    search: params.runtime.nativeWebSearchEnabled === true ? "enabled" : "disabled",
    approval_policy: safety === "auto" ? "auto" : "ask",
    ...(roots.length ? { workspace_roots: roots } : {}),
    ...(Object.keys(policies).length ? { tools: { policies } } : {}),
    ...(agentMode && clientTools.length ? { client_tools: clientTools } : {}),
    ...(agentMode && params.planModeEnabled !== undefined
      ? { plan_mode_enabled: params.planModeEnabled }
      : {}),
  };
}

export async function runKBrainConversationTurn(params: Params): Promise<void> {
  const round = 1;
  const { transcriptStore, gatewayBridgeEvents, hookLifecycle, cancellation } = params;
  const context = params.buildPreparedContext(params.getNextConversationState(), undefined, {
    includeUploadedFilesMetadata: true,
  });
  const user = context.messages.filter((message) => message.role === "user").at(-1);
  const prompt =
    typeof user?.content === "string"
      ? user.content
      : (user?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  const results = new Map<string, ToolResultMessage>();
  const calls = new Map<string, ToolCall>();
  const approvalController = new AbortController();
  const cancelApprovals = () => approvalController.abort();
  cancellation.userStop.signal.addEventListener("abort", cancelApprovals, {
    once: true,
  });
  const update = (apply: (round: LiveRound) => LiveRound) => {
    params.batchLiveRoundsUpdate((previous) => {
      const rounds = previous.some((item) => item.round === round)
        ? previous
        : [
            ...previous,
            {
              key: `r${round}`,
              round,
              blocks: [],
              runningToolCallIds: [],
              thinkingOpen: false,
            },
          ];
      return updateLiveRound(rounds, round, apply);
    }, transcriptStore);
  };
  const status = (value: string | null) => {
    if ("updateGatewayBridgeToolStatus" in params) params.updateGatewayBridgeToolStatus(value);
    else {
      params.updateToolStatus(value, transcriptStore);
      gatewayBridgeEvents.queueToolStatus(value);
    }
  };
  const onToolCall = (call: ToolCall) => {
    calls.set(call.id, call);
    update((target) => ({
      ...upsertToolCallToRound(collapseThinking(target), call),
      runningToolCallIds: [...new Set([...target.runningToolCallIds, call.id])],
    }));
    gatewayBridgeEvents.queueEvent({
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      conversation_id: params.conversationId,
      round,
    });
  };
  const projectToolResult = (call: ToolCall, result: ToolResultMessage) => {
    const prior = results.get(call.id);
    const enriched =
      prior?.details && !result.details ? { ...result, details: prior.details } : result;
    results.set(call.id, enriched);
    update((target) => ({
      ...attachToolResultToRound(target, call, enriched),
      runningToolCallIds: target.runningToolCallIds.filter((id) => id !== call.id),
    }));
    gatewayBridgeEvents.queueEvent({
      type: "tool_result",
      id: call.id,
      name: call.name,
      result: result.content,
      conversation_id: params.conversationId,
      round,
    });
  };
  const onToolResult = (call: ToolCall, result: ToolResultMessage) => {
    if (call.name === "ExitPlanMode" && !result.isError) {
      const planTools = createExitPlanModeTools({ conversationId: params.conversationId });
      void planTools
        .executeToolCall(call)
        .then((projected) => projectToolResult(call, { ...result, details: projected.details }));
    } else projectToolResult(call, result);
  };
  hookLifecycle.startAgent();
  hookLifecycle.startTurn(round);
  try {
    const runtimeConnection = getConfiguredKBrainConnection();
    const desktopClientTools = createDesktopClientTools();
    const assistant = await runKBrainTurn({
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      clientRequestId:
        params.clientRequestId?.trim() || params.trajectoryMessageId || crypto.randomUUID(),
      turnId: user && "id" in user && typeof user.id === "string" ? user.id : undefined,
      cwd: params.conversationCwd,
      model: {
        provider: params.selectedModel.customProviderId || String(params.providerId),
        model: params.model,
      },
      prompt,
      context,
      options: canonicalRunOptions(params, clientToolDefinitions(desktopClientTools)),
      signal: cancellation.userStop.signal,
      hook_policy: "backend",
      hook_scope_id: params.conversationId,
      baseUrl: runtimeConnection?.baseUrl,
      token: runtimeConnection?.token,
      onTextDelta: (delta) => {
        update((target) => appendTextDeltaToRound(collapseThinking(target), delta));
        gatewayBridgeEvents.queueToken(delta, { round });
      },
      onThinkingDelta: (delta) => {
        update((target) => appendThinkingDeltaToRound(target, delta));
        gatewayBridgeEvents.queueEvent({
          type: "thinking",
          text: delta,
          round,
          conversation_id: params.conversationId,
        });
      },
      onHostedSearch: (search) => {
        update((target) => upsertHostedSearchToRound(target, search));
      },
      onToolCall,
      onToolResult,
      onStatus: status,
      onQuestionRequest: async (
        request: KBrainQuestionRequest,
        signal?: AbortSignal,
      ): Promise<KBrainQuestionAnswer[]> => {
        const answers = await requestBackendQuestion({
          toolCallId: request.tool_call_id,
          conversationId: params.conversationId,
          questions: request.questions,
          deadlineAt: request.deadline_at,
          signal,
        });
        return answers.map((answer) => ({
          question_id: answer.questionId,
          selected_label: answer.selectedLabel,
          ...(answer.custom ? { custom: true } : {}),
        }));
      },
      onClientToolRequest: (request, signal) =>
        executeDesktopClientTool(desktopClientTools, request, signal),
      onPermissionRequest: async (request) => {
        const settlement = await requestToolApproval({
          toolCallId: request.permission_id,
          toolName: request.tool,
          summary: request.command ?? request.description,
          conversationId: params.conversationId,
          signal: approvalController.signal,
        });
        if (settlement.kind !== "decided" || settlement.decision === "deny") return "reject";
        return settlement.decision === "approve_session" ? "allow_always" : "allow_once";
      },
      onSubagent: (subagent) => {
        const id = `kbrain-subagent:${subagent.id}`;
        const call: ToolCall = {
          type: "toolCall",
          id,
          name: "subagent",
          arguments: {
            id: subagent.id,
            description: subagent.description,
            status: subagent.status,
            model: subagent.model,
          },
        };
        onToolCall(call);
        if (["done", "completed", "error", "failed", "cancelled"].includes(subagent.status)) {
          onToolResult(call, {
            role: "toolResult",
            toolCallId: id,
            toolName: call.name,
            content: [
              {
                type: "text",
                text: subagent.error || subagent.report || subagent.status,
              },
            ],
            isError: !["done", "completed"].includes(subagent.status),
            timestamp: Date.now(),
          });
        }
      },
    });
    const assistantCallIds = new Set(
      assistant.content.filter((block) => block.type === "toolCall").map((block) => block.id),
    );
    const projected: AssistantMessage = {
      ...assistant,
      content: [
        ...assistant.content,
        ...Array.from(calls.values()).filter((call) => !assistantCallIds.has(call.id)),
      ],
    };
    update((target) => ({
      ...collapseThinking(target),
      runningToolCallIds: [],
      meta: {
        provider: projected.provider,
        model: projected.model,
        api: projected.api,
        stopReason: projected.stopReason,
        usage: projected.usage,
      },
    }));
    gatewayBridgeEvents.queueToken("", {
      round,
      provider: projected.provider,
      model: projected.model,
      api: projected.api,
      stopReason: projected.stopReason,
      usage: projected.usage,
    });
    if (projected.errorMessage) gatewayBridgeEvents.emitError(projected.errorMessage);
    let state = appendMessagesToConversation(params.getNextConversationState(), [
      projected,
      ...results.values(),
    ]);
    if (projected.stopReason !== "error" && projected.stopReason !== "aborted") {
      try {
        const history = await getKBrainHistoryWindow(params.conversationId);
        state = buildConversationStateFromWindow(history);
      } catch (error) {
        gatewayBridgeEvents.emitError(
          `Reply completed, but history refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    params.applyConversationState(state);
    params.freezeGatewayFinalProjection(state, true);
    params.settleLiveTranscript(transcriptStore);
    await params.persistConversationWithHistorySync({
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      providerId: projected.provider,
      model: projected.model,
      cwd: "historyCwd" in params ? params.historyCwd : params.conversationCwd,
      state,
      fallbackTitle: params.fallbackTitle,
      createdAt: params.createdAt,
      titlePromise: params.titlePromise,
    });
  } finally {
    approvalController.abort();
    cancellation.userStop.signal.removeEventListener("abort", cancelApprovals);
    status(null);
    hookLifecycle.ensureMessageEnded();
    hookLifecycle.endTurn(round);
    hookLifecycle.endAgent();
  }
}
