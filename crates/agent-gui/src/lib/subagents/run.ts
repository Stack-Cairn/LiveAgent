import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SubagentReportDetails } from "@liveagent/ui/lib/subagents/protocol";
import { CompactionController } from "../chat/compaction/controller";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
  createConversationStateFromContext,
} from "../chat/conversation/conversationState";
import { createTurnCancellationFromSignal } from "../chat/conversation/turnCancellation";
import { runAssistantWithTools } from "../chat/runner/agentRunner";
import type { ProviderRuntimeConfig } from "../providers/runtime/types";
import type { RuntimePlatform } from "../runtimePlatform";
import type { ProviderId } from "../settings";
import type { AdditionalProjectRoot } from "../tools/additionalProjectRoots";
import { renderMessageBusSnapshot } from "./bus";
import { toolErrorResult } from "./errors";
import type { SubagentWorktreeIpc } from "./ipc/worktree";
import { decideWorktreeApply, decideWorktreeCleanup, selectWorktreeTools } from "./policy";
import {
  buildMessageBusUpdateMessage,
  buildSubagentContext,
  buildSubagentContinuationMessage,
  buildSubagentSystemPrompt,
  resolveSubagentRetainedUserText,
} from "./prompts";
import { createSubagentIdentity } from "./roster";
import type { SubagentScheduler } from "./scheduler";
import type { SubagentConversationStore } from "./store";
import {
  MAX_DIFF_CHARS,
  type SubagentIdentity,
  type SubagentRunStatus,
  type SubagentSpec,
  type SubagentTemplate,
  type SubagentToolRegistry,
  type SubagentWorktreeInfo,
  type SubagentWorktreeStatus,
} from "./types";
import {
  assistantMessageToText,
  normalizeErrorMessage,
  randomIdSuffix,
  sanitizeLabelPart,
  truncateText,
} from "./utils";

type ChildToolExecutor = (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;

export type SubagentRunEnvironment = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  runtimePlatform?: RuntimePlatform;
  workdir: string;
  additionalRoots?: readonly AdditionalProjectRoot[];
  sessionId?: string;
  messageBusEnabled: boolean;
  store: SubagentConversationStore;
  scheduler: SubagentScheduler;
  worktree: SubagentWorktreeIpc;
  createChildToolRegistry?: (workdir: string) => Promise<SubagentToolRegistry>;
  readonlyTools: Tool[];
  readonlyExecuteToolCall: ChildToolExecutor;
  withMessageTools?: (
    agent: { id: string; name: string; runId: string },
    tools: Tool[],
    execute: ChildToolExecutor,
  ) => { tools: Tool[]; execute: ChildToolExecutor };
  enqueueWorktreeApply: <T>(run: () => Promise<T>) => Promise<T>;
  /** 父对话检查点上下文;传给 worktree.apply 让后端在改写父工作区前捕获前像。 */
  checkpoint?: { conversationId: string; turnId: string };
  onStatus?: (status: string | null) => void;
};

export type SubagentRunRequest = {
  spec: SubagentSpec;
  existingIdentity?: SubagentIdentity;
  template?: SubagentTemplate;
  parentToolCallId: string;
  index: number;
  total: number;
  signal?: AbortSignal;
};

export function buildSubagentRunId(parentToolCallId: string, agentId: string, index: number) {
  const call = sanitizeLabelPart(parentToolCallId, "call");
  const agent = sanitizeLabelPart(agentId, `agent-${index + 1}`);
  return `${call}:agent:${index + 1}:${agent}:${randomIdSuffix()}`;
}

function buildWorktreeLabel(params: {
  sessionId?: string;
  parentToolCallId: string;
  agentId: string;
  index: number;
}) {
  const prefix = params.sessionId
    ? sanitizeLabelPart(params.sessionId.split(":")[0] || params.sessionId, "session")
    : "session";
  const call = sanitizeLabelPart(params.parentToolCallId, "call");
  const agent = sanitizeLabelPart(params.agentId, `agent-${params.index + 1}`);
  return `${prefix}-${call}-${params.index + 1}-${agent}`;
}

