import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildTrajectoryLedger } = loader.loadModule("@liveagent/ui/lib/trajectory/eventLog.ts");
const {
  aggregateTrajectoryStats,
  formatStatCount,
  formatStatDuration,
  formatStatLatency,
  formatStatPercent,
  formatStatThroughput,
  formatStatTokens,
  hasConversationStats,
  resolveStatDurations,
} = loader.loadModule("@liveagent/ui/lib/trajectory/stats.ts");

const BASE = 1_700_000_000_000;

/** 手工算好的黄金样例：两轮，第二轮两步带一次工具调用。 */
function goldenEvents() {
  return [
    // turn 1: 单步，1s 起 TTFT 200ms，结束于 +2000ms，output 100 tok
    { k: "user", t: 1, at: BASE, tx: "hi" },
    { k: "step_start", t: 1, s: 1, at: BASE + 1_000 },
    { k: "first_token", t: 1, s: 1, at: BASE + 1_200 },
    {
      k: "step_end",
      t: 1,
      s: 1,
      at: BASE + 3_000,
      st: "complete",
      u: { input: 500, output: 100, cacheRead: 1_500, cacheWrite: 200 },
    },
    { k: "turn_end", t: 1, at: BASE + 3_100, st: "complete" },
    // turn 2 step 1: 带工具调用 (600ms)，TTFT 400ms，step 时长 2000ms，output 60
    { k: "user", t: 2, at: BASE + 4_000, tx: "again" },
    { k: "step_start", t: 2, s: 1, at: BASE + 4_100 },
    { k: "first_token", t: 2, s: 1, at: BASE + 4_500 },
    { k: "tool_start", t: 2, s: 1, at: BASE + 5_000, id: "c1", n: "Read" },
    { k: "tool_end", t: 2, s: 1, at: BASE + 5_600, id: "c1" },
    {
      k: "step_end",
      t: 2,
      s: 1,
      at: BASE + 6_100,
      st: "complete",
      u: { input: 800, output: 60, cacheRead: 2_000 },
    },
    // turn 2 step 2: 无 usage，只计步数与时长 (900ms)
    { k: "step_start", t: 2, s: 2, at: BASE + 6_200 },
    { k: "step_end", t: 2, s: 2, at: BASE + 7_100, st: "complete" },
    { k: "turn_end", t: 2, at: BASE + 7_200, st: "complete" },
  ];
}

test("golden sample: every metric matches hand-computed values", () => {
  const stats = aggregateTrajectoryStats(buildTrajectoryLedger(goldenEvents()));

  assert.equal(stats.turns, 2);
  assert.equal(stats.steps, 3);
  // 2000 + 2000 + 900
  assert.equal(stats.llmMs, 4_900);
  assert.equal(stats.llmRunningSinceAt, null);
  assert.equal(stats.toolMs, 600);
  assert.equal(stats.toolRunningSinceAt, null);
  // (200 + 400) / 2
  assert.equal(stats.ttftAvgMs, 300);
  assert.equal(stats.ttftSamples, 2);
  // input = (500+1500+200) + (800+2000) = 5000
  assert.equal(stats.inputTokens, 5_000);
  assert.equal(stats.outputTokens, 160);
  // cacheRead 3500 / prompt 5000
  assert.equal(stats.cacheHitRatio, 0.7);
  // decode: 100 tok / 1800ms + 60 tok / 1600ms → 160 tok / 3400ms
  assert.equal(stats.decodeTokPerSec, (160 * 1000) / 3_400);
  assert.equal(stats.compactions, 0);
  assert.equal(stats.approximate, false);
});

test("aggregation is idempotent under shuffled and duplicated replay", () => {
  const ordered = aggregateTrajectoryStats(buildTrajectoryLedger(goldenEvents()));
  const events = goldenEvents();
  const noisy = [...events].reverse().concat(events, events.slice(3, 8));
  const shuffled = aggregateTrajectoryStats(buildTrajectoryLedger(noisy));

  assert.deepEqual(shuffled, ordered);
});

