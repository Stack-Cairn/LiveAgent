// Organizer pipeline: pure data transforms between the store, the LLM plan
// tools, and the batch apply payload. No React, no scheduling, no I/O — the
// service drives these stages and unit tests pin them directly.

import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { MemoryMeta, MemoryOrganizeRun } from "../api";
import {
  MEMORY_BODY_LIMIT_BYTES,
  ORGANIZER_STRUCTURAL_CLUSTER_SIZE,
  ORGANIZER_TOPIC_CLUSTER_SIZE,
} from "../config";
import { ORGANIZER_PLAN_TOOL_NAME, ORGANIZER_TOPIC_TOOL_NAME } from "../prompts/organizer";
import type {
  MemoryType,
  OrganizerAction,
  OrganizerMode,
  RejectionBuckets,
  RiskLevel,
} from "../schema";
import type { OrganizerReviewItem, OrganizerSafeDecision } from "./runRecord";

export type OrganizerEntry = MemoryMeta & {
  body: string;
};

export type OrganizerCluster = {
  id: string;
  entries: OrganizerEntry[];
};

export type OrganizerPlanDecision = {
  action: OrganizerAction;
  slug?: string;
  targetSlug?: string;
  sourceSlugs: string[];
  riskLevel?: RiskLevel;
  confidence?: number;
  reason: string;
  preservedEvidence: string[];
  descriptionHint?: string;
  rewriteGoal?: string;
};

export type OrganizerClusterPlan = {
  raw: string;
  decisions: OrganizerPlanDecision[];
  summary: string;
  compression?: {
    before?: number;
    after?: number;
    deletions?: number;
  };
};

export type ParsedClusterResult = {
  cluster: OrganizerCluster;
  plan: OrganizerClusterPlan;
};

// ---------------------------------------------------------------------------
// Value coercion (single implementation — the runner/protocol duplicates died)
// ---------------------------------------------------------------------------

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
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

function optionalInteger(value: unknown) {
  const number = numberValue(value);
  return number == null ? undefined : Math.max(0, Math.floor(number));
}

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function normalizeOrganizerMode(mode: string): OrganizerMode {
  if (mode === "conservative" || mode === "aggressive") return mode;
  return "standard";
}

