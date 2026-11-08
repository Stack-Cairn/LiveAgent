import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

// A K-brain run is one live round spanning several model calls. Each call reports usage
// mid-run (`usageLive`), so the context ring and the stats bar move during the run.
const loader = createWebModuleLoader();
const { createTurn, applyEventToTurn } = loader.loadModule(
  "src/lib/chat/transcript/turnReducer.ts",
);
const { buildTurnRows } = loader.loadModule("src/lib/chat/transcript/rows.ts");
const { deriveContextUsageTokens, estimateTextTokenUnits } = loader.loadModule(
  "@liveagent/ui/lib/chat/contextUsage.ts",
);
const liveTrajectory = loader.loadModule("src/lib/trajectory/liveTrajectory.ts");

const usage = (input, cacheRead, output) => ({
  input,
  cacheRead,
  cacheWrite: 0,
  output,
  totalTokens: input + cacheRead + output,
});

function reduce(events) {
  let turn = createTurn({ key: "req:usage", runId: "run-usage", phase: "streaming" });
  for (const event of events) turn = applyEventToTurn(turn, event);
  return turn;
}

function assistantRound(turn) {
  const row = buildTurnRows(turn).find((candidate) => candidate.kind === "assistant");
  return row?.rounds.at(-1);
}

const toolText = "r".repeat(4_000);
const callA = { type: "tool_call", id: "read-1", name: "Read", arguments: { path: "a" }, round: 1 };
const resultA = {
  type: "tool_result",
  id: "read-1",
  name: "Read",
  content: [{ type: "text", text: toolText }],
  isError: false,
  round: 1,
};

test("a live usage report marks how many blocks of the round it covers", () => {
  const turn = reduce([
    { type: "token", text: "x".repeat(40_000), round: 1 },
    { type: "token", text: "", round: 1, usage: usage(2_000, 8_000, 200), usageLive: true },
    callA,
    resultA,
  ]);
  const round = assistantRound(turn);
  assert.equal(round.meta.usageBlockCount, 1);
  assert.equal(round.meta.usage.totalTokens, 10_200);
  const toolTokens = Math.ceil(estimateTextTokenUnits(toolText)) + 8;
  // The covered 40,000-character text is inside the report; only the tool result is added.
  assert.equal(deriveContextUsageTokens([{ kind: "assistant", rounds: [round] }]), 10_200 + toolTokens);
});

test("a later report moves the marker forward and the ring with it", () => {
  const events = [
    { type: "token", text: "step one", round: 1 },
    { type: "token", text: "", round: 1, usage: usage(2_000, 8_000, 200), usageLive: true },
    callA,
    resultA,
    { type: "token", text: "step two", round: 1 },
    { type: "token", text: "", round: 1, usage: usage(1_000, 12_000, 300), usageLive: true },
  ];
  const before = assistantRound(reduce(events.slice(0, 4)));
  const after = assistantRound(reduce(events));
  assert.equal(after.meta.usageBlockCount, after.blocks.length);
  const read = (round) => deriveContextUsageTokens([{ kind: "assistant", rounds: [round] }]);
  assert.equal(read(after), 13_300);
  assert.ok(read(after) > read(before));
});

test("a report after a tool result starts a marked entry instead of an earlier one", () => {
  const turn = reduce([
    { type: "token", text: "step one", round: 1 },
    callA,
    resultA,
    { type: "token", text: "", round: 1, usage: usage(500, 9_000, 100), usageLive: true },
  ]);
  const marked = turn.entries.filter((entry) => entry.kind === "assistant" && entry.usageMark);
  assert.equal(marked.length, 1);
  assert.equal(turn.entries.at(-1), marked[0]);
  // Final, non-live usage keeps the legacy semantics.
  const settled = reduce([
    { type: "token", text: "done", round: 1 },
    { type: "token", text: "", round: 1, usage: usage(500, 9_000, 100), stopReason: "stop" },
  ]);
  assert.equal(settled.entries.some((entry) => entry.usageMark), false);
  assert.equal(assistantRound(settled).meta.usageBlockCount, undefined);
});

test("live usage reports reload the stats bar at most once per window", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = "conv-stats";
    assert.equal(liveTrajectory.liveUsageRefreshRevision(id), 0);
    liveTrajectory.noteLiveUsageReport(id);
    assert.equal(liveTrajectory.liveUsageRefreshRevision(id), 1);
    liveTrajectory.noteLiveUsageReport(id);
    liveTrajectory.noteLiveUsageReport(id);
    assert.equal(liveTrajectory.liveUsageRefreshRevision(id), 1);
    mock.timers.tick(liveTrajectory.LIVE_USAGE_REFRESH_MS);
    assert.equal(liveTrajectory.liveUsageRefreshRevision(id), 2);
    mock.timers.tick(liveTrajectory.LIVE_USAGE_REFRESH_MS);
    assert.equal(liveTrajectory.liveUsageRefreshRevision(id), 2);
    liveTrajectory.noteLiveUsageReport(id);
    assert.equal(liveTrajectory.liveUsageRefreshRevision(id), 3);
    liveTrajectory.noteLiveUsageReport(undefined);
    liveTrajectory.clearLiveTrajectory(id);
  } finally {
    mock.timers.reset();
  }
});
