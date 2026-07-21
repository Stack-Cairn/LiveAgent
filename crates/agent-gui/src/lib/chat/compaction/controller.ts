import type { Context, UserMessage } from "@earendil-works/pi-ai";

import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { ProviderId } from "../../settings";
import { type ConversationViewState, getActiveSegment } from "../conversation/conversationState";
import type { TurnCancellation } from "../conversation/turnCancellation";
import type { PendingUploadedFile } from "../messages/uploadedFiles";
import { isAbortLikeError } from "../page/chatPageHelpers";
import { createSyntheticContinueUserMessage, runCompaction } from "./engine";
import {
  createCompactionPressure,
  decideCompaction,
  normalizeCompactionPressure,
  notePressureAfterCompaction,
  resolvePruneOptions,
  shouldPruneBeforeCompaction,
} from "./policy";
import { type PruneConversationResult, pruneConversationState } from "./prune";
import {
  buildCompactionRunningStatus,
  buildPruneFallbackStatus,
  PRUNE_FALLBACK_NOTICE,
} from "./statusText";
import { type CompleteAssistantFn, createCompactionAbortError } from "./summarizer";
import { TokenLedger } from "./tokenLedger";
import type {
  CompactionDecision,
  CompactionIntent,
  CompactionStatus,
  CompactionTrigger,
  ProviderRuntimeConfig,
} from "./types";

type ContextBuildOptions = {
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
};

// 所有副作用经由注入的 sinks：ChatPage 提供完整实现，子代理提供轻量子集。
// 全部可选——缺省即 no-op，controller 自身保持纯净可测。
export type CompactionSinks = {
  applyState?: (state: ConversationViewState) => void;
  // 运行中换底：apply + 清空 live transcript（压缩/prune 结果落地后旧流式内容已过期）。
  applyStateMidRun?: (state: ConversationViewState) => void;
  publishStatus?: (status: CompactionStatus) => void;
  setBridgeToolStatus?: (status: string | null, isCompaction?: boolean) => void;
  queueCheckpoint?: (state: ConversationViewState) => void;
  persist?: (state: ConversationViewState) => Promise<unknown>;
  restoreComposer?: (
    composerText: string | undefined,
    uploadedFiles: PendingUploadedFile[],
  ) => void;
  persistRollback?: (state: ConversationViewState) => Promise<unknown>;
};

export type CompactionPreSendBinding = {
  // 待 checkpoint 的基线状态（不含本轮待发送的用户消息）。
  baseState: ConversationViewState;
  pendingUserText: string;
  composerText?: string;
  uploadedFiles?: PendingUploadedFile[];
  // 压缩/prune 后如何得到要 apply 的最终状态（如重新附加待发送的用户消息）。
  composeAppliedState: (state: ConversationViewState) => ConversationViewState;
};

export type CompactionTurnBinding = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  cancellation: TurnCancellation;
  debugLogger?: StreamDebugLogger;
  complete?: CompleteAssistantFn;
  sinks: CompactionSinks;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: ContextBuildOptions,
  ) => Context;
  buildResumeContext: (
    state: ConversationViewState,
    resumeMessage?: UserMessage,
    tools?: Context["tools"],
    options?: ContextBuildOptions,
  ) => Context;
  presend?: CompactionPreSendBinding;
};

export type CompactionDuringRunResult = {
  context: Context | null;
  shouldDisableProtection: boolean;
};

type RollbackSnapshot = {
  state: ConversationViewState;
  composerText?: string;
  uploadedFiles?: PendingUploadedFile[];
  persistOnRollback?: boolean;
};

/**
 * 每会话压缩状态机。跨轮持有压力阶梯与 token 账本；每轮 bindTurn 注入
 * 运行时/sinks/取消链。单飞由 inFlight 保证；回滚快照是实例字段，所有
 * 终态都经 settle*() 收敛（状态发布与 bridge 状态清理成对，不再散落）。
 */
export class CompactionController {
  private pressure = createCompactionPressure();
  private readonly ledger = new TokenLedger();
  private binding: CompactionTurnBinding | null = null;
  private rollbackSnapshot: RollbackSnapshot | null = null;
  private inFlight = false;
  private statusPhase: CompactionStatus["phase"] = "idle";
  private turnMeta = { activeMessageCount: 0, userMessageCount: 0, lastSummaryAt: 0 };

  bindTurn(binding: CompactionTurnBinding) {
    this.binding = binding;
    this.rollbackSnapshot = null;
    this.inFlight = false;
  }

  unbindTurn() {
    this.binding = null;
    this.rollbackSnapshot = null;
    this.inFlight = false;
  }

