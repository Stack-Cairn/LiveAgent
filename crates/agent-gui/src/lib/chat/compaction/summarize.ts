import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  StopReason,
  UserMessage,
} from "@earendil-works/pi-ai";
import { estimateTextTokens, estimateTextTokenUnits } from "@liveagent/ui/lib/chat/contextUsage";
import { buildStreamRequestDebugPayload, type StreamDebugLogger } from "../../debug/agentDebug";
import { createLinkedAbortSignal } from "../../providers/runtime/abortLink";
import { normalizeErrorMessage } from "../../providers/runtime/errors";
import {
  finalizeRequest,
  prepareTransport,
  type RequestRecipe,
  shapeRequestContext,
} from "../../providers/runtime/modelRequest";
import { isOverflowError, readAssistantFromError } from "../../providers/runtime/overflow";
import { primaryFailoverBreakerKey } from "../../providers/runtime/providerFailover";
import { resolveCappedStreamRetryConfig } from "../../providers/runtime/retryPolicy";
import { isStreamStallError } from "../../providers/runtime/streamRetry";
import {
  streamAssistantMessage,
  type TextStreamFailoverParams,
} from "../../providers/runtime/textOnlyRuntime";
import { llm } from "../../providers/service/llmService";
import type { ProviderId } from "../../settings";
import { withPowerActivity } from "../../system/powerActivity";
import { deterministicSummary } from "./checkpoint";
import {
  type CompactionLimits,
  type CompactionStage,
  firstEventBudgetMs,
  IDLE_TIMEOUT_MS,
  isFatalProviderError,
  TRANSCRIPT_MIN_REMAINING_MS,
} from "./policy";
import {
  buildCompactionInstruction,
  PROMPT_VERSION,
  parseSummaryOutput,
  TRANSCRIPT_SYSTEM,
} from "./prompt";
import { clipMiddle, serializeTranscript } from "./transcript";
import type { ProviderRuntimeConfig } from "./types";

// ============================================================================
// 摘要降级梯：fork（主请求配方原样重放 + 1 条指令，缓存热时近乎零预填）→
// transcript（标签纯文本 + 指令，可 failover）→ deterministic（无 LLM，只在自动
// 触发且 mustProgress 时）。全链路只有 withStreamRetry 一层重试；首事件 / 空闲
// 看门狗在传输层，总时限在这里。计时器只中止本档，绝不中止压缩 scope。
// ============================================================================

/** 每档的流内总尝试上限（与用户重试策略取小）。 */
const SUMMARY_MAX_STREAM_ATTEMPTS = 3;
const TRANSCRIPT_BUDGET_MAX_TOKENS = 64_000;
const TRANSCRIPT_MAX_OUTPUT_TOKENS = 32_000;
// 本地每 2s 刷新时钟与 token 数；线上只在阶段变化、重试、换档时发送，外加距上次
// 上线满 20s 的心跳：每条 tool_status 都进 gateway 事件环，2s 一刷会挤掉 WebUI 需要
// 的转录事件。心跳同时刷新 lastEventAt。
const PROGRESS_LOCAL_REFRESH_MS = 2_000;
const PROGRESS_HEARTBEAT_MS = 20_000;

export function createCompactionAbortError() {
  const error = new Error("compaction aborted");
  error.name = "AbortError";
  return error;
}

/** 档被主动结束的原因：总时限，或摘要没写完就要调工具。 */
type StageEnd = "tool-call" | "deadline";

type SummaryFailureKind = StageEnd | "stall" | "overflow" | "fatal" | "transient" | "invalid";

type SummaryFailure = { kind: SummaryFailureKind; message: string };

type SummaryDraft = {
  summaryText: string;
  promptVersion: string;
  /** 实际服务了这次摘要的目标（transcript 档可能已 failover）。 */
  providerId: ProviderId;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
};

/** degraded：LLM 档全部失败后由 deterministic 兜底，值为最后一次失败的说明。 */
type SummarizeResult = { ok: SummaryDraft; degraded?: string } | { failure: SummaryFailure };

