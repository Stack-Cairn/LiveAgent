import type { Context, UserMessage } from "@earendil-works/pi-ai";
import {
  canManualCompact,
  contextUsageRatio,
  positiveTokenCount,
} from "@liveagent/ui/lib/chat/contextUsage";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { ProviderId } from "../../settings";
import { type ConversationViewState, getActiveSegment } from "../conversation/conversationState";
import type { TurnCancellation } from "../conversation/turnCancellation";
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
import { deriveContextTokens, TokenLedger } from "./tokenLedger";
import type {
  CompactionDecision,
  CompactionDecisionReason,
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
  queueCheckpoint?: (state: ConversationViewState, contextUsageTokens: number) => void;
  persist?: (state: ConversationViewState) => Promise<boolean | undefined>;
  restoreComposer?: (
    composerText: string | undefined,
    uploadedFiles: PendingUploadedFile[],
  ) => void;
  persistRollback?: (state: ConversationViewState) => Promise<unknown>;
  // 压缩成功落地后的通知(finalizeCheckpoint 统一触发,三条压缩路径共用)。
  // 用于失效那些按消息 id 挂在 user 消息上的注入状态:载体消息被压缩移出
  // active segment 后,继续增量会静默丢变化,必须整体重冻结。
  onCompacted?: () => void;
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
  // 本次调用的显式结果通道。statusPhase 是控制器生命周期字段（跨操作残留、
  // 决策拒绝时不 publish），任何调用方都不得用它反推单次调用的结果。
  outcome: "compacted" | "skipped" | "failed";
  // skipped 时携带决策拒绝原因；无 binding 的空跑没有决策、不带 reason。
  reason?: CompactionDecisionReason;
};

export type ManualCompactionOutcome =
  | { status: "compacted" | "busy" }
  | { status: "failed"; aborted?: boolean }
  | { status: "skipped"; reason: CompactionDecisionReason };

export type ManualContextUsageSnapshot = {
  totalTokens?: number;
  fixedTokens?: number;
};

