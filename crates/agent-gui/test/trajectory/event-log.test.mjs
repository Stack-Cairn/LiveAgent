import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  buildTrajectoryLedger,
  mergeTrajectoryEventWindows,
  parseTrajectoryEvents,
  trajectoryLiveEventIdentities,
} = loader.loadModule("@liveagent/ui/lib/trajectory/eventLog.ts");

const BASE = 1_700_000_000_000;

function turnEvents({ turn = 1, step = 1 } = {}) {
  return [
    { k: "user", t: turn, at: BASE, tx: "hello" },
    { k: "step_start", t: turn, s: step, at: BASE + 10, hid: "h_a" },
    { k: "first_token", t: turn, s: step, at: BASE + 40 },
    { k: "step_end", t: turn, s: step, at: BASE + 100, st: "complete", u: { output: 12 } },
  ];
}

test("converges regardless of arrival order", () => {
  const ordered = buildTrajectoryLedger(turnEvents());
  const shuffled = buildTrajectoryLedger([...turnEvents()].reverse());
  assert.deepEqual(shuffled, ordered);
});

test("legacy and id-enriched copies of one user event converge to the enriched event", () => {
  const legacy = { k: "user", t: 7, at: BASE, mi: 42, tx: "question" };
  const enriched = { ...legacy, id: "user-42" };
  const forward = buildTrajectoryLedger([legacy, enriched]);
  const reversed = buildTrajectoryLedger([enriched, legacy]);
  assert.deepEqual(reversed, forward);
  assert.equal(forward.turns[0].inputs.length, 1);
  assert.equal(forward.turns[0].inputs[0].messageId, "user-42");
});

test("applying the same event twice is a no-op", () => {
  const once = buildTrajectoryLedger(turnEvents());
  const twice = buildTrajectoryLedger([...turnEvents(), ...turnEvents()]);
  assert.deepEqual(twice, once);
});

test("pairs tool_end that arrives before its tool_start", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    { k: "tool_end", at: BASE + 300, id: "c1", err: false, sum: "ok" },
    { k: "tool_start", t: 1, s: 1, at: BASE + 200, id: "c1", n: "Bash" },
    { k: "turn_end", t: 1, at: BASE + 400, st: "complete" },
  ]);
  const tool = ledger.turns[0].steps[0].tools[0];
  assert.equal(tool.callId, "c1");
  assert.equal(tool.name, "Bash");
  assert.equal(tool.startedAt, BASE + 200);
  assert.equal(tool.endedAt, BASE + 300);
  assert.equal(tool.status, "complete");
  assert.equal(tool.summary, "ok");
});

test("drops a tool_end whose tool_start never appears", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    { k: "tool_end", at: BASE + 300, id: "ghost" },
  ]);
  assert.equal(ledger.turns[0].steps[0].tools.length, 0);
});

test("an unclosed turn is running, its unclosed tool is running too", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    { k: "step_start", t: 1, s: 2, at: BASE + 150 },
    { k: "tool_start", t: 1, s: 2, at: BASE + 200, id: "c1", n: "Bash" },
  ]);
  assert.equal(ledger.turns[0].status, "running");
  const step2 = ledger.turns[0].steps[1];
  assert.equal(step2.status, "running");
  assert.equal(step2.tools[0].status, "running");
});

test("a turn that ended marks its unclosed tool aborted", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    { k: "tool_start", t: 1, s: 1, at: BASE + 200, id: "c1", n: "Bash" },
    { k: "turn_end", t: 1, at: BASE + 400, st: "aborted" },
  ]);
  assert.equal(ledger.turns[0].status, "aborted");
  assert.equal(ledger.turns[0].steps[0].tools[0].status, "aborted");
});

test("a legacy turn-level provider error is inherited by the last unclosed model step", () => {
  const ledger = buildTrajectoryLedger([
    { k: "user", t: 1, at: BASE, tx: "question" },
    { k: "step_start", t: 1, s: 1, at: BASE + 10, hid: "h_provider" },
    { k: "turn_end", t: 1, at: BASE + 20, st: "error", err: "provider exploded" },
  ]);

  assert.equal(ledger.turns[0].status, "error");
  assert.equal(ledger.turns[0].steps[0].status, "error");
  assert.equal(ledger.turns[0].steps[0].error, "provider exploded");
});

