import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const extraction = loader.loadModule("src/lib/memory/prompts/extraction.ts");
const shared = loader.loadModule("src/lib/memory/prompts/shared.ts");
const {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionInstructionPrompt,
  buildExistingCandidatesBlock,
  buildRecentRejectionsBlock,
  buildAlreadyWrittenBlock,
  buildWorkspaceMutationsBlock,
  buildConversationSummaryBlock,
  buildReviewerModeLines,
} = extraction;

test("system prompt forbids mutations and requires exactly one submission", () => {
  assert.ok(EXTRACTION_SYSTEM_PROMPT.includes("read-only"));
  assert.ok(EXTRACTION_SYSTEM_PROMPT.includes("SubmitMemoryPlan exactly once"));
});

test("instruction prompt contains the load-bearing sections", () => {
  const prompt = buildExtractionInstructionPrompt({
    localDate: "2026-07-04",
    workdir: "/Users/dev/project",
  });
  assert.ok(prompt.includes("Project-scope gate"));
  assert.ok(prompt.includes("<workspace-mutations-this-turn>"));
  assert.ok(prompt.includes("Classification decision tree"));
  assert.ok(prompt.includes("append_daily"));
  assert.ok(prompt.includes("2026-07-04"));
  // conflict arbitration appears exactly once (single-source regression)
  assert.equal(prompt.match(/Conflict resolution \(in order\)/g)?.length, 1);
});

test("no workdir → project scope is closed off", () => {
  const prompt = buildExtractionInstructionPrompt({ localDate: "2026-07-04" });
  assert.ok(prompt.includes('Do not use scope="project"'));
});

test("no hardcoded status sentinels anywhere in the prompts", () => {
  const prompt = buildExtractionInstructionPrompt({
    localDate: "2026-07-04",
    workdir: "/w",
  });
  for (const text of [prompt, EXTRACTION_SYSTEM_PROMPT]) {
    assert.ok(!text.includes("记忆整理完成"));
    assert.ok(!text.includes("本轮无需更新记忆"));
  }
});

test("reviewer modes differ and embed into the prompt", () => {
  const strict = buildReviewerModeLines("strict");
  const lenient = buildReviewerModeLines("lenient");
  assert.ok(strict.includes("STRICT"));
  assert.ok(lenient.includes("LENIENT"));
  assert.notEqual(strict, lenient);
  const prompt = buildExtractionInstructionPrompt({
    localDate: "2026-07-04",
    reviewerMode: "strict",
  });
  assert.ok(prompt.includes("Extraction mode: STRICT."));
  const defaulted = buildExtractionInstructionPrompt({ localDate: "2026-07-04" });
  assert.ok(defaulted.includes("Extraction mode: STANDARD."));
});

test("context blocks render entries and (none) fallbacks", () => {
  assert.ok(buildExistingCandidatesBlock([]).includes("- (none)"));
  const candidates = buildExistingCandidatesBlock(
    [
      {
        slug: "user-editor",
        memoryType: "user",
        scope: "global",
        description: "编辑器偏好",
        unreviewed: true,
        confidence: "medium",
        updatedAt: Date.now() - 86_400_000,
      },
    ],
    Date.now(),
  );
  assert.ok(candidates.includes("user-editor"));
  assert.ok(candidates.includes("unreviewed"));
  assert.ok(candidates.includes("1d ago"));

  const rejections = buildRecentRejectionsBlock([
    { slug: "user-noise", rejectedAt: Date.now(), reason: 'said "别记这个"' },
  ]);
  assert.ok(rejections.includes("user-noise"));
  assert.ok(rejections.includes("别记这个"));

  assert.ok(buildAlreadyWrittenBlock(["a-slug"]).includes("- a-slug"));
  assert.ok(buildWorkspaceMutationsBlock([]).includes("- (none)"));
  assert.ok(buildWorkspaceMutationsBlock(["Edit src/a.ts"]).includes("- Edit src/a.ts"));
  assert.equal(buildConversationSummaryBlock(undefined), null);
  assert.ok(buildConversationSummaryBlock("earlier summary").includes("earlier summary"));
});

test("shared policy constants stay single-sourced and contract-aligned", () => {
  assert.ok(shared.MEMORY_CONFIDENCE_CONTRACT_LINE.includes(">=5 characters"));
  assert.ok(shared.PROJECT_MEMORY_WRITE_EVIDENCE_GATE.includes("HARD precondition"));
  assert.equal(shared.MEMORY_SKIP_LIST_ITEMS.length, 5);
});
