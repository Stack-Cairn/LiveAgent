// 记忆整理的执行引擎。
//
// 调度与「下次什么时候跑」不在这里:那是设置状态,归前端所有。这里只负责
// 「拿到一个已 claim 的 run,把它跑完」—— 扫描、聚类、规划、闸门、写入,
// 阶段进度经 memory_organize_* wire 事件广播,run 记录本身写回 Rust 库。
//
// 与主聊天一致的受理语义:acceptOrganizerRun 同步入队并立即返回,真正的
// 终态从 memory_organize_ended 事件来 —— 一次整理可能跑几分钟,不能挂在
// HTTP 响应上。

import type { Context, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { runAssistantWithTools } from "../../chat/runner/agentRunner";
import { createStreamDebugLogger } from "../../debug/agentDebug";
import { emitWireEvent } from "../../events";
import { assistantMessageToText, createProviderRuntimeConfig } from "../../providers/llm";
import { type AppSettings, DEFAULT_CHAT_RUNTIME_CONTROLS, isAgentDevMode } from "../../settings";
import { loadPersistedSettingsWithDefaults } from "../../settings/storage";
import { createMemoryTools } from "../../tools/memoryTools";
import {
  type MemoryBatchResponse,
  type MemoryOrganizeRun,
  memoryApplyBatch,
  memoryList,
  memoryOrganizeDueComplete,
  memoryOrganizeRunUpdate,
  memoryQuotaSummary,
  memoryRead,
} from "../api";
import { ORGANIZER_RAW_PROTOCOL_CHARS } from "../config";
import {
  buildClusterPrompt,
  buildGlobalInventory,
  buildMetaClusterPrompt,
  clipText,
  ORGANIZER_PLAN_TOOL_NAME,
  ORGANIZER_SYSTEM_PROMPT,
  ORGANIZER_TOPIC_TOOL_NAME,
  TOPIC_CLUSTER_SYSTEM_PROMPT,
} from "../prompts/organizer";
import {
  buildDecisions,
  buildStructuralClusters,
  buildTopicClustersFromArgs,
  normalizeOrganizerMode,
  normalizeOrganizerPlanArgs,
  ORGANIZER_PLAN_TOOL,
  ORGANIZER_TOPIC_TOOL,
  type OrganizerCluster,
  type OrganizerClusterPlan,
  type OrganizerEntry,
  type ParsedClusterResult,
  scopeMatchesRun,
} from "./pipeline";
import { deriveQuotaLadder } from "./quota";
import { appliedBatchCount, createEmptyRunReport, type OrganizeRunReportV4 } from "./runRecord";

type OrganizerStats = {
  inputCount: number;
  clusterCount: number;
  safeApplied: number;
  pendingSafeDecisions: number;
  reviewSkipped: number;
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  mergedCount: number;
  parseFailures: number;
};

function emptyStats(): OrganizerStats {
  return {
    inputCount: 0,
    clusterCount: 0,
    safeApplied: 0,
    pendingSafeDecisions: 0,
    reviewSkipped: 0,
    createdCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    mergedCount: 0,
    parseFailures: 0,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function modelLabel(run: MemoryOrganizeRun, settings: AppSettings) {
  const selected =
    run.model && typeof run.model === "object"
      ? (run.model as { customProviderId?: unknown; model?: unknown })
      : settings.memory.organizerModel;
  const providerId = stringValue(selected?.customProviderId);
  const model = stringValue(selected?.model);
  return providerId && model ? `${providerId}/${model}` : model;
}

function resolveOrganizerProvider(run: MemoryOrganizeRun, settings: AppSettings) {
  const selected =
    run.model && typeof run.model === "object"
      ? (run.model as { customProviderId?: unknown; model?: unknown })
      : settings.memory.organizerModel;
  const customProviderId = stringValue(selected?.customProviderId);
  const model = stringValue(selected?.model);
  if (!customProviderId || !model) {
    throw new Error("请先在 Settings > Memory 中选择记忆整理模型。");
  }
  const provider = settings.customProviders.find((item) => item.id === customProviderId);
  if (!provider) {
    throw new Error(`记忆整理模型供应商不存在：${customProviderId}`);
  }
  if (!provider.baseUrl.trim()) {
    throw new Error(`记忆整理模型供应商 Base URL 为空：${provider.name || provider.id}`);
  }
  if (!provider.apiKey.trim()) {
    throw new Error(`记忆整理模型供应商 API Key 为空：${provider.name || provider.id}`);
  }
  return { provider, model };
}

function buildFinalSummary(stats: OrganizerStats) {
  if (stats.inputCount === 0) {
    return "本次记忆整理未找到可整理的普通记忆，未进行任何写入。";
  }
  const failureNote =
    stats.parseFailures > 0 ? `；${stats.parseFailures} 个分组未提交有效计划，已局部跳过` : "";
  if (stats.pendingSafeDecisions > 0) {
    return `本次整理覆盖 ${stats.inputCount} 条记忆、${stats.clusterCount} 个分组，已生成 ${stats.pendingSafeDecisions} 条安全建议，等待你在历史记录中确认应用；${stats.reviewSkipped} 条风险建议已跳过并保存在历史详情中${failureNote}。`;
  }
  return `本次整理覆盖 ${stats.inputCount} 条记忆、${stats.clusterCount} 个分组，已应用 ${stats.safeApplied} 条安全建议，新增 ${stats.createdCount} 条、更新 ${stats.updatedCount} 条、删除 ${stats.deletedCount} 条；${stats.reviewSkipped} 条风险建议已跳过并保存在历史详情中${failureNote}。`;
}

function toolResultMessage(
  toolCall: ToolCall,
  text: string,
  details: unknown,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details,
    isError,
    timestamp: Date.now(),
  };
}

async function listOrganizerEntries(run: MemoryOrganizeRun, workdir: string) {
  const entries = [];
  let offset = 0;
  for (;;) {
    const page = await memoryList({
      workdir,
      includeAllProjects: run.scope !== "current-project",
      includeDaily: false,
      limit: 1000,
      offset,
    });
    entries.push(...page.entries);
    if (!page.truncated) break;
    offset += page.entries.length;
    if (page.entries.length === 0) break;
  }
  return entries.filter((entry) => scopeMatchesRun(entry, run, workdir));
}

async function readOrganizerEntries(
  entries: Awaited<ReturnType<typeof listOrganizerEntries>>,
  workdir: string,
): Promise<OrganizerEntry[]> {
  const out: OrganizerEntry[] = [];
  for (const entry of entries) {
    const read = await memoryRead({
      slug: entry.slug,
      scope: entry.scope,
      workdir: entry.scope === "project" ? entry.workdirPath || workdir : workdir,
      workdirHash: entry.scope === "project" ? entry.workdirHash : undefined,
    });
    out.push({ ...entry, body: read.body });
  }
  return out;
}

/** One LLM round for the organizer; token usage accumulates into `tokens`. */
async function runOrganizerModelPrompt(params: {
  settings: AppSettings;
  run: MemoryOrganizeRun;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  tools: Context["tools"];
  executeToolCall: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
  tokens: { total: number };
  signal?: AbortSignal;
}) {
  const { provider, model } = resolveOrganizerProvider(params.run, params.settings);
  const context: Context = {
    systemPrompt: params.systemPrompt,
    messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
    tools: params.tools,
  };
  const debugLogger = createStreamDebugLogger({
    enabled: isAgentDevMode(params.settings.system.executionMode),
    conversationId: params.run.runId,
    executionMode: params.settings.system.executionMode,
    streamKind: "memory_organizer",
    providerId: provider.type,
    model,
  });
  const result = await runAssistantWithTools({
    providerId: provider.type,
    model,
    runtime: {
      ...createProviderRuntimeConfig(
        provider,
        model,
        DEFAULT_CHAT_RUNTIME_CONTROLS,
        params.settings.customSettings.providerIdentities,
      ),
      // 后台整理恒开提示词缓存：多轮 prompt 共享同一前缀，命中率远高于按供应商
      // 开关逐个判断。
      promptCachingEnabled: true,
    },
    context,
    workdir: params.workdir,
    sessionId: params.run.runId,
    tools: params.tools,
    executeToolCall: params.executeToolCall,
    onTextDelta() {},
    onToolStatus() {},
    signal: params.signal,
    debugLogger,
    allowEmptyWorkdir: true,
  });
  for (const message of result.emittedMessages) {
    if (message.role === "assistant" && message.usage) {
      params.tokens.total += message.usage.totalTokens ?? 0;
    }
  }
  return assistantMessageToText(result.assistant).trim();
}

async function runTopicClusterPrompt(params: {
  settings: AppSettings;
  run: MemoryOrganizeRun;
  prompt: string;
  workdir: string;
  tokens: { total: number };
}) {
  let submittedArgs: Record<string, unknown> | null = null;
  const rawText = await runOrganizerModelPrompt({
    ...params,
    systemPrompt: TOPIC_CLUSTER_SYSTEM_PROMPT,
    tools: [ORGANIZER_TOPIC_TOOL],
    async executeToolCall(toolCall) {
      if (toolCall.name !== ORGANIZER_TOPIC_TOOL_NAME) {
        return toolResultMessage(toolCall, `Unknown tool: ${toolCall.name}`, {}, true);
      }
      submittedArgs =
        toolCall.arguments && typeof toolCall.arguments === "object"
          ? (toolCall.arguments as Record<string, unknown>)
          : {};
      return toolResultMessage(
        toolCall,
        "Topic clusters received. No further protocol output is needed.",
        submittedArgs,
      );
    },
  });
  if (!submittedArgs) {
    throw new Error(`${ORGANIZER_TOPIC_TOOL_NAME} was not called`);
  }
  return {
    args: submittedArgs,
    raw: clipText(
      [rawText, "", `[${ORGANIZER_TOPIC_TOOL_NAME}]`, JSON.stringify(submittedArgs, null, 2)]
        .filter((part) => part.trim().length > 0)
        .join("\n"),
      ORGANIZER_RAW_PROTOCOL_CHARS,
    ),
  };
}

async function runOrganizerPlanPrompt(params: {
  settings: AppSettings;
  run: MemoryOrganizeRun;
  prompt: string;
  workdir: string;
  tokens: { total: number };
}): Promise<OrganizerClusterPlan> {
  const { model } = resolveOrganizerProvider(params.run, params.settings);
  const memoryBundle = createMemoryTools({
    workdir: params.workdir,
    mode: "ro",
    actor: "extractor",
    model,
  });
  const captured: {
    plan?: Omit<OrganizerClusterPlan, "raw">;
    args?: Record<string, unknown>;
  } = {};
  const rawText = await runOrganizerModelPrompt({
    ...params,
    systemPrompt: ORGANIZER_SYSTEM_PROMPT,
    tools: [ORGANIZER_PLAN_TOOL, ...memoryBundle.tools],
    async executeToolCall(toolCall, signal) {
      if (toolCall.name === ORGANIZER_PLAN_TOOL_NAME) {
        captured.args =
          toolCall.arguments && typeof toolCall.arguments === "object"
            ? (toolCall.arguments as Record<string, unknown>)
            : {};
        captured.plan = normalizeOrganizerPlanArgs(captured.args);
        return toolResultMessage(
          toolCall,
          "Organization plan received. No further protocol output is needed.",
          captured.plan,
        );
      }
      return memoryBundle.executeToolCall(toolCall, signal);
    },
  });
  if (!captured.plan) {
    throw new Error(`${ORGANIZER_PLAN_TOOL_NAME} was not called`);
  }
  return {
    ...captured.plan,
    raw: clipText(
      [rawText, "", `[${ORGANIZER_PLAN_TOOL_NAME}]`, JSON.stringify(captured.args, null, 2)]
        .filter((part) => part.trim().length > 0)
        .join("\n"),
      ORGANIZER_RAW_PROTOCOL_CHARS,
    ),
  };
}

async function buildOrganizerClusters(params: {
  entries: OrganizerEntry[];
  run: MemoryOrganizeRun;
  settings: AppSettings;
  workdir: string;
  tokens: { total: number };
}): Promise<{ clusters: OrganizerCluster[]; rawMeta: string }> {
  if (params.entries.length <= 8) {
    return { clusters: buildStructuralClusters(params.entries), rawMeta: "" };
  }
  try {
    const topicPlan = await runTopicClusterPrompt({
      settings: params.settings,
      run: params.run,
      prompt: buildMetaClusterPrompt(params.entries),
      workdir: params.workdir,
      tokens: params.tokens,
    });
    const clusters = buildTopicClustersFromArgs(topicPlan.args, params.entries);
    return {
      clusters: clusters.length > 0 ? clusters : buildStructuralClusters(params.entries),
      rawMeta: topicPlan.raw,
    };
  } catch (error) {
    console.warn("memory organizer topic clustering failed", error);
    return { clusters: buildStructuralClusters(params.entries), rawMeta: "" };
  }
}

function emitProgress(
  run: MemoryOrganizeRun,
  phase: "scan" | "cluster" | "plan" | "gate" | "apply",
  counts?: { inputCount?: number; clusterCount?: number },
) {
  emitWireEvent({
    type: "memory_organize_progress",
    run_id: run.runId,
    phase,
    input_count: counts?.inputCount,
    cluster_count: counts?.clusterCount,
  });
}

function emitEnded(
  run: MemoryOrganizeRun,
  status: "succeeded" | "failed" | "skipped",
  finalSummary: string,
  errorMessage?: string,
) {
  emitWireEvent({
    type: "memory_organize_ended",
    run_id: run.runId,
    trigger: run.trigger,
    status,
    final_summary: finalSummary || undefined,
    error_message: errorMessage || undefined,
  });
}

async function executeOrganizerRun(run: MemoryOrganizeRun, settings: AppSettings) {
  const workdir = settings.system.workdir.trim();
  const startedAt = Date.now();
  const tokens = { total: 0 };
  const stats = emptyStats();
  const report: OrganizeRunReportV4 = createEmptyRunReport();

  // --- scan -----------------------------------------------------------------
  await memoryOrganizeRunUpdate({ runId: run.runId, status: "running", startedAt, phase: "scan" });
  emitProgress(run, "scan");
  const quotaSummary = await memoryQuotaSummary({ workdir: workdir || undefined }).catch(
    () => null,
  );
  const ladder = deriveQuotaLadder(quotaSummary);
  const quotaHeadroomAtStart = ladder.tightestScope?.headroom;

  try {
    const metas = await listOrganizerEntries(run, workdir);
    const entries = await readOrganizerEntries(metas, workdir);
    stats.inputCount = entries.length;

    if (entries.length === 0) {
      const finalSummary = buildFinalSummary(stats);
      await memoryOrganizeRunUpdate({
        runId: run.runId,
        status: "skipped",
        finishedAt: Date.now(),
        finalSummary,
        inputCount: 0,
        clusterCount: 0,
        phase: "scan",
        quotaHeadroomAtStart,
        tokenUsageTotal: tokens.total,
        report,
      });
      emitEnded(run, "skipped", finalSummary);
      return;
    }

    // --- cluster --------------------------------------------------------------
    await memoryOrganizeRunUpdate({
      runId: run.runId,
      phase: "cluster",
      inputCount: stats.inputCount,
      quotaHeadroomAtStart,
    });
    emitProgress(run, "cluster", { inputCount: stats.inputCount });
    const clusterPlan = await buildOrganizerClusters({ entries, run, settings, workdir, tokens });
    const clusters = clusterPlan.clusters;
    stats.clusterCount = clusters.length;
    const clusterIdBySlug = new Map<string, string>();
    for (const cluster of clusters) {
      for (const entry of cluster.entries) {
        clusterIdBySlug.set(entry.slug, cluster.id);
      }
    }
    const globalInventory = buildGlobalInventory(entries, clusterIdBySlug);
    if (clusterPlan.rawMeta) {
      report.raw.push({ clusterId: "__topic_clustering__", text: clusterPlan.rawMeta });
    }
    report.compressionForecast = {
      from: entries.length,
      toMin: Math.max(0, Math.floor(entries.length * 0.6)),
      toMax: Math.max(0, Math.ceil(entries.length * 0.8)),
    };

    // --- plan -----------------------------------------------------------------
    await memoryOrganizeRunUpdate({
      runId: run.runId,
      phase: "plan",
      clusterCount: stats.clusterCount,
      tokenUsageTotal: tokens.total,
    });
    emitProgress(run, "plan", { inputCount: stats.inputCount, clusterCount: stats.clusterCount });
    const mode = normalizeOrganizerMode(run.mode);
    const parsedResults: ParsedClusterResult[] = [];
    for (const cluster of clusters) {
      try {
        const plan = await runOrganizerPlanPrompt({
          settings,
          run,
          prompt: buildClusterPrompt({
            trigger: run.trigger,
            mode,
            clusterId: cluster.id,
            entries: cluster.entries,
            globalInventory,
            compressionTarget: ladder.compressionTarget,
          }),
          workdir,
          tokens,
        });
        parsedResults.push({ cluster, plan });
        report.clusterSummaries.push(plan.summary);
        report.raw.push({ clusterId: cluster.id, text: plan.raw });
      } catch (error) {
        stats.parseFailures += 1;
        report.reviewItems.push({
          phase: "planning",
          kind: "error",
          severity: "error",
          message: `Cluster ${cluster.id} plan submission failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    if (parsedResults.length === 0 && stats.parseFailures > 0) {
      const message = `所有 ${stats.parseFailures} 个分组都未提交有效整理计划，已跳过本次写入。`;
      report.reviewItems.push({
        phase: "system",
        kind: "error",
        severity: "error",
        message,
      });
      const finalSummary = `本次记忆整理失败：${message}请重新运行或调整记忆整理模型。`;
      await memoryOrganizeDueComplete({
        runId: run.runId,
        status: "failed",
        finishedAt: Date.now(),
        inputCount: stats.inputCount,
        clusterCount: stats.clusterCount,
        parseFailures: stats.parseFailures,
        error: message,
        finalSummary,
        phase: "plan",
        quotaHeadroomAtStart,
        tokenUsageTotal: tokens.total,
        report,
      });
      emitEnded(run, "failed", finalSummary, message);
      return;
    }

    // --- gate -----------------------------------------------------------------
    await memoryOrganizeRunUpdate({ runId: run.runId, phase: "gate" });
    emitProgress(run, "gate", { inputCount: stats.inputCount, clusterCount: stats.clusterCount });
    const gated = buildDecisions(parsedResults, run);
    stats.reviewSkipped += gated.reviewSkipped;
    stats.mergedCount = gated.mergedCount;
    report.rejectionBuckets = gated.rejectionBuckets;
    report.reviewItems.push(...gated.reviewItems);

    // --- apply ----------------------------------------------------------------
    await memoryOrganizeRunUpdate({ runId: run.runId, phase: "apply" });
    emitProgress(run, "apply", { inputCount: stats.inputCount, clusterCount: stats.clusterCount });
    let batch: MemoryBatchResponse = { created: [], updated: [], deleted: [], warnings: [] };
    if (run.trigger === "manual") {
      stats.pendingSafeDecisions = gated.decisions.length;
      report.safeDecisions = gated.decisions;
      report.manualApplyState = {
        status: "pending",
        appliedDecisionKeys: [],
        failedDecisionKeys: [],
      };
    } else if (gated.decisions.length > 0) {
      batch = await memoryApplyBatch({
        workdir,
        trigger: "memory-organize",
        model: modelLabel(run, settings),
        decisions: gated.decisions,
      });
      stats.createdCount = batch.created.length;
      stats.updatedCount = batch.updated.length;
      stats.deletedCount = batch.deleted.length;
      stats.safeApplied = appliedBatchCount(batch);
      stats.reviewSkipped += batch.warnings.length;
      for (const warning of batch.warnings) {
        report.reviewItems.push({
          phase: "apply",
          kind: "error",
          severity: "error",
          message: warning,
        });
      }
    }

    const finalCount = Math.max(0, stats.inputCount - stats.deletedCount + stats.createdCount);
    const finalSummary = buildFinalSummary(stats);
    await memoryOrganizeDueComplete({
      runId: run.runId,
      status: "succeeded",
      finishedAt: Date.now(),
      inputCount: stats.inputCount,
      clusterCount: stats.clusterCount,
      safeApplied: stats.safeApplied,
      reviewSkipped: stats.reviewSkipped,
      createdCount: stats.createdCount,
      updatedCount: stats.updatedCount,
      deletedCount: stats.deletedCount,
      mergedCount: stats.mergedCount,
      parseFailures: stats.parseFailures,
      finalSummary,
      phase: "apply",
      finalCount,
      compressionRatio: stats.inputCount > 0 ? finalCount / stats.inputCount : undefined,
      compressionTarget: ladder.compressionTarget,
      quotaHeadroomAtStart,
      tokenUsageTotal: tokens.total,
      report,
    });
    emitEnded(run, "succeeded", finalSummary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finalSummary = `本次记忆整理失败：${message}`;
    await memoryOrganizeDueComplete({
      runId: run.runId,
      status: "failed",
      finishedAt: Date.now(),
      inputCount: stats.inputCount,
      clusterCount: stats.clusterCount,
      safeApplied: stats.safeApplied,
      reviewSkipped: stats.reviewSkipped,
      createdCount: stats.createdCount,
      updatedCount: stats.updatedCount,
      deletedCount: stats.deletedCount,
      mergedCount: stats.mergedCount,
      parseFailures: stats.parseFailures,
      error: message,
      finalSummary,
      quotaHeadroomAtStart,
      tokenUsageTotal: tokens.total,
      report,
    });
    emitEnded(run, "failed", finalSummary, message);
  }
}

/** 同一时刻只跑一次整理:run 记录的 claim 在 Rust 侧是原子的,这里再挡一道
 *  进程内的并发,避免同一进程被连续 poke 时抢自己的 API 配额。 */
let inFlight: Promise<void> | null = null;

/**
 * 受理一次已 claim 的整理 run:同步入队并立即返回(与 chat_send 同语义),
 * 终态从 memory_organize_ended 事件来。
 */
export function acceptOrganizerRun(run: MemoryOrganizeRun): {
  accepted: boolean;
  busy?: boolean;
} {
  if (!run?.runId) throw new Error("run.runId required");
  if (inFlight) return { accepted: false, busy: true };
  inFlight = (async () => {
    const { settings } = await loadPersistedSettingsWithDefaults();
    await executeOrganizerRun(run, settings);
  })()
    .catch((error) => {
      console.error(`[organizer] run failed for ${run.runId}:`, error);
    })
    .finally(() => {
      inFlight = null;
    });
  return { accepted: true };
}
