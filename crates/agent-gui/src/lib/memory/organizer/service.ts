// Organizer service: a plain TS engine that owns scheduling and run
// execution. Replaces the 1575-line headless React component and its
// window-CustomEvent bus. Scheduling is a single one-shot timer armed from
// organizerNextRunAt — nothing is armed while the organizer is disabled, and
// there is no mount-time forced claim: Run Now (poke) is the only entry then.

import type { Context, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { runAssistantWithTools } from "../../chat/runner/agentRunner";
import { createStreamDebugLogger } from "../../debug/agentDebug";
import { assistantMessageToText } from "../../providers/llm";
import {
  type AppSettings,
  computeNextMemoryOrganizerRunAt,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  findProviderModelConfig,
  isAgentDevMode,
} from "../../settings";
import { createMemoryTools } from "../../tools/memoryTools";
import {
  type MemoryBatchResponse,
  type MemoryOrganizeRun,
  memoryApplyBatch,
  memoryList,
  memoryOrganizeDueClaim,
  memoryOrganizeDueComplete,
  memoryOrganizeRunUpdate,
  memoryQuotaSummary,
  memoryRead,
} from "../api";
import { ORGANIZER_MAX_WAKE_DELAY_MS, ORGANIZER_RAW_PROTOCOL_CHARS } from "../config";
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

type SetSettings = (updater: (prev: AppSettings) => AppSettings) => void;

type OrganizerServiceDeps = {
  getSettings: () => AppSettings;
  setSettings: SetSettings;
};

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

function advanceScheduledOrganizer(run: MemoryOrganizeRun, setSettings: SetSettings) {
  if (run.trigger !== "scheduled") return;
  const now = Date.now();
  setSettings((prev) => {
    const organizerEnabled =
      prev.memory.organizerEnabled && prev.memory.organizerSchedule.frequency !== "none";
    const nextRunAt = organizerEnabled
      ? computeNextMemoryOrganizerRunAt(prev.memory.organizerSchedule, now + 1_000)
      : undefined;
    return {
      ...prev,
      memory: {
        ...prev.memory,
        organizerEnabled,
        organizerLastRunAt: now,
        organizerNextRunAt: nextRunAt,
      },
    };
  });
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
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      customHeaders: provider.customHeaders,
      requestFormat: provider.requestFormat,
      reasoning: DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning,
      promptCachingEnabled: true,
      nativeWebSearchEnabled: DEFAULT_CHAT_RUNTIME_CONTROLS.nativeWebSearchEnabled,
      useSystemProxy: provider.useSystemProxy,
      modelConfig: findProviderModelConfig(provider, model),
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

async function executeOrganizerRun(
  run: MemoryOrganizeRun,
  settings: AppSettings,
  setSettings: SetSettings,
) {
  const workdir = settings.system.workdir.trim();
  const startedAt = Date.now();
  const tokens = { total: 0 };
  const stats = emptyStats();
  const report: OrganizeRunReportV4 = createEmptyRunReport();

  // --- scan -----------------------------------------------------------------
  await memoryOrganizeRunUpdate({ runId: run.runId, status: "running", startedAt, phase: "scan" });
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
      await memoryOrganizeRunUpdate({
        runId: run.runId,
        status: "skipped",
        finishedAt: Date.now(),
        finalSummary: buildFinalSummary(stats),
        inputCount: 0,
        clusterCount: 0,
        phase: "scan",
        quotaHeadroomAtStart,
        tokenUsageTotal: tokens.total,
        report,
      });
      advanceScheduledOrganizer(run, setSettings);
      return;
    }

    // --- cluster --------------------------------------------------------------
    await memoryOrganizeRunUpdate({
      runId: run.runId,
      phase: "cluster",
      inputCount: stats.inputCount,
      quotaHeadroomAtStart,
    });
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
      await memoryOrganizeDueComplete({
        runId: run.runId,
        status: "failed",
        finishedAt: Date.now(),
        inputCount: stats.inputCount,
        clusterCount: stats.clusterCount,
        parseFailures: stats.parseFailures,
        error: message,
        finalSummary: `本次记忆整理失败：${message}请重新运行或调整记忆整理模型。`,
        phase: "plan",
        quotaHeadroomAtStart,
        tokenUsageTotal: tokens.total,
        report,
      });
      advanceScheduledOrganizer(run, setSettings);
      return;
    }

    // --- gate -----------------------------------------------------------------
    await memoryOrganizeRunUpdate({ runId: run.runId, phase: "gate" });
    const gated = buildDecisions(parsedResults, run);
    stats.reviewSkipped += gated.reviewSkipped;
    stats.mergedCount = gated.mergedCount;
    report.rejectionBuckets = gated.rejectionBuckets;
    report.reviewItems.push(...gated.reviewItems);

    // --- apply ----------------------------------------------------------------
    await memoryOrganizeRunUpdate({ runId: run.runId, phase: "apply" });
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
      finalSummary: buildFinalSummary(stats),
      phase: "apply",
      finalCount,
      compressionRatio: stats.inputCount > 0 ? finalCount / stats.inputCount : undefined,
      compressionTarget: ladder.compressionTarget,
      quotaHeadroomAtStart,
      tokenUsageTotal: tokens.total,
      report,
    });

    advanceScheduledOrganizer(run, setSettings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
      finalSummary: `本次记忆整理失败：${message}`,
      quotaHeadroomAtStart,
      tokenUsageTotal: tokens.total,
      report,
    });
    advanceScheduledOrganizer(run, setSettings);
  }
}

