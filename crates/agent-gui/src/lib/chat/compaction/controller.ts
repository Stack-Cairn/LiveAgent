import type { Context, Message } from "@earendil-works/pi-ai";
import { estimateTextTokens, positiveTokenCount } from "@liveagent/ui/lib/chat/contextUsage";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { RequestRecipe } from "../../providers/runtime/modelRequest";
import type { TextStreamFailoverParams } from "../../providers/runtime/textOnlyRuntime";
import type { ProviderId } from "../../settings";
import {
  appendMessagesToConversation,
  applyCompactionCheckpoint,
  type ConversationViewState,
  getActiveSegment,
  replaceActiveSegmentMessages,
} from "../conversation/conversationState";
import type { TurnCancellation } from "../conversation/turnCancellation";
import { estimateCheckpointBridgeTokens } from "./bridge";
import {
  buildCheckpointMessage,
  type RetainedUserTextResolver,
  selectRetainedUserMessages,
  withContextTokensAfter,
} from "./checkpoint";
import {
  type CompactionVerdict,
  DEADLINE_AUTO_MS,
  DEADLINE_MANUAL_MS,
  decideCompaction,
  retainedBudgetTokens,
} from "./policy";
import { createCompactionAbortError, summarize } from "./summarize";
import { deriveContextTokens, TokenLedger } from "./tokenLedger";
import type {
  CompactionDecisionReason,
  CompactionStatus,
  CompactionTrigger,
  ProviderRuntimeConfig,
} from "./types";

// 防抖动（取代已删除的冷却）：两次自动压缩之间判为低于阈值的调用少于它，这次压缩
// 记一次抖动；连续抖动达到上限即只拦 [soft, hard)，≥ hard 照样压缩。
const THRASH_MIN_CALLS_BETWEEN = 2;
const THRASH_STREAK_LIMIT = 3;
// 进度文本与语言无关；首档开始前先点亮 isCompaction。
const INITIAL_PROGRESS_TEXT = "0:00";

// 所有副作用经由注入的 sinks：ChatPage 提供完整实现，子代理提供轻量子集。
// 全部可选——缺省即 no-op，controller 自身保持纯净可测。
export type CompactionSinks = {
  applyState?: (state: ConversationViewState) => void;
  // 运行中换底：apply + 清空 live transcript（压缩结果落地后旧流式内容已过期）。
  applyStateMidRun?: (state: ConversationViewState) => void;
  publishStatus?: (status: CompactionStatus) => void;
  // wire=false 只刷新本地显示，不进 gateway 事件环。
  setBridgeToolStatus?: (status: string | null, isCompaction?: boolean, wire?: boolean) => void;
  queueCheckpoint?: (state: ConversationViewState, contextUsageTokens: number) => void;
  // 提交点。false/null 表示持久化失败（什么都不落地）。成功可返回"盖好 revision 的持
  // 久化状态"——controller 落地这一份而非入参：组合状态出自 appendMessagesToConversation，
  // revision 恒为 null，照原样 apply 运行时缓存会失去 replace/分页所需的 CAS 令牌
  // （压缩后 edit-resend 报"历史会话缺少 revision"即源于此）。返回 true/undefined 则
  // 沿用入参状态（子代理的 fire-and-forget persist 走这条）。
  persist?: (
    state: ConversationViewState,
  ) => Promise<ConversationViewState | boolean | null | undefined>;
  // pre-send 回滚撤销待发送消息时，原样还原本次发送清空的输入框草稿与附件。返回 false
  // 表示没能全部放回（期间输入框又有了新内容）：此时撤销会让那条消息无处可寻。
  restoreComposer?: () => boolean;
  persistRollback?: (state: ConversationViewState) => Promise<unknown>;
  // 压缩成功落地后的通知。用于失效那些按消息 id 挂在 user 消息上的注入状态:载体消息
  // 被压缩移出 active segment 后,继续增量会静默丢变化,必须整体重冻结。
  onCompacted?: () => void;
};

// 轮次绑定：运行时 / sinks / 取消链。刻意不含任何状态快照——base 一律在 compact
// 调用时由 CompactRequest.state 现推。
export type CompactionBinding = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  sessionId?: string;
  /** transcript 档可用的 failover 列表；fork 锁定在缓存热的目标上，不 failover。 */
  failover?: TextStreamFailoverParams;
  cancellation: TurnCancellation;
  debugLogger?: StreamDebugLogger;
  sinks: CompactionSinks;
  // 保留原话的改写：子代理据此排除 bus 刷新、把委派 / 续跑消息收窄到任务原文。
  resolveRetainedUserText?: RetainedUserTextResolver;
};