type SummarizeInput = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  sessionId?: string;
  /** transcript 档可用的 failover 列表；fork 锁定在缓存热的目标上，不 failover。 */
  failover?: TextStreamFailoverParams;
  debugLogger?: StreamDebugLogger;
  /** 本会话最后一次主请求的配方；目标或协议与当前 binding 不符时 fork 不可用。 */
  recipe: RequestRecipe | null;
  /** 要摘要的对话：主请求下一轮原样要发的消息（含 checkpoint bridge），fork 原样重放。 */
  messages: readonly Message[];
  /** deterministic 档的原料：上一份摘要正文与被压缩 segment 的消息。 */
  previousSummary?: string;
  segmentMessages: readonly Message[];
  startAt: CompactionStage;
  /** 非 manual 触发。manual 永远不走 deterministic。 */
  automatic: boolean;
  mustProgress: boolean;
  tokensBefore: number;
  limits: CompactionLimits;
  /** 绝对总时限（毫秒时间戳），按触发类型由调用方给定。 */
  deadlineAt: number;
  /** 压缩 scope：只有用户停止 / 操作过期会中止它。 */
  signal: AbortSignal;
  /** 与语言无关的进度文本（数字与符号）。wire=false 只刷新本地，变化点与心跳才上线。 */
  onProgress?: (text: string, wire: boolean) => void;
};

type StageControl = { controller: AbortController; endedBy?: StageEnd };

/** 进度汇报：绑定在所属档上，档结束（其信号中止）后一律丢弃。 */
type StageProgress = {
  thinking: () => void;
  write: (delta: string) => void;
  retry: (attempt: number, maxAttempts: number) => void;
};

type StrategyIo = {
  /** 本档信号：链到压缩 scope；总时限与 tool-call 只中止本档。 */
  signal: AbortSignal;
  /** 主动结束本档，原因参与结果分类。 */
  end: (reason: StageEnd) => void;
  progress: StageProgress;
};

/** 一档的原始产出，统一交给 classify 按序判定。 */
type StageAttempt = {
  text: string;
  final?: AssistantMessage;
  error?: unknown;
  providerId: ProviderId;
  model: string;
};

/**
 * 摘要策略接缝。供应商原生压缩（Anthropic compact、OpenAI compaction_trigger）
 * 以后作为新的一档接进降级梯。run 返回 null 表示准备阶段发现本档不可用，直接进入
 * 下一档、不记失败。
 */
interface SummaryStrategy {
  readonly id: string;
  readonly promptVersion: string;
  /** fork 必须有闭合的 <summary>：pause_turn 会被映射成 stop。 */
  readonly requireClosed: boolean;
  available(input: SummarizeInput): boolean;
  run(input: SummarizeInput, io: StrategyIo): Promise<StageAttempt | null>;
}

