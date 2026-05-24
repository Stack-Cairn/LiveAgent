import { useEffect, useRef } from "react";
import { Type } from "@sinclair/typebox";
import type { Context, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

import { createStreamDebugLogger } from "../../lib/debug/agentDebug";
import { runAssistantWithTools } from "../../lib/chat/runner/agentRunner";
import { assistantMessageToText } from "../../lib/providers/llm";
import {
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  computeNextMemoryOrganizerRunAt,
  findProviderModelConfig,
  isAgentDevMode,
  type AppSettings,
  type MemoryOrganizerMode,
} from "../../lib/settings";
import {
  memoryApplyBatch,
  memoryList,
  memoryOrganizeDueClaim,
  memoryOrganizeDueComplete,
  memoryOrganizeRunUpdate,
  memoryRead,
  type MemoryBatchResponse,
  type MemoryMeta,
  type MemoryOrganizeRun,
  type MemoryType,
} from "../../lib/memory/api";
import { createMemoryTools } from "../../lib/tools/memoryTools";

type MemoryOrganizerRunnerProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
};

type OrganizerEntry = MemoryMeta & {
  body: string;
};

type OrganizerCluster = {
  id: string;
  entries: OrganizerEntry[];
};

type OrganizerPlanDecisionAction =
  | "keep"
  | "merge_into"
  | "delete"
  | "mark_review"
  | "rewrite_hint";

type OrganizerPlanDecision = {
  action: OrganizerPlanDecisionAction;
  slug?: string;
  targetSlug?: string;
  sourceSlugs: string[];
  riskLevel?: OrganizerRiskLevel;
  confidence?: number;
  reason: string;
  preservedEvidence: string[];
  descriptionHint?: string;
  rewriteGoal?: string;
};

type OrganizerClusterPlan = {
  raw: string;
  decisions: OrganizerPlanDecision[];
  summary: string;
  compression?: {
    before?: number;
    after?: number;
    deletions?: number;
  };
};

type ParsedClusterResult = {
  cluster: OrganizerCluster;
  plan: OrganizerClusterPlan;
};

type MemoryApplyDecision = NonNullable<Parameters<typeof memoryApplyBatch>[0]["decisions"]>[number];
type OrganizerRiskLevel = "low" | "medium" | "high";

type OrganizerApplyDecision = MemoryApplyDecision & {
  confidence?: number;
  riskLevel?: OrganizerRiskLevel;
  requiresUserAck?: boolean;
  sourceSlugs?: string[];
  evidencePreserved?: string[];
  blockedReasons?: string[];
  groupId?: string;
};

