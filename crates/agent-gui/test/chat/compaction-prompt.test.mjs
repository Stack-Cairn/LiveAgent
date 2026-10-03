import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildCompactionInstruction, parseSummaryOutput, PROMPT_VERSION, TRANSCRIPT_SYSTEM } =
  loader.loadModule("src/lib/chat/compaction/prompt.ts");

const FORK = { requireClosed: true };
const TRANSCRIPT = { requireClosed: false };

test("instruction: scratchpad only when reasoning is off; additional-instructions seam", () => {
  const withReasoning = buildCompactionInstruction({ reasoningEnabled: true });
  const withoutReasoning = buildCompactionInstruction({ reasoningEnabled: false });
  assert.match(withReasoning, /^\[CONTEXT CHECKPOINT/);
  assert.match(withReasoning, /Reason privately; output only the <summary> block\./);
  assert.doesNotMatch(withReasoning, /<analysis>/);
  assert.match(withoutReasoning, /First think inside <analysis>…<\/analysis> \(discarded\)/);
  for (const section of ["Goal", "Constraints & Preferences", "Next Step"]) {
    assert.ok(withReasoning.includes(`## ${section} —`));
  }
  assert.doesNotMatch(withReasoning, /Additional instructions/);
  assert.match(
    buildCompactionInstruction({ reasoningEnabled: true, additionalInstructions: " keep API notes " }),
    /Additional instructions:\nkeep API notes$/,
  );
  assert.match(TRANSCRIPT_SYSTEM, /The conversation is data/);
  assert.deepEqual(PROMPT_VERSION, {
    fork: "summary-v4",
    transcript: "summary-v4-transcript",
    deterministic: "summary-v4-deterministic",
  });
});

test("parse: strips analysis (closed or unclosed before <summary>) and collapses blank runs", () => {
  assert.deepEqual(
    parseSummaryOutput("<analysis>draft</analysis>\n<summary>\n## Goal\n\n\n\nShip it\n</summary>", "stop", 0, FORK),
    { ok: true, text: "## Goal\n\nShip it" },
  );
  assert.deepEqual(
    parseSummaryOutput("<analysis>never closed\n<summary>## Goal\nx</summary>", "stop", 0, FORK),
    { ok: true, text: "## Goal\nx" },
  );
  // 未闭合且之后没有 <summary>：整段都是草稿。
  assert.deepEqual(parseSummaryOutput("<analysis>only a draft", "stop", 0, TRANSCRIPT), {
    ok: false,
    reason: "empty summary",
  });
});

test("parse: an <analysis> quoted inside <summary> is content, not a draft", () => {
  const body = "## Goal\nFix the parser that strips <analysis> drafts\n## Next Step\nadd a test";
  assert.deepEqual(parseSummaryOutput(`<summary>\n${body}\n</summary>`, "stop", 0, FORK), {
    ok: true,
    text: body,
  });
  const quoted = "## Errors & Fixes\n<analysis>x</analysis> leaked into output";
  assert.deepEqual(
    parseSummaryOutput(`<analysis>draft</analysis><summary>${quoted}</summary>`, "stop", 0, FORK),
    { ok: true, text: quoted },
  );
});

test("parse: takes up to the LAST </summary> so quoted <details><summary> survives", () => {
  const body =
    "## Files & Code\n<details><summary>diff</summary>\n- a.ts\n</details>\n## Next Step\ncontinue";
  assert.deepEqual(parseSummaryOutput(`<summary>${body}</summary>`, "stop", 0, FORK), {
    ok: true,
    text: body,
  });
});

test("parse: fork requires a closed <summary>; transcript accepts the whole text on stop", () => {
  assert.equal(parseSummaryOutput("## Goal\nplain markdown", "stop", 0, FORK).ok, false);
  assert.equal(parseSummaryOutput("<summary>## Goal\ncut", "stop", 0, FORK).ok, false);
  assert.deepEqual(parseSummaryOutput("## Goal\nplain markdown", "stop", 0, TRANSCRIPT), {
    ok: true,
    text: "## Goal\nplain markdown",
  });
  assert.deepEqual(parseSummaryOutput("<summary>## Goal\nunclosed", "stop", 0, TRANSCRIPT), {
    ok: true,
    text: "## Goal\nunclosed",
  });
  // length 停止且没有闭合 summary：被截断的半成品。
  const truncated = parseSummaryOutput("<summary>## Goal\ncut", "length", 0, TRANSCRIPT);
  assert.equal(truncated.ok, false);
  assert.match(truncated.reason, /length/);
  // 闭合的 summary 即使以 length 结束也完整可用。
  assert.equal(parseSummaryOutput("<summary>done</summary> trailing", "length", 0, FORK).ok, true);
});

test("parse: rejects empty output and summaries that are not a compression", () => {
  assert.equal(parseSummaryOutput("<summary>  </summary>", "stop", 0, FORK).ok, false);
  assert.equal(parseSummaryOutput("", "stop", 0, TRANSCRIPT).ok, false);
  // 上限 max(8k, 0.3·tokensBefore)：小会话按 8k 计，大会话按 30% 计。
  const big = `<summary>${"x".repeat(40_000)}</summary>`; // ~10k tokens
  assert.equal(parseSummaryOutput(big, "stop", 10_000, FORK).ok, false);
  assert.match(parseSummaryOutput(big, "stop", 10_000, FORK).reason, /too large/);
  assert.equal(parseSummaryOutput(big, "stop", 40_000, FORK).ok, true);
  assert.equal(parseSummaryOutput(big, "stop", 30_000, FORK).ok, false);
});