/** 只有 pre-send 调用点会传：待发送的用户消息已在 state 末尾，压缩后原样落在新 segment。 */
export type CompactionPresend = {
  pendingUserMessage: Message;
  /**
   * 本次发送清空了本地输入框：Stop 时撤销已入库的待发送消息并还原输入框。否则
   *（队列 / WebUI / 计划续跑 / edit-resend）文本不在输入框里，撤销即永久丢失——
   * 不建快照，消息随普通的中止提交保留。
   */
  restoreOnRollback?: boolean;
};

export type CompactRequest = {
  trigger: CompactionTrigger;
  /** 调用时的当前状态（getNextConversationState()）：base 与预算都由它现推。 */
  state: ConversationViewState;
  /** 与主请求同一个构建器：预算、contextTokensAfter 与 fork 后缀都按真实请求口径。 */
  buildContext: (state: ConversationViewState) => Context;
  /** post-tool：runner 下一轮原样要发的消息，fork 原样重放。 */
  forkMessages?: readonly Message[];
  presend?: CompactionPresend;
  /** manual：用量环读数快照。 */
  usage?: ManualContextUsageSnapshot;
  /** 决策通过、真正开始压缩前同步调用恰好一次（skip / busy 不触发）。 */
  onProceed?: () => void;
};

export type CompactResult =
  | { outcome: "compacted"; state: ConversationViewState; degraded?: string }
  | { outcome: "skipped"; reason: CompactionDecisionReason }
  | { outcome: "failed"; message: string };

export type ManualContextUsageSnapshot = {
  totalTokens?: number;
  fixedTokens?: number;
};

/**
 * 压缩生命周期的旁观者，供轨迹埋点订阅。
 *
 * 挂在控制器上而不是各调用点：压缩有 pre-send / overflow / post-tool / manual 四个
 * 触发路径，逐个调用点埋会漏，也会随新增触发方式失配。控制器内部只有
 * `publishRunning` 一个开始点和 `settle` 一个终点，每个 operation 恰好一个终态
 *（degraded 算 complete）。
 *
 * 刻意不引用轨迹类型：控制器不该知道消费者是谁。
 */
export type CompactionObserver = {
  onStart: (info: { trigger: CompactionTrigger; tokensBefore?: number }) => void;
  onEnd: (info: CompactionEnd & { trigger: CompactionTrigger; tokensBefore?: number }) => void;
};

type CompactionEnd = {
  status: "complete" | "error" | "aborted";
  tokensAfter?: number;
  newSegmentIndex?: number;
  error?: string;
};

type RollbackSnapshot = {
  state: ConversationViewState;
  restoreComposer?: boolean;
};

// 消息身份：配方里的消息与现建上下文里的同一条消息往往不是同一个对象（sanitize、
// memory 增量块都会复制），按角色 + 时间戳 + 可用的 id 比对。
function messageKey(message: Message): string {
  const { id, toolCallId, responseId } = message as Message & Record<string, unknown>;
  const ref = [id, toolCallId, responseId].find((value) => typeof value === "string");
  return `${message.role}:${message.timestamp}:${ref ?? ""}`;
}

function withoutMessage(state: ConversationViewState, target: Message): ConversationViewState {
  const messages = getActiveSegment(state)?.messages ?? [];
  const key = messageKey(target);
  const kept = messages.filter((message) => message !== target && messageKey(message) !== key);
  return kept.length === messages.length ? state : replaceActiveSegmentMessages(state, kept);
}

/**
 * 每会话压缩状态机。跨轮持有 token 账本、熔断与防抖动计数；每轮 bindTurn 注入
 * 运行时/sinks/取消链。唯一入口 compact()：单飞由 inFlight 保证，回滚快照是实例
 * 字段，persist 成功即提交点，所有终态都经 settle() 收敛。
 */
