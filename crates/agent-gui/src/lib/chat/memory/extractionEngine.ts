// Post-turn memory extraction engine. One hidden LLM round on a compact,
// self-contained context; the model submits its plan through a single
// SubmitMemoryPlan tool call (per-item validation — a formatting slip never
// drops the whole turn), and the validated plan is persisted through ONE
// memory_apply_batch call. Model fallback (configured summary model → main
// conversation model) is absorbed here.

import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  type MemoryMeta,
  memoryApplyBatch,
  memoryList,
  memoryRecentRejections,
  memoryTodayLocalDate,
} from "@liveagent/ui/lib/memory/api";
import {
  EXTRACTION_CANDIDATE_LIMIT,
  EXTRACTION_REJECTION_DAYS,
  EXTRACTION_TIMEOUT_MS,
} from "@liveagent/ui/lib/memory/config";
import type { MemoryReviewerMode, ValidatedPlanItem } from "@liveagent/ui/lib/memory/schema";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import {
  buildConversationWindowBlock,
  deriveWorkspaceMutations,
  extractLatestUserText,
} from "../../memory/extraction/context";
import {
  buildPlanReceiptText,
  createSubmitMemoryPlanTool,
  parsePlanSubmission,
  planToApplyBatchArgs,
  SUBMIT_MEMORY_PLAN_TOOL_NAME,
  validateSubmittedPlan,
} from "../../memory/extraction/planTool";
import {
  buildAlreadyWrittenBlock,
  buildConversationSummaryBlock,
  buildExistingCandidatesBlock,
  buildExtractionInstructionPrompt,
  buildRecentRejectionsBlock,
  buildWorkspaceMutationsBlock,
  EXTRACTION_SYSTEM_PROMPT,
  type ExtractionCandidateEntry,
  type ExtractionRejectionEntry,
} from "../../memory/prompts/extraction";
import type { ProviderRuntimeConfig } from "../../providers/runtime/types";
import type { ProviderId, SelectedModel } from "../../settings";
import { createMemoryTools } from "../../tools/memoryTools";
import { isAbortLikeError } from "../page/chatPageHelpers";
import { runAssistantWithTools } from "../runner/agentRunner";

export type MemoryExtractionModelConfig = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  selectedModel?: SelectedModel;
};

export type MemoryExtractionVisibleEvents = {
  roundOffset?: number;
  onTurnStart?: (round: number) => void;
  onTextDelta?: (delta: string, round: number) => void;
  onThinkingDelta?: (delta: string, round: number) => void;
  onToolCall?: (toolCall: ToolCall, round: number) => void;
  onToolExecutionStart?: (toolCall: ToolCall, round: number) => void;
  onToolResult?: (toolCall: ToolCall, toolResult: ToolResultMessage, round: number) => void;
  onAssistantMessage?: (assistant: AssistantMessage, round: number) => void;
  onToolStatus?: (status: string | null) => void;
};

export type MemoryExtractionStatusKey = "done" | "noop" | "partial";

export type MemoryExtractionStatusText = (
  key: MemoryExtractionStatusKey,
  counts: { accepted: number; rejected: number },
) => string;

export type MemoryExtractionEngineParams = {
  primary: MemoryExtractionModelConfig;
  fallback?: MemoryExtractionModelConfig;
  onPrimaryFailure?: (primary: MemoryExtractionModelConfig) => void;
  sessionId: string;
  conversationId: string;
  workdir?: string;
  reviewerMode?: MemoryReviewerMode;
  /** Snapshot of the conversation messages at turn end. */
  messages: readonly Message[];
  /** Optional compaction summary for long conversations. */
  conversationSummary?: string;
  /** Slugs already written this turn (from the controller). */
  alreadyWrittenSlugs: readonly string[];
  /** True when the run was claimed only because the latest message may answer
   *  a memory confirmation; the engine re-checks once candidates are loaded. */
  confirmationDeferralOnly?: boolean;
  statusText?: MemoryExtractionStatusText;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  visibleEvents?: MemoryExtractionVisibleEvents;
};

export type MemoryExtractionResult = {
  ok: boolean;
  aborted?: boolean;
  /** Set when the run bailed before the LLM round. */
  skipped?: string;
  acceptedCount: number;
  rejectedCount: number;
  /** Non-daily slugs actually written/updated (feeds already-written dedup). */
  writtenSlugs: string[];
  /** Render-only messages for agent-dev visible mode. */
  emittedMessages: Message[];
};

