import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const pipeline = loader.loadModule("src/lib/memory/organizer/pipeline.ts");
const {
  buildStructuralClusters,
  buildTopicClustersFromArgs,
  deriveRisk,
  shouldQueueDecision,
  buildDecisions,
  normalizeOrganizerPlanArgs,
  synthesizeBodyFromSources,
  scopeMatchesRun,
} = pipeline;

function entry(overrides = {}) {
  return {
    slug: "user-a",
    scope: "global",
    workdirHash: "",
    workdirPath: null,
    memoryType: "user",
    description: "desc",
    headline: "",
    dateLocal: null,
    createdAt: 1,
    updatedAt: 1,
    appendCount: 0,
    archived: false,
    unreviewed: true,
    confidence: "medium",
    fileSize: 10,
    body: "body text",
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    runId: "r1",
    trigger: "manual",
    status: "running",
    createdAt: 1,
    model: null,
    scope: "all",
    mode: "standard",
    inputCount: 0,
    clusterCount: 0,
    safeApplied: 0,
    reviewSkipped: 0,
    createdCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    mergedCount: 0,
    parseFailures: 0,
    finalCount: 0,
    dryRun: false,
    tokenUsageTotal: 0,
    overrideReviewed: false,
    report: {},
    ...overrides,
  };
}

test("scopeMatchesRun filters daily and honors run scope", () => {
  const r = run({ scope: "global" });
  assert.equal(scopeMatchesRun(entry({ memoryType: "daily" }), r, ""), false);
  assert.equal(scopeMatchesRun(entry({ scope: "global" }), r, ""), true);
  assert.equal(scopeMatchesRun(entry({ scope: "project" }), r, ""), false);
  const current = run({ scope: "current-project" });
  assert.equal(
    scopeMatchesRun(entry({ scope: "project", workdirPath: "/w" }), current, "/w"),
    true,
  );
  assert.equal(
    scopeMatchesRun(entry({ scope: "project", workdirPath: "/other" }), current, "/w"),
    false,
  );
});

test("structural clusters group by scope:hash:type in chunks of 8", () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry({ slug: `user-${i}` }));
  const clusters = buildStructuralClusters(entries);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].entries.length, 8);
  assert.equal(clusters[1].entries.length, 2);
});

test("topic clusters consume LLM groups and fall back structurally for leftovers", () => {
  const entries = ["a-slug", "b-slug", "c-slug", "d-slug"].map((slug) => entry({ slug }));
  const clusters = buildTopicClustersFromArgs(
    {
      topic_clusters: [
        { topic: "Editor Preferences", slugs: ["a-slug", "b-slug"] },
        { topic: "singleton", slugs: ["c-slug"] }, // <2 slugs → dropped
      ],
    },
    entries,
  );
  assert.ok(clusters[0].id.toLowerCase().startsWith("topic:editor-preferences"));
  assert.deepEqual(
    clusters[0].entries.map((e) => e.slug),
    ["a-slug", "b-slug"],
  );
  // leftovers (c,d) fall into structural clusters
  const leftoverSlugs = clusters.slice(1).flatMap((c) => c.entries.map((e) => e.slug));
  assert.deepEqual(leftoverSlugs.sort(), ["c-slug", "d-slug"]);
});

test("deriveRisk clamps: cross-scope→high, low confidence→high, reviewed→≥medium", () => {
  const target = entry({ slug: "t", unreviewed: true });
  const low = deriveRisk({
    action: "merge",
    llmRisk: "low",
    confidence: 0.95,
    targetEntry: target,
    sourceEntries: [target, entry({ slug: "s", unreviewed: true })],
  });
  assert.equal(low.risk, "low");

  const crossScope = deriveRisk({
    action: "merge",
    llmRisk: "low",
    confidence: 0.95,
    targetEntry: target,
    sourceEntries: [target, entry({ slug: "s", scope: "project" })],
  });
  assert.equal(crossScope.risk, "high");
  assert.ok(crossScope.reasons.includes("cross_scope"));

  const lowConf = deriveRisk({
    action: "merge",
    llmRisk: "low",
    confidence: 0.5,
    targetEntry: target,
    sourceEntries: [target],
  });
  assert.equal(lowConf.risk, "high");

  const reviewed = deriveRisk({
    action: "merge",
    llmRisk: "low",
    confidence: 0.95,
    targetEntry: entry({ slug: "t", unreviewed: false }),
    sourceEntries: [entry({ slug: "t", unreviewed: false })],
  });
  assert.equal(reviewed.risk, "medium");

  const deleteReviewed = deriveRisk({
    action: "delete",
    llmRisk: "low",
    confidence: 0.95,
    targetEntry: entry({ slug: "t", unreviewed: false }),
    sourceEntries: [entry({ slug: "t", unreviewed: false })],
  });
  assert.equal(deleteReviewed.risk, "high");
});