export class CompactionController {
  private readonly ledger = new TokenLedger();
  /**
   * provider 边界才拼进 systemPrompt 的追加段估算（agent 模式的工具执行规则
   * toolsSuffix 实测 ~4k）。turn runner 每轮在压缩决策前注入；跨 bind 保留，
   * 空闲手动压缩的检查点估值同样受益。所有 rebase/估值统一透传，保证检查点
   * 权威值与发送时账本读数同口径——两者不一致正是压缩后环倒退/猛增的根源。
   */
  private fixedOverheadTokens = 0;
  private binding: CompactionBinding | null = null;
  private rollbackSnapshot: RollbackSnapshot | null = null;
  private inFlight = false;
  private statusPhase: CompactionStatus["phase"] = "idle";
  private observer: CompactionObserver | null = null;
  /**
   * 已发出 onStart、尚未闭合的压缩。id 区分同 trigger 的前后两次异步压缩，拒绝旧
   * 摘要的晚到结果；tokensBefore 供结束事件补齐前后对比。
   */
  private observed: { id: number; trigger: CompactionTrigger; tokensBefore: number } | null = null;
  private nextObservedOperationId = 0;
  /**
   * 本会话最近一次主请求（含 failover 候选）实际发出的内容 / 缓存配方。跨轮
   * 保留、随控制器（即会话）一同释放；标题 / 记忆 / cron 等辅助请求不记录。
   */
  private lastRecipe: RequestRecipe | null = null;
  private compactionsApplied = 0;
  // 熔断：连续失败的自动压缩数，成功或手动压缩清零。
  private failureStreak = 0;
  // 初值 ∞：每轮的第一次压缩不算抖动。
  private callsSinceCompaction = Number.POSITIVE_INFINITY;
  private thrashStreak = 0;

  /** 订阅压缩生命周期；传 null 取消订阅。 */
  setObserver(observer: CompactionObserver | null) {
    this.observer = observer;
  }

  /** 主循环每个实际尝试的候选各记一次：保留的是最后一次尝试的目标（全部失败时亦然）。 */
  noteRequest(recipe: RequestRecipe) {
    this.lastRecipe = recipe;
  }

  /** 注入 provider 边界追加段的估算；非法值按 0 清除（模式切换后不残留）。 */
  noteFixedOverheadTokens(tokens: number) {
    this.fixedOverheadTokens =
      typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  }

  /**
   * 当前注入的边界追加段估算（0 = 本会话尚无轮次注入过）。空闲手动压缩据此
   * 判断是否需要按持久化工具集补一份回退估算：turn runner 的现值出自真实
   * 请求参数，质量更高，绝不覆盖。
   */
  get contextFixedOverheadTokens(): number {
    return this.fixedOverheadTokens;
  }

  /**
   * 活跃 segment 检查点的权威上下文快照（stats.contextTokensAfter）。检查点
   * 上下文只有一条 checkpoint bridge，该值本质是「新前缀的 fixed + bridge」
   *（fixed = system+tools+边界追加段，可能含校准）——压缩后的无锚点窗口里，
   * 两端空闲环显示的正是它。后续 rebase 以它扣掉 bridge 为 fixed 下界：现算
   * 估算的任何输入漂移（激活工具子集收窄、memory 段重冻结、重启后控制器丢失
   * overhead、模式切换）都不得让发送后的运行中读数低于空闲读数，否则环先
   * 倒退、首个真实 usage 到达再跳涨。从 state 现读而非控制器字段，跨重启
   * 依然生效；真实 usage 锚点存在时 fixed 不参与读数，下界自动退场。
   */
  private checkpointFixedFloor(state: ConversationViewState): number | undefined {
    const summary = getActiveSegment(state)?.summary;
    const after = positiveTokenCount(summary?.summaryMeta?.stats?.contextTokensAfter);
    // contextTokensAfter = fixed + bridge（bridge 以单独一条消息计入）；账本把
    // bridge 当消息另算，下界必须扣回，否则双算。旧 checkpoint 的值不含 bridge
    // （摘要在 system 里），扣完约等于旧口径的 fixed，同样成立。
    return summary && after !== undefined
      ? positiveTokenCount(after - estimateCheckpointBridgeTokens(summary))
      : undefined;
  }

  // 统一的账本重建入口：检查点下界与调用方校准值取较大者，边界追加段一律透传。
  private rebaseLedger(
    ledger: TokenLedger,
    context: Context,
    state: ConversationViewState,
    fixedTokens?: number,
  ) {
    const floor = this.checkpointFixedFloor(state);
    ledger.rebase(context, {
      fixedTokens:
        fixedTokens === undefined || floor === undefined
          ? (fixedTokens ?? floor)
          : Math.max(fixedTokens, floor),
      fixedOverheadTokens: this.fixedOverheadTokens,
    });
  }