test("a step superseded by a later step cannot stay running", () => {
  const ledger = buildTrajectoryLedger([
    { k: "step_start", t: 1, s: 1, at: BASE },
    { k: "step_start", t: 1, s: 2, at: BASE + 100 },
  ]);
  assert.equal(ledger.turns[0].steps[0].status, "aborted");
  assert.equal(ledger.turns[0].steps[1].status, "running");
});

test("pairs compaction start/end without ids and keeps standalone ones apart", () => {
  const ledger = buildTrajectoryLedger([
    { k: "compaction_start", t: 1, at: BASE + 10 },
    { k: "compaction_end", t: 1, at: BASE + 60, st: "complete", before: 90_000, after: 12_000 },
    { k: "compaction_start", t: null, at: BASE + 500 },
    { k: "compaction_end", t: null, at: BASE + 560, st: "complete" },
  ]);
  const owned = ledger.turns[0].compactions[0];
  assert.equal(owned.status, "complete");
  assert.equal(owned.tokensBefore, 90_000);
  assert.equal(owned.tokensAfter, 12_000);
  assert.equal(ledger.standaloneCompactions.length, 1);
  assert.equal(ledger.standaloneCompactions[0].turn, null);
});

test("retries are deduplicated by attempt and sorted", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    { k: "retry", t: 1, s: 1, at: BASE + 70, n: 2, max: 3 },
    { k: "retry", t: 1, s: 1, at: BASE + 50, n: 1, max: 3 },
    { k: "retry", t: 1, s: 1, at: BASE + 70, n: 2, max: 3 },
  ]);
  const retries = ledger.turns[0].steps[0].retries;
  assert.deepEqual(
    retries.map((entry) => entry.attempt),
    [1, 2],
  );
});

test("retry provider labels survive into the ledger", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    { k: "retry", t: 1, s: 1, at: BASE + 50, n: 1, max: 3, p: "P1 · claude-x", delay: 200 },
  ]);
  const retry = ledger.turns[0].steps[0].retries[0];
  assert.equal(retry.provider, "P1 · claude-x");
  assert.equal(retry.delayMs, 200);
});

test("failover 后各候选的重试按发生时刻排序，不按 attempt 交错", () => {
  // 真实时间线:P1 重试 1 → P1 重试 2 → failover 切到 P2 → P2 重试 1。
  // 各候选的 withStreamRetry attempt 独立从 1 起,按 attempt 排会得到
  // P1/1, P2/1, P1/2 的交错;账本必须还原时间线。
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    { k: "retry", t: 1, s: 1, at: BASE + 50, n: 1, max: 5, p: "P1 · claude-x" },
    { k: "retry", t: 1, s: 1, at: BASE + 80, n: 2, max: 5, p: "P1 · claude-x" },
    { k: "failover", t: 1, s: 1, at: BASE + 90, n: 1, from: "P1 · claude-x", to: "P2 · gpt-y", ti: 1 },
    { k: "retry", t: 1, s: 1, at: BASE + 95, n: 1, max: 5, p: "P2 · gpt-y" },
  ]);
  const retries = ledger.turns[0].steps[0].retries;
  assert.deepEqual(
    retries.map((entry) => `${entry.provider}#${entry.attempt}`),
    ["P1 · claude-x#1", "P1 · claude-x#2", "P2 · gpt-y#1"],
  );
});