test("shouldQueueDecision matrix: trigger × mode × risk × confidence", () => {
  // scheduled: low risk + confidence>=0.8 only
  assert.equal(
    shouldQueueDecision({ trigger: "scheduled", mode: "standard", risk: "low", confidence: 0.85, action: "merge", reasons: [] }),
    true,
  );
  assert.equal(
    shouldQueueDecision({ trigger: "scheduled", mode: "aggressive", risk: "medium", confidence: 0.95, action: "merge", reasons: [] }),
    false,
  );
  // manual low: confidence>=0.6
  assert.equal(
    shouldQueueDecision({ trigger: "manual", mode: "standard", risk: "low", confidence: 0.65, action: "merge", reasons: [] }),
    true,
  );
  // manual medium blocked in conservative, allowed at >=0.8 otherwise
  assert.equal(
    shouldQueueDecision({ trigger: "manual", mode: "conservative", risk: "medium", confidence: 0.95, action: "merge", reasons: [] }),
    false,
  );
  assert.equal(
    shouldQueueDecision({ trigger: "manual", mode: "standard", risk: "medium", confidence: 0.85, action: "merge", reasons: [] }),
    true,
  );
  // manual high: reviewed-delete escape hatch
  assert.equal(
    shouldQueueDecision({
      trigger: "manual",
      mode: "standard",
      risk: "high",
      confidence: 0.9,
      action: "delete",
      reasons: ["delete_reviewed"],
    }),
    true,
  );
  // aggressive high cross-scope at >=0.85
  assert.equal(
    shouldQueueDecision({
      trigger: "manual",
      mode: "aggressive",
      risk: "high",
      confidence: 0.9,
      action: "merge",
      reasons: ["cross_scope"],
    }),
    true,
  );
  assert.equal(
    shouldQueueDecision({
      trigger: "manual",
      mode: "standard",
      risk: "high",
      confidence: 0.95,
      action: "merge",
      reasons: ["cross_scope"],
    }),
    false,
  );
});

test("normalizeOrganizerPlanArgs reads canonical snake_case only", () => {
  const plan = normalizeOrganizerPlanArgs({
    summary: "done",
    decisions: [
      {
        action: "merge_into",
        target_slug: "target-a",
        source_slugs: ["src-1", "src-1", "src-2"],
        risk_level: "low",
        confidence: 1.7,
        reason: "dup",
        preserved_evidence: ["q1"],
      },
      { action: "bogus" },
      { action: "keep", slug: "keeper" },
    ],
    compression: { before: 5, after: 3 },
  });
  assert.equal(plan.decisions.length, 2);
  const merge = plan.decisions[0];
  assert.equal(merge.targetSlug, "target-a");
  assert.deepEqual(merge.sourceSlugs, ["src-1", "src-2"]);
  assert.equal(merge.confidence, 1); // clamped
  assert.equal(plan.compression.before, 5);
});

test("buildDecisions merges via synthesized body and bins rejections", () => {
  const target = entry({ slug: "target-a", unreviewed: true, body: "target body" });
  const source = entry({ slug: "src-1", unreviewed: true, body: "source body" });
  const cluster = { id: "global::user:1", entries: [target, source] };
  const result = buildDecisions(
    [
      {
        cluster,
        plan: {
          raw: "",
          summary: "s",
          decisions: [
            {
              action: "merge_into",
              targetSlug: "target-a",
              sourceSlugs: ["src-1"],
              riskLevel: "low",
              confidence: 0.95,
              reason: "duplicate",
              preservedEvidence: ["原话引用"],
            },
            {
              action: "mark_review",
              slug: "target-a",
              sourceSlugs: [],
              reason: "risky idea",
              preservedEvidence: [],
            },
          ],
        },
      },
    ],
    run({ trigger: "manual", mode: "standard" }),
  );
  // merge produces upsert(target) + delete(source) sharing a groupId
  assert.equal(result.decisions.length, 2);
  const [upsert, del] = result.decisions;
  assert.equal(upsert.op, "upsert");
  assert.ok(upsert.body.includes("## Organizer merge"));
  assert.ok(upsert.body.includes("source body"));
  assert.equal(del.op, "delete");
  assert.equal(upsert.groupId, del.groupId);
  assert.equal(result.mergedCount, 1);
  // mark_review lands in the reviewRequiredByLlm bucket + typed review item
  assert.equal(result.rejectionBuckets.reviewRequiredByLlm, 1);
  assert.equal(result.reviewItems.length, 1);
  assert.equal(result.reviewItems[0].phase, "planning");
});

test("oversized merged bodies are skipped into missingPayload", () => {
  const target = entry({ slug: "target-a", body: "x".repeat(5_000) });
  const source = entry({ slug: "src-1", body: "y".repeat(5_000) });
  const cluster = { id: "c1", entries: [target, source] };
  const result = buildDecisions(
    [
      {
        cluster,
        plan: {
          raw: "",
          summary: "s",
          decisions: [
            {
              action: "merge_into",
              targetSlug: "target-a",
              sourceSlugs: ["src-1"],
              riskLevel: "low",
              confidence: 0.95,
              reason: "dup",
              preservedEvidence: [],
            },
          ],
        },
      },
    ],
    run(),
  );
  assert.equal(result.decisions.length, 0);
  assert.equal(result.rejectionBuckets.missingPayload, 1);
});

test("synthesizeBodyFromSources preserves target body, sources, and evidence", () => {
  const body = synthesizeBodyFromSources(
    entry({ slug: "t", body: "target text" }),
    [entry({ slug: "t", body: "target text" }), entry({ slug: "s", body: "src text" })],
    "because",
    ["evidence-1"],
  );
  assert.ok(body.startsWith("target text"));
  assert.ok(body.includes("### Source: s"));
  assert.ok(body.includes("- evidence-1"));
  assert.ok(body.includes("Reason: because"));
});