  bindTurn(binding: CompactionBinding) {
    // A defensive rebind must not strand the previous observer interval.
    this.unbindTurn();
    this.binding = binding;
    // 防抖动只管一轮之内的"压完立即又满"。
    this.callsSinceCompaction = Number.POSITIVE_INFINITY;
    this.thrashStreak = 0;
  }

  unbindTurn() {
    // Every published start receives exactly one terminal notification, even when a caller
    // tears down the turn without first reaching the ordinary completion path.
    this.settleAbortedIfRunning();
    this.binding = null;
    this.rollbackSnapshot = null;
    this.inFlight = false;
  }

  get stats() {
    return { compactionsApplied: this.compactionsApplied };
  }

  beginRequest(context: Context, state: ConversationViewState) {
    this.rebaseLedger(this.ledger, context, state);
    return this.ledger.total();
  }

  observeContextMessages(
    messages: readonly Context["messages"][number][],
    options?: { suppressUsageAnchors?: boolean },
  ) {
    this.ledger.addMessages(messages, options);
    return this.ledger.total();
  }

  get contextUsageTokens() {
    const totalTokens = this.ledger.total();
    return totalTokens > 0 ? totalTokens : undefined;
  }

  /** 账本当前的 system+tools 固定开销估算；供空闲倒扫在无锚点时补齐同口径。 */
  get contextFixedTokens(): number | undefined {
    const { fixedTokens } = this.ledger.snapshot();
    return fixedTokens > 0 ? fixedTokens : undefined;
  }

  get contextUsageSnapshot(): ManualContextUsageSnapshot | undefined {
    const snapshot = this.ledger.snapshot();
    return snapshot.totalTokens > 0
      ? { totalTokens: snapshot.totalTokens, fixedTokens: snapshot.fixedTokens }
      : undefined;
  }

