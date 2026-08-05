import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const policy = loader.loadModule("src/lib/chat/compaction/policy.ts");

const NOW = 1_700_000_000_000;
const modelConfig = { contextWindow: 200_000, maxOutputToken: 32_000 };

function decide(overrides = {}) {
  return policy.decideCompaction({
    providerId: "anthropic",
    intent: "optimization",
    totalTokens: 0,
    modelConfig,
    activeMessageCount: 10,
    userMessageCount: 5,
    lastCompactionAt: 0,
    pressure: policy.createCompactionPressure(),
    inFlight: false,
    now: NOW,
    ...overrides,
  });
}

test("threshold: codex uses the full context window, others reserve output buffer", () => {
  assert.deepEqual(
    policy.resolveCompactionThreshold({
      providerId: "codex",
      intent: "protection",
      contextWindow: 200_000,
      maxOutputToken: 32_000,
      pressureLevel: 0,
    }),
    { threshold: 200_000, thresholdMode: "context-window" },
  );

  assert.equal(
    policy.resolveCompactionThreshold({
      providerId: "anthropic",
      intent: "optimization",
      contextWindow: 200_000,
      maxOutputToken: 32_000,
      pressureLevel: 0,
    }).threshold,
    200_000 - 32_000 * 1.5,
  );

  assert.equal(
    policy.resolveCompactionThreshold({
      providerId: "anthropic",
      intent: "protection",
      contextWindow: 200_000,
      maxOutputToken: 32_000,
      pressureLevel: 0,
    }).threshold,
    200_000 - 32_000 * 1.2,
  );
});

test("threshold: sustained pressure pins the protection factor to 1.0", () => {
  const pinned = policy.resolveCompactionThreshold({
    providerId: "anthropic",
    intent: "protection",
    contextWindow: 200_000,
    maxOutputToken: 32_000,
    pressureLevel: 2,
  });
  assert.equal(pinned.threshold, 200_000 - 32_000);

  const optimizationUnchanged = policy.resolveCompactionThreshold({
    providerId: "anthropic",
    intent: "optimization",
    contextWindow: 200_000,
    maxOutputToken: 32_000,
    pressureLevel: 2,
  });
  assert.equal(optimizationUnchanged.threshold, 200_000 - 32_000 * 1.5);
});

test("decideCompaction covers every reason", () => {
  assert.equal(decide({ modelConfig: undefined }).reason, "disabled");
  assert.equal(decide({ activeMessageCount: 0, totalTokens: 999_999 }).reason, "no-active-messages");
  assert.equal(decide({ inFlight: true, totalTokens: 999_999 }).reason, "in-flight");
  assert.equal(decide({ totalTokens: 10_000 }).reason, "below-threshold");

  const cooldown = decide({
    totalTokens: 199_000,
    lastCompactionAt: NOW - 30_000,
    userMessageCount: 1,
  });
  assert.equal(cooldown.reason, "cooldown");
  assert.equal(cooldown.shouldCompact, false);

  // 冷却窗内但用户消息已足量 → 允许压缩（防超大单轮卡死）。
  assert.equal(
    decide({ totalTokens: 199_000, lastCompactionAt: NOW - 30_000, userMessageCount: 3 }).reason,
    "threshold-exceeded",
  );

  const fire = decide({ totalTokens: 199_000 });
  assert.equal(fire.shouldCompact, true);
  assert.equal(fire.reason, "threshold-exceeded");
  assert.equal(fire.threshold, 152_000);
});

test("pressure escalates on consecutive ineffective compactions and resets on an effective one", () => {
  let pressure = policy.createCompactionPressure();
  assert.equal(pressure.level, 0);

  // 压缩后仍高于阈值 90% = 低效。
  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW,
  });
  assert.equal(pressure.level, 1);
  assert.equal(pressure.consecutiveIneffective, 1);
  assert.equal(pressure.compactionsApplied, 1);

  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW + 1000,
  });
  assert.equal(pressure.level, 2);

  // 永不硬拒：第 3 次低效仍停在最高档而不是禁止压缩。
  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW + 2000,
  });
  assert.equal(pressure.level, 2);
  assert.equal(pressure.consecutiveIneffective, 3);

  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 20_000,
    threshold: 160_000,
    now: NOW + 3000,
  });
  assert.equal(pressure.level, 0);
  assert.equal(pressure.consecutiveIneffective, 0);
  assert.equal(pressure.compactionsApplied, 4);
});

test("pressure decays outside the recent-compaction window", () => {
  let pressure = policy.notePressureAfterCompaction(policy.createCompactionPressure(), {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW,
  });
  pressure = policy.notePressureAfterCompaction(pressure, {
    totalTokensAfter: 150_000,
    threshold: 160_000,
    now: NOW + 1000,
  });
  assert.equal(pressure.level, 2);

  const withinWindow = policy.normalizeCompactionPressure(pressure, NOW + 2 * 60_000);
  assert.equal(withinWindow.level, 2);

  const decayed = policy.normalizeCompactionPressure(pressure, NOW + 6 * 60_000);
  assert.equal(decayed.level, 0);
  assert.equal(decayed.consecutiveIneffective, 0);
  assert.equal(decayed.compactionsApplied, 2);
});

test("prune options escalate with pressure level", () => {
  const level0 = policy.resolvePruneOptions(policy.createCompactionPressure());
  assert.deepEqual(level0, {
    minimumReleasedTokens: 20_000,
    protectedToolTokens: 40_000,
    protectedRecentUserTurns: 2,
  });

  const level1 = policy.resolvePruneOptions({
    level: 1,
    consecutiveIneffective: 1,
    compactionsApplied: 1,
    lastCompactionAt: NOW,
  });
  assert.equal(level1.protectedToolTokens, 20_000);
  assert.equal(level1.protectedRecentUserTurns, 2);

  const level2 = policy.resolvePruneOptions({
    level: 2,
    consecutiveIneffective: 2,
    compactionsApplied: 2,
    lastCompactionAt: NOW,
  });
  assert.equal(level2.protectedToolTokens, 10_000);
  assert.equal(level2.protectedRecentUserTurns, 1);
});

test("prune-first fires on recent compaction or raised pressure; advisory at max level", () => {
  const fresh = policy.createCompactionPressure();
  assert.equal(policy.shouldPruneBeforeCompaction(fresh, NOW), false);

  const recent = { ...fresh, compactionsApplied: 1, lastCompactionAt: NOW - 2 * 60_000 };
  assert.equal(policy.shouldPruneBeforeCompaction(recent, NOW), true);

  const stale = { ...fresh, compactionsApplied: 1, lastCompactionAt: NOW - 10 * 60_000 };
  assert.equal(policy.shouldPruneBeforeCompaction(stale, NOW), false);

  assert.equal(policy.isNearModelLimit(fresh), false);
  assert.equal(
    policy.isNearModelLimit({ ...fresh, level: 2, consecutiveIneffective: 2 }),
    true,
  );
});