function withActiveSummaryContextTokens(
  state: ConversationViewState,
  contextUsageTokens: number,
): ConversationViewState {
  const segmentIndex = state.activeSegmentIndex;
  const segment = state.segments[segmentIndex];
  if (!segment?.summary) return state;
  const nextSegment = {
    ...segment,
    summary: {
      ...segment.summary,
      summaryMeta: {
        ...segment.summary.summaryMeta,
        stats: {
          ...(segment.summary.summaryMeta.stats ?? {
            sourceMessageCount: segment.summary.summaryMeta.coveredMessageCount,
          }),
          contextTokensAfter: contextUsageTokens,
        },
      },
    },
  };
  const segments = state.segments.slice();
  segments[segmentIndex] = nextSegment;
  return { ...state, segments };
}

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

  private async persistCheckpoint(binding: CompactionTurnBinding, state: ConversationViewState) {
    const persisted = await binding.sinks.persist?.(state);
    if (persisted === false) {
      throw new Error("compaction checkpoint persistence failed");
    }
  }

  // 压缩成功后的统一收尾（pre-send 与 during-run 共用同一顺序不变量）：
  // checkpoint 上下文估值 → 写回 summary stats → 持久化屏障 → 回滚快照失效 →
  // apply 落地 → completed 终态 → checkpoint 入队。tools 必须与真实请求同参，
  // 否则 contextTokensAfter 系统性少算工具重量；fixedTokens 用持久化的动态
  // 开销校准估值（undefined 时 deriveContextTokens 内部回退 system+tools 估算）。
  private async finalizeCheckpoint(params: {
    binding: CompactionTurnBinding;
    trigger: CompactionTrigger;
    state: ConversationViewState;
    newSegmentIndex: number;
    tools?: Context["tools"];
    buildOptions: ContextBuildOptions;
    fixedTokens?: number;
    // 在 persist 屏障之后、completed 终态之前同步执行的状态落地钩子。
    apply: (checkpointState: ConversationViewState) => void;
  }): Promise<{ checkpointState: ConversationViewState; checkpointTokens: number }> {
    const checkpointContext = params.binding.buildPreparedContext(
      params.state,
      params.tools,
      params.buildOptions,
    );
    const checkpointTokens = deriveContextTokens(checkpointContext, {
      fixedTokens: params.fixedTokens,
    });
    const checkpointState = withActiveSummaryContextTokens(params.state, checkpointTokens);
    await this.persistCheckpoint(params.binding, checkpointState);
    this.rollbackSnapshot = null;
    params.apply(checkpointState);
    this.settleCompleted(params.trigger, params.newSegmentIndex);
    params.binding.sinks.queueCheckpoint?.(checkpointState, checkpointTokens);
    // 放在最后:checkpoint 上下文估值仍需按压缩前的注入状态计算,通知只影响
    // 下一轮 planTurn 的走向。
    params.binding.sinks.onCompacted?.();
    return { checkpointState, checkpointTokens };
  }

  beginRequest(context: Context, state: ConversationViewState) {
    this.ledger.rebase(context);
    this.updateTurnMeta(state);
    return this.ledger.total();
  }

  observeContextMessages(messages: readonly Context["messages"][number][]) {
    this.ledger.addMessages(messages);
    return this.ledger.total();
  }

  get contextUsageTokens() {
    const totalTokens = this.ledger.total();
    return totalTokens > 0 ? totalTokens : undefined;
  }

  get contextUsageSnapshot(): ManualContextUsageSnapshot | undefined {
    const snapshot = this.ledger.snapshot();
    return snapshot.totalTokens > 0
      ? { totalTokens: snapshot.totalTokens, fixedTokens: snapshot.fixedTokens }
      : undefined;
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
    this.publishRunning("pre-send", workingState.meta.activeSegmentIndex, decision);

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

      // apply 在 finalizeCheckpoint 内同步执行，appliedState 在其返回前必已赋值。
      let appliedState!: ConversationViewState;
      await this.finalizeCheckpoint({
        binding,
        trigger: "pre-send",
        state: outcome.state,
        newSegmentIndex: outcome.newSegmentIndex,
        tools: params.tools,
        buildOptions,
        apply: (checkpointState) => {
          appliedState = presend.composeAppliedState(checkpointState);
          binding.sinks.applyState?.(appliedState);
        },
      });
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
    // manual 触发透传给决策：跳过阈值/冷却，硬守卫不受影响。
    bypassThresholdAndCooldown?: boolean;
    manualContextUsage?: ManualContextUsageSnapshot;
  }): Promise<CompactionDuringRunResult> {
    const binding = this.binding;
    if (!binding) {
      return { context: null, shouldDisableProtection: false, outcome: "skipped" };
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
    // manual（空闲触发）不做前置 prune：prune 是运行中泄压手段，空闲路径没有
    // 后续 persist 兜底，落地未持久化的剪枝状态会造成内存/磁盘分叉；同时保证
    // 执行路径与探针（同样不 prune）对同一状态做决策，消除两者分歧。
    if (params.trigger !== "manual" && shouldPruneBeforeCompaction(this.pressure, now)) {
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
    const manualFixedTokens = params.manualContextUsage?.fixedTokens;
    // rebase 内部校验 fixedTokens（非法/undefined 回退估算），无需在调用点分叉。
    this.ledger.rebase(budgetContext, { fixedTokens: manualFixedTokens });
    this.updateTurnMeta(workingState);
    // manual 是空闲时的从容压缩，走 optimization 口径；运行中触发保持 protection。
    const intent: CompactionIntent = params.trigger === "manual" ? "optimization" : "protection";
    const totalTokens =
      positiveTokenCount(params.manualContextUsage?.totalTokens) ?? this.ledger.total();
    const decision =
      params.trigger === "manual"
        ? this.decideManual(totalTokens, now)
        : this.decide(intent, totalTokens, now, params.bypassThresholdAndCooldown);
    this.logDecision(decision);

    if (!decision.shouldCompact) {
      if (pruned) {
        binding.sinks.applyStateMidRun?.(pruned.state);
        return {
          context: buildFallbackContext(pruned.state),
          shouldDisableProtection: false,
          outcome: "skipped",
          reason: decision.reason,
        };
      }
      return params.trigger === "mid-stream"
        ? {
            context: buildFallbackContext(workingState),
            shouldDisableProtection: true,
            outcome: "skipped",
            reason: decision.reason,
          }
        : {
            context: null,
            shouldDisableProtection: false,
            outcome: "skipped",
            reason: decision.reason,
          };
    }

    this.rollbackSnapshot = { state: params.state, persistOnRollback: true };
    this.inFlight = true;
    this.publishRunning(params.trigger, workingState.meta.activeSegmentIndex, decision);

    const scope = binding.cancellation.deriveScope();
    try {
      const outcome = await runCompaction({
        state: workingState,
        intent,
        contextTokens: decision.totalTokens,
        threshold: decision.threshold,
        providerId: binding.providerId,
        model: binding.model,
        runtime: binding.runtime,
        signal: scope.controller.signal,
        debugLogger: binding.debugLogger,
        complete: binding.complete,
      });

      const { checkpointState } = await this.finalizeCheckpoint({
        binding,
        trigger: params.trigger,
        state: outcome.state,
        newSegmentIndex: outcome.newSegmentIndex,
        tools: params.tools,
        buildOptions,
        fixedTokens: manualFixedTokens,
        apply: (state) => binding.sinks.applyStateMidRun?.(state),
      });

      const resumeMessage = createSyntheticContinueUserMessage(
        (outcome.checkpointMessage.timestamp ?? now) + 1,
      );
      const resumeContext = binding.buildResumeContext(
        checkpointState,
        resumeMessage,
        params.tools,
        {
          includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
        },
      );
      this.notePostCompactionPressure(
        resumeContext,
        checkpointState,
        decision.threshold,
        manualFixedTokens,
      );
      return { context: resumeContext, shouldDisableProtection: false, outcome: "compacted" };
    } catch (error) {
      if (this.isAbortOutcome(scope.controller.signal, error)) {
        throw error;
      }
      this.rollbackSnapshot = null;
      // manual 面向空闲会话：没有后续轮次消费 fallback context，prune 结果也
      // 不会被持久化（一旦 apply 即内存与磁盘分叉），失败时必须原样保留会话。
      if (params.trigger !== "manual") {
        const fallback =
          pruned ?? pruneConversationState(workingState, resolvePruneOptions(this.pressure));
        if (fallback.applied) {
          binding.sinks.applyStateMidRun?.(fallback.state);
          this.settleFailed(params.trigger, PRUNE_FALLBACK_NOTICE);
          binding.sinks.setBridgeToolStatus?.(
            buildPruneFallbackStatus(fallback.prunedMessageCount),
          );
          return {
            context: buildFallbackContext(fallback.state),
            shouldDisableProtection: false,
            outcome: "failed",
          };
        }
      }
      this.settleFailed(
        params.trigger,
        (error instanceof Error ? error.message : String(error)) || "压缩失败",
      );
      return params.trigger === "mid-stream"
        ? {
            context: buildFallbackContext(workingState),
            shouldDisableProtection: true,
            outcome: "failed",
          }
        : { context: null, shouldDisableProtection: false, outcome: "failed" };
    } finally {
      scope.release();
      this.inFlight = false;
      this.binding?.sinks.setBridgeToolStatus?.(null);
    }
  }

  /**
   * 用户手动触发的压缩（用量环 → 确认）。仅限空闲：已有轮次绑定或压缩在飞
   * 返回 "busy"。临时绑定一轮复用 compactDuringRun 主流程；决策跳过自动阈值
   * 与冷却，但仍强制执行共享的 50% 手动门槛以及 disabled / no-active-messages
   * 等硬守卫（守卫不过返回 "skipped"）。
   */
  async compactManually(
    binding: Omit<CompactionTurnBinding, "presend">,
    state: ConversationViewState,
    contextUsage?: ManualContextUsageSnapshot,
    options?: {
      // 与真实请求同参的工具集：checkpoint 估值缺了工具重量会系统性偏低。
      tools?: Context["tools"];
      // 探针通过、真正开始压缩前同步调用恰好一次（skip / busy 不触发）。
      onProceed?: () => void;
    },
  ): Promise<ManualCompactionOutcome> {
    if (this.binding || this.inFlight) return { status: "busy" };
    this.bindTurn(binding);
    try {
      const probe = this.probeManualDecision(binding, state, contextUsage, options?.tools);
      if (!probe.shouldCompact) {
        // in-flight 已被入口 busy 检查排除（bindTurn 刚复位 inFlight），探针
        // 拒绝只剩 disabled / no-active-messages / below-manual-threshold 等硬守卫。
        return { status: "skipped", reason: probe.reason };
      }
      options?.onProceed?.();
      const result = await this.compactDuringRun({
        trigger: "manual",
        state,
        tools: options?.tools,
        manualContextUsage: contextUsage,
      });
      // 只信本次调用的显式 outcome：statusPhase 可能残留上一次压缩的终态，
      // 而内层二次裁决 skip 时不 publish 任何状态。
      switch (result.outcome) {
        case "compacted":
          return { status: "compacted" };
        case "skipped":
          // binding 恒存在，内层 skip 必带决策 reason；回退仅为类型完备。
          return { status: "skipped", reason: result.reason ?? "disabled" };
        default:
          return { status: "failed" };
      }
    } catch {
      // 中止或意外异常：走统一善后（回滚快照 / running 态复位 idle）。
      await this.handleTurnAbort();
      return binding.cancellation.userStop.signal.aborted
        ? { status: "failed", aborted: true }
        : { status: "failed" };
    } finally {
      this.unbindTurn();
    }
  }

  // 手动压缩的前置探针：跑一次与执行路径同口径的决策，把手动 50% 门槛及
  // disabled 等硬守卫挡在 publishRunning 之前。读数用局部临时账本计算——
  // 共享账本是用量环的读数真源，被拒的探测不得在其上留下任何残留。
  private probeManualDecision(
    binding: Omit<CompactionTurnBinding, "presend">,
    state: ConversationViewState,
    contextUsage?: ManualContextUsageSnapshot,
    tools?: Context["tools"],
  ) {
    const probeLedger = new TokenLedger();
    probeLedger.rebase(binding.buildPreparedContext(state, tools), {
      fixedTokens: contextUsage?.fixedTokens,
    });
    // turnMeta 是按 state 的幂等派生（decide 的硬守卫需要），更新无残留风险。
    this.updateTurnMeta(state);
    return this.decideManual(
      positiveTokenCount(contextUsage?.totalTokens) ?? probeLedger.total(),
      Date.now(),
    );
  }

  private decideManual(totalTokens: number, now: number): CompactionDecision {
    const decision = this.decide("optimization", totalTokens, now, true);
    if (!decision.shouldCompact) return decision;
    if (canManualCompact(contextUsageRatio(decision.totalTokens, decision.contextWindow))) {
      return decision;
    }
    return { ...decision, shouldCompact: false, reason: "below-manual-threshold" };
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

  private decide(
    intent: CompactionIntent,
    totalTokens: number,
    now = Date.now(),
    bypassThresholdAndCooldown?: boolean,
  ) {
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
      bypassThresholdAndCooldown,
    });
  }

  private notePostCompactionPressure(
    contextAfter: Context,
    stateAfter: ConversationViewState,
    threshold: number,
    fixedTokens?: number,
  ) {
    this.ledger.rebase(contextAfter, { fixedTokens });
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