function messageText(message: AssistantMessage | undefined): string {
  let text = "";
  for (const block of message?.content ?? []) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

function hasClosedSummary(text: string): boolean {
  return /<summary>[\s\S]*<\/summary>/i.test(text);
}

async function drive(stream: AssistantMessageEventStream, io: StrategyIo) {
  let text = "";
  for await (const event of stream) {
    if (event.type === "thinking_delta") {
      io.progress.thinking();
    } else if (event.type === "text_delta") {
      text += event.delta;
      io.progress.write(event.delta);
    } else if (event.type === "toolcall_start" && !hasClosedSummary(text)) {
      // 工具永远不会被执行：没写完摘要就要调工具，这一档作废。
      io.end("tool-call");
    }
  }
  const final = await stream.result();
  return { text: messageText(final) || text, final };
}

// 摘要不需要长思考：开着推理就降到 low（经现有 clamp，Codex 不会落到 minimal）。
function withSummaryReasoning(runtime: ProviderRuntimeConfig): ProviderRuntimeConfig {
  const level = runtime.reasoning;
  return { ...runtime, reasoning: !level || level === "off" ? level : "low" };
}

// fork 的首事件预算不得吃掉 transcript 档的最低时间：否则手动压缩（总时限 270s）在大
// 上下文冷预填时会被 fork 耗尽，transcript 永远轮不到。
const MIN_FIRST_EVENT_TIMEOUT_MS = 1_000;
// 看门狗触发到 transcript 的 available 检查之间还有收尾耗时，留出余量免得卡在边界上。
const TRANSCRIPT_HANDOFF_MARGIN_MS = 5_000;

function forkFirstEventTimeoutMs(
  input: SummarizeInput,
  reasoning: Parameters<typeof firstEventBudgetMs>[1],
): number {
  const leaveForTranscript =
    input.deadlineAt - Date.now() - TRANSCRIPT_MIN_REMAINING_MS - TRANSCRIPT_HANDOFF_MARGIN_MS;
  return Math.max(
    MIN_FIRST_EVENT_TIMEOUT_MS,
    Math.min(firstEventBudgetMs(input.tokensBefore, reasoning), leaveForTranscript),
  );
}

const forkStrategy: SummaryStrategy = {
  id: "fork",
  promptVersion: PROMPT_VERSION.fork,
  requireClosed: true,
  // 同一轮内 failover 过的配方出自 fallback：fork 走 binding 主目标只会打到失败的
  // provider、缓存还是冷的，交给可 failover 的 transcript 档。
  available: ({ recipe, providerId, model, failover }) =>
    recipe?.providerId === providerId &&
    recipe.modelId === model &&
    recipe.targetKey === primaryFailoverBreakerKey(providerId, model, failover?.primary),
  async run(input, io) {
    const recorded = input.recipe as RequestRecipe;
    const { toolChoice } = recorded.options;
    // 强制工具（plan 模式的补提交轮）原样重放只会让本档以 tool-call 作废：放开成 auto。
    const recipe: RequestRecipe =
      toolChoice === "any" || typeof toolChoice === "object"
        ? { ...recorded, options: { ...recorded.options, toolChoice: "auto" } }
        : recorded;
    // 传输每次现取：轮换过的 key、改过的 baseUrl / 自定义头立即生效。会话头与请求体里
    // 的缓存键同出配方，两者不会漂移。
    const transport = await prepareTransport(input.providerId, input.model, input.runtime, {
      sessionId: recipe.options.sessionId ?? input.sessionId,
    });
    // 同模型 responses↔completions 切换后，配方里的选项是按另一协议算的。
    if (transport.model.api !== recipe.api) return null;
    const instruction: UserMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: buildCompactionInstruction({ reasoningEnabled: Boolean(recipe.options.reasoning) }),
        },
      ],
      timestamp: Date.now(),
    };
    // 与上一次主请求逐字节相同（system / tools / tool_choice / reasoning / max_tokens /
    // 缓存键 / wireTail），唯一差异是末尾这条指令（以及上面放开的强制工具）。
    const request = finalizeRequest(
      recipe,
      shapeRequestContext(recipe, [...input.messages, instruction]),
      transport,
      {
        signal: io.signal,
        streamRetry: {
          ...resolveCappedStreamRetryConfig(input.runtime.retryPolicy, SUMMARY_MAX_STREAM_ATTEMPTS),
          firstEventTimeoutMs: forkFirstEventTimeoutMs(input, recipe.options.reasoning),
          idleTimeoutMs: IDLE_TIMEOUT_MS,
          // 沉默是确定性的（冷预填、长推理），重发只会再付一遍费用：直接降到 transcript。
          retryOnStall: false,
          onRetry: (attempt, maxAttempts) => io.progress.retry(attempt, maxAttempts),
        },
        debugLogger: input.debugLogger,
      },
    );
    input.debugLogger?.logRequest(
      buildStreamRequestDebugPayload({
        runtime: input.runtime,
        context: request.context,
        options: request.options,
      }),
    );
    return {
      ...(await drive(llm.stream(request), io)),
      providerId: input.providerId,
      model: input.model,
    };
  },
};