type OrganizerRejectionBuckets = {
  reviewedProtected: number;
  lowConfidence: number;
  crossType: number;
  crossScope: number;
  reviewRequiredByLlm: number;
  missingPayload: number;
  unsupported: number;
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

const MEMORY_ORGANIZER_EVENT = "liveagent:memory-organizer-poke";
const ORGANIZER_POLL_INTERVAL_MS = 15_000;
const ORGANIZER_BODY_EXCERPT_CHARS = 3_000;
const ORGANIZER_META_BODY_EXCERPT_CHARS = 600;
const ORGANIZER_CLUSTER_SIZE = 8;
const ORGANIZER_TOPIC_CLUSTER_SIZE = 12;
const ORGANIZER_RAW_PROTOCOL_CHARS = 4_000;
const ORGANIZER_GLOBAL_INVENTORY_CHARS = 8_000;
const ORGANIZER_TOOL_NAME = "SubmitMemoryOrganizePlan";
const ORGANIZER_TOPIC_TOOL_NAME = "SubmitMemoryTopicClusters";
const ORGANIZER_MEMORY_BODY_LIMIT_BYTES = 8 * 1024;

const MODE_DESCRIPTIONS: Record<MemoryOrganizerMode, string> = {
  conservative:
    "Only merge near-duplicates with semantic overlap >= 0.9. Same scope and same type are required. Reviewed entries default to keep. Emit at most 20% non-keep decisions.",
  standard:
    "Default mode. Merge clear semantic duplicates and rewrite redundant fragments. Same scope is required, but type may cross when one note clearly subsumes the other. Reviewed entries can be merged or rewritten when confidence >= 0.8 and evidence is preserved.",
  aggressive:
    "Actively consolidate topically related fragments. Cross-scope and cross-type merges are allowed when the unified note preserves all evidence. Reviewed entries can be merged, rewritten, or superseded. Emit at least 30% non-keep decisions when redundancy is visible.",
};

const ORGANIZER_SYSTEM_PROMPT = `# LiveAgent Memory Organizer

You are running an offline memory organization pass for LiveAgent.

You ONLY organize existing persistent memories supplied by the client. Do not extract new facts from conversations. Do not create facts from inference. Do not modify, merge, rewrite, or delete daily memories.

Use MemoryManager only in read-only mode when tools are available. Never call write, update, delete, accept, or apply tools. The client will validate and apply your plan.

You MUST submit the organization result by calling the ${ORGANIZER_TOOL_NAME} tool. Do not hand-write JSON, XML, Markdown protocol blocks, or replacement memory bodies in assistant text.

## Mode policy (CRITICAL)

The cluster prompt declares a Mode. Adjust behavior accordingly:

- conservative: only merge near-duplicates with semantic overlap >= 0.9; same scope AND same type required; reviewed entries default to keep; output <=20% of inventory as non-keep decisions.
- standard (DEFAULT): merge clear semantic duplicates and rewrite redundant fragments; same scope required, type may cross when one topic clearly subsumes another; reviewed entries CAN be merged/rewritten if confidence >= 0.8 AND evidence is preserved verbatim; output <=40% non-keep.
- aggressive: actively consolidate topically-related fragments; cross-scope and cross-type merges allowed when a unified note preserves all evidence; reviewed entries can be merged/rewritten/superseded; output >=30% non-keep when redundancy is visible. Stale low-confidence reviewed entries are deletion candidates.

If Mode is unspecified, treat it as standard.

## Confidence & risk scoring (REQUIRED on every non-keep decision)

Every non-keep decision MUST declare:
- confidence: 0.0-1.0
- risk_level: low | medium | high
- evidence_preserved: string[]

Risk hints:
- low: same scope, same type, all sources unreviewed OR confidence >= 0.9 with full evidence preservation.
- medium: crosses type, involves reviewed entries, or confidence is 0.7-0.9.
- high: deletes reviewed entries, crosses scope, drops source evidence, or confidence < 0.7.

The client maps risk_level to safety. Do NOT rely on safety alone; set risk_level honestly.

## Pruning policy

Organization is not only deduplication. In standard and aggressive mode, stale or low-value memories SHOULD be proposed for deletion or rewrite when evidence supports it:
- empty bodies, literal [] payloads, placeholder records, abandoned scratch data, or tool-owned state that should not live as durable memory
- memories whose core claim was later corrected or narrowed and no longer has enough independent durable value
- tiny fragments fully subsumed by a richer memory in the same topic

If the deletion touches a reviewed entry, keep all evidence in the target/reason and mark risk_level high so the client queues it for manual confirmation.

## Hard rules

1. Act only on slugs present in the current cluster input.
2. Preserve evidence verbatim: source_quote, reasoning, aliases, supersedes, conflicts_with, dates, names, numbers, confidence, and meaningful body details must not be lost.
3. Daily memories are immutable here. Skip them entirely.
4. For merge_into, provide only target_slug, source_slugs, risk_level, confidence, reason, and preserved_evidence. The client will synthesize the merged body from original source bodies.
5. Scheduled trigger: only low-risk decisions are auto-applied. Manual trigger: low and medium risk decisions are queued for user review.
6. If a rewrite needs a new full body, use rewrite_hint instead of writing the body. The client will handle rewrite as a separate review workflow.

## Required first step: GLOBAL META-ANALYSIS

Before per-cluster work, you receive a Global inventory block listing all clusters' slug/headline. In memory-organize-analysis, first emit a meta section with top cross-cluster consolidation candidates before local items.

## Required output: target compression ratio

Every tool submission summary must include compression data so the user can see expected reduction.`;

const TOPIC_CLUSTER_SYSTEM_PROMPT = `You are grouping existing LiveAgent memories for an offline organization pass.

Do not propose edits. Do not create, update, or delete memories. Only group supplied slugs by semantic topic so a later pass can compare related memories.

You MUST submit the grouping by calling the ${ORGANIZER_TOPIC_TOOL_NAME} tool. Do not hand-write JSON, XML, or Markdown protocol blocks in assistant text.`;

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter(Boolean)
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clampConfidence(value: unknown) {
  const number = numberValue(value);
  if (number == null) return undefined;
  return Math.max(0, Math.min(1, number));
}

function normalizeOrganizerMode(mode: string): MemoryOrganizerMode {
  if (mode === "conservative" || mode === "aggressive") return mode;
  return "standard";
}

function riskLevelValue(value: unknown): OrganizerRiskLevel | undefined {
  const normalized = stringValue(value).toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

function organizerActionValue(value: unknown): OrganizerPlanDecisionAction | undefined {
  const normalized = stringValue(value).toLowerCase();
  if (
    normalized === "keep" ||
    normalized === "merge_into" ||
    normalized === "delete" ||
    normalized === "mark_review" ||
    normalized === "rewrite_hint"
  ) {
    return normalized;
  }
  return undefined;
}

function optionalInteger(value: unknown) {
  const number = numberValue(value);
  return number == null ? undefined : Math.max(0, Math.floor(number));
}

function riskRank(value: OrganizerRiskLevel) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function maxRisk(
  current: OrganizerRiskLevel,
  next: OrganizerRiskLevel,
): OrganizerRiskLevel {
  return riskRank(next) > riskRank(current) ? next : current;
}

function isReviewed(entry: OrganizerEntry | undefined) {
  return Boolean(entry && !entry.unreviewed);
}

const ORGANIZER_PLAN_DECISION_SCHEMA = Type.Object({
  action: Type.Union([
    Type.Literal("keep"),
    Type.Literal("merge_into"),
    Type.Literal("delete"),
    Type.Literal("mark_review"),
    Type.Literal("rewrite_hint"),
  ], {
    description:
      "Decision action. Use merge_into to merge source_slugs into target_slug. Use rewrite_hint instead of emitting a replacement body.",
  }),
  slug: Type.Optional(
    Type.String({
      minLength: 3,
      description: "Existing slug for keep/delete/mark_review/rewrite_hint.",
    }),
  ),
  target_slug: Type.Optional(
    Type.String({
      minLength: 3,
      description: "Existing target slug for merge_into.",
    }),
  ),
  source_slugs: Type.Optional(
    Type.Array(Type.String({ minLength: 3 }), {
      maxItems: ORGANIZER_TOPIC_CLUSTER_SIZE,
      description: "Existing source slugs to merge into target_slug.",
    }),
  ),
  risk_level: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  ),
  confidence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Confidence from 0.0 to 1.0.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      maxLength: 1200,
      description: "Short reason for this decision. Do not include full memory bodies.",
    }),
  ),
  preserved_evidence: Type.Optional(
    Type.Array(Type.String({ maxLength: 400 }), {
      maxItems: 24,
      description:
        "Evidence snippets, dates, names, source_quote labels, or facts the client must preserve.",
    }),
  ),
  description_hint: Type.Optional(
    Type.String({
      maxLength: 160,
      description: "Optional description for the merged target memory.",
    }),
  ),
  rewrite_goal: Type.Optional(
    Type.String({
      maxLength: 800,
      description: "For rewrite_hint only: what should be rewritten later.",
    }),
  ),
});