test("failover events converge into the owning step sorted by attempt", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    {
      k: "failover",
      t: 1,
      s: 1,
      at: BASE + 60,
      n: 2,
      from: "P2 · claude-x",
      to: "P3 · gpt-y",
      ti: 2,
    },
    {
      k: "failover",
      t: 1,
      s: 1,
      at: BASE + 30,
      n: 1,
      from: "P1 · claude-x",
      to: "P2 · claude-x",
      ti: 1,
      err: "503 from primary",
    },
    // 重复投递(实时+落盘)收敛为一条。
    {
      k: "failover",
      t: 1,
      s: 1,
      at: BASE + 30,
      n: 1,
      from: "P1 · claude-x",
      to: "P2 · claude-x",
      ti: 1,
      err: "503 from primary",
    },
  ]);
  const failovers = ledger.turns[0].steps[0].failovers;
  assert.equal(failovers.length, 2);
  assert.deepEqual(
    failovers.map((entry) => entry.attempt),
    [1, 2],
  );
  assert.equal(failovers[0].fromLabel, "P1 · claude-x");
  assert.equal(failovers[0].toLabel, "P2 · claude-x");
  assert.equal(failovers[0].targetIndex, 1);
  assert.equal(failovers[0].error, "503 from primary");
  assert.equal(failovers[1].targetIndex, 2);
});

test("transport snapshots keep per-candidate independence in the ledger", () => {
  const ledger = buildTrajectoryLedger([
    ...turnEvents(),
    {
      k: "transport",
      t: 1,
      s: 1,
      at: BASE + 15,
      p: "P1 · claude-x",
      o: "https://api.primary.example",
      sp: true,
      fu: false,
      hn: ["x-liveagent-proxy-token", "x-liveagent-upstream-origin", "x-liveagent-use-system-proxy"],
    },
    {
      k: "transport",
      t: 1,
      s: 1,
      at: BASE + 35,
      p: "P2 · claude-x",
      o: "https://api.fallback.example",
      sp: false,
      fu: false,
      hn: ["x-liveagent-proxy-token", "x-liveagent-upstream-origin"],
    },
  ]);
  const transports = ledger.turns[0].steps[0].transports;
  assert.equal(transports.length, 2);
  assert.equal(transports[0].useSystemProxy, true);
  assert.equal(transports[1].useSystemProxy, false);
  assert.ok(transports[0].headerNames.includes("x-liveagent-use-system-proxy"));
  assert.ok(!transports[1].headerNames.includes("x-liveagent-use-system-proxy"));
});

test("failover and transport events converge order-independently like all others", () => {
  const events = [
    ...turnEvents(),
    { k: "transport", t: 1, s: 1, at: BASE + 15, p: "P1", sp: true, fu: false, hn: ["a"] },
    { k: "failover", t: 1, s: 1, at: BASE + 30, n: 1, from: "P1", to: "P2", ti: 1 },
  ];
  const ordered = buildTrajectoryLedger(events);
  const shuffled = buildTrajectoryLedger([...events].reverse());
  assert.deepEqual(shuffled, ordered);
});

test("hasTiming stays false when no operation carried a timestamp", () => {
  const ledger = buildTrajectoryLedger([{ k: "user", t: 1, at: Number.NaN }]);
  assert.equal(ledger.hasTiming, false);
});

test("exact header replays deduplicate while preserving the content id", () => {
  const header = {
    k: "header",
    at: BASE,
    hid: "h_a",
    sec: ["s_1", null, null, null, null, "s_2"],
    ch: "initial",
  };
  const ledger = buildTrajectoryLedger([header, header]);
  assert.equal(ledger.headers.size, 1);
  const [stored] = ledger.headers.values();
  assert.equal(stored.contentId, "h_a");
  assert.equal(stored.change, "initial");
});

test("header occurrences survive an A to B to A transition", () => {
  const events = [
    { k: "header", at: BASE, hid: "h_a", sec: ["s_a", null, null, null, null, null], ch: "initial" },
    { k: "step_start", t: 1, s: 1, at: BASE + 1, hid: "h_a" },
    { k: "header", at: BASE + 10, hid: "h_b", sec: ["s_b", null, null, null, null, null], ch: "system", prev: "h_a" },
    { k: "step_start", t: 1, s: 2, at: BASE + 11, hid: "h_b" },
    { k: "header", at: BASE + 20, hid: "h_a", sec: ["s_a", null, null, null, null, null], ch: "system", prev: "h_b" },
    { k: "step_start", t: 1, s: 3, at: BASE + 21, hid: "h_a" },
  ];
  const ledger = buildTrajectoryLedger(events);
  assert.equal(ledger.headers.size, 3);
  const [first, second, third] = ledger.turns[0].steps.map((step) =>
    ledger.headers.get(step.headerId),
  );
  assert.equal(first.contentId, "h_a");
  assert.equal(second.contentId, "h_b");
  assert.equal(third.contentId, "h_a");
  assert.notEqual(first.headerId, third.headerId);
  assert.equal(third.previousHeaderId, second.headerId);
});