const transcriptStrategy: SummaryStrategy = {
  id: "transcript",
  promptVersion: PROMPT_VERSION.transcript,
  requireClosed: false,
  available: (input) => input.deadlineAt - Date.now() >= TRANSCRIPT_MIN_REMAINING_MS,
  async run(input, io) {
    const runtime = withSummaryReasoning(input.runtime);
    const { reasoning } = runtime;
    const content = `<conversation>\n${serializeTranscript(input.messages, {
      budgetTokens: Math.min(TRANSCRIPT_BUDGET_MAX_TOKENS, Math.floor(0.5 * input.limits.inputCap)),
    })}\n</conversation>\n\n${buildCompactionInstruction({ reasoningEnabled: reasoning === "low" })}`;
    let served = { providerId: input.providerId, model: input.model };
    let text = "";
    const failover = input.failover;
    try {
      const final = await streamAssistantMessage({
        providerId: input.providerId,
        model: input.model,
        runtime,
        context: {
          systemPrompt: TRANSCRIPT_SYSTEM,
          messages: [{ role: "user", content, timestamp: Date.now() }],
        },
        sessionId: input.sessionId,
        cacheRetention: "none",
        signal: io.signal,
        debugLogger: input.debugLogger,
        maxTokens: Math.min(
          input.runtime.modelConfig?.maxOutputToken || TRANSCRIPT_MAX_OUTPUT_TOKENS,
          TRANSCRIPT_MAX_OUTPUT_TOKENS,
        ),
        streamRetry: {
          maxAttempts: SUMMARY_MAX_STREAM_ATTEMPTS,
          firstEventTimeoutMs: firstEventBudgetMs(estimateTextTokens(content), reasoning),
          idleTimeoutMs: IDLE_TIMEOUT_MS,
          retryOnStall: true,
        },
        onTextDelta: (delta) => {
          text += delta;
          io.progress.write(delta);
        },
        onThinkingDelta: () => io.progress.thinking(),
        onRetryStatus: (attempt, maxAttempts) => io.progress.retry(attempt, maxAttempts),
        failover: failover && {
          ...failover,
          fallbacks: failover.fallbacks.map((fallback) => ({
            ...fallback,
            runtime: withSummaryReasoning(fallback.runtime),
          })),
          // generatedBy 记实际服务了摘要的目标。
          onSwitched: (event) => {
            served = event.target
              ? { providerId: event.target.providerId, model: event.target.model }
              : { providerId: input.providerId, model: input.model };
            failover.onSwitched?.(event);
          },
        },
      });
      return { text: messageText(final) || text, final, ...served };
    } catch (error) {
      return { text, error, ...served };
    }
  },
};

const SUMMARY_LADDER: readonly SummaryStrategy[] = [forkStrategy, transcriptStrategy];

function errorDetail(attempt: StageAttempt, raw: AssistantMessage | undefined): string {
  if (attempt.error instanceof Error && attempt.error.message) return attempt.error.message;
  return normalizeErrorMessage(
    raw?.errorMessage,
    attempt.error === undefined ? "request failed" : String(attempt.error),
  );
}

/**
 * 按序判定一档的结果（user stop / scope 中止由调用方先行抛 AbortError）：
 * 本档被总时限或 tool-call 结束 → 能收下闭合的 <summary> 就收下；无因的 aborted →
 * stall；溢出 → overflow；其他错误 → 能收下就收下，否则 fatal / stall / transient；
 * 正常结束 → parseSummaryOutput。
 */