function riskLevelValue(value: unknown): RiskLevel | undefined {
  const normalized = stringValue(value).toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

function organizerActionValue(value: unknown): OrganizerAction | undefined {
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

function riskRank(value: RiskLevel) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function maxRisk(current: RiskLevel, next: RiskLevel): RiskLevel {
  return riskRank(next) > riskRank(current) ? next : current;
}

function isReviewed(entry: OrganizerEntry | undefined) {
  return Boolean(entry && !entry.unreviewed);
}

const utf8 = new TextEncoder();

// ---------------------------------------------------------------------------
// LLM plan tools
// ---------------------------------------------------------------------------

const ORGANIZER_PLAN_DECISION_SCHEMA = Type.Object({
  action: Type.Union(
    [
      Type.Literal("keep"),
      Type.Literal("merge_into"),
      Type.Literal("delete"),
      Type.Literal("mark_review"),
      Type.Literal("rewrite_hint"),
    ],
    {
      description:
        "Decision action. Use merge_into to merge source_slugs into target_slug. Use rewrite_hint instead of emitting a replacement body.",
    },
  ),
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

export const ORGANIZER_PLAN_TOOL: Tool = {
  name: ORGANIZER_PLAN_TOOL_NAME,
  description:
    "Submit the memory organization plan. Do not include full replacement memory bodies; the client preserves bodies and applies validated decisions.",
  parameters: Type.Object({
    summary: Type.Optional(
      Type.String({
        maxLength: 600,
        description: "Concise summary for this cluster.",
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

export const ORGANIZER_TOPIC_TOOL: Tool = {
  name: ORGANIZER_TOPIC_TOOL_NAME,
  description: "Submit semantic topic clusters for memory organization. Do not propose edits.",
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

/** Normalize a SubmitMemoryOrganizePlan tool call. The tool schema is the
 *  contract — only canonical snake_case keys are read. */
export function normalizeOrganizerPlanArgs(
  args: Record<string, unknown>,
): Omit<OrganizerClusterPlan, "raw"> {
  const decisions = Array.isArray(args.decisions) ? args.decisions : [];
  const normalized: OrganizerPlanDecision[] = [];
  for (const item of decisions) {
    const obj = recordValue(item);
    const action = organizerActionValue(obj.action);
    if (!action) continue;
    normalized.push({
      action,
      slug: stringValue(obj.slug),
      targetSlug: stringValue(obj.target_slug),
      sourceSlugs: uniqueStrings(stringArrayValue(obj.source_slugs)),
      riskLevel: riskLevelValue(obj.risk_level),
      confidence: clampConfidence(obj.confidence),
      reason: stringValue(obj.reason),
      preservedEvidence: uniqueStrings(stringArrayValue(obj.preserved_evidence)),
      descriptionHint: stringValue(obj.description_hint),
      rewriteGoal: stringValue(obj.rewrite_goal),
    });
  }
  const compression = recordValue(args.compression);
  return {
    decisions: normalized,
    summary: stringValue(args.summary) || "Cluster analyzed.",
    compression: {
      before: optionalInteger(compression.before),
      after: optionalInteger(compression.after),
      deletions: optionalInteger(compression.deletions),
    },
  };
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export function scopeMatchesRun(entry: MemoryMeta, run: MemoryOrganizeRun, workdir: string) {
  if (entry.memoryType === "daily") return false;
  if (run.scope === "global") return entry.scope === "global";
  if (run.scope === "projects") return entry.scope === "project";
  if (run.scope === "current-project") {
    return entry.scope === "project" && Boolean(workdir) && entry.workdirPath === workdir;
  }
  return entry.scope === "global" || entry.scope === "project";
}

export function buildStructuralClusters(entries: OrganizerEntry[]): OrganizerCluster[] {
  const groups = new Map<string, OrganizerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.scope}:${entry.workdirHash || ""}:${entry.memoryType}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const clusters: OrganizerCluster[] = [];
  for (const [key, group] of groups) {
    const sorted = group.sort((a, b) => a.slug.localeCompare(b.slug) || b.updatedAt - a.updatedAt);
    for (let index = 0; index < sorted.length; index += ORGANIZER_STRUCTURAL_CLUSTER_SIZE) {
      clusters.push({
        id: `${key}:${Math.floor(index / ORGANIZER_STRUCTURAL_CLUSTER_SIZE) + 1}`,
        entries: sorted.slice(index, index + ORGANIZER_STRUCTURAL_CLUSTER_SIZE),
      });
    }
  }
  return clusters;
}

export function buildTopicClustersFromArgs(
  args: Record<string, unknown>,
  entries: OrganizerEntry[],
): OrganizerCluster[] {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const used = new Set<string>();
  const topicClusters = Array.isArray(args.topic_clusters) ? args.topic_clusters : [];
  const clusters: OrganizerCluster[] = [];
  for (const item of topicClusters) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const topic =
      stringValue((item as { topic?: unknown }).topic) || `topic-${clusters.length + 1}`;
    const slugs = uniqueStrings(stringArrayValue((item as { slugs?: unknown }).slugs))
      .filter((slug) => bySlug.has(slug) && !used.has(slug))
      .slice(0, ORGANIZER_TOPIC_CLUSTER_SIZE);
    if (slugs.length < 2) continue;
    for (const slug of slugs) used.add(slug);
    clusters.push({
      id: `topic:${
        topic
          .replace(/[^a-z0-9_-]+/gi, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || clusters.length + 1
      }`,
      entries: slugs
        .map((slug) => bySlug.get(slug))
        .filter((entry): entry is OrganizerEntry => Boolean(entry)),
    });
  }
  const leftovers = entries.filter((entry) => !used.has(entry.slug));
  return [...clusters, ...buildStructuralClusters(leftovers)];
}

// ---------------------------------------------------------------------------
// Risk gate
// ---------------------------------------------------------------------------

export function deriveRisk(params: {
  action: string;
  llmRisk?: RiskLevel;
  confidence?: number;
  targetEntry: OrganizerEntry;
  sourceEntries: OrganizerEntry[];
}) {
  const reasons: string[] = [];
  let risk: RiskLevel = params.llmRisk || "medium";

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

export function shouldQueueDecision(params: {
  trigger: MemoryOrganizeRun["trigger"];
  mode: OrganizerMode;
  risk: RiskLevel;
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

export function emptyRejectionBuckets(): RejectionBuckets {
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

function addRejectionBucketForReasons(buckets: RejectionBuckets, reasons: string[]) {
  if (reasons.includes("review_required_by_llm")) buckets.reviewRequiredByLlm += 1;
  if (reasons.includes("low_confidence") || reasons.includes("missing_confidence")) {
    buckets.lowConfidence += 1;
  }
  if (reasons.includes("cross_type")) buckets.crossType += 1;
  if (reasons.includes("cross_scope")) buckets.crossScope += 1;
  if (reasons.includes("reviewed_entries") || reasons.includes("delete_reviewed")) {
    buckets.reviewedProtected += 1;
  }
}

// ---------------------------------------------------------------------------
// Merge synthesis & decision building
// ---------------------------------------------------------------------------

export function synthesizeBodyFromSources(
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

export function organizerMergeGroupId(clusterId: string, target: string, sources: string[]) {
  return `merge:${clusterId}:${target}:${sources.slice().sort().join("+")}`;
}

export type BuildDecisionsResult = {
  decisions: OrganizerSafeDecision[];
  reviewSkipped: number;
  mergedCount: number;
  rejectionBuckets: RejectionBuckets;
  reviewItems: OrganizerReviewItem[];
};

/** The client-side gate: recompute risk independently of the LLM, decide
 *  auto-apply vs queue, synthesize merged bodies, and bin every rejection. */
export function buildDecisions(
  results: ParsedClusterResult[],
  run: MemoryOrganizeRun,
): BuildDecisionsResult {
  const mode = normalizeOrganizerMode(run.mode);
  const decisions: OrganizerSafeDecision[] = [];
  let reviewSkipped = 0;
  let mergedCount = 0;
  const rejectionBuckets = emptyRejectionBuckets();
  const reviewItems: OrganizerReviewItem[] = [];

  const note = (message: string, slug?: string) => {
    reviewItems.push({
      phase: "planning",
      kind: "review",
      severity: "warning",
      message,
      slug,
    });
  };

  for (const { cluster, plan } of results) {
    const bySlug = new Map<string, OrganizerEntry>();
    for (const entry of cluster.entries) {
      bySlug.set(entry.slug, entry);
    }

    for (const item of plan.decisions) {
      if (item.action === "keep") continue;

      if (item.action === "mark_review" || item.action === "rewrite_hint") {
        reviewSkipped += 1;
        rejectionBuckets.reviewRequiredByLlm += 1;
        const slugText = item.slug || item.targetSlug || item.sourceSlugs.join(", ");
        note(
          `${cluster.id}: ${item.action} ${slugText || "(unknown)"} - ${item.reason || item.rewriteGoal || "needs review"}`,
          item.slug || item.targetSlug,
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
          rejectionBuckets.unsupported += 1;
          continue;
        }
        const risk = deriveRisk({
          action: "delete",
          llmRisk: item.riskLevel,
          confidence,
          targetEntry: deleteEntry,
          sourceEntries: [deleteEntry],
        });
        if (
          !shouldQueueDecision({
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
          rejectionBuckets.unsupported += 1;
          continue;
        }
        const risk = deriveRisk({
          action: "merge",
          llmRisk: item.riskLevel,
          confidence,
          targetEntry,
          sourceEntries: [targetEntry, ...sourceEntries],
        });
        if (
          !shouldQueueDecision({
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
        if (utf8.encode(body).length > MEMORY_BODY_LIMIT_BYTES) {
          reviewSkipped += 1;
          rejectionBuckets.missingPayload += 1;
          note(
            `${cluster.id}: merge_into ${targetEntry.slug} - merged body exceeds ${MEMORY_BODY_LIMIT_BYTES} bytes; skipped automatic apply and requires a shorter manual rewrite.`,
            targetEntry.slug,
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
            rejectionBuckets.unsupported += 1;
            continue;
          }
          const deleteRisk = deriveRisk({
            action: "delete",
            llmRisk: risk.risk,
            confidence,
            targetEntry: sourceEntry,
            sourceEntries: [sourceEntry, targetEntry],
          });
          if (
            !shouldQueueDecision({
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
  return { decisions, reviewSkipped, mergedCount, rejectionBuckets, reviewItems };
}
