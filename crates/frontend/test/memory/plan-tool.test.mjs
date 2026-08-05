import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const planTool = loader.loadModule("src/lib/memory/extraction/planTool.ts");
const {
  createSubmitMemoryPlanTool,
  parsePlanSubmission,
  validateSubmittedPlan,
  planToApplyBatchArgs,
  buildPlanReceiptText,
  SUBMIT_MEMORY_PLAN_TOOL_NAME,
} = planTool;

const CTX = {
  hasWorkdir: true,
  rejectedSlugs: new Set(),
  alreadyWrittenSlugs: new Set(),
};

const WRITE_ITEM = {
  action: "write",
  slug: "user-language",
  scope: "global",
  type: "feedback",
  description: "用户偏好中文回答",
  body: "用户希望默认用中文回答。",
  confidence: "high",
  source_quote: "以后默认用中文回答",
  reasoning: "explicit signal",
};

test("tool definition exposes the SubmitMemoryPlan contract", () => {
  const tool = createSubmitMemoryPlanTool();
  assert.equal(tool.name, SUBMIT_MEMORY_PLAN_TOOL_NAME);
  assert.ok(tool.description.includes("exactly once"));
  assert.ok(tool.parameters);
});

test("parsePlanSubmission tolerates malformed args", () => {
  assert.deepEqual(parsePlanSubmission(null), {});
  assert.deepEqual(parsePlanSubmission("x"), {});
  const parsed = parsePlanSubmission({ status: "updated", items: [WRITE_ITEM, null, "junk"] });
  assert.equal(parsed.status, "updated");
  assert.equal(parsed.items.length, 1);
});

test("a valid write item is accepted with camelCase evidence", () => {
  const result = validateSubmittedPlan({ items: [WRITE_ITEM] }, CTX);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 1);
  const item = result.accepted[0];
  assert.equal(item.action, "write");
  assert.equal(item.slug, "user-language");
  assert.equal(item.evidence.sourceQuote, "以后默认用中文回答");
  assert.equal(item.evidence.confidence, "high");
});

test("one bad item never kills the rest of the plan", () => {
  const result = validateSubmittedPlan(
    { items: [{ action: "explode" }, WRITE_ITEM] },
    CTX,
  );
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].index, 0);
  assert.equal(result.rejected[0].code, "invalid-action");
});

test("write field requirements are enforced individually", () => {
  const cases = [
    [{ action: "write", scope: "global", type: "user", description: "d", body: "b" }, "missing-slug"],
    [{ action: "write", slug: "user-x", type: "user", description: "d", body: "b" }, "invalid-scope"],
    [{ action: "write", slug: "user-x", scope: "global", description: "d", body: "b" }, "missing-type-for-write"],
    [{ action: "write", slug: "user-x", scope: "global", type: "user", body: "b" }, "missing-description-for-write"],
    [{ action: "write", slug: "user-x", scope: "global", type: "user", description: "d" }, "missing-body-for-write"],
  ];
  for (const [item, code] of cases) {
    const result = validateSubmittedPlan({ items: [item] }, CTX);
    assert.equal(result.accepted.length, 0, JSON.stringify(item));
    assert.equal(result.rejected[0].code, code);
  }
});

test("project scope requires a configured workdir (delete exempt)", () => {
  const noWorkdir = { ...CTX, hasWorkdir: false };
  const write = validateSubmittedPlan(
    { items: [{ ...WRITE_ITEM, scope: "project", type: "project" }] },
    noWorkdir,
  );
  assert.equal(write.rejected[0].code, "project-scope-gate");

  const del = validateSubmittedPlan(
    { items: [{ action: "delete", slug: "project-old", scope: "project" }] },
    noWorkdir,
  );
  assert.equal(del.accepted.length, 1);
});

test("recently rejected slugs need override_reject", () => {
  const ctx = { ...CTX, rejectedSlugs: new Set(["user-language"]) };
  const blocked = validateSubmittedPlan({ items: [WRITE_ITEM] }, ctx);
  assert.equal(blocked.rejected[0].code, "rejected-slug-no-override");

  const overridden = validateSubmittedPlan(
    { items: [{ ...WRITE_ITEM, override_reject: "user re-stated with 请记住" }] },
    ctx,
  );
  assert.equal(overridden.accepted.length, 1);
  assert.equal(overridden.accepted[0].evidence.overrideReject, "user re-stated with 请记住");
});

