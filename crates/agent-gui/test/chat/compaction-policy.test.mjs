import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const policy = loader.loadModule("src/lib/chat/compaction/policy.ts");

test("limits: inputCap / reserve / hard / soft per the W·O table", () => {
  const rows = [
    [200_000, 64_000, { inputCap: 136_000, reserve: 10_000, hard: 126_000, soft: 116_000 }],
    [400_000, 128_000, { inputCap: 272_000, reserve: 20_000, hard: 252_000, soft: 236_000 }],
    [1_000_000, 128_000, { inputCap: 872_000, reserve: 20_000, hard: 852_000, soft: 836_000 }],
    // 有意比旧阈值提前：旧口径给估算漂移只留 1.6k。
    [128_000, 8_000, { inputCap: 120_000, reserve: 6_400, hard: 113_600, soft: 107_200 }],
  ];
  for (const [contextWindow, maxOutputToken, expected] of rows) {
    assert.deepEqual(policy.resolveCompactionLimits({ contextWindow, maxOutputToken }), expected);
  }
  const limits = policy.resolveCompactionLimits({ contextWindow: 200_000, maxOutputToken: 64_000 });
  assert.equal(policy.forkFits(134_000, limits), true);
  assert.equal(policy.forkFits(134_001, limits), false);
});

const W200 = { contextWindow: 200_000, maxOutputToken: 64_000 }; // soft 116k / hard 126k

function next(overrides = {}) {
  return policy.decideCompaction({
    trigger: "pre-send",
    totalTokens: 0,
    fixedTokens: 10_000,
    modelConfig: W200,
    activeMessageCount: 10,
    inFlight: false,
    failureStreak: 0,
    thrashing: false,
    ...overrides,
  });
}

test("decideCompaction checks guards in order", () => {
  const huge = { totalTokens: 999_999 };
  assert.equal(next({ ...huge, modelConfig: undefined }).reason, "disabled");
  assert.equal(next({ ...huge, modelConfig: { contextWindow: 200_000, maxOutputToken: 0 } }).reason, "disabled");
  assert.equal(next({ ...huge, activeMessageCount: 0 }).reason, "no-active-messages");
  assert.equal(next({ ...huge, inFlight: true, trigger: "manual" }).reason, "in-flight");

  // manual：只看 50% 门槛，不受 soft / 熔断影响。
  assert.equal(next({ trigger: "manual", totalTokens: 99_999 }).reason, "below-manual-threshold");
  const manual = next({ trigger: "manual", totalTokens: 100_000, failureStreak: 9 });
  assert.equal(manual.shouldCompact, true);
  assert.equal(manual.mustProgress, false);
  assert.equal(manual.startAt, "fork");

  // overflow：同样的输入必然再溢出，从 transcript 开始且必须推进。
  const overflow = next({ trigger: "overflow", totalTokens: 50_000, thrashing: true });
  assert.deepEqual([overflow.shouldCompact, overflow.mustProgress, overflow.startAt], [true, true, "transcript"]);

  assert.equal(next({ totalTokens: 115_999 }).reason, "below-threshold");
  const soft = next({ totalTokens: 116_000 });
  assert.deepEqual([soft.shouldCompact, soft.mustProgress, soft.startAt], [true, false, "fork"]);
  assert.equal(soft.limits.soft, 116_000);
});

test("prefix-too-large: compaction cannot free room under a huge fixed prefix", () => {
  // W200：soft 116k，余量 min(20k, 116k/4) = 20k，只拦 [soft, hard)。
  assert.equal(next({ totalTokens: 120_000, fixedTokens: 96_000 }).reason, "prefix-too-large");
  assert.equal(next({ totalTokens: 120_000, fixedTokens: 95_999 }).shouldCompact, true);
  // ≥ hard：压缩仍能把上下文拉回 fixed + bridge，必须推进。
  const atHard = next({ totalTokens: 130_000, fixedTokens: 96_000 });
  assert.deepEqual([atHard.shouldCompact, atHard.mustProgress], [true, true]);
  // fixed 本身已 ≥ hard：压缩腾不出空间，让溢出自然暴露。
  assert.equal(next({ totalTokens: 130_000, fixedTokens: 126_000 }).reason, "prefix-too-large");
});