  /**
   * 唯一入口：决策 → 降级梯 → checkpoint → 组合 → persist（提交点）→ apply → settle。
   * 只在用户停止 / 操作过期时抛（回滚快照留给 handleTurnAbort）；其余失败一律
   * settle 为 error 并返回 failed。persist 成功之后绝不回滚、绝不抛错。
   */
  async compact(req: CompactRequest): Promise<CompactResult> {
    const binding = this.binding;
    if (!binding) return { outcome: "skipped", reason: "disabled" };
    if (binding.cancellation.userStop.signal.aborted) throw createCompactionAbortError();
    const presend = req.trigger === "pre-send" ? req.presend : undefined;
    // base 在调用时现推：edit-resend 在绑定之后才替换状态，绑定时的快照会把删掉的后缀
    // 写回库。pre-send 的 base 不含待发送消息：它不进摘要与保留池，原样落在新 segment。
    const base = presend ? withoutMessage(req.state, presend.pendingUserMessage) : req.state;
    const manual = req.trigger === "manual";
    // manual 用临时账本：共享账本是用量环的读数真源，被拒的探针不得在其上留痕。
    const ledger = manual ? new TokenLedger() : this.ledger;
    this.rebaseLedger(ledger, req.buildContext(req.state), req.state, req.usage?.fixedTokens);
    const fixedTokens = ledger.snapshot().fixedTokens;
    const thrashing = this.thrashStreak >= THRASH_STREAK_LIMIT;
    const segment = getActiveSegment(base);
    const verdict = decideCompaction({
      trigger: req.trigger,
      totalTokens: positiveTokenCount(req.usage?.totalTokens) ?? ledger.total(),
      fixedTokens,
      modelConfig: binding.runtime.modelConfig,
      activeMessageCount: segment?.messages.length ?? 0,
      inFlight: this.inFlight,
      failureStreak: this.failureStreak,
      thrashing,
    });
    this.logDecision(req.trigger, verdict, ledger);
    if (!verdict.shouldCompact) {
      if (verdict.reason === "below-threshold") this.callsSinceCompaction += 1;
      return { outcome: "skipped", reason: verdict.reason };
    }

    // 同步置位：onProceed / publishRunning 之前，任何并发触发都必须看到 in-flight。
    this.inFlight = true;
    const scope = binding.cancellation.deriveScope();
    let operationId: number | undefined;
    let progressClosed = false;
    try {
      req.onProceed?.();
      operationId = this.publishRunning(
        req.trigger,
        base.meta.activeSegmentIndex,
        verdict.totalTokens,
      );
      // pre-send 回到不含待发送消息的 base 并还原输入框：首次持久化已把那条消息写进库，
      // 回滚必须一并撤销，否则留下无回复的孤儿消息、重发时重复。两者都补持久化。
      this.rollbackSnapshot = !presend
        ? { state: req.state }
        : presend.restoreOnRollback
          ? { state: base, restoreComposer: true }
          : null;
      const result = await summarize({
        providerId: binding.providerId,
        model: binding.model,
        runtime: binding.runtime,
        sessionId: binding.sessionId,
        failover: binding.failover,
        debugLogger: binding.debugLogger,
        recipe: this.lastRecipe,
        messages: req.forkMessages ?? this.replayMessages(req.buildContext(base).messages),
        previousSummary: segment?.summary?.content,
        segmentMessages: segment?.messages ?? [],
        startAt: verdict.startAt,
        automatic: !manual,
        mustProgress: verdict.mustProgress,
        tokensBefore: verdict.totalTokens,
        limits: verdict.limits,
        deadlineAt: Date.now() + (manual ? DEADLINE_MANUAL_MS : DEADLINE_AUTO_MS),
        signal: scope.controller.signal,
        // 进度绑定本次操作：closed 在 finally 里先于清空状态同步置位，迟到的回调不会
        // 在压缩结束后重新点亮 isCompaction。
        onProgress: (text, wire) => {
          if (!progressClosed && this.observed?.id === operationId) {
            binding.sinks.setBridgeToolStatus?.(text, true, wire);
          }
        },
      });
      // 失败一律经 catch 收敛：过期操作的失败按中止处理，不得动新操作的快照与熔断计数。
      if ("failure" in result) throw new Error(result.failure.message);

      const draft = result.ok;
      const checkpointState = applyCompactionCheckpoint(
        base,
        buildCheckpointMessage({
          summaryText: draft.summaryText,
          providerId: draft.providerId,
          model: draft.model,
          promptVersion: draft.promptVersion,
          timestamp: Date.now(),
          conversationTokens: verdict.totalTokens,
          summarizerUsage: draft.usage,
          retainedUserMessages: selectRetainedUserMessages({
            previous: segment?.summary?.retainedUserMessages,
            messages: segment?.messages ?? [],
            budgetTokens: retainedBudgetTokens(
              verdict.limits.soft,
              fixedTokens,
              estimateTextTokens(draft.summaryText),
              thrashing,
            ),
            resolveText: binding.resolveRetainedUserText,
          }),
        }),
      );
      if (checkpointState === base) {
        throw new Error("compaction checkpoint was not applied to the conversation state");
      }
      // contextTokensAfter = fixed + bridge（用量环锚点），在组合待发送消息之前计算。
      const tokensAfter = deriveContextTokens(req.buildContext(checkpointState), {
        fixedTokens: req.usage?.fixedTokens,
        fixedOverheadTokens: this.fixedOverheadTokens,
      });
      const checkpointed = withContextTokensAfter(checkpointState, tokensAfter);
      // pre-send 一次 IPC 原子地封存 N（不含待发送消息）并插入 N+1（含待发送消息）。
      const composed = presend
        ? appendMessagesToConversation(checkpointed, [presend.pendingUserMessage])
        : checkpointed;
      // 提交点之前最后一道关：Stop / 过期只能在这里走回滚。
      if (this.isAbortOutcome(scope.controller.signal, operationId)) {
        throw createCompactionAbortError();
      }
      const persisted = await binding.sinks.persist?.(composed);
      if (persisted === false || persisted === null) {
        throw new Error("compaction checkpoint persistence failed");
      }
      // 提交点：库里已是新 segment。立即作废回滚快照，此后 Stop 与过期一律忽略——回滚
      // 会把内存退回旧 segment，之后每次持久化都会报分段回退。
      this.rollbackSnapshot = null;
      const committed = typeof persisted === "object" ? persisted : composed;
      this.commit(binding, req, committed, operationId, tokensAfter, result.degraded);
      return {
        outcome: "compacted",
        state: committed,
        ...(result.degraded ? { degraded: result.degraded } : {}),
      };
    } catch (error) {
      if (this.isAbortOutcome(scope.controller.signal, operationId)) throw error;
      return this.fail(
        req.trigger,
        error instanceof Error ? error.message : String(error),
        operationId,
      );
    } finally {
      progressClosed = true;
      scope.release();
      // 被 unbind / 重绑作废的操作不得动新绑定的单飞位与状态。
      if (this.binding === binding) {
        this.inFlight = false;
        binding.sinks.setBridgeToolStatus?.(null);
      }
    }
  }