test("already-written slugs are dropped as duplicates", () => {
  const ctx = { ...CTX, alreadyWrittenSlugs: new Set(["user-language"]) };
  const result = validateSubmittedPlan({ items: [WRITE_ITEM] }, ctx);
  assert.equal(result.rejected[0].code, "already-written-this-turn");
});

test("in-plan duplicate mutations rejected; update-then-accept allowed", () => {
  const duplicate = validateSubmittedPlan(
    { items: [WRITE_ITEM, { ...WRITE_ITEM, action: "update" }] },
    CTX,
  );
  assert.equal(duplicate.accepted.length, 1);
  assert.equal(duplicate.rejected[0].code, "duplicate-slug-in-plan");

  const promote = validateSubmittedPlan(
    {
      items: [
        { action: "update", slug: "user-language", mode: "merge", confidence: "high", source_quote: "以后默认用中文回答" },
        { action: "accept", slug: "user-language", scope: "global" },
      ],
    },
    CTX,
  );
  assert.equal(promote.accepted.length, 2);
  assert.equal(promote.rejected.length, 0);
});

test("evidence-only update carries no body and defaults to merge", () => {
  const result = validateSubmittedPlan(
    {
      items: [
        {
          action: "update",
          slug: "user-editor",
          confidence: "medium",
          source_quote: "其实我最近换 helix 了",
          reasoning: "user restated",
        },
      ],
    },
    CTX,
  );
  assert.equal(result.accepted.length, 1);
  const item = result.accepted[0];
  assert.equal(item.body, undefined);
  assert.equal(item.mode, "merge");
  assert.equal(item.evidence.confidence, "medium");
});

test("append_daily requires a body and needs no slug", () => {
  const empty = validateSubmittedPlan({ items: [{ action: "append_daily" }] }, CTX);
  assert.equal(empty.rejected[0].code, "empty-daily-body");

  const ok = validateSubmittedPlan(
    { items: [{ action: "append_daily", body: "- 完成 memory 重构 P1" }] },
    CTX,
  );
  assert.equal(ok.accepted.length, 1);
});

test("oversized bodies are rejected", () => {
  const result = validateSubmittedPlan(
    { items: [{ ...WRITE_ITEM, body: "x".repeat(9 * 1024) }] },
    CTX,
  );
  assert.equal(result.rejected[0].code, "body-too-large");
});

test("planToApplyBatchArgs maps to the single batch payload", () => {
  const { accepted } = validateSubmittedPlan(
    {
      items: [
        WRITE_ITEM,
        {
          action: "update",
          slug: "user-editor",
          confidence: "medium",
          source_quote: "换 helix 了",
        },
        { action: "accept", slug: "user-name", scope: "global" },
        { action: "delete", slug: "user-old-pref", scope: "global", reasoning: "user refuted" },
        { action: "append_daily", body: "- bullet one" },
        { action: "append_daily", body: "- bullet two" },
      ],
    },
    CTX,
  );
  const batch = planToApplyBatchArgs(accepted);
  assert.equal(batch.dailyAppend.bullet, "- bullet one\n- bullet two");
  assert.equal(batch.decisions.length, 4);
  const [write, update, accept, del] = batch.decisions;
  assert.equal(write.op, "upsert");
  assert.equal(write.memoryType, "feedback");
  assert.equal(write.evidence.sourceQuote, "以后默认用中文回答");
  assert.equal(update.op, "update");
  assert.equal(update.mode, "merge");
  assert.equal(update.body, undefined);
  assert.equal(accept.op, "accept");
  assert.equal(del.op, "delete");
  assert.equal(del.reason, "user refuted");
  // no client-side frontmatter: bodies pass through verbatim
  assert.equal(write.body, WRITE_ITEM.body);
});

test("receipt text reports accepted and rejected counts", () => {
  const result = validateSubmittedPlan(
    { items: [WRITE_ITEM, { action: "nope" }] },
    CTX,
  );
  const text = buildPlanReceiptText(result);
  assert.ok(text.includes("1 accepted"));
  assert.ok(text.includes("1 rejected"));
  assert.ok(text.includes("invalid-action"));
});