test("prefix-too-large headroom scales with soft on small windows", () => {
  // W=64k/O=32k：soft 24768 / hard 28768，余量 6192。
  const w64 = { modelConfig: { contextWindow: 65_536, maxOutputToken: 32_768 } };
  const w64Soft = next({ ...w64, totalTokens: 25_000, fixedTokens: 8_000 });
  assert.deepEqual([w64Soft.shouldCompact, w64Soft.mustProgress], [true, false]);
  assert.equal(next({ ...w64, totalTokens: 25_000, fixedTokens: 18_576 }).reason, "prefix-too-large");
  const w64Hard = next({ ...w64, totalTokens: 30_000, fixedTokens: 20_000 });
  assert.deepEqual([w64Hard.shouldCompact, w64Hard.mustProgress], [true, true]);

  // W=32k/O=4k：soft 20672 / hard 24672，余量 5168。
  const w32 = { modelConfig: { contextWindow: 32_768, maxOutputToken: 4_096 } };
  const w32Hard = next({ ...w32, totalTokens: 26_000, fixedTokens: 5_000 });
  assert.deepEqual([w32Hard.shouldCompact, w32Hard.mustProgress], [true, true]);
  assert.equal(next({ ...w32, totalTokens: 21_000, fixedTokens: 5_000 }).shouldCompact, true);
});

test("breaker and thrash guard only gate [soft, hard); ≥ hard always progresses", () => {
  for (const guard of [{ failureStreak: 2 }, { thrashing: true }]) {
    assert.equal(next({ totalTokens: 125_999, ...guard }).reason, "circuit-open");
    const atHard = next({ totalTokens: 126_000, ...guard });
    assert.equal(atHard.shouldCompact, true);
    assert.equal(atHard.mustProgress, true);
  }
  assert.equal(next({ totalTokens: 120_000, failureStreak: 1 }).shouldCompact, true);
  // forkFits：total + 2k ≤ inputCap(136k)，否则从 transcript 开始。
  assert.equal(next({ totalTokens: 134_000 }).startAt, "fork");
  assert.equal(next({ totalTokens: 134_001 }).startAt, "transcript");
});

test("retained budget, first-event budget and fatal classifier", () => {
  assert.equal(policy.retainedBudgetTokens(116_000, 10_000, 3_000, false), 20_000);
  assert.equal(policy.retainedBudgetTokens(40_000, 10_000, 3_000, false), 7_000);
  assert.equal(policy.retainedBudgetTokens(40_000, 30_000, 3_000, false), 0);
  assert.equal(policy.retainedBudgetTokens(116_000, 10_000, 3_000, true), 0);

  assert.equal(policy.firstEventBudgetMs(0, undefined), 60_000);
  assert.equal(policy.firstEventBudgetMs(100_000, "medium"), 90_000);
  assert.equal(policy.firstEventBudgetMs(100_001, "high"), 180_000);
  assert.equal(policy.firstEventBudgetMs(250_000, "xhigh"), 210_000);
  assert.equal(policy.firstEventBudgetMs(900_000, "high"), 300_000);

  assert.deepEqual(
    [policy.IDLE_TIMEOUT_MS, policy.DEADLINE_MANUAL_MS, policy.DEADLINE_AUTO_MS],
    [180_000, 270_000, 600_000],
  );
  assert.equal(policy.TRANSCRIPT_MIN_REMAINING_MS, 45_000);

  for (const fatal of [
    "401 Unauthorized",
    "HTTP 403 forbidden",
    "402 Payment Required",
    "Invalid API key provided",
    "insufficient_quota",
    "You exceeded your current quota exceeded",
    "billing hard limit reached",
  ]) {
    assert.equal(policy.isFatalProviderError(fatal), true, fatal);
  }
  for (const transient of ["502 bad gateway", "stream stalled: no events", "40100 tokens", undefined]) {
    assert.equal(policy.isFatalProviderError(transient), false, String(transient));
  }
});