export type MemoryOrganizerService = {
  /** Re-arm the wake timer from current settings (call on settings change). */
  configure: () => void;
  /** Run Now / external trigger: claim and execute immediately. */
  poke: () => void;
  dispose: () => void;
};

export function createMemoryOrganizerService(deps: OrganizerServiceDeps): MemoryOrganizerService {
  let disposed = false;
  let running = false;
  let wakeTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearWake() {
    if (wakeTimeout === null) return;
    clearTimeout(wakeTimeout);
    wakeTimeout = null;
  }

  function scheduledDelayMs(): number | null {
    const current = deps.getSettings();
    if (!current.memory.organizerEnabled || current.memory.organizerSchedule.frequency === "none") {
      return null;
    }
    const dueAt = current.memory.organizerNextRunAt;
    if (typeof dueAt !== "number" || !Number.isFinite(dueAt) || dueAt <= 0) {
      return null;
    }
    return Math.max(0, dueAt - Date.now());
  }

  function scheduleNextWake() {
    clearWake();
    if (disposed) return;
    const delay = scheduledDelayMs();
    if (delay === null) return;
    wakeTimeout = setTimeout(() => void tick(false), Math.min(delay, ORGANIZER_MAX_WAKE_DELAY_MS));
  }

  async function tick(forceClaim: boolean) {
    if (disposed || running) return;
    const current = deps.getSettings();
    const model = current.memory.organizerModel;
    const delay = scheduledDelayMs();
    // Forced pokes (Run Now) always try to claim; otherwise only a due
    // schedule does. A disabled organizer never claims on its own.
    const shouldClaim =
      forceClaim ||
      delay === 0 ||
      (delay === null && current.memory.organizerEnabled && Boolean(model));
    if (!shouldClaim) {
      scheduleNextWake();
      return;
    }
    running = true;
    try {
      const claim = await memoryOrganizeDueClaim({
        enabled: current.memory.organizerEnabled,
        dueAt: current.memory.organizerNextRunAt,
        now: Date.now(),
        model,
        scope: current.memory.organizerScope,
        mode: current.memory.organizerMode,
      });
      if (claim.run) {
        if (claim.run.status === "skipped") {
          advanceScheduledOrganizer(claim.run, deps.setSettings);
        } else {
          await executeOrganizerRun(claim.run, current, deps.setSettings);
        }
      }
    } catch (error) {
      console.error("memory organizer service failed", error);
    } finally {
      running = false;
      scheduleNextWake();
    }
  }

  return {
    configure() {
      // Settings changed: re-arm the timer; claim only if already due.
      void tick(false);
    },
    poke() {
      void tick(true);
    },
    dispose() {
      disposed = true;
      clearWake();
    },
  };
}

// ---------------------------------------------------------------------------
// Module singleton so UI surfaces (Run Now button) can poke without prop
// drilling. The hook installs/uninstalls the instance.
// ---------------------------------------------------------------------------

let activeService: MemoryOrganizerService | null = null;

export function installMemoryOrganizerService(service: MemoryOrganizerService | null) {
  activeService = service;
}

/** Run Now entry. Returns false when no organizer runs in this frontend (the
 *  gateway web build ships a platform stub that always returns false). */
export function pokeMemoryOrganizer(): boolean {
  if (!activeService) return false;
  activeService.poke();
  return true;
}