const ORGANIZER_PLAN_TOOL: Tool = {
  name: ORGANIZER_TOOL_NAME,
  description:
    "Submit the memory organization plan. Do not include full replacement memory bodies; the client preserves bodies and applies validated decisions.",
  parameters: Type.Object({
    summary: Type.Optional(
      Type.String({
        maxLength: 600,
        description: "Chinese summary for this cluster, 200 Chinese characters preferred.",
      }),
    ),
    compression: Type.Optional(
      Type.Object({
        before: Type.Optional(Type.Integer({ minimum: 0 })),
        after: Type.Optional(Type.Integer({ minimum: 0 })),
        deletions: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
    ),
    decisions: Type.Array(ORGANIZER_PLAN_DECISION_SCHEMA, {
      description: "Organization decisions for slugs in the current cluster.",
    }),
  }),
};

const ORGANIZER_TOPIC_TOOL: Tool = {
  name: ORGANIZER_TOPIC_TOOL_NAME,
  description:
    "Submit semantic topic clusters for memory organization. Do not propose edits.",
  parameters: Type.Object({
    topic_clusters: Type.Array(
      Type.Object({
        topic: Type.String({ minLength: 1, maxLength: 120 }),
        slugs: Type.Array(Type.String({ minLength: 3 }), {
          maxItems: ORGANIZER_TOPIC_CLUSTER_SIZE,
        }),
        suspected_duplicate: Type.Optional(Type.Boolean()),
        target_action_hint: Type.Optional(
          Type.Union([
            Type.Literal("merge"),
            Type.Literal("rewrite"),
            Type.Literal("delete"),
            Type.Literal("review"),
            Type.Literal("keep"),
          ]),
        ),
      }),
    ),
    target_total_after: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
};

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function organizerMergeGroupId(clusterId: string, target: string, sources: string[]) {
  return `merge:${clusterId}:${target}:${sources.slice().sort().join("+")}`;
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

function scopeMatchesRun(entry: MemoryMeta, run: MemoryOrganizeRun, workdir: string) {
  if (entry.memoryType === "daily") return false;
  if (run.scope === "global") return entry.scope === "global";
  if (run.scope === "projects") return entry.scope === "project";
  if (run.scope === "current-project") {
    return entry.scope === "project" && Boolean(workdir) && entry.workdirPath === workdir;
  }
  return entry.scope === "global" || entry.scope === "project";
}

async function listOrganizerEntries(run: MemoryOrganizeRun, workdir: string) {
  const entries: MemoryMeta[] = [];
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

async function readOrganizerEntries(entries: MemoryMeta[], workdir: string) {
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

function buildStructuralClusters(entries: OrganizerEntry[]): OrganizerCluster[] {
  const groups = new Map<string, OrganizerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.scope}:${entry.workdirHash || ""}:${entry.memoryType}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const clusters: OrganizerCluster[] = [];
  for (const [key, group] of groups) {
    const sorted = group.sort((a, b) =>
      a.slug.localeCompare(b.slug) || b.updatedAt - a.updatedAt,
    );
    for (let index = 0; index < sorted.length; index += ORGANIZER_CLUSTER_SIZE) {
      clusters.push({
        id: `${key}:${Math.floor(index / ORGANIZER_CLUSTER_SIZE) + 1}`,
        entries: sorted.slice(index, index + ORGANIZER_CLUSTER_SIZE),
      });
    }
  }
  return clusters;
}

function buildMetaClusterPrompt(entries: OrganizerEntry[]) {
  const items = entries.map((entry) => ({
    slug: entry.slug,
    scope: entry.scope,
    workdir_hash: entry.workdirHash || "",
    type: entry.memoryType,
    headline: entry.headline,
    description: entry.description,
    unreviewed: entry.unreviewed,
    confidence: entry.confidence,
    body_excerpt: clip(entry.body, ORGANIZER_META_BODY_EXCERPT_CHARS),
  }));
  return [
    `Inventory count: ${entries.length}`,
    `Max slugs per topic cluster: ${ORGANIZER_TOPIC_CLUSTER_SIZE}`,
    "",
    "Group memories by semantic topic, not by scope/type. Cross-scope and cross-type groups are allowed.",
    "Prefer grouping likely duplicates, overlapping profiles, broad notes that subsume narrow notes, and stale fragments that should be compared together.",
    "Every input slug should appear at most once. Leave unrelated singleton slugs out; the client will place them in fallback clusters.",
    "",
    "Inventory:",
    JSON.stringify({ items }, null, 2),
    "",
    `Call ${ORGANIZER_TOPIC_TOOL_NAME} with topic_clusters. Do not write protocol text.`,
  ].join("\n");
}

function buildTopicClustersFromArgs(args: Record<string, unknown>, entries: OrganizerEntry[]) {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const used = new Set<string>();
  const topicClusters = Array.isArray(args.topic_clusters)
    ? args.topic_clusters
    : Array.isArray(args.items)
      ? args.items
      : [];
  const clusters: OrganizerCluster[] = [];
  for (const item of topicClusters) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const topic = stringValue((item as { topic?: unknown }).topic) || `topic-${clusters.length + 1}`;
    const slugs = uniqueStrings(stringArrayValue((item as { slugs?: unknown }).slugs))
      .filter((slug) => bySlug.has(slug) && !used.has(slug))
      .slice(0, ORGANIZER_TOPIC_CLUSTER_SIZE);
    if (slugs.length < 2) continue;
    for (const slug of slugs) used.add(slug);
    clusters.push({
      id: `topic:${topic.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || clusters.length + 1}`,
      entries: slugs.map((slug) => bySlug.get(slug)).filter((entry): entry is OrganizerEntry => Boolean(entry)),
    });
  }
  const leftovers = entries.filter((entry) => !used.has(entry.slug));
  return [...clusters, ...buildStructuralClusters(leftovers)];
}

async function buildOrganizerClusters(params: {
  entries: OrganizerEntry[];
  run: MemoryOrganizeRun;
  settings: AppSettings;
  workdir: string;
}) {
  if (params.entries.length <= ORGANIZER_CLUSTER_SIZE) {
    return { clusters: buildStructuralClusters(params.entries), rawMeta: "" };
  }
  try {
    const topicPlan = await runTopicClusterPrompt({
      settings: params.settings,
      run: params.run,
      prompt: buildMetaClusterPrompt(params.entries),
      systemPrompt: TOPIC_CLUSTER_SYSTEM_PROMPT,
      workdir: params.workdir,
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

function buildGlobalInventory(entries: OrganizerEntry[], clusters: OrganizerCluster[]) {
  const clusterBySlug = new Map<string, string>();
  for (const cluster of clusters) {
    for (const entry of cluster.entries) {
      clusterBySlug.set(entry.slug, cluster.id);
    }
  }
  const inventory = entries
    .slice()
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.memoryType.localeCompare(b.memoryType) || a.slug.localeCompare(b.slug))
    .map((entry) => ({
      slug: entry.slug,
      cluster_id: clusterBySlug.get(entry.slug) || "",
      scope: entry.scope,
      workdir_hash: entry.workdirHash || "",
      type: entry.memoryType,
      headline: entry.headline,
      description: entry.description,
      unreviewed: entry.unreviewed,
      confidence: entry.confidence,
    }));
  return clip(JSON.stringify({ items: inventory }, null, 2), ORGANIZER_GLOBAL_INVENTORY_CHARS);
}

function buildClusterPrompt(
  run: MemoryOrganizeRun,
  cluster: OrganizerCluster,
  globalInventory: string,
) {
  const mode = normalizeOrganizerMode(run.mode);
  const memories = cluster.entries
    .map((entry) =>
      [
        "---",
        `slug: ${entry.slug}`,
        `scope: ${entry.scope}`,
        `workdir_hash: ${entry.workdirHash || ""}`,
        `workdir_path: ${entry.workdirPath || ""}`,
        `type: ${entry.memoryType}`,
        `description: ${entry.description}`,
        `headline: ${entry.headline}`,
        `unreviewed: ${entry.unreviewed ? "true" : "false"}`,
        `confidence: ${entry.confidence}`,
        `updated_at: ${entry.updatedAt}`,
        "body_excerpt:",
        clip(entry.body, ORGANIZER_BODY_EXCERPT_CHARS),
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `Local date: ${new Date().toISOString().slice(0, 10)}`,
    `Trigger: ${run.trigger}`,
    `Mode: ${mode}`,
    `Mode behavior reminder: ${MODE_DESCRIPTIONS[mode]}`,
    "Scope policy: organize ordinary global and project memories only; daily entries are excluded.",
    "Scheduled policy: if trigger is scheduled, only low-risk conservative actions may be applied.",
    "Manual policy: low-risk suggestions are selected by default in the review UI; medium/high-risk suggestions must carry risk_level and confidence so the user can explicitly confirm them.",
    "",
    "Global inventory (read-only context; use it to spot cross-cluster duplicate topics, but act only on current cluster slugs):",
    globalInventory,
    "",
    "Cluster:",
    `- cluster_id: ${cluster.id}`,
    `- scope_group: ${cluster.id.split(":").slice(0, 2).join(":")}`,
    `- memory_count: ${cluster.entries.length}`,
    "",
    "Memories:",
    memories,
    "",
    `Call ${ORGANIZER_TOOL_NAME} with decisions for this cluster.`,
    "Decision contract:",
    "- Use action=keep for memories that should remain unchanged.",
    "- Use action=merge_into with target_slug and source_slugs when sources are redundant and should be deleted after target is updated.",
    "- Use action=delete for stale/empty/low-value memories that do not need to be merged.",
    "- Use action=mark_review for risky ideas that should not be applied automatically.",
    "- Use action=rewrite_hint when a memory needs a future rewrite; do not include replacement body.",
    "- Never include full memory bodies in tool arguments.",
    "- Always include risk_level, confidence, reason, and preserved_evidence for non-keep decisions.",
  ].join("\n");
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

function normalizeOrganizerPlanArgs(args: Record<string, unknown>): Omit<OrganizerClusterPlan, "raw"> {
  const decisions = Array.isArray(args.decisions) ? args.decisions : [];
  const normalized: OrganizerPlanDecision[] = [];
  for (const item of decisions) {
    const obj = recordValue(item);
    const action = organizerActionValue(obj.action);
    if (!action) continue;
    normalized.push({
      action,
      slug: stringValue(obj.slug),
      targetSlug: stringValue(obj.target_slug) || stringValue(obj.targetSlug),
      sourceSlugs: uniqueStrings(
        stringArrayValue(obj.source_slugs).length
          ? stringArrayValue(obj.source_slugs)
          : stringArrayValue(obj.sourceSlugs),
      ),
      riskLevel: riskLevelValue(obj.risk_level) || riskLevelValue(obj.riskLevel),
      confidence: clampConfidence(obj.confidence),
      reason: stringValue(obj.reason),
      preservedEvidence: uniqueStrings(
        stringArrayValue(obj.preserved_evidence).length
          ? stringArrayValue(obj.preserved_evidence)
          : stringArrayValue(obj.preservedEvidence),
      ),
      descriptionHint: stringValue(obj.description_hint) || stringValue(obj.descriptionHint),
      rewriteGoal: stringValue(obj.rewrite_goal) || stringValue(obj.rewriteGoal),
    });
  }
  const compression = recordValue(args.compression);
  return {
    decisions: normalized,
    summary: stringValue(args.summary) || "本 cluster 已完成整理分析。",
    compression: {
      before: optionalInteger(compression.before),
      after: optionalInteger(compression.after),
      deletions: optionalInteger(compression.deletions),
    },
  };
}

async function runOrganizerModelPrompt(params: {
  settings: AppSettings;
  run: MemoryOrganizeRun;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  tools: Context["tools"];
  executeToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
  ) => Promise<ToolResultMessage>;
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
      requestFormat: provider.requestFormat,
      reasoning: DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning,
      promptCachingEnabled: true,
      nativeWebSearchEnabled: DEFAULT_CHAT_RUNTIME_CONTROLS.nativeWebSearchEnabled,
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
  return assistantMessageToText(result.assistant).trim();
}

async function runTopicClusterPrompt(params: {
  settings: AppSettings;
  run: MemoryOrganizeRun;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  signal?: AbortSignal;
}) {
  let submittedArgs: Record<string, unknown> | null = null;
  const rawText = await runOrganizerModelPrompt({
    ...params,
    tools: [ORGANIZER_TOPIC_TOOL],
    async executeToolCall(toolCall) {
      if (toolCall.name !== ORGANIZER_TOPIC_TOOL_NAME) {
        return toolResultMessage(toolCall, `Unknown tool: ${toolCall.name}`, {}, true);
      }
      submittedArgs = recordValue(toolCall.arguments);
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
    raw: clip(
      [
        rawText,
        "",
        `[${ORGANIZER_TOPIC_TOOL_NAME}]`,
        JSON.stringify(submittedArgs, null, 2),
      ]
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
  systemPrompt: string;
  workdir: string;
  signal?: AbortSignal;
}) {
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
    tools: [ORGANIZER_PLAN_TOOL, ...memoryBundle.tools],
    async executeToolCall(toolCall, signal) {
      if (toolCall.name === ORGANIZER_TOOL_NAME) {
        captured.args = recordValue(toolCall.arguments);
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
    throw new Error(`${ORGANIZER_TOOL_NAME} was not called`);
  }
  const plan = captured.plan;
  return {
    decisions: plan.decisions,
    summary: plan.summary,
    compression: plan.compression,
    raw: clip(
      [
        rawText,
        "",
        `[${ORGANIZER_TOOL_NAME}]`,
        JSON.stringify(captured.args ?? plan, null, 2),
      ]
        .filter((part) => part.trim().length > 0)
        .join("\n"),
      ORGANIZER_RAW_PROTOCOL_CHARS,
    ),
  };
}

function emptyRejectionBuckets(): OrganizerRejectionBuckets {
  return {
    reviewedProtected: 0,
    lowConfidence: 0,
    crossType: 0,
    crossScope: 0,
    reviewRequiredByLlm: 0,
    missingPayload: 0,
    unsupported: 0,
  };
}

function incrementBucket(
  buckets: OrganizerRejectionBuckets,
  key: keyof OrganizerRejectionBuckets,
) {
  buckets[key] += 1;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function synthesizeBodyFromSources(
  targetEntry: OrganizerEntry,
  sourceEntries: OrganizerEntry[],
  reason: string,
  evidence: string[] = [],
) {
  const sourceOnly = sourceEntries.filter((entry) => entry.slug !== targetEntry.slug);
  const sections = [
    targetEntry.body.trim(),
    "",
    "## Organizer merge",
    `Merged at: ${new Date().toISOString()}`,
    `Merged from: ${sourceOnly.map((entry) => entry.slug).join(", ") || "none"}`,
    reason ? `Reason: ${reason}` : "",
    evidence.length > 0
      ? ["", "Preserved evidence:", ...evidence.map((item) => `- ${item}`)].join("\n")
      : "",
    ...sourceOnly.map((entry) =>
      [
        "",
        `### Source: ${entry.slug}`,
        `description: ${entry.description}`,
        `headline: ${entry.headline}`,
        `confidence: ${entry.confidence}`,
        "",
        entry.body.trim(),
      ].join("\n"),
    ),
  ];
  return sections.filter((part) => part.trim().length > 0).join("\n");
}

function deriveClientRisk(params: {
  action: string;
  llmRisk?: OrganizerRiskLevel;
  confidence?: number;
  targetEntry: OrganizerEntry;
  sourceEntries: OrganizerEntry[];
}) {
  const reasons: string[] = [];
  let risk: OrganizerRiskLevel = params.llmRisk || "medium";

  if (params.confidence == null) {
    risk = maxRisk(risk, "medium");
    reasons.push("missing_confidence");
  } else if (params.confidence < 0.7) {
    risk = "high";
    reasons.push("low_confidence");
  } else if (params.confidence < 0.9) {
    risk = maxRisk(risk, "medium");
  }
  if (params.sourceEntries.some((entry) => entry.scope !== params.targetEntry.scope)) {
    risk = "high";
    reasons.push("cross_scope");
  }
  if (params.sourceEntries.some((entry) => entry.memoryType !== params.targetEntry.memoryType)) {
    risk = maxRisk(risk, "medium");
    reasons.push("cross_type");
  }
  if (params.sourceEntries.some(isReviewed) || isReviewed(params.targetEntry)) {
    risk = maxRisk(risk, "medium");
    reasons.push("reviewed_entries");
  }
  if (params.action === "delete" && isReviewed(params.targetEntry)) {
    risk = "high";
    reasons.push("delete_reviewed");
  }
  return { risk, reasons: uniqueStrings(reasons) };
}

function shouldQueueOrganizerDecision(params: {
  trigger: MemoryOrganizeRun["trigger"];
  mode: MemoryOrganizerMode;
  risk: OrganizerRiskLevel;
  confidence?: number;
  action: string;
  reasons: string[];
}) {
  const confidence = params.confidence ?? 0.8;
  if (params.trigger === "scheduled") {
    return params.risk === "low" && confidence >= 0.8;
  }
  if (params.risk === "low") return confidence >= 0.6;
  if (params.risk === "medium") {
    if (params.mode === "conservative") return false;
    return confidence >= 0.8;
  }
  if (
    params.trigger === "manual" &&
    params.action === "delete" &&
    params.mode !== "conservative" &&
    confidence >= 0.85 &&
    params.reasons.includes("delete_reviewed") &&
    !params.reasons.includes("cross_scope") &&
    !params.reasons.includes("cross_type")
  ) {
    return true;
  }
  if (params.mode !== "aggressive" || confidence < 0.85) return false;
  return (
    params.action === "delete" ||
    params.reasons.includes("delete_reviewed") ||
    params.reasons.includes("cross_scope")
  );
}

function addRejectionBucketForReasons(
  buckets: OrganizerRejectionBuckets,
  reasons: string[],
) {
  if (reasons.includes("review_required_by_llm")) {
    incrementBucket(buckets, "reviewRequiredByLlm");
  }
  if (reasons.includes("low_confidence") || reasons.includes("missing_confidence")) {
    incrementBucket(buckets, "lowConfidence");
  }
  if (reasons.includes("cross_type")) {
    incrementBucket(buckets, "crossType");
  }
  if (reasons.includes("cross_scope")) {
    incrementBucket(buckets, "crossScope");
  }
  if (reasons.includes("reviewed_entries") || reasons.includes("delete_reviewed")) {
    incrementBucket(buckets, "reviewedProtected");
  }
}

function buildSafeDecisions(results: ParsedClusterResult[], run: MemoryOrganizeRun) {
  const mode = normalizeOrganizerMode(run.mode);
  const decisions: OrganizerApplyDecision[] = [];
  let reviewSkipped = 0;
  let mergedCount = 0;
  const rejectionBuckets = emptyRejectionBuckets();
  const reviewNotes: string[] = [];

  for (const { cluster, plan } of results) {
    const bySlug = new Map<string, OrganizerEntry>();
    for (const entry of cluster.entries) {
      bySlug.set(entry.slug, entry);
    }

    for (const item of plan.decisions) {
      if (item.action === "keep") continue;

      if (item.action === "mark_review" || item.action === "rewrite_hint") {
        reviewSkipped += 1;
        incrementBucket(rejectionBuckets, "reviewRequiredByLlm");
        const slugText = item.slug || item.targetSlug || item.sourceSlugs.join(", ");
        reviewNotes.push(
          `${cluster.id}: ${item.action} ${slugText || "(unknown)"} - ${item.reason || item.rewriteGoal || "needs review"}`,
        );
        continue;
      }

      const confidence = item.confidence;
      const evidencePreserved = item.preservedEvidence;
      const reason = item.reason;

      if (item.action === "delete") {
        const slug = item.slug || item.targetSlug;
        const deleteEntry = slug ? bySlug.get(slug) : undefined;
        if (!deleteEntry || deleteEntry.memoryType === "daily") {
          reviewSkipped += 1;
          incrementBucket(rejectionBuckets, "unsupported");
          continue;
        }
        const risk = deriveClientRisk({
          action: "delete",
          llmRisk: item.riskLevel,
          confidence,
          targetEntry: deleteEntry,
          sourceEntries: [deleteEntry],
        });
        if (
          !shouldQueueOrganizerDecision({
            trigger: run.trigger,
            mode,
            risk: risk.risk,
            confidence,
            action: "delete",
            reasons: risk.reasons,
          })
        ) {
          reviewSkipped += 1;
          addRejectionBucketForReasons(rejectionBuckets, risk.reasons);
          continue;
        }
        decisions.push({
          op: "delete",
          slug: deleteEntry.slug,
          scope: deleteEntry.scope,
          workdirHash: deleteEntry.scope === "project" ? deleteEntry.workdirHash : undefined,
          reason: reason || "memory organizer delete",
          confidence,
          riskLevel: risk.risk,
          requiresUserAck: risk.risk !== "low" || isReviewed(deleteEntry),
          sourceSlugs: [deleteEntry.slug],
          evidencePreserved,
          blockedReasons: risk.reasons,
        });
        continue;
      }

      if (item.action === "merge_into") {
        const target = item.targetSlug || item.slug;
        const targetEntry = target ? bySlug.get(target) : undefined;
        const sourceSlugs = uniqueStrings(item.sourceSlugs.filter((source) => source !== target));
        const sourceEntries = sourceSlugs
          .map((sourceSlug) => bySlug.get(sourceSlug))
          .filter((entry): entry is OrganizerEntry => Boolean(entry));
        if (
          !targetEntry ||
          targetEntry.memoryType === "daily" ||
          sourceSlugs.length === 0 ||
          sourceEntries.length !== sourceSlugs.length
        ) {
          reviewSkipped += 1;
          incrementBucket(rejectionBuckets, "unsupported");
          continue;
        }
        const risk = deriveClientRisk({
          action: "merge",
          llmRisk: item.riskLevel,
          confidence,
          targetEntry,
          sourceEntries: [targetEntry, ...sourceEntries],
        });
        if (
          !shouldQueueOrganizerDecision({
            trigger: run.trigger,
            mode,
            risk: risk.risk,
            confidence,
            action: "merge",
            reasons: risk.reasons,
          })
        ) {
          reviewSkipped += 1;
          addRejectionBucketForReasons(rejectionBuckets, risk.reasons);
          continue;
        }
          const description = item.descriptionHint || targetEntry.description;
          const body = synthesizeBodyFromSources(
            targetEntry,
            [targetEntry, ...sourceEntries],
            reason,
            evidencePreserved,
          );
          const groupId = organizerMergeGroupId(cluster.id, targetEntry.slug, [
            targetEntry.slug,
            ...sourceSlugs,
          ]);
          if (utf8ByteLength(body) > ORGANIZER_MEMORY_BODY_LIMIT_BYTES) {
            reviewSkipped += 1;
            incrementBucket(rejectionBuckets, "missingPayload");
            reviewNotes.push(
              `${cluster.id}: merge_into ${targetEntry.slug} - merged body exceeds ${ORGANIZER_MEMORY_BODY_LIMIT_BYTES} bytes; skipped automatic apply and requires a shorter manual rewrite.`,
            );
            continue;
          }
          decisions.push({
            op: "upsert",
            slug: targetEntry.slug,
            scope: targetEntry.scope,
            workdirHash: targetEntry.scope === "project" ? targetEntry.workdirHash : undefined,
          memoryType: targetEntry.memoryType as MemoryType,
          description,
          body,
          reason: reason || "memory organizer update",
          confidence,
          riskLevel: risk.risk,
            requiresUserAck:
              risk.risk !== "low" ||
              sourceEntries.some(isReviewed) ||
              isReviewed(targetEntry) ||
              risk.reasons.includes("cross_type") ||
              risk.reasons.includes("cross_scope"),
            sourceSlugs: [targetEntry.slug, ...sourceSlugs],
            evidencePreserved,
            blockedReasons: risk.reasons,
            groupId,
          });
          for (const sourceEntry of sourceEntries) {
          if (sourceEntry.memoryType === "daily") {
            reviewSkipped += 1;
            incrementBucket(rejectionBuckets, "unsupported");
            continue;
          }
          const deleteRisk = deriveClientRisk({
            action: "delete",
            llmRisk: risk.risk,
            confidence,
            targetEntry: sourceEntry,
            sourceEntries: [sourceEntry, targetEntry],
          });
          if (
            !shouldQueueOrganizerDecision({
              trigger: run.trigger,
              mode,
              risk: deleteRisk.risk,
              confidence,
              action: "delete",
              reasons: deleteRisk.reasons,
            })
          ) {
            reviewSkipped += 1;
            addRejectionBucketForReasons(rejectionBuckets, deleteRisk.reasons);
            continue;
          }
            decisions.push({
              op: "delete",
              slug: sourceEntry.slug,
            scope: sourceEntry.scope,
            workdirHash: sourceEntry.scope === "project" ? sourceEntry.workdirHash : undefined,
            reason: `merged into ${targetEntry.slug}`,
            confidence,
            riskLevel: deleteRisk.risk,
            requiresUserAck:
              deleteRisk.risk !== "low" ||
              isReviewed(sourceEntry) ||
              deleteRisk.reasons.includes("cross_type") ||
              deleteRisk.reasons.includes("cross_scope"),
              sourceSlugs: [sourceEntry.slug, targetEntry.slug],
              evidencePreserved,
              blockedReasons: deleteRisk.reasons,
              groupId,
            });
          mergedCount += 1;
        }
      }
    }
  }
  return { decisions, reviewSkipped, mergedCount, rejectionBuckets, reviewNotes };
}

function buildFallbackSummary(stats: OrganizerStats) {
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

function appliedBatchCount(batch: MemoryBatchResponse) {
  return batch.created.length + batch.updated.length + batch.deleted.length;
}

function advanceScheduledOrganizer(
  run: MemoryOrganizeRun,
  setSettings: MemoryOrganizerRunnerProps["setSettings"],
) {
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

function buildFinalSummary(stats: OrganizerStats) {
  return buildFallbackSummary(stats);
}

async function executeOrganizerRun(
  run: MemoryOrganizeRun,
  settings: AppSettings,
  setSettings: MemoryOrganizerRunnerProps["setSettings"],
) {
  const workdir = settings.system.workdir.trim();
  const startedAt = Date.now();
  await memoryOrganizeRunUpdate({ runId: run.runId, status: "running", startedAt });
  const stats: OrganizerStats = {
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
  const trimmedProtocol: {
    clusterSummaries: string[];
    reviewNotes: string[];
    raw: Array<{ clusterId: string; text: string }>;
    safeDecisions?: OrganizerApplyDecision[];
    rejectionBuckets?: OrganizerRejectionBuckets;
    compressionForecast?: { from: number; toMin: number; toMax: number };
    manualApplyState?: {
      status: "pending" | "applied";
      appliedAt?: number;
      appliedDecisionKeys?: string[];
    };
  } = { clusterSummaries: [], reviewNotes: [], raw: [] };

  try {
    const metas = await listOrganizerEntries(run, workdir);
    const entries = await readOrganizerEntries(metas, workdir);
    const clusterPlan = await buildOrganizerClusters({ entries, run, settings, workdir });
    const clusters = clusterPlan.clusters;
    const globalInventory = buildGlobalInventory(entries, clusters);
    stats.inputCount = entries.length;
    stats.clusterCount = clusters.length;
    if (clusterPlan.rawMeta) {
      trimmedProtocol.raw.push({
        clusterId: "__topic_clustering__",
        text: clip(clusterPlan.rawMeta, ORGANIZER_RAW_PROTOCOL_CHARS),
      });
    }
    trimmedProtocol.compressionForecast = {
      from: entries.length,
      toMin: Math.max(0, Math.floor(entries.length * 0.6)),
      toMax: Math.max(0, Math.ceil(entries.length * 0.8)),
    };
    if (entries.length === 0) {
      const finalSummary = buildFallbackSummary(stats);
      await memoryOrganizeRunUpdate({
        runId: run.runId,
        status: "skipped",
        finishedAt: Date.now(),
        finalSummary,
        inputCount: 0,
        clusterCount: 0,
        trimmedProtocol,
      });
      advanceScheduledOrganizer(run, setSettings);
      return;
    }

    const parsedResults: ParsedClusterResult[] = [];
    for (const cluster of clusters) {
      try {
        const plan = await runOrganizerPlanPrompt({
          settings,
          run,
          prompt: buildClusterPrompt(run, cluster, globalInventory),
          systemPrompt: ORGANIZER_SYSTEM_PROMPT,
          workdir,
        });
        parsedResults.push({ cluster, plan });
        trimmedProtocol.clusterSummaries.push(plan.summary);
        trimmedProtocol.raw.push({
          clusterId: cluster.id,
          text: clip(plan.raw, ORGANIZER_RAW_PROTOCOL_CHARS),
        });
      } catch (error) {
        stats.parseFailures += 1;
        trimmedProtocol.reviewNotes.push(
          `Cluster ${cluster.id} plan submission failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (parsedResults.length === 0 && stats.parseFailures > 0) {
      const message = `所有 ${stats.parseFailures} 个分组都未提交有效整理计划，已跳过本次写入。`;
      trimmedProtocol.reviewNotes.push(message);
      await memoryOrganizeDueComplete({
        runId: run.runId,
        status: "failed",
        finishedAt: Date.now(),
        inputCount: stats.inputCount,
        clusterCount: stats.clusterCount,
        safeApplied: 0,
        reviewSkipped: stats.reviewSkipped,
        createdCount: 0,
        updatedCount: 0,
        deletedCount: 0,
        mergedCount: 0,
        parseFailures: stats.parseFailures,
        error: message,
        finalSummary: `本次记忆整理失败：${message}请重新运行或调整记忆整理模型。`,
        trimmedProtocol,
      });
      advanceScheduledOrganizer(run, setSettings);
      return;
    }

    const safe = buildSafeDecisions(parsedResults, run);
    stats.reviewSkipped += safe.reviewSkipped;
    stats.mergedCount = safe.mergedCount;
    trimmedProtocol.rejectionBuckets = safe.rejectionBuckets;
    if (safe.reviewNotes.length > 0) {
      trimmedProtocol.reviewNotes.push(...safe.reviewNotes);
    }
    let batch: MemoryBatchResponse = { created: [], updated: [], deleted: [], warnings: [] };
    if (run.trigger === "manual") {
      stats.pendingSafeDecisions = safe.decisions.length;
      trimmedProtocol.safeDecisions = safe.decisions;
      trimmedProtocol.manualApplyState = { status: "pending" };
    } else if (safe.decisions.length > 0) {
      batch = await memoryApplyBatch({
        workdir,
        trigger: "memory-organize",
        model: modelLabel(run, settings),
        decisions: safe.decisions,
      });
      stats.createdCount = batch.created.length;
      stats.updatedCount = batch.updated.length;
      stats.deletedCount = batch.deleted.length;
      stats.safeApplied = appliedBatchCount(batch);
      stats.reviewSkipped += batch.warnings.length;
      if (batch.warnings.length > 0) {
        trimmedProtocol.reviewNotes.push(...batch.warnings);
      }
    }

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
      trimmedProtocol,
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
      trimmedProtocol,
    });
    advanceScheduledOrganizer(run, setSettings);
  }
}

export function pokeMemoryOrganizerRunner() {
  if (typeof window === "undefined") {
    return false;
  }
  window.dispatchEvent(new CustomEvent(MEMORY_ORGANIZER_EVENT));
  return true;
}

export function MemoryOrganizerRunner({ settings, setSettings }: MemoryOrganizerRunnerProps) {
  const settingsRef = useRef(settings);
  const runningRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled || runningRef.current) return;
      const current = settingsRef.current;
      const model = current.memory.organizerModel;
      runningRef.current = true;
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
            advanceScheduledOrganizer(claim.run, setSettings);
          } else {
            await executeOrganizerRun(claim.run, current, setSettings);
          }
        }
      } catch (error) {
        console.error("memory organizer runner failed", error);
      } finally {
        runningRef.current = false;
      }
    }

    const interval = window.setInterval(() => void tick(), ORGANIZER_POLL_INTERVAL_MS);
    const onPoke = () => void tick();
    window.addEventListener(MEMORY_ORGANIZER_EVENT, onPoke);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(MEMORY_ORGANIZER_EVENT, onPoke);
    };
  }, [setSettings]);

  return null;
}