test("running step and tool report start markers without inflating completed time", () => {
  const stats = aggregateTrajectoryStats(
    buildTrajectoryLedger([
      { k: "user", t: 1, at: BASE, tx: "go" },
      { k: "step_start", t: 1, s: 1, at: BASE + 100 },
      { k: "first_token", t: 1, s: 1, at: BASE + 300 },
      { k: "step_end", t: 1, s: 1, at: BASE + 1_100, st: "complete", u: { output: 10 } },
      { k: "step_start", t: 1, s: 2, at: BASE + 1_200 },
      { k: "tool_start", t: 1, s: 2, at: BASE + 1_500, id: "c9", n: "Bash" },
    ]),
  );

  assert.equal(stats.llmMs, 1_000);
  assert.equal(stats.llmRunningSinceAt, BASE + 1_200);
  assert.equal(stats.toolMs, 0);
  assert.equal(stats.toolRunningSinceAt, BASE + 1_500);

  const resolved = resolveStatDurations(stats, BASE + 2_200);
  assert.equal(resolved.llmMs, 1_000 + 1_000);
  assert.equal(resolved.toolMs, 700);
});

test("multiple running tools anchor on the earliest start", () => {
  const stats = aggregateTrajectoryStats(
    buildTrajectoryLedger([
      { k: "user", t: 1, at: BASE, tx: "go" },
      { k: "step_start", t: 1, s: 1, at: BASE + 100 },
      { k: "tool_start", t: 1, s: 1, at: BASE + 900, id: "b", n: "Bash" },
      { k: "tool_start", t: 1, s: 1, at: BASE + 400, id: "a", n: "Read" },
    ]),
  );

  assert.equal(stats.toolRunningSinceAt, BASE + 400);
});

test("an aborted step without step_end must not keep the stopwatch running", () => {
  // 崩溃/强退遗留：账本按空 live 身份集把 step 收敛成 aborted，但不会补 endedAt。
  // 按 endedAt 判定运行段会让已死会话的时长永远随心跳增长。
  const ledger = buildTrajectoryLedger(
    [
      { k: "user", t: 1, at: BASE, tx: "go" },
      { k: "step_start", t: 1, s: 1, at: BASE + 100 },
      { k: "tool_start", t: 1, s: 1, at: BASE + 200, id: "zombie", n: "Bash" },
    ],
    { liveIdentities: new Set() },
  );

  assert.equal(ledger.turns[0].steps[0].status, "aborted");
  assert.equal(ledger.turns[0].steps[0].endedAt, null, "前提：收敛为 aborted 时不补 endedAt");

  const stats = aggregateTrajectoryStats(ledger);
  assert.equal(stats.llmRunningSinceAt, null, "已中断的 step 不得再开心跳");
  assert.equal(stats.toolRunningSinceAt, null, "已中断的工具调用同理");

  // 时间推移不改变读数：秒表确实停了。
  const early = resolveStatDurations(stats, BASE + 1_000);
  const late = resolveStatDurations(stats, BASE + 9_999_000);
  assert.deepEqual(late, early);
});

test("missing usage, missing first token, and zero spans never yield NaN", () => {
  const stats = aggregateTrajectoryStats(
    buildTrajectoryLedger([
      { k: "user", t: 1, at: BASE, tx: "x" },
      // 无 usage、无 first_token
      { k: "step_start", t: 1, s: 1, at: BASE + 10 },
      { k: "step_end", t: 1, s: 1, at: BASE + 500, st: "complete" },
      // 零跨度：startedAt == endedAt，output 有值但窗口为 0，不计入吞吐
      { k: "step_start", t: 1, s: 2, at: BASE + 600 },
      { k: "step_end", t: 1, s: 2, at: BASE + 600, st: "complete", u: { output: 7 } },
    ]),
  );

  assert.equal(stats.steps, 2);
  assert.equal(stats.ttftAvgMs, null);
  assert.equal(stats.ttftSamples, 0);
  assert.equal(stats.decodeTokPerSec, null);
  assert.equal(stats.cacheHitRatio, null);
  assert.equal(stats.inputTokens, 0);
  assert.equal(stats.outputTokens, 7);
  for (const value of Object.values(stats)) {
    assert.equal(Number.isNaN(value), false);
  }
});