function classify(
  strategy: SummaryStrategy,
  attempt: StageAttempt,
  endedBy: StageEnd | undefined,
  input: SummarizeInput,
): { ok: SummaryDraft } | { failure: SummaryFailure } {
  const raw = readAssistantFromError(attempt.error) ?? attempt.final;
  const accept = (summaryText: string) => ({
    ok: {
      summaryText,
      promptVersion: strategy.promptVersion,
      providerId: attempt.providerId,
      model: attempt.model,
      usage: {
        inputTokens: raw?.usage?.input ?? 0,
        outputTokens: raw?.usage?.output ?? 0,
        cacheReadTokens: raw?.usage?.cacheRead ?? 0,
      },
    },
  });
  // 失败说明会写进 deterministic 摘要与降级提示：中转的 HTML 错误页不能整段带进去。
  const fail = (kind: SummaryFailureKind, detail: string) => ({
    failure: { kind, message: `${strategy.id} ${kind}: ${clipMiddle(detail, 300)}` },
  });
  const salvage = (stopReason: StopReason) => {
    const parsed = parseSummaryOutput(attempt.text, stopReason, input.tokensBefore, {
      requireClosed: true,
    });
    return parsed.ok ? accept(parsed.text) : undefined;
  };

  if (endedBy) {
    return (
      salvage(raw?.stopReason ?? "aborted") ??
      fail(endedBy, endedBy === "deadline" ? "summary deadline reached" : "model called a tool")
    );
  }
  if (raw?.stopReason === "aborted") {
    return fail("stall", raw.errorMessage || "stream aborted");
  }
  // 不传窗口：正常结束的摘要不按"静默溢出"作废，内容由 parseSummaryOutput 把关。
  if (isOverflowError(raw)) return fail("overflow", errorDetail(attempt, raw));
  if (attempt.error || !raw || raw.stopReason === "error") {
    const detail = errorDetail(attempt, raw);
    return (
      salvage(raw?.stopReason ?? "error") ??
      fail(
        isFatalProviderError(`${raw?.errorMessage ?? ""}\n${detail}`)
          ? "fatal"
          : isStreamStallError(raw)
            ? "stall"
            : "transient",
        detail,
      )
    );
  }
  const parsed = parseSummaryOutput(attempt.text, raw.stopReason, input.tokensBefore, {
    requireClosed: strategy.requireClosed,
  });
  return parsed.ok ? accept(parsed.text) : fail("invalid", parsed.reason);
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTokens(units: number): string {
  const tokens = Math.round(units);
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * 进度文本只含数字与符号（"12.3k · 0:41"、"↻2/3 · 0:52"、"→ transcript · 1:10"）。
 * closed 同步置位后一切发布作废；每档的汇报还绑定该档信号，档被中止（结束、
 * 总时限、tool-call）后迟到的重试 / 增量回调直接丢弃，不会在压缩结束后重新点亮状态。
 */
function createProgressReporter(onProgress: SummarizeInput["onProgress"]) {
  const startedAt = Date.now();
  let closed = false;
  let stage = "";
  let phase: "waiting" | "thinking" | "writing" = "waiting";
  let outputUnits = 0;
  let retry: [number, number] | null = null;
  let wiredAt = startedAt;

  const publish = (wire = true) => {
    if (closed || !onProgress) return;
    const parts: string[] = [];
    if (stage !== "fork") parts.push(`→ ${stage}`);
    if (retry) parts.push(`↻${retry[0]}/${retry[1]}`);
    else if (phase === "thinking") parts.push("…");
    else if (phase === "writing") parts.push(formatTokens(outputUnits));
    parts.push(formatElapsed(Date.now() - startedAt));
    if (wire) wiredAt = Date.now();
    try {
      onProgress(parts.join(" · "), wire);
    } catch (error) {
      console.warn("[compaction] progress sink threw; compaction is unaffected", error);
    }
  };
  const ticker = setInterval(
    () => publish(Date.now() - wiredAt >= PROGRESS_HEARTBEAT_MS),
    PROGRESS_LOCAL_REFRESH_MS,
  );

  return {
    enterStage(id: string, signal: AbortSignal): StageProgress {
      stage = id;
      phase = "waiting";
      outputUnits = 0;
      retry = null;
      publish();
      const live = () => !closed && !signal.aborted;
      const setPhase = (next: "thinking" | "writing") => {
        if (phase === next && !retry) return;
        phase = next;
        retry = null;
        publish();
      };
      return {
        thinking: () => {
          if (live()) setPhase("thinking");
        },
        write: (delta) => {
          if (!live()) return;
          outputUnits += estimateTextTokenUnits(delta);
          setPhase("writing");
        },
        retry: (attempt, maxAttempts) => {
          if (!live()) return;
          retry = [attempt, maxAttempts];
          phase = "waiting";
          publish();
        },
      };
    },
    close() {
      closed = true;
      clearInterval(ticker);
    },
  };
}

/**
 * 运行降级梯。返回摘要（可能 degraded）或最后一次失败；只有用户停止 / scope 中止
 * 抛 AbortError——总时限、stall、tool-call 都是失败而不是中止。
 */
export async function summarize(input: SummarizeInput): Promise<SummarizeResult> {
  return withPowerActivity("compaction", `${input.providerId}:${input.model}`, async () => {
    const progress = createProgressReporter(input.onProgress);
    let current: StageControl | null = null;
    const endStage = (stage: StageControl, reason: StageEnd) => {
      if (stage.endedBy || stage.controller.signal.aborted) return;
      stage.endedBy = reason;
      stage.controller.abort();
    };
    const deadlineTimer = setTimeout(
      () => {
        if (current) endStage(current, "deadline");
      },
      Math.max(0, input.deadlineAt - Date.now()),
    );
    const throwIfAborted = () => {
      if (input.signal.aborted) throw createCompactionAbortError();
    };

    try {
      let lastFailure: SummaryFailure | undefined;
      const startIndex = SUMMARY_LADDER.findIndex((strategy) => strategy.id === input.startAt);
      for (const strategy of SUMMARY_LADDER.slice(Math.max(0, startIndex))) {
        throwIfAborted();
        if (Date.now() >= input.deadlineAt) break;
        if (!strategy.available(input)) continue;

        const stage: StageControl = { controller: new AbortController() };
        const link = createLinkedAbortSignal([input.signal, stage.controller.signal]);
        const signal = link.signal ?? stage.controller.signal;
        current = stage;
        let attempt: StageAttempt | null;
        try {
          attempt = await strategy.run(input, {
            signal,
            end: (reason) => endStage(stage, reason),
            progress: progress.enterStage(strategy.id, signal),
          });
        } catch (error) {
          attempt = { text: "", error, providerId: input.providerId, model: input.model };
        } finally {
          current = null;
          // 本档到此为止：迟到的重试回调与残留请求一并作废。
          if (!stage.controller.signal.aborted) stage.controller.abort();
          link.cleanup();
        }
        throwIfAborted();
        if (!attempt) continue;

        const outcome = classify(strategy, attempt, stage.endedBy, input);
        input.debugLogger?.logResult({
          event: "compaction_stage",
          stage: strategy.id,
          ...("ok" in outcome
            ? { outcome: "ok", usage: outcome.ok.usage }
            : { outcome: outcome.failure.kind, message: outcome.failure.message }),
        });
        if ("ok" in outcome) return outcome;
        lastFailure = outcome.failure;
      }

      throwIfAborted();
      const failure = lastFailure ?? {
        kind: "deadline" as const,
        message: "no summary stage could run before the deadline",
      };
      // 鉴权 / 配额类失败时主请求同样会失败，有损的兜底换不来任何东西。
      if (!input.automatic || !input.mustProgress || failure.kind === "fatal") return { failure };
      progress.enterStage("deterministic", input.signal);
      return {
        ok: {
          summaryText: deterministicSummary({
            previousSummary: input.previousSummary,
            messages: input.segmentMessages,
            reason: failure.message,
          }),
          promptVersion: PROMPT_VERSION.deterministic,
          providerId: input.providerId,
          model: input.model,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        },
        degraded: failure.message,
      };
    } finally {
      clearTimeout(deadlineTimer);
      progress.close();
    }
  });
}