const EMPTY_RESULT: Omit<MemoryExtractionResult, "ok"> = {
  acceptedCount: 0,
  rejectedCount: 0,
  writtenSlugs: [],
  emittedMessages: [],
};

function defaultStatusText(
  key: MemoryExtractionStatusKey,
  counts: { accepted: number; rejected: number },
): string {
  switch (key) {
    case "done":
      return "Memory updated.";
    case "partial":
      return `Memory partially updated (${counts.accepted} applied, ${counts.rejected} rejected).`;
    default:
      return "No memory updates needed this turn.";
  }
}

function memoryExtractionModelKey(model: MemoryExtractionModelConfig) {
  if (model.selectedModel) {
    return `${model.selectedModel.customProviderId}:${model.selectedModel.model}`;
  }
  return `${model.providerId}:${model.model}:${model.runtime.baseUrl}`;
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function toCandidateEntry(entry: MemoryMeta): ExtractionCandidateEntry {
  return {
    slug: entry.slug,
    memoryType: entry.memoryType,
    scope: entry.scope,
    description: entry.description || entry.headline || undefined,
    unreviewed: entry.unreviewed,
    confidence: entry.confidence,
    updatedAt: entry.updatedAt,
  };
}

function collectCandidateEntries(entries: readonly MemoryMeta[]): ExtractionCandidateEntry[] {
  const seen = new Set<string>();
  const all: ExtractionCandidateEntry[] = [];
  for (const entry of entries) {
    if (entry.memoryType === "daily") continue;
    const key = `${entry.scope}:${entry.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(toCandidateEntry(entry));
  }
  all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return all.slice(0, EXTRACTION_CANDIDATE_LIMIT);
}

async function loadCandidates(workdir: string) {
  try {
    const response = await memoryList({
      workdir: workdir || undefined,
      includeDaily: false,
      limit: EXTRACTION_CANDIDATE_LIMIT * 3,
    });
    return collectCandidateEntries(response.entries);
  } catch (error) {
    console.warn("Failed to load memory extraction candidates:", error);
    return [];
  }
}

async function loadRejections(workdir: string): Promise<ExtractionRejectionEntry[]> {
  try {
    const response = await memoryRecentRejections({
      sinceDays: EXTRACTION_REJECTION_DAYS,
      limit: 30,
      workdir: workdir || undefined,
    });
    return response.entries.map((entry) => ({
      slug: entry.slug,
      rejectedAt: entry.rejectedAt,
      reason: entry.reason ?? null,
    }));
  } catch (error) {
    console.warn("Failed to load memory extraction rejections:", error);
    return [];
  }
}

async function resolveLocalDate() {
  try {
    return await memoryTodayLocalDate();
  } catch (error) {
    console.warn("Failed to resolve memory local date for extraction", error);
    const now = new Date();
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }
}

function createSyntheticUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createStatusAssistant(params: {
  template?: AssistantMessage;
  model: string;
  text: string;
}): AssistantMessage {
  return {
    ...(params.template ?? {}),
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: params.template?.api ?? "liveagent-memory",
    provider: params.template?.provider ?? "liveagent",
    model: params.template?.model ?? params.model,
    usage: params.template?.usage ?? createSyntheticUsage(),
    stopReason: "stop",
    timestamp: params.template?.timestamp ?? Date.now(),
  };
}

function findLastAssistantIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

function assistantText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) {
    return typeof message.content === "string" ? message.content : "";
  }
  return message.content
    .map((part) => (part && typeof part === "object" && part.type === "text" ? part.text : ""))
    .filter((segment): segment is string => typeof segment === "string" && segment.length > 0)
    .join("\n");
}

function replaceFinalAssistantWithStatus(
  messages: readonly Message[],
  statusAssistant: AssistantMessage,
): Message[] {
  const next = messages.slice();
  const index = findLastAssistantIndex(next);
  if (index >= 0) {
    next[index] = statusAssistant;
  } else {
    next.push(statusAssistant);
  }
  return next;
}

type CapturedSubmission = {
  accepted: ValidatedPlanItem[];
  rejected: ReturnType<typeof validateSubmittedPlan>["rejected"];
  status: string | undefined;
};

/** Run one LLM round with the ro MemoryManager bundle + SubmitMemoryPlan and
 *  capture the first submission. */
async function runExtractionRound(params: {
  model: MemoryExtractionModelConfig;
  systemPrompt: string;
  messages: Message[];
  includeMemoryManager: boolean;
  workdir: string;
  sessionId: string;
  conversationId: string;
  planContext: Parameters<typeof validateSubmittedPlan>[1];
  signal: AbortSignal;
  debugLogger?: StreamDebugLogger;
  visibleEvents?: MemoryExtractionVisibleEvents;
  roundState: { forwardedTurnRounds: Set<number>; lastAssistantRound: number | null };
}): Promise<{ submission: CapturedSubmission | null; emittedMessages: Message[] }> {
  const memoryBundle = createMemoryTools({
    workdir: params.workdir,
    mode: "ro",
    actor: "extractor",
    conversationId: params.conversationId,
    model: params.model.model,
  });
  const planTool = createSubmitMemoryPlanTool();
  const tools = params.includeMemoryManager ? [...memoryBundle.tools, planTool] : [planTool];

  let captured: CapturedSubmission | null = null;

  const executeToolCall = async (
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> => {
    if (toolCall.name === SUBMIT_MEMORY_PLAN_TOOL_NAME) {
      const now = Date.now();
      if (captured) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "Plan already submitted; extra calls are ignored." }],
          details: {},
          isError: true,
          timestamp: now,
        };
      }
      const submission = parsePlanSubmission(toolCall.arguments);
      const validation = validateSubmittedPlan(submission, params.planContext);
      captured = { ...validation, status: submission.status };
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: buildPlanReceiptText(validation) }],
        details: { accepted: validation.accepted.length, rejected: validation.rejected },
        isError: false,
        timestamp: now,
      };
    }
    const result = await memoryBundle.executeToolCall(toolCall, signal);
    return result.role === "toolResult"
      ? result
      : {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "MemoryManager did not return a tool result" }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
  };

  const visibleEvents = params.visibleEvents;
  const mapRound = (round: number) => (visibleEvents?.roundOffset ?? 0) + round;
  const context: Context = {
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    tools,
  };

  const result = await runAssistantWithTools({
    providerId: params.model.providerId,
    model: params.model.model,
    runtime: params.model.runtime,
    context,
    workdir: params.workdir,
    // 稳定 sessionId:codex 路径上它就是 prompt_cache_key(缓存分片路由)。同一
    // 会话的多次抽取共享 system prompt / 工具定义 / 对话前缀,带时间戳会每次换
    // 分片、全量 miss;去掉后后续抽取直接吃前一次的前缀。诊断侧的 prefixShape
    // LRU 也不再被一次性键挤占(prompt-cache-stability.md 残留风险 #2)。
    sessionId: `${params.sessionId}:memory:${params.conversationId}`,
    tools,
    executeToolCall,
    onTurnStart: (round) => {
      const mapped = mapRound(round);
      params.roundState.forwardedTurnRounds.add(mapped);
      visibleEvents?.onTurnStart?.(mapped);
    },
    // Raw model text is machine reasoning; only the i18n status line is shown.
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolCall: (toolCall, round) => visibleEvents?.onToolCall?.(toolCall, mapRound(round)),
    onToolExecutionStart: (toolCall, round) =>
      visibleEvents?.onToolExecutionStart?.(toolCall, mapRound(round)),
    onToolResult: (toolCall, toolResult, round) => {
      if (toolResult.role !== "toolResult") return;
      visibleEvents?.onToolResult?.(toolCall, toolResult, mapRound(round));
    },
    onAssistantMessage: (assistant, round) => {
      if (assistant.role !== "assistant") return;
      params.roundState.lastAssistantRound = mapRound(round);
    },
    onToolStatus: (status) => visibleEvents?.onToolStatus?.(status),
    signal: params.signal,
    debugLogger: params.debugLogger,
    allowEmptyWorkdir: true,
  });

  return { submission: captured, emittedMessages: result.emittedMessages };
}

export async function runMemoryExtraction(
  params: MemoryExtractionEngineParams,
): Promise<MemoryExtractionResult> {
  const workdir = params.workdir?.trim() ?? "";
  const statusText = params.statusText ?? defaultStatusText;
  if (params.signal?.aborted) {
    return { ok: false, aborted: true, ...EMPTY_RESULT };
  }

  const [localDate, candidates, rejections] = await Promise.all([
    resolveLocalDate(),
    loadCandidates(workdir),
    loadRejections(workdir),
  ]);
  if (params.signal?.aborted) {
    return { ok: false, aborted: true, ...EMPTY_RESULT };
  }

  // Confirmation deferral: the controller claimed this run only because the
  // short reply may answer a memory confirmation. With candidates loaded we
  // can settle that question.
  if (params.confirmationDeferralOnly) {
    const hasConfirmable = candidates.some(
      (entry) => entry.unreviewed === true && entry.memoryType !== "daily",
    );
    if (!hasConfirmable) {
      return { ok: true, skipped: "user-message-too-short", ...EMPTY_RESULT };
    }
  }

  const latestUserText = extractLatestUserText(params.messages);
  if (!latestUserText.trim()) {
    return { ok: true, skipped: "empty-user-message", ...EMPTY_RESULT };
  }

  const workspaceMutations = deriveWorkspaceMutations(params.messages, workdir || undefined);
  const summaryBlock = buildConversationSummaryBlock(params.conversationSummary);
  // 块序按「稳定 → 易变」排:指令 prompt(约 4KB,会话内静态)打头,对话窗口
  // (每轮必变)垫底。前缀缓存是字节级匹配,最易变的块排前面会让同会话的多次
  // 抽取在第一行就分叉 —— sessionId 已稳定(见 runExtractionRound),块序对了
  // 才真能吃到前一次抽取的前缀。指令里的方位措辞(above/below)与此序同步。
  const hiddenPromptText = [
    buildExtractionInstructionPrompt({
      localDate,
      workdir: workdir || undefined,
      reviewerMode: params.reviewerMode,
    }),
    "",
    ...(summaryBlock ? [summaryBlock] : []),
    buildRecentRejectionsBlock(rejections),
    buildExistingCandidatesBlock(candidates),
    buildAlreadyWrittenBlock(params.alreadyWrittenSlugs),
    buildWorkspaceMutationsBlock(workspaceMutations),
    buildConversationWindowBlock(params.messages),
  ].join("\n\n");
  const hiddenPrompt: UserMessage = {
    role: "user",
    content: hiddenPromptText,
    timestamp: Date.now(),
  };

  const planContext = {
    hasWorkdir: Boolean(workdir),
    rejectedSlugs: new Set(rejections.map((entry) => entry.slug)),
    alreadyWrittenSlugs: new Set(params.alreadyWrittenSlugs),
  };

  const timeout = createTimeoutSignal(params.signal, EXTRACTION_TIMEOUT_MS);
  const roundState = {
    forwardedTurnRounds: new Set<number>(),
    lastAssistantRound: null as number | null,
  };

  const attempt = async (model: MemoryExtractionModelConfig) => {
    let round = await runExtractionRound({
      model,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [hiddenPrompt],
      includeMemoryManager: true,
      workdir,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      planContext,
      signal: timeout.signal,
      debugLogger: params.debugLogger,
      visibleEvents: params.visibleEvents,
      roundState,
    });

    if (!round.submission) {
      // Recovery: one terse follow-up with ONLY SubmitMemoryPlan available.
      const priorAssistant = round.emittedMessages
        .filter((message): message is AssistantMessage => message.role === "assistant")
        .map((message) => assistantText(message))
        .filter(Boolean)
        .join("\n");
      const followUp: Message[] = [
        hiddenPrompt,
        ...(priorAssistant
          ? [
              {
                role: "assistant",
                content: [{ type: "text", text: priorAssistant }],
                api: "liveagent-memory",
                provider: "liveagent",
                model: model.model,
                usage: createSyntheticUsage(),
                stopReason: "stop",
                timestamp: Date.now(),
              } as AssistantMessage,
            ]
          : []),
        {
          role: "user",
          content:
            'You did not call SubmitMemoryPlan. Call it now exactly once — with status="noop" and items=[] if nothing qualifies.',
          timestamp: Date.now(),
        } as UserMessage,
      ];
      const retry = await runExtractionRound({
        model,
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        messages: followUp,
        includeMemoryManager: false,
        workdir,
        sessionId: params.sessionId,
        conversationId: params.conversationId,
        planContext,
        signal: timeout.signal,
        debugLogger: params.debugLogger,
        visibleEvents: params.visibleEvents,
        roundState,
      });
      round = {
        submission: retry.submission,
        emittedMessages: [...round.emittedMessages, ...retry.emittedMessages],
      };
    }
    return round;
  };

  try {
    let round: Awaited<ReturnType<typeof attempt>>;
    try {
      round = await attempt(params.primary);
    } catch (primaryError) {
      const abortedPrimary =
        params.signal?.aborted === true || (!timeout.timedOut() && isAbortLikeError(primaryError));
      if (abortedPrimary || timeout.timedOut() || !params.fallback) throw primaryError;
      params.onPrimaryFailure?.(params.primary);
      if (memoryExtractionModelKey(params.primary) === memoryExtractionModelKey(params.fallback)) {
        throw primaryError;
      }
      round = await attempt(params.fallback);
    }

    const submission = round.submission;
    if (!submission) {
      console.warn("Memory extraction ended without a SubmitMemoryPlan call");
    }

    const accepted = submission?.accepted ?? [];
    let acceptedCount = accepted.length;
    let rejectedCount = submission?.rejected.length ?? 0;
    const writtenSlugs: string[] = [];

    if (accepted.length > 0) {
      if (params.signal?.aborted) {
        throw new Error("Cancelled");
      }
      const batch = planToApplyBatchArgs(accepted);
      const model = params.primary.model;
      const response = await memoryApplyBatch({
        workdir: workdir || undefined,
        conversationId: params.conversationId,
        trigger: "memory-extraction",
        model,
        localDate,
        dailyAppend: batch.dailyAppend,
        decisions: batch.decisions.length > 0 ? batch.decisions : undefined,
      });
      const applied = new Set([...response.created, ...response.updated, ...response.deleted]);
      for (const slug of applied) {
        if (!slug.startsWith("daily-")) writtenSlugs.push(slug);
      }
      if (response.warnings.length > 0) {
        acceptedCount = Math.max(0, acceptedCount - response.warnings.length);
        rejectedCount += response.warnings.length;
        console.warn("Memory extraction batch warnings:", response.warnings);
      }
    }

    const statusKey: MemoryExtractionStatusKey =
      acceptedCount > 0 ? (rejectedCount > 0 ? "partial" : "done") : "noop";
    const finalAssistantIndex = findLastAssistantIndex(round.emittedMessages);
    const template =
      finalAssistantIndex >= 0
        ? (round.emittedMessages[finalAssistantIndex] as AssistantMessage)
        : undefined;
    const statusAssistant = createStatusAssistant({
      template,
      model: params.primary.model,
      text: statusText(statusKey, { accepted: acceptedCount, rejected: rejectedCount }),
    });
    const emittedMessages = replaceFinalAssistantWithStatus(round.emittedMessages, statusAssistant);

    // Surface the status line in visible (agent-dev) mode.
    const visibleEvents = params.visibleEvents;
    if (visibleEvents) {
      const round_ = roundState.lastAssistantRound ?? (visibleEvents.roundOffset ?? 0) + 1;
      if (!roundState.forwardedTurnRounds.has(round_)) {
        visibleEvents.onTurnStart?.(round_);
        roundState.forwardedTurnRounds.add(round_);
      }
      const text = assistantText(statusAssistant);
      if (text) visibleEvents.onTextDelta?.(text, round_);
      visibleEvents.onAssistantMessage?.(statusAssistant, round_);
    }

    return {
      ok: true,
      acceptedCount,
      rejectedCount,
      writtenSlugs,
      emittedMessages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timeout.timedOut()) {
      console.warn("Memory extraction timed out");
    } else if (!params.signal?.aborted && !isAbortLikeError(error)) {
      console.warn("Memory extraction failed", message);
    }
    return {
      ok: false,
      aborted: params.signal?.aborted === true || (!timeout.timedOut() && isAbortLikeError(error)),
      ...EMPTY_RESULT,
    };
  } finally {
    timeout.cleanup();
  }
}