test("malformed persisted json degrades to an empty segment", () => {
  assert.deepEqual(parseTrajectoryEvents("not json"), []);
  assert.deepEqual(parseTrajectoryEvents(""), []);
  assert.deepEqual(parseTrajectoryEvents(null), []);
  assert.deepEqual(parseTrajectoryEvents('{"k":"user"}'), []);
  assert.deepEqual(parseTrajectoryEvents('[{"k":"user","t":1,"at":1}]'), [
    { k: "user", t: 1, at: 1 },
  ]);
});

test("ignores non-object entries instead of throwing", () => {
  const ledger = buildTrajectoryLedger([null, undefined, 42, "x", ...turnEvents()]);
  assert.equal(ledger.turns.length, 1);
});

test("distinct inputs at the same millisecond are not collapsed", () => {
  const ledger = buildTrajectoryLedger([
    { k: "user", t: 1, at: BASE, mi: 0, id: "user-1", tx: "question" },
    { k: "context", t: 1, at: BASE, src: "memory", tx: "memory A" },
    { k: "context", t: 1, at: BASE, src: "skill", tx: "skill B" },
  ]);
  assert.equal(ledger.turns[0].inputs[0].messageId, "user-1");
  assert.deepEqual(
    ledger.turns[0].inputs.map((input) => [input.kind, input.source, input.text]),
    [
      ["user", undefined, "question"],
      ["context", "memory", "memory A"],
      ["context", "skill", "skill B"],
    ],
  );
});

test("legacy tool_end events pair correctly when a provider reuses call ids across turns", () => {
  const ledger = buildTrajectoryLedger([
    { k: "user", t: 1, at: BASE, mi: 0 },
    { k: "step_start", t: 1, s: 1, at: BASE + 1 },
    { k: "tool_start", t: 1, s: 1, at: BASE + 2, id: "call_1", n: "Read" },
    { k: "tool_end", at: BASE + 3, id: "call_1", sum: "first" },
    { k: "step_end", t: 1, s: 1, at: BASE + 4, st: "complete" },
    { k: "turn_end", t: 1, at: BASE + 5, st: "complete" },
    { k: "user", t: 2, at: BASE + 10, mi: 2 },
    { k: "step_start", t: 2, s: 1, at: BASE + 11 },
    { k: "tool_start", t: 2, s: 1, at: BASE + 12, id: "call_1", n: "Read" },
    { k: "tool_end", at: BASE + 13, id: "call_1", sum: "second" },
    { k: "step_end", t: 2, s: 1, at: BASE + 14, st: "complete" },
    { k: "turn_end", t: 2, at: BASE + 15, st: "complete" },
  ]);

  assert.equal(ledger.turns[0].steps[0].tools[0].summary, "first");
  assert.equal(ledger.turns[1].steps[0].tools[0].summary, "second");
  assert.equal(ledger.turns[0].steps[0].tools[0].status, "complete");
  assert.equal(ledger.turns[1].steps[0].tools[0].status, "complete");
});

// ---------------------------------------------------------------------------
// liveIdentities 中断收敛：崩溃/强退后遗留的 running 不再永久悬挂。
// ---------------------------------------------------------------------------