  get stats() {
    return { compactionsApplied: this.pressure.compactionsApplied };
  }

  beginRequest(context: Context, state: ConversationViewState) {
    this.ledger.rebase(context);
    this.updateTurnMeta(state);
  }

  // O(1)：账本读数 + 流式增量估算 + 纯决策，无状态构建、无序列化。
  // pendingTokenUnits 由调用方按流式 delta 用 estimateTextTokenUnits 累加。
  shouldProtectMidStream(pendingTokenUnits: number): boolean {
    if (!this.binding || this.inFlight) return false;
    return this.decide("protection", this.ledger.totalWithPendingTokens(pendingTokenUnits))
      .shouldCompact;
  }

  async maybeCompactPreSend(params: {
    budgetContext: Context;
    tools?: Context["tools"];
    includeUploadedFilesMetadata?: boolean;
  }): Promise<boolean> {
    const binding = this.binding;
    const presend = binding?.presend;
    if (!binding || !presend) return false;
    if (binding.cancellation.userStop.signal.aborted) {
      throw createCompactionAbortError();
    }
    const now = Date.now();
    const buildOptions: ContextBuildOptions = {
      includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
    };

    let workingState = presend.baseState;
    let pruned: PruneConversationResult | null = null;
    if (shouldPruneBeforeCompaction(this.pressure, now)) {
      const attempt = pruneConversationState(workingState, resolvePruneOptions(this.pressure));
      if (attempt.applied) {
        pruned = attempt;
        workingState = attempt.state;
      }
    }

    const budgetContext = pruned
      ? binding.buildPreparedContext(workingState, params.tools, buildOptions)
      : params.budgetContext;
    this.ledger.rebase(budgetContext);
    this.updateTurnMeta(workingState);
    const decision = this.decide("optimization", this.ledger.total(), now);
    this.logDecision(decision);

    if (!decision.shouldCompact) {
      if (pruned) {
        binding.sinks.applyState?.(presend.composeAppliedState(pruned.state));
        return true;
      }
      return false;
    }

    this.rollbackSnapshot = {
      state: presend.baseState,
      composerText: presend.composerText,
      uploadedFiles: presend.uploadedFiles,
    };
    this.inFlight = true;
    this.publishRunning("pre-send", workingState.activeSegmentIndex, decision);

    const scope = binding.cancellation.deriveScope();
    try {
      const outcome = await runCompaction({
        state: workingState,
        incomingUserText: presend.pendingUserText,
        intent: "optimization",
        contextTokens: decision.totalTokens,
        threshold: decision.threshold,
        providerId: binding.providerId,
        model: binding.model,
        runtime: binding.runtime,
        signal: scope.controller.signal,
        debugLogger: binding.debugLogger,
        complete: binding.complete,
      });

      // best-effort：失败由差量写入器在下一次持久化时以全量 upsert 自愈。
      await binding.sinks.persist?.(outcome.state);
      this.rollbackSnapshot = null;
      const appliedState = presend.composeAppliedState(outcome.state);
      binding.sinks.applyState?.(appliedState);
      this.settleCompleted("pre-send", outcome.newSegmentIndex);
      binding.sinks.queueCheckpoint?.(outcome.state);
      this.notePostCompactionPressure(
        binding.buildPreparedContext(appliedState, params.tools, buildOptions),
        appliedState,
        decision.threshold,
      );
      return true;
    } catch (error) {
      if (this.isAbortOutcome(scope.controller.signal, error)) {
        throw error;
      }
      this.rollbackSnapshot = null;
      const fallback =
        pruned ?? pruneConversationState(presend.baseState, resolvePruneOptions(this.pressure));
      if (fallback.applied) {
        binding.sinks.applyState?.(presend.composeAppliedState(fallback.state));
        this.settleFailed("pre-send", PRUNE_FALLBACK_NOTICE);
        binding.sinks.setBridgeToolStatus?.(buildPruneFallbackStatus(fallback.prunedMessageCount));
        return true;
      }
      console.warn("发送前上下文压缩失败，继续使用原始上下文", error);
      this.settleFailed("pre-send", error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      scope.release();
      this.inFlight = false;
      this.binding?.sinks.setBridgeToolStatus?.(null);
    }
  }

  async compactDuringRun(params: {
    trigger: Exclude<CompactionTrigger, "pre-send">;
    state: ConversationViewState;
    budgetContext?: Context;
    tools?: Context["tools"];
    includeAbortedMessages?: boolean;
    includeUploadedFilesMetadata?: boolean;
  }): Promise<CompactionDuringRunResult> {
    const binding = this.binding;
    if (!binding) {
      return { context: null, shouldDisableProtection: false };
    }
    // 覆盖"mid-stream abort 后、summarizer 启动前"用户恰好点停止的间隙。
    if (binding.cancellation.userStop.signal.aborted) {
      throw createCompactionAbortError();
    }
    const now = Date.now();
    const buildOptions: ContextBuildOptions = {
      includeAbortedMessages: params.includeAbortedMessages,
      includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
    };
    const buildFallbackContext = (state: ConversationViewState): Context => {
      if (params.trigger !== "mid-stream") {
        return binding.buildPreparedContext(state, params.tools, buildOptions);
      }
      const messages = getActiveSegment(state)?.messages ?? [];
      const lastTimestamp = messages[messages.length - 1]?.timestamp;
      const resumeMessage = createSyntheticContinueUserMessage(
        typeof lastTimestamp === "number" ? lastTimestamp + 1 : now,
      );
      return binding.buildResumeContext(state, resumeMessage, params.tools, {
        includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
      });
    };

    let workingState = params.state;
    let pruned: PruneConversationResult | null = null;
    if (shouldPruneBeforeCompaction(this.pressure, now)) {
      const attempt = pruneConversationState(workingState, resolvePruneOptions(this.pressure));
      if (attempt.applied) {
        pruned = attempt;
        workingState = attempt.state;
      }
    }

    const budgetContext =
      !pruned && params.budgetContext
        ? params.budgetContext
        : binding.buildPreparedContext(workingState, params.tools, buildOptions);
    this.ledger.rebase(budgetContext);
    this.updateTurnMeta(workingState);
    const decision = this.decide("protection", this.ledger.total(), now);
    this.logDecision(decision);

    if (!decision.shouldCompact) {
      if (pruned) {
        binding.sinks.applyStateMidRun?.(pruned.state);
        return {
          context: buildFallbackContext(pruned.state),
          shouldDisableProtection: false,
        };
      }
      return params.trigger === "mid-stream"
        ? {
            context: buildFallbackContext(workingState),
            shouldDisableProtection: true,
          }
        : { context: null, shouldDisableProtection: false };
    }

    this.rollbackSnapshot = { state: params.state, persistOnRollback: true };
    this.inFlight = true;
    this.publishRunning(params.trigger, workingState.activeSegmentIndex, decision);

    const scope = binding.cancellation.deriveScope();
    try {
      const outcome = await runCompaction({
        state: workingState,
        intent: "protection",
        contextTokens: decision.totalTokens,
        threshold: decision.threshold,
        providerId: binding.providerId,
        model: binding.model,
        runtime: binding.runtime,
        signal: scope.controller.signal,
        debugLogger: binding.debugLogger,
        complete: binding.complete,
      });

      await binding.sinks.persist?.(outcome.state);
      this.rollbackSnapshot = null;
      binding.sinks.applyStateMidRun?.(outcome.state);
      this.settleCompleted(params.trigger, outcome.newSegmentIndex);
      binding.sinks.queueCheckpoint?.(outcome.state);

      const resumeMessage = createSyntheticContinueUserMessage(
        (outcome.checkpointMessage.timestamp ?? now) + 1,
      );
      const resumeContext = binding.buildResumeContext(outcome.state, resumeMessage, params.tools, {
        includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
      });
      this.notePostCompactionPressure(resumeContext, outcome.state, decision.threshold);
      return { context: resumeContext, shouldDisableProtection: false };
    } catch (error) {
      if (this.isAbortOutcome(scope.controller.signal, error)) {
        throw error;
      }
      this.rollbackSnapshot = null;
      const fallback =
        pruned ?? pruneConversationState(workingState, resolvePruneOptions(this.pressure));
      if (fallback.applied) {
        binding.sinks.applyStateMidRun?.(fallback.state);
        this.settleFailed(params.trigger, PRUNE_FALLBACK_NOTICE);
        binding.sinks.setBridgeToolStatus?.(buildPruneFallbackStatus(fallback.prunedMessageCount));
        return {
          context: buildFallbackContext(fallback.state),
          shouldDisableProtection: false,
        };
      }
      this.settleFailed(
        params.trigger,
        (error instanceof Error ? error.message : String(error)) || "压缩失败",
      );
      return params.trigger === "mid-stream"
        ? {
            context: buildFallbackContext(workingState),
            shouldDisableProtection: true,
          }
        : { context: null, shouldDisableProtection: false };
    } finally {
      scope.release();
      this.inFlight = false;
      this.binding?.sinks.setBridgeToolStatus?.(null);
    }
  }

  // 用户中止后的统一善后：有快照则回滚（恢复状态/输入框/可选持久化）并返回 true。
  async handleTurnAbort(): Promise<boolean> {
    const binding = this.binding;
    const snapshot = this.rollbackSnapshot;
    this.rollbackSnapshot = null;
    this.inFlight = false;
    if (!binding) return false;

    if (!snapshot) {
      if (this.statusPhase === "running") {
        this.publishStatus({ phase: "idle" });
      }
      return false;
    }

    binding.sinks.applyStateMidRun?.(snapshot.state);
    binding.sinks.setBridgeToolStatus?.(null, false);
    this.publishStatus({ phase: "idle" });
    binding.sinks.restoreComposer?.(snapshot.composerText, snapshot.uploadedFiles ?? []);
    if (snapshot.persistOnRollback) {
      await binding.sinks.persistRollback?.(snapshot.state);
    }
    return true;
  }

  private updateTurnMeta(state: ConversationViewState) {
    const segment = getActiveSegment(state);
    const messages = segment?.messages ?? [];
    let userMessageCount = 0;
    for (const message of messages) {
      if (message.role === "user") userMessageCount += 1;
    }
    this.turnMeta = {
      activeMessageCount: messages.length,
      userMessageCount,
      lastSummaryAt: segment?.summary?.timestamp ?? 0,
    };
  }

  private decide(intent: CompactionIntent, totalTokens: number, now = Date.now()) {
    const binding = this.binding;
    if (!binding) {
      throw new Error("compaction decision requested without an active turn binding");
    }
    this.pressure = normalizeCompactionPressure(this.pressure, now);
    return decideCompaction({
      providerId: binding.providerId,
      intent,
      totalTokens,
      modelConfig: binding.runtime.modelConfig,
      activeMessageCount: this.turnMeta.activeMessageCount,
      userMessageCount: this.turnMeta.userMessageCount,
      lastCompactionAt: Math.max(this.turnMeta.lastSummaryAt, this.pressure.lastCompactionAt),
      pressure: this.pressure,
      inFlight: this.inFlight,
      now,
    });
  }

  private notePostCompactionPressure(
    contextAfter: Context,
    stateAfter: ConversationViewState,
    threshold: number,
  ) {
    this.ledger.rebase(contextAfter);
    this.updateTurnMeta(stateAfter);
    this.pressure = notePressureAfterCompaction(this.pressure, {
      totalTokensAfter: this.ledger.total(),
      threshold,
      now: Date.now(),
    });
  }

  private isAbortOutcome(scopeSignal: AbortSignal, error: unknown) {
    return (
      this.binding?.cancellation.userStop.signal.aborted ||
      scopeSignal.aborted ||
      isAbortLikeError(error)
    );
  }

  private publishStatus(status: CompactionStatus) {
    this.statusPhase = status.phase;
    this.binding?.sinks.publishStatus?.(status);
  }

  private publishRunning(
    trigger: CompactionTrigger,
    sourceSegmentIndex: number,
    decision: CompactionDecision,
  ) {
    this.publishStatus({
      phase: "running",
      trigger,
      startedAt: Date.now(),
      sourceSegmentIndex,
    });
    this.binding?.sinks.setBridgeToolStatus?.(
      buildCompactionRunningStatus(decision, this.pressure),
      true,
    );
  }

  private settleCompleted(trigger: CompactionTrigger, newSegmentIndex: number) {
    this.publishStatus({
      phase: "completed",
      trigger,
      newSegmentIndex,
      completedAt: Date.now(),
    });
  }

  private settleFailed(trigger: CompactionTrigger, message: string) {
    this.publishStatus({ phase: "failed", trigger, failedAt: Date.now(), message });
  }

  private logDecision(decision: CompactionDecision) {
    this.binding?.debugLogger?.logResult({
      event: "compaction_decision",
      intent: decision.intent,
      reason: decision.reason,
      shouldCompact: decision.shouldCompact,
      totalTokens: decision.totalTokens,
      threshold: decision.threshold,
      thresholdMode: decision.thresholdMode,
      contextWindow: decision.contextWindow,
      maxOutputToken: decision.maxOutputToken,
      pressure: this.pressure,
      ledger: this.ledger.snapshot(),
    });
  }
}

export type CompactionControllerRegistry = {
  get: (conversationId: string) => CompactionController;
  dispose: (conversationId: string) => void;
};

export function createCompactionControllerRegistry(): CompactionControllerRegistry {
  const controllers = new Map<string, CompactionController>();
  return {
    get(conversationId: string) {
      const key = conversationId.trim();
      const existing = controllers.get(key);
      if (existing) return existing;
      const created = new CompactionController();
      controllers.set(key, created);
      return created;
    },
    dispose(conversationId: string) {
      controllers.delete(conversationId.trim());
    },
  };
}
