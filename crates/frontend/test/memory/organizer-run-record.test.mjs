import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const runRecord = loader.loadModule("src/lib/memory/organizer/runRecord.ts");
const quota = loader.loadModule("src/lib/memory/organizer/quota.ts");
const {
  createEmptyRunReport,
  readRunReport,
  organizerDecisionKey,
  isDefaultSelectedDecision,
  buildManualApplyState,
  buildReviewItemsForBatch,
  successfulDecisionKeys,
  failedDecisionKeysFromReviewItems,
  decisionsWithApplyStatus,
  ORGANIZE_RUN_REPORT_VERSION,
} = runRecord;
const { deriveQuotaLadder } = quota;

function runWithReport(report) {
  return { report };
}

test("v4 report round-trips through readRunReport", () => {
  const report = createEmptyRunReport();
  report.clusterSummaries.push("summary");
  report.safeDecisions = [{ op: "delete", slug: "old-slug" }];
  const parsed = readRunReport(runWithReport(JSON.parse(JSON.stringify(report))));
  assert.equal(parsed.version, ORGANIZE_RUN_REPORT_VERSION);
  assert.deepEqual(parsed.clusterSummaries, ["summary"]);
  assert.equal(parsed.safeDecisions[0].slug, "old-slug");
});

test("legacy blobs degrade to read-only summaries", () => {
  const parsed = readRunReport(
    runWithReport({
      clusterSummaries: ["旧总结"],
      reviewNotes: ["cluster c1: something skipped"],
      safeDecisions: [{ op: "delete", slug: "x" }],
    }),
  );
  assert.equal(parsed.version, "legacy");
  assert.deepEqual(parsed.clusterSummaries, ["旧总结"]);
  assert.equal(parsed.reviewItems.length, 1);
  assert.equal(parsed.reviewItems[0].message, "cluster c1: something skipped");
  assert.equal("safeDecisions" in parsed, false);
});

test("readRunReport tolerates null/garbage", () => {
  assert.equal(readRunReport(null).version, "legacy");
  assert.equal(readRunReport(runWithReport("junk")).version, "legacy");
  assert.equal(readRunReport(runWithReport([1, 2])).version, "legacy");
});

test("decision keys and default selection", () => {
  const decision = { op: "upsert", slug: "a", scope: "global", riskLevel: "low" };
  assert.equal(organizerDecisionKey(decision, 2), "2:upsert:global::a");
  assert.equal(isDefaultSelectedDecision(decision), true);
  assert.equal(isDefaultSelectedDecision({ ...decision, requiresUserAck: true }), false);
  assert.equal(isDefaultSelectedDecision({ ...decision, riskLevel: "medium" }), false);
});

test("manual apply state derives applied/partial/failed", () => {
  assert.equal(
    buildManualApplyState({
      selectedCount: 3,
      appliedCount: 3,
      warningCount: 0,
      appliedDecisionKeys: ["k1"],
      failedDecisionKeys: [],
    }).status,
    "applied",
  );
  assert.equal(
    buildManualApplyState({
      selectedCount: 3,
      appliedCount: 1,
      warningCount: 2,
      appliedDecisionKeys: ["k1"],
      failedDecisionKeys: ["k2"],
    }).status,
    "partial",
  );
  assert.equal(
    buildManualApplyState({
      selectedCount: 3,
      appliedCount: 0,
      warningCount: 3,
      appliedDecisionKeys: [],
      failedDecisionKeys: ["k1"],
    }).status,
    "failed",
  );
});

test("batch review items map structured warnings back to decision keys", () => {
  const decisions = [
    { decision: { op: "upsert", slug: "a" }, key: "0:upsert::-:a" },
    { decision: { op: "delete", slug: "b" }, key: "1:delete::-:b" },
  ];
  const items = buildReviewItemsForBatch(
    {
      created: [],
      updated: [],
      deleted: [],
      warnings: ["raw warning"],
      warningDetails: [
        {
          code: "body_too_large",
          message: "memory body for 'b' exceeds limit",
          slug: "b",
          op: "delete",
          decisionIndex: 1,
        },
      ],
    },
    decisions,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].code, "body_too_large");
  assert.equal(items[0].decisionKey, "1:delete::-:b");
  assert.equal(items[0].phase, "apply");
});

test("successful and failed decision keys derive from batch results", () => {
  const selected = [
    { decision: { op: "upsert", slug: "a" }, key: "ka" },
    { decision: { op: "delete", slug: "b" }, key: "kb" },
  ];
  const good = successfulDecisionKeys(selected, { created: ["a"], updated: [], deleted: [] });
  assert.deepEqual(good, ["ka"]);
  const bad = failedDecisionKeysFromReviewItems(selected, [
    { phase: "apply", kind: "error", severity: "error", message: "x", slug: "b" },
  ]);
  assert.deepEqual(bad, ["kb"]);
});

test("decisionsWithApplyStatus overlays stored state", () => {
  const decisions = [
    { op: "upsert", slug: "a" },
    { op: "delete", slug: "b" },
  ];
  const overlaid = decisionsWithApplyStatus(
    decisions,
    {
      status: "partial",
      appliedDecisionKeys: [organizerDecisionKey(decisions[0], 0)],
      failedDecisionKeys: [organizerDecisionKey(decisions[1], 1)],
    },
    [],
  );
  assert.equal(overlaid[0].applyStatus, "applied");
  assert.equal(overlaid[1].applyStatus, "failed");
});

test("quota ladder grades headroom and sets compression targets", () => {
  const scope = (headroom) => ({
    scope: "global",
    workdirHash: "",
    used: 500 - headroom,
    limit: 500,
    headroom,
    archivedCount: 0,
    unreviewedCount: 0,
  });
  assert.equal(deriveQuotaLadder(null).level, "normal");
  assert.equal(deriveQuotaLadder({ scopes: [scope(200)] }).level, "normal");
  assert.equal(deriveQuotaLadder({ scopes: [scope(80)] }).level, "notice");
  assert.equal(deriveQuotaLadder({ scopes: [scope(40)] }).level, "degraded");
  assert.equal(deriveQuotaLadder({ scopes: [scope(10)] }).level, "critical");
  assert.equal(deriveQuotaLadder({ scopes: [scope(2)] }).level, "exhausted");
  const ladder = deriveQuotaLadder({ scopes: [scope(200), scope(10)] });
  assert.equal(ladder.level, "critical");
  assert.equal(ladder.compressionTarget, 400); // limit - notice threshold
  assert.ok(ladder.bannerKey);
});