test("step without first token falls back to the full span for throughput", () => {
  const stats = aggregateTrajectoryStats(
    buildTrajectoryLedger([
      { k: "user", t: 1, at: BASE, tx: "x" },
      { k: "step_start", t: 1, s: 1, at: BASE },
      { k: "step_end", t: 1, s: 1, at: BASE + 2_000, st: "complete", u: { output: 50 } },
    ]),
  );

  assert.equal(stats.decodeTokPerSec, 25);
});

test("cacheWrite counts toward the cache-hit denominator and input total", () => {
  const stats = aggregateTrajectoryStats(
    buildTrajectoryLedger([
      { k: "user", t: 1, at: BASE, tx: "x" },
      { k: "step_start", t: 1, s: 1, at: BASE },
      {
        k: "step_end",
        t: 1,
        s: 1,
        at: BASE + 1_000,
        st: "complete",
        u: { input: 100, cacheRead: 300, cacheWrite: 600 },
      },
    ]),
  );

  assert.equal(stats.inputTokens, 1_000);
  assert.equal(stats.cacheHitRatio, 0.3);
});

test("compactions count both in-turn and standalone occurrences", () => {
  const stats = aggregateTrajectoryStats(
    buildTrajectoryLedger([
      { k: "user", t: 1, at: BASE, tx: "x" },
      { k: "step_start", t: 1, s: 1, at: BASE },
      { k: "compaction_start", t: 1, at: BASE + 100 },
      { k: "compaction_end", t: 1, at: BASE + 200, st: "complete", before: 900, after: 300 },
      { k: "step_end", t: 1, s: 1, at: BASE + 400, st: "complete" },
      { k: "compaction_start", t: null, at: BASE + 900 },
      { k: "compaction_end", t: null, at: BASE + 950, st: "complete" },
    ]),
  );

  assert.equal(stats.compactions, 2);
});

test("approximate flag is carried through from the loader", () => {
  const ledger = buildTrajectoryLedger(goldenEvents());
  assert.equal(aggregateTrajectoryStats(ledger, { approximate: true }).approximate, true);
});

test("empty ledger yields no displayable stats", () => {
  const stats = aggregateTrajectoryStats(buildTrajectoryLedger([]));
  assert.equal(stats.turns, 0);
  assert.equal(hasConversationStats(stats), false);
  assert.equal(hasConversationStats(null), false);
  assert.equal(hasConversationStats(aggregateTrajectoryStats(buildTrajectoryLedger(goldenEvents()))), true);
});

test("duration formatting covers the documented breakpoints", () => {
  assert.equal(formatStatDuration(0), "0s");
  assert.equal(formatStatDuration(-5), "0s");
  assert.equal(formatStatDuration(42_000), "42s");
  assert.equal(formatStatDuration(59_999), "59s");
  assert.equal(formatStatDuration(60_000), "1m00s");
  assert.equal(formatStatDuration(754_000), "12m34s");
  assert.equal(formatStatDuration(3_599_000), "59m59s");
  assert.equal(formatStatDuration(3_600_000), "1h00m");
  assert.equal(formatStatDuration(18_360_000), "5h06m");
});

test("latency, token, and ratio formatting cover their edges", () => {
  assert.equal(formatStatLatency(0), "0ms");
  assert.equal(formatStatLatency(940), "940ms");
  assert.equal(formatStatLatency(20_900), "20.9s");

  assert.equal(formatStatTokens(0, "en-US"), "0");
  assert.equal(formatStatTokens(999, "en-US"), "999");
  assert.equal(formatStatTokens(999_000, "en-US"), "999K");
  assert.equal(formatStatTokens(1_000_000, "en-US"), "1M");
  assert.equal(formatStatTokens(111_400_000, "en-US"), "111.4M");

  assert.equal(formatStatCount(1_234, "en-US"), "1,234");
  assert.equal(formatStatThroughput(170.4), "170");
  assert.equal(formatStatThroughput(0), "0");
  assert.equal(formatStatPercent(0.854), "85");
  assert.equal(formatStatPercent(1), "100");
});