function crashedAndLiveEvents() {
  return [
    // turn 1：完整结束（任何模式下都必须保持 complete）。
    { k: "user", t: 1, at: BASE, tx: "done turn" },
    { k: "step_start", t: 1, s: 1, at: BASE + 10 },
    { k: "tool_start", t: 1, s: 1, at: BASE + 20, id: "c-ok", n: "Read" },
    { k: "tool_end", at: BASE + 30, id: "c-ok" },
    { k: "step_end", t: 1, s: 1, at: BASE + 40, st: "complete" },
    { k: "turn_end", t: 1, at: BASE + 50, st: "complete" },
    // turn 2：进程崩溃 —— 有开头没有终态，也不在 live 流里。
    { k: "user", t: 2, at: BASE + 100, tx: "crashed turn" },
    { k: "step_start", t: 2, s: 1, at: BASE + 110 },
    { k: "tool_start", t: 2, s: 1, at: BASE + 120, id: "c-dead", n: "Bash" },
    // 崩溃前遗留的独立手动压缩（t=null，无 compaction_end）。
    { k: "compaction_start", t: null, at: BASE + 130 },
    // turn 3：本进程正在运行 —— 全部在 live 流里，必须保持 running。
    { k: "user", t: 3, at: BASE + 200, tx: "live turn" },
    { k: "step_start", t: 3, s: 1, at: BASE + 210 },
    { k: "tool_start", t: 3, s: 1, at: BASE + 220, id: "c-live", n: "Grep" },
  ];
}

test("entries without live coverage converge to aborted when liveIdentities is provided", () => {
  const events = crashedAndLiveEvents();
  const liveEvents = events.filter((event) => event.t === 3);
  const ledger = buildTrajectoryLedger(events, {
    liveIdentities: trajectoryLiveEventIdentities(liveEvents),
  });

  const crashedTurn = ledger.turns.find((turn) => turn.turn === 2);
  assert.equal(crashedTurn.status, "aborted");
  assert.equal(crashedTurn.steps[0].status, "aborted");
  assert.equal(crashedTurn.steps[0].tools[0].status, "aborted");

  const liveTurn = ledger.turns.find((turn) => turn.turn === 3);
  assert.equal(liveTurn.status, "running");
  assert.equal(liveTurn.steps[0].status, "running");
  assert.equal(liveTurn.steps[0].tools[0].status, "running");

  // 独立压缩不在 live 流里 → aborted；完整 turn 1 的终态不受影响。
  assert.equal(ledger.standaloneCompactions[0].status, "aborted");
  assert.equal(ledger.turns[0].status, "complete");
});

test("an empty live identity set converges every running entry (fresh process after restart)", () => {
  const ledger = buildTrajectoryLedger(crashedAndLiveEvents(), {
    liveIdentities: trajectoryLiveEventIdentities([]),
  });
  for (const turn of ledger.turns) {
    if (turn.status === "complete") continue;
    assert.equal(turn.status, "aborted");
  }
  assert.equal(ledger.standaloneCompactions[0].status, "aborted");
});

test("without liveIdentities the legacy behavior is unchanged", () => {
  const ledger = buildTrajectoryLedger(crashedAndLiveEvents());
  assert.equal(ledger.turns.find((turn) => turn.turn === 2).status, "running");
  assert.equal(ledger.standaloneCompactions[0].status, "running");
});

test("mergeTrajectoryEventWindows dedups by convergence identity and keeps enriched copies", () => {
  const enriched = { k: "user", t: 1, at: BASE, mi: 0, id: "u-1", tx: "hi" };
  const legacy = { k: "user", t: 1, at: BASE, mi: 0, tx: "hi" };
  const olderPage = [
    { k: "user", t: 0, at: BASE - 100, tx: "older" },
    { k: "turn_end", t: 0, at: BASE - 50, st: "complete" },
  ];
  const tail = [enriched, { k: "turn_end", t: 1, at: BASE + 10, st: "complete" }];

  const merged = mergeTrajectoryEventWindows(olderPage, [...tail, legacy]);
  assert.equal(merged.length, 4);
  assert.ok(merged.some((event) => event.k === "user" && event.id === "u-1"));

  // 合并结果与一次全量读取在账本层完全等价。
  assert.deepEqual(
    buildTrajectoryLedger(merged),
    buildTrajectoryLedger([...olderPage, ...tail, legacy]),
  );
});