  // 提交点之后的落地：apply → completed 终态 → checkpoint 入队 → 注入状态失效 → 账本
  // rebase → 计数。绝不抛错：库里已是新 segment，抛出去只会让调用方把一次成功的压缩
  // 当成失败；每步各自兜底，一个 sink 抛错不得跳过其余步骤（尤其 completed 终态）。
  private commit(
    binding: CompactionBinding,
    req: CompactRequest,
    committed: ConversationViewState,
    operationId: number,
    tokensAfter: number,
    degraded: string | undefined,
  ) {
    const { sinks } = binding;
    const step = (run: () => void) => {
      try {
        run();
      } catch (error) {
        console.warn("[compaction] post-commit step threw; the checkpoint is persisted", error);
      }
    };
    const newSegmentIndex =
      getActiveSegment(committed)?.segmentIndex ?? committed.meta.activeSegmentIndex;
    step(() =>
      (req.trigger === "pre-send" ? sinks.applyState : sinks.applyStateMidRun)?.(committed),
    );
    step(() =>
      this.settle(
        operationId,
        { status: "complete", tokensAfter, newSegmentIndex },
        {
          phase: "completed",
          trigger: req.trigger,
          newSegmentIndex,
          completedAt: Date.now(),
          ...(degraded ? { degraded } : {}),
        },
      ),
    );
    step(() => sinks.queueCheckpoint?.(committed, tokensAfter));
    // 放在落地之后:checkpoint 上下文估值仍需按压缩前的注入状态计算,通知只影响
    // 下一轮 planTurn 的走向。
    step(() => sinks.onCompacted?.());
    // committed 已带 contextTokensAfter：账本从检查点权威值起步。
    step(() =>
      this.rebaseLedger(
        this.ledger,
        req.buildContext(committed),
        committed,
        req.usage?.fixedTokens,
      ),
    );
    this.compactionsApplied += 1;
    this.failureStreak = 0;
    this.thrashStreak =
      req.trigger !== "manual" && this.callsSinceCompaction < THRASH_MIN_CALLS_BETWEEN
        ? this.thrashStreak + 1
        : 0;
    this.callsSinceCompaction = 0;
  }

  private fail(
    trigger: CompactionTrigger,
    message: string,
    operationId: number | undefined,
  ): CompactResult {
    // 什么都没落地：快照留着只会让之后的 Stop 把一轮正常续跑的会话错误回滚。
    this.rollbackSnapshot = null;
    this.failureStreak = trigger === "manual" ? 0 : this.failureStreak + 1;
    console.warn("[compaction] failed; continuing with the uncompacted context", message);
    // 状态里的空 message 留给提示按界面语言兜底。
    this.settle(
      operationId,
      { status: "error", error: message || "compaction failed" },
      { phase: "failed", trigger, failedAt: Date.now(), message },
    );
    return { outcome: "failed", message };
  }

  // fork 回放的消息：上一次主请求原样发出的 messages 接上其后新增的后缀（上一轮最终
  // 回复等），缓存前缀因此逐字节一致；对不上（edit-resend 删掉了那段、重启后无配方）
  // 时回退为整份现建上下文。
  private replayMessages(current: readonly Message[]): readonly Message[] {
    const recorded = this.lastRecipe?.messages;
    const last = recorded?.at(-1);
    if (!recorded || !last) return current;
    const key = messageKey(last);
    for (let index = current.length - 1; index >= 0; index -= 1) {
      if (messageKey(current[index]) === key) return [...recorded, ...current.slice(index + 1)];
    }
    return current;
  }

