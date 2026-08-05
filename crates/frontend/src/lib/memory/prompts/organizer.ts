// Organizer audience: system prompts, mode policies, and per-cluster prompt
// builders for the offline organization pass. Pure string builders — the
// pipeline supplies all data.

import {
  ORGANIZER_BODY_EXCERPT_CHARS,
  ORGANIZER_GLOBAL_INVENTORY_CHARS,
  ORGANIZER_META_BODY_EXCERPT_CHARS,
  ORGANIZER_TOPIC_CLUSTER_SIZE,
} from "../config";
import type { OrganizerMode } from "../schema";

export const ORGANIZER_PLAN_TOOL_NAME = "SubmitMemoryOrganizePlan";
export const ORGANIZER_TOPIC_TOOL_NAME = "SubmitMemoryTopicClusters";

export const ORGANIZER_MODE_DESCRIPTIONS: Record<OrganizerMode, string> = {
  conservative:
    "Only merge near-duplicates with semantic overlap >= 0.9. Same scope and same type are required. Reviewed entries default to keep. Emit at most 20% non-keep decisions.",
  standard:
    "Default mode. Merge clear semantic duplicates and rewrite redundant fragments. Same scope is required, but type may cross when one note clearly subsumes the other. Reviewed entries can be merged or rewritten when confidence >= 0.8 and evidence is preserved.",
  aggressive:
    "Actively consolidate topically related fragments. Cross-scope and cross-type merges are allowed when the unified note preserves all evidence. Reviewed entries can be merged, rewritten, or superseded. Emit at least 30% non-keep decisions when redundancy is visible.",
};

export const ORGANIZER_SYSTEM_PROMPT = `# LiveAgent Memory Organizer

You are running an offline memory organization pass for LiveAgent.

You ONLY organize existing persistent memories supplied by the client. Do not extract new facts from conversations. Do not create facts from inference. Do not modify, merge, rewrite, or delete daily memories.

Use MemoryManager only in read-only mode when tools are available. Never call write, update, delete, accept, or apply tools. The client will validate and apply your plan.

You MUST submit the organization result by calling the ${ORGANIZER_PLAN_TOOL_NAME} tool. Do not hand-write JSON, XML, Markdown protocol blocks, or replacement memory bodies in assistant text.

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

Before per-cluster work, you receive a Global inventory block listing all clusters' slug/headline. First identify top cross-cluster consolidation candidates, then work on the local cluster.

## Required output: target compression ratio

Every tool submission summary must include compression data so the user can see expected reduction.`;

export const TOPIC_CLUSTER_SYSTEM_PROMPT = `You are grouping existing LiveAgent memories for an offline organization pass.

Do not propose edits. Do not create, update, or delete memories. Only group supplied slugs by semantic topic so a later pass can compare related memories.

You MUST submit the grouping by calling the ${ORGANIZER_TOPIC_TOOL_NAME} tool. Do not hand-write JSON, XML, or Markdown protocol blocks in assistant text.`;

export function clipText(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

export type OrganizerPromptEntry = {
  slug: string;
  scope: string;
  workdirHash: string;
  workdirPath?: string | null;
  memoryType: string;
  description: string;
  headline: string;
  unreviewed: boolean;
  confidence: string;
  updatedAt: number;
  body: string;
};

export function buildMetaClusterPrompt(entries: readonly OrganizerPromptEntry[]) {
  const items = entries.map((entry) => ({
    slug: entry.slug,
    scope: entry.scope,
    workdir_hash: entry.workdirHash || "",
    type: entry.memoryType,
    headline: entry.headline,
    description: entry.description,
    unreviewed: entry.unreviewed,
    confidence: entry.confidence,
    body_excerpt: clipText(entry.body, ORGANIZER_META_BODY_EXCERPT_CHARS),
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

export function buildGlobalInventory(
  entries: readonly OrganizerPromptEntry[],
  clusterIdBySlug: ReadonlyMap<string, string>,
) {
  const inventory = entries
    .slice()
    .sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) ||
        a.memoryType.localeCompare(b.memoryType) ||
        a.slug.localeCompare(b.slug),
    )
    .map((entry) => ({
      slug: entry.slug,
      cluster_id: clusterIdBySlug.get(entry.slug) || "",
      scope: entry.scope,
      workdir_hash: entry.workdirHash || "",
      type: entry.memoryType,
      headline: entry.headline,
      description: entry.description,
      unreviewed: entry.unreviewed,
      confidence: entry.confidence,
    }));
  return clipText(JSON.stringify({ items: inventory }, null, 2), ORGANIZER_GLOBAL_INVENTORY_CHARS);
}

export function buildClusterPrompt(params: {
  trigger: string;
  mode: OrganizerMode;
  clusterId: string;
  entries: readonly OrganizerPromptEntry[];
  globalInventory: string;
  /** From the quota ladder: when set, the model is asked to consolidate down
   *  to roughly this many entries in scope. */
  compressionTarget?: number;
}) {
  const memories = params.entries
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
        clipText(entry.body, ORGANIZER_BODY_EXCERPT_CHARS),
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `Local date: ${new Date().toISOString().slice(0, 10)}`,
    `Trigger: ${params.trigger}`,
    `Mode: ${params.mode}`,
    `Mode behavior reminder: ${ORGANIZER_MODE_DESCRIPTIONS[params.mode]}`,
    "Scope policy: organize ordinary global and project memories only; daily entries are excluded.",
    "Scheduled policy: if trigger is scheduled, only low-risk conservative actions may be applied.",
    "Manual policy: low-risk suggestions are selected by default in the review UI; medium/high-risk suggestions must carry risk_level and confidence so the user can explicitly confirm them.",
    ...(params.compressionTarget
      ? [
          `Quota pressure: the memory store is near its per-scope quota. Bias toward consolidation — aim to reduce toward ~${params.compressionTarget} entries in scope while preserving all evidence.`,
        ]
      : []),
    "",
    "Global inventory (read-only context; use it to spot cross-cluster duplicate topics, but act only on current cluster slugs):",
    params.globalInventory,
    "",
    "Cluster:",
    `- cluster_id: ${params.clusterId}`,
    `- memory_count: ${params.entries.length}`,
    "",
    "Memories:",
    memories,
    "",
    `Call ${ORGANIZER_PLAN_TOOL_NAME} with decisions for this cluster.`,
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