function isCancellation(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  return error instanceof Error && error.message === "Cancelled";
}

/**
 * Execute one subagent run through five explicit phases:
 * provision (identity + worktree + tools + resume) -> execute (turn loop with
 * turn-boundary incremental persistence) -> settle (apply/cleanup) -> report.
 * Batch-level validation happened before this function is called.
 */
export async function executeSubagentRun(
  env: SubagentRunEnvironment,
  request: SubagentRunRequest,
): Promise<SubagentReportDetails> {
  const { spec, template, signal } = request;
  const startedAt = Date.now();
  const persistenceEnabled = Boolean(env.store.conversationId);

  // ---- provision: identity ------------------------------------------------
  let identity =
    request.existingIdentity ??
    createSubagentIdentity({
      parentConversationId: env.store.conversationId,
      toolCallId: request.parentToolCallId,
      spec,
      template,
      now: startedAt,
    });
  const identityNeedsPersist = !request.existingIdentity || identity.lastMode !== spec.mode;
  if (identity.lastMode !== spec.mode) {
    identity = { ...identity, lastMode: spec.mode };
  }

  const runId = buildSubagentRunId(request.parentToolCallId, spec.id, request.index);
  const existingRunSummary = spec.resume ? env.store.getLatestRun(spec.id) : undefined;
  const subagentSessionId = env.sessionId
    ? (existingRunSummary?.sessionId ??
      (spec.resume
        ? `${env.sessionId}:subagent:${sanitizeLabelPart(spec.id, `agent-${request.index + 1}`)}`
        : `${env.sessionId}:subagent:${sanitizeLabelPart(spec.id, `agent-${request.index + 1}`)}:fresh:${sanitizeLabelPart(runId, "run")}`))
    : undefined;

  // ---- mutable run outcome -------------------------------------------------
  let rounds = 0;
  let toolCalls = 0;
  let compactions = 0;
  let worktree: SubagentWorktreeInfo | undefined;
  let worktreeStatus: SubagentWorktreeStatus | undefined;
  let worktreeStatusError: string | undefined;
  let applyStatus: SubagentReportDetails["applyStatus"];
  let applyMethod: SubagentReportDetails["applyMethod"];
  let applyChanged: boolean | undefined;
  let applyPatchBytes: number | undefined;
  let applySkippedReason: string | undefined;
  let applyFallbackReason: string | undefined;
  let applyCopiedFiles: string[] | undefined;
  let applyDeletedFiles: string[] | undefined;
  let applyConflictFiles: string[] | undefined;
  let applyError: string | undefined;
  let appliedToWorkdir: string | undefined;
  let worktreeCleanupStatus: SubagentReportDetails["worktreeCleanupStatus"];
  let worktreeCleanupReason: string | undefined;
  let worktreeCleanupError: string | undefined;
  let worktreeBranchDeleted: boolean | undefined;
  let candidateArtifacts: string[] | undefined;
  let changedPaths: string[] | undefined;
  let childWorkdir = env.workdir;

  const persistenceWarnings: string[] = [];
  const trackedPersists: Promise<void>[] = [];
  let lastPersistedMessageCount = -1;

  const persistRun = (
    status: SubagentRunStatus,
    view: ConversationViewState,
    options?: {
      summary?: string;
      error?: string;
      endedAt?: number;
    },
  ) => {
    if (!persistenceEnabled) return Promise.resolve();
    return env.store.saveRunState({
      id: runId,
      parentToolCallId: request.parentToolCallId,
      agentId: spec.id,
      agentIndex: request.index,
      agentTotal: request.total,
      prompt: spec.prompt,
      mode: spec.mode,
      status,
      providerId: env.providerId,
      model: env.model,
      sessionId: subagentSessionId,
      workdir: childWorkdir,
      worktreeRoot: worktree?.worktreeRoot,
      branchName: worktree?.branchName,
      roundCount: rounds,
      toolCallCount: toolCalls,
      compactionCount: compactions,
      summary: options?.summary,
      error: options?.error,
      startedAt,
      endedAt: options?.endedAt,
      state: view,
    });
  };
  const schedulePersist = (
    status: SubagentRunStatus,
    view: ConversationViewState,
    options?: { summary?: string; error?: string; endedAt?: number },
  ) => {
    if (status === "running" && view.meta.totalMessageCount === lastPersistedMessageCount) {
      return;
    }
    lastPersistedMessageCount = view.meta.totalMessageCount;
    trackedPersists.push(
      persistRun(status, view, options).catch((error) => {
        persistenceWarnings.push(
          normalizeErrorMessage(error, "Failed to persist subagent history"),
        );
      }),
    );
  };
  const flushPersists = async () => {
    while (trackedPersists.length > 0) {
      const pending = trackedPersists.splice(0);
      await Promise.all(pending);
    }
  };

  const buildReport = (
    status: SubagentReportDetails["status"],
    outcome: { summary?: string; error?: string },
  ): SubagentReportDetails => ({
    id: spec.id,
    runId,
    name: identity.name,
    role: identity.role,
    prompt: spec.prompt,
    templateId: spec.templateId,
    mode: spec.mode,
    applyPolicy: spec.mode === "worktree" ? spec.applyPolicy : undefined,
    allowedOutputPaths: spec.allowedOutputPaths.length > 0 ? spec.allowedOutputPaths : undefined,
    status,
    summary: outcome.summary ?? "",
    durationMs: Date.now() - startedAt,
    rounds,
    toolCalls,
    error: outcome.error,
    persistenceWarnings: persistenceWarnings.length > 0 ? [...persistenceWarnings] : undefined,
    worktreeRoot: worktree?.worktreeRoot,
    workdir: worktree?.workdir,
    branchName: worktree?.branchName,
    changed: worktreeStatus?.changed,
    statusText: worktreeStatus?.status,
    diffStat: worktreeStatus?.diffStat,
    diff: worktreeStatus?.diff,
    diffTruncated: worktreeStatus?.diffTruncated,
    untrackedFiles: worktreeStatus?.untrackedFiles,
    worktreeStatusError,
    applyStatus,
    applyMethod,
    applyChanged,
    applyPatchBytes,
    applySkippedReason,
    applyFallbackReason,
    applyCopiedFiles,
    applyDeletedFiles,
    applyConflictFiles,
    applyError,
    appliedToWorkdir,
    worktreeCleanupStatus,
    worktreeCleanupReason,
    worktreeCleanupError,
    worktreeBranchDeleted,
    candidateArtifacts,
    changedPaths,
  });

  const renderBusSnapshot = async () => {
    if (!env.messageBusEnabled) return "";
    try {
      const messages = await env.store.listBusMessages(spec.id);
      return renderMessageBusSnapshot({
        messages,
        currentAgentId: spec.id,
        currentAgentName: identity.name,
      }).text;
    } catch (error) {
      console.warn("Failed to load subagent message bus snapshot", error);
      return "";
    }
  };

  const fetchWorktreeStatus = async () => {
    if (!worktree) return;
    try {
      worktreeStatus = await env.worktree.status({
        worktreeRoot: worktree.worktreeRoot,
        maxDiffChars: MAX_DIFF_CHARS,
      });
    } catch (error) {
      worktreeStatusError = normalizeErrorMessage(
        error,
        "Failed to inspect subagent worktree status",
      );
    }
  };

  const settleWorktree = async (terminal: "completed" | "failed" | "cancelled") => {
    if (!worktree) return;
    const worktreeRoot = worktree.worktreeRoot;
    env.onStatus?.(`Inspecting worktree changes for ${identity.name}…`);
    await fetchWorktreeStatus();

    const agentSucceeded = terminal === "completed";
    if (agentSucceeded) {
      const applyDecision = worktreeStatus
        ? decideWorktreeApply({ spec, status: worktreeStatus })
        : undefined;
      if (applyDecision) {
        changedPaths = applyDecision.changedPaths;
        candidateArtifacts = applyDecision.candidateArtifacts;
      }
      if (worktreeStatus?.changed && applyDecision?.shouldApply) {
        env.onStatus?.(`Applying worktree changes from ${identity.name}…`);
        try {
          const applyResult = await env.enqueueWorktreeApply(() =>
            env.worktree.apply({
              parentWorkdir: env.workdir,
              worktreeRoot,
              ...(env.checkpoint ? { checkpoint: env.checkpoint } : {}),
            }),
          );
          applyStatus = applyResult.applied ? "applied" : "skipped";
          applyMethod = applyResult.applyMethod;
          applyChanged = applyResult.changed;
          applyPatchBytes = applyResult.patchBytes;
          applySkippedReason = applyResult.skippedReason;
          applyFallbackReason = applyResult.fallbackReason;
          applyCopiedFiles = applyResult.copiedFiles;
          applyDeletedFiles = applyResult.deletedFiles;
          applyConflictFiles = applyResult.conflictFiles;
          appliedToWorkdir = env.workdir;
        } catch (error) {
          applyStatus = "failed";
          applyError = normalizeErrorMessage(error, "Failed to apply subagent worktree changes");
        }
      } else {
        applyStatus = "skipped";
        applyChanged = false;
        applyPatchBytes = 0;
        applySkippedReason = worktreeStatusError
          ? "status_unavailable"
          : (applyDecision?.skippedReason ?? "no_changes");
      }
    } else {
      applyStatus = "skipped";
      applyChanged = false;
      applyPatchBytes = 0;
      applySkippedReason = terminal === "cancelled" ? "agent_cancelled" : "agent_failed";
    }

    const cleanupDecision = agentSucceeded
      ? decideWorktreeCleanup({
          spec,
          status: worktreeStatus,
          statusError: worktreeStatusError,
          applyStatus,
          applySkippedReason,
        })
      : { shouldCleanup: false, reason: applySkippedReason ?? "agent_failed" };
    worktreeCleanupReason = cleanupDecision.reason;
    if (cleanupDecision.shouldCleanup) {
      env.onStatus?.(`Cleaning up worktree for ${identity.name}…`);
      try {
        const cleanupResult = await env.worktree.cleanup({
          worktreeRoot: worktree.worktreeRoot,
          branchName: worktree.branchName,
        });
        worktreeBranchDeleted = cleanupResult.branchDeleted;
        if (cleanupResult.error) {
          worktreeCleanupStatus = "failed";
          worktreeCleanupError = cleanupResult.error;
        } else if (cleanupResult.removed) {
          worktreeCleanupStatus = "removed";
        } else {
          worktreeCleanupStatus = "skipped";
          worktreeCleanupReason = cleanupResult.skippedReason ?? worktreeCleanupReason;
        }
      } catch (error) {
        worktreeCleanupStatus = "failed";
        worktreeCleanupError = normalizeErrorMessage(error, "Failed to clean up subagent worktree");
      }
    } else {
      worktreeCleanupStatus = "retained";
    }
    env.onStatus?.(null);
  };

  // ---- provision: persist identity ----------------------------------------
  if (persistenceEnabled && identityNeedsPersist) {
    try {
      identity = await env.store.upsertIdentity(identity);
    } catch (error) {
      const message = normalizeErrorMessage(error, "Failed to persist subagent identity");
      return buildReport("failed", {
        error: `provision_failed: ${message}`,
      });
    }
  }

  // Latest full view (base state + messages emitted since); what failure
  // and turn-boundary persistence write.
  let lastView: ConversationViewState | undefined;

  try {
    // ---- provision: tools / worktree ---------------------------------------
    let childTools: Tool[];
    let childExecute: ChildToolExecutor;
    if (spec.mode === "worktree") {
      if (!env.createChildToolRegistry) {
        throw new Error(
          "worktree_unavailable: Agent mode=worktree is not available in this runtime.",
        );
      }
      env.onStatus?.(`Creating isolated worktree for ${identity.name}…`);
      worktree = await env.worktree.create({
        workdir: env.workdir,
        label: buildWorktreeLabel({
          sessionId: env.sessionId,
          parentToolCallId: request.parentToolCallId,
          agentId: spec.id,
          index: request.index,
        }),
      });
      env.onStatus?.(null);
      const childRegistry = await env.createChildToolRegistry(worktree.workdir);
      childTools = selectWorktreeTools({
        tools: childRegistry.tools,
        metadataByName: childRegistry.metadataByName,
      });
      childExecute = childRegistry.executeToolCall;
      childWorkdir = worktree.workdir;
    } else {
      childTools = env.readonlyTools;
      childExecute = env.readonlyExecuteToolCall;
    }
    if (env.withMessageTools) {
      const attached = env.withMessageTools(
        { id: spec.id, name: identity.name, runId },
        childTools,
        childExecute,
      );
      childTools = attached.tools;
      childExecute = attached.execute;
    }
    const childToolNames = new Set(childTools.map((tool) => tool.name));

    // ---- provision: context (resume or fresh) ------------------------------
    const systemPrompt = buildSubagentSystemPrompt({
      spec,
      identity,
      template,
      worktree,
      agentIndex: request.index,
      agentTotal: request.total,
      messageBusEnabled: env.messageBusEnabled,
    });
    // 发给模型的请求上下文：与主会话同口径带上 checkpoint bridge（摘要只经它进入请求）。
    const buildChildRequestContext = (state: ConversationViewState) =>
      buildRequestContext(state, { includeCheckpointBridge: true });
    // 子代理复用同一压缩状态机：结果状态经 compact 的返回值落地，sinks 只触发运行期持久化。
    const compaction = new CompactionController();
    compaction.bindTurn({
      providerId: env.providerId,
      model: env.model,
      runtime: env.runtime,
      sessionId: subagentSessionId,
      cancellation: createTurnCancellationFromSignal(signal),
      sinks: {
        persist: async (state) => {
          schedulePersist("running", state);
          return undefined;
        },
      },
      resolveRetainedUserText: resolveSubagentRetainedUserText,
    });

    let restoredState: ConversationViewState | null = null;
    if (existingRunSummary) {
      const restored = await env.store.loadRunState({
        runSummary: existingRunSummary,
        systemPrompt,
        tools: childTools,
      });
      if (restored) {
        // 续跑消息追加之前先按恢复出的上下文做一次发送前压缩。
        const compacted = await compaction.compact({
          trigger: "pre-send",
          state: restored,
          buildContext: buildChildRequestContext,
        });
        compactions = compaction.stats.compactionsApplied;
        restoredState = appendMessagesToConversation(
          compacted.outcome === "compacted" ? compacted.state : restored,
          [
            buildSubagentContinuationMessage({
              spec,
              identity,
              resumedFrom: existingRunSummary,
              messageBusSnapshot: await renderBusSnapshot(),
              messageBusEnabled: env.messageBusEnabled,
            }),
          ],
        );
      }
    }
    // The state whose request context is the runner's current message
    // baseline. Advanced only when an applied compaction replaces the
    // turn context.
    let baseState: ConversationViewState =
      restoredState ??
      createConversationStateFromContext(
        buildSubagentContext({
          spec,
          identity,
          template,
          worktree,
          tools: childTools,
          agentIndex: request.index,
          agentTotal: request.total,
          messageBusSnapshot: await renderBusSnapshot(),
          messageBusEnabled: env.messageBusEnabled,
        }),
      );
    lastView = baseState;
    schedulePersist("running", baseState);

    // ---- execute ------------------------------------------------------------
    const result = await runAssistantWithTools({
      providerId: env.providerId,
      model: env.model,
      runtime: env.runtime,
      runtimePlatform: env.runtimePlatform,
      context: buildChildRequestContext(baseState),
      workdir: childWorkdir,
      additionalRoots: env.additionalRoots,
      sessionId: subagentSessionId,
      nativeWebSearch: env.runtime.nativeWebSearchEnabled !== false,
      tools: childTools,
      subagentScheduler: env.scheduler,
      executeToolCall: (childToolCall, childSignal) => {
        if (!childToolNames.has(childToolCall.name)) {
          return Promise.resolve(
            toolErrorResult(
              childToolCall,
              `Tool ${childToolCall.name} is not available to delegated subagents in mode=${spec.mode}.`,
            ),
          );
        }
        return childExecute(childToolCall, childSignal);
      },
      onRequestPrepared: (recipe) => compaction.noteRequest(recipe),
      onTurnStart: (round) => {
        rounds = Math.max(rounds, round);
      },
      onTextDelta: () => {},
      onToolExecutionStart: () => {
        toolCalls += 1;
      },
      onBeforeNextTurn: async ({ emittedMessages, runtimeContext, willContinue }) => {
        const view = appendMessagesToConversation(baseState, emittedMessages);
        lastView = view;
        if (!willContinue) {
          schedulePersist("running", view);
          return null;
        }
        const busUpdateMessage = buildMessageBusUpdateMessage(await renderBusSnapshot());

        // controller 内部消化非中止失败；用户中止会原样抛出。
        const compacted = await compaction.compact({
          trigger: "post-tool",
          state: view,
          buildContext: buildChildRequestContext,
          forkMessages: runtimeContext.messages,
        });

        if (compacted.outcome !== "compacted") {
          schedulePersist("running", view);
          if (!busUpdateMessage) return null;
          const context = buildChildRequestContext(view);
          return {
            context: { ...context, messages: [...context.messages, busUpdateMessage] },
            emittedMessages: [...emittedMessages, busUpdateMessage],
          };
        }

        const nextState = compacted.state;
        compactions = compaction.stats.compactionsApplied;
        baseState = nextState;
        lastView = nextState;
        schedulePersist("running", nextState);
        // 带 bus 刷新时从状态重建：压缩后 segment 为空，bus 消息成为首条 user、bridge
        // 合入它——不出现连续两条 user，且与下一轮从 view 重建的请求字节一致。
        return {
          context: buildChildRequestContext(
            busUpdateMessage
              ? appendMessagesToConversation(nextState, [busUpdateMessage])
              : nextState,
          ),
          emittedMessages: busUpdateMessage ? [busUpdateMessage] : [],
        };
      },
      signal,
    });

    const finalState = appendMessagesToConversation(baseState, result.emittedMessages);
    lastView = finalState;

    // ---- settle ---------------------------------------------------------------
    await settleWorktree("completed");

    // ---- report ---------------------------------------------------------------
    const summary =
      truncateText(assistantMessageToText(result.assistant).trim()) ||
      "(subagent returned an empty report)";
    schedulePersist("completed", finalState, { summary, endedAt: Date.now() });
    await flushPersists();
    return buildReport("completed", { summary });
  } catch (error) {
    const cancelled = isCancellation(error, signal);
    const status: "failed" | "cancelled" = cancelled ? "cancelled" : "failed";
    const message = cancelled
      ? "Cancelled"
      : normalizeErrorMessage(error, "Delegated subagent failed");
    try {
      await settleWorktree(status);
    } catch {
      // Settlement is best-effort on the failure path.
    }
    if (lastView) {
      schedulePersist(status, lastView, { error: message, endedAt: Date.now() });
    }
    await flushPersists();
    return buildReport(status, { error: message });
  }
}