  /**
   * 用户手动触发的压缩（用量环 → 确认 / WebUI compact_now）。仅限空闲：已有轮次绑定
   * 或压缩在飞返回 "busy"。临时绑定一轮走 compact 主流程：50% 手动门槛与 disabled /
   * no-active-messages 等硬守卫同口径，manual 永不走 deterministic。
   */
  async compactManually(
    binding: CompactionBinding,
    request: Omit<CompactRequest, "trigger" | "forkMessages" | "presend">,
  ): Promise<CompactResult | { outcome: "busy" | "aborted" }> {
    if (this.binding || this.inFlight) return { outcome: "busy" };
    this.bindTurn(binding);
    try {
      return await this.compact({ ...request, trigger: "manual" });
    } catch {
      // 中止或意外异常：走统一善后（回滚快照 / running 态复位 idle）。
      await this.handleTurnAbort();
      return binding.cancellation.userStop.signal.aborted
        ? { outcome: "aborted" }
        : { outcome: "failed", message: "" };
    } finally {
      this.unbindTurn();
    }
  }

  // 用户中止后的统一善后：有快照则回滚（恢复状态 / 输入框并补持久化）并返回 true。
  async handleTurnAbort(): Promise<boolean> {
    const binding = this.binding;
    const snapshot = this.rollbackSnapshot;
    this.rollbackSnapshot = null;
    this.inFlight = false;
    this.settleAbortedIfRunning();
    if (!binding || !snapshot) return false;
    // 草稿放不回输入框：不撤销待发送消息，交给调用方按普通中止提交保留它。
    if (snapshot.restoreComposer && binding.sinks.restoreComposer?.() === false) return false;

    binding.sinks.applyStateMidRun?.(snapshot.state);
    binding.sinks.setBridgeToolStatus?.(null, false);
    await binding.sinks.persistRollback?.(snapshot.state);
    return true;
  }

  // 用户停止（scope 链着 userStop）或操作已被 unbind / 重绑作废。不认 isAbortLikeError：
  // 总时限、stall 都是失败，不能被误判成用户停止。
  private isAbortOutcome(scopeSignal: AbortSignal, operationId: number | undefined) {
    return (
      Boolean(this.binding?.cancellation.userStop.signal.aborted) ||
      scopeSignal.aborted ||
      this.observed?.id !== operationId
    );
  }

  private publishStatus(status: CompactionStatus) {
    this.statusPhase = status.phase;
    this.binding?.sinks.publishStatus?.(status);
  }

  private publishRunning(
    trigger: CompactionTrigger,
    sourceSegmentIndex: number,
    tokensBefore: number,
  ): number {
    const id = ++this.nextObservedOperationId;
    this.observed = { id, trigger, tokensBefore };
    this.notifyObserver(() => this.observer?.onStart({ trigger, tokensBefore }));
    this.publishStatus({
      phase: "running",
      trigger,
      startedAt: Date.now(),
      sourceSegmentIndex,
    });
    this.binding?.sinks.setBridgeToolStatus?.(INITIAL_PROGRESS_TEXT, true);
    return id;
  }

  // 唯一终点。之前的 abort / unbind 可能已在异步摘要回卷时收尾了这个区间：迟到的
  // settle 已过期，不得再发第二个终态。
  private settle(operationId: number | undefined, end: CompactionEnd, status: CompactionStatus) {
    const observed = this.observed;
    if (!observed || observed.id !== operationId) return;
    this.observed = null;
    const { trigger, tokensBefore } = observed;
    this.notifyObserver(() => this.observer?.onEnd({ trigger, tokensBefore, ...end }));
    this.publishStatus(status);
  }

  private settleAbortedIfRunning() {
    if (this.observed) {
      this.settle(this.observed.id, { status: "aborted" }, { phase: "idle" });
    } else if (this.statusPhase === "running") {
      this.publishStatus({ phase: "idle" });
    }
  }

  /** 旁观者是诊断通道，它抛错绝不能把压缩这条主路径带崩。 */
  private notifyObserver(run: () => void) {
    try {
      run();
    } catch (error) {
      console.warn("[compaction] observer threw; compaction is unaffected", error);
    }
  }

  private logDecision(trigger: CompactionTrigger, verdict: CompactionVerdict, ledger: TokenLedger) {
    this.binding?.debugLogger?.logResult({
      event: "compaction_decision",
      trigger,
      reason: verdict.reason,
      shouldCompact: verdict.shouldCompact,
      totalTokens: verdict.totalTokens,
      limits: verdict.limits,
      failureStreak: this.failureStreak,
      thrashStreak: this.thrashStreak,
      ledger: ledger.snapshot(),
    });
  }
}

export function createCompactionControllerRegistry() {
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
