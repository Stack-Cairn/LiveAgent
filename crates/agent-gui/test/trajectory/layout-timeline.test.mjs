import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildTrajectoryLedger } = loader.loadModule("@liveagent/ui/lib/trajectory/eventLog.ts");
const { deriveTrajectoryLayout, flattenTrajectoryRecords, lastRecordIndex, stepKey } =
  loader.loadModule("@liveagent/ui/lib/trajectory/layout.ts");
const { deriveTrajectoryTimeline, trajectoryLaneFor, trajectoryTimelineFocusIndexes } =
  loader.loadModule("@liveagent/ui/lib/trajectory/timeline.ts");
const { normalizeTimelineViewport, zoomTimelineViewport } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/timelineViewport.ts",
);
const { groupTrajectoryVirtualRows } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/virtualRows.ts",
);
const { TrajectorySearchIndex, trajectorySearchMatchIndexes } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/searchIndex.ts",
);

const BASE = 1_700_000_000_000;

const HEADER_A = {
  k: "header",
  at: BASE,
  hid: "h_a",
  sec: ["s_base", null, null, "s_mem1", null, "s_tools"],
  ch: "initial",
};
const HEADER_B = {
  k: "header",
  at: BASE + 500,
  hid: "h_b",
  sec: ["s_base", null, null, "s_mem2", null, "s_tools"],
  ch: "system",
  prev: "h_a",
};

function twoTurnEvents() {
  return [
    HEADER_A,
    { k: "user", t: 1, at: BASE + 1, tx: "first ask" },
    { k: "step_start", t: 1, s: 1, at: BASE + 10, hid: "h_a" },
    { k: "first_token", t: 1, s: 1, at: BASE + 40 },
    { k: "step_end", t: 1, s: 1, at: BASE + 100, st: "complete", u: { output: 10, input: 100 } },
    { k: "tool_start", t: 1, s: 1, at: BASE + 110, id: "c1", n: "Bash" },
    { k: "tool_end", at: BASE + 210, id: "c1", err: false, sum: "listed" },
    { k: "turn_end", t: 1, at: BASE + 300, st: "complete" },
    HEADER_B,
    { k: "user", t: 2, at: BASE + 501, tx: "second ask" },
    { k: "step_start", t: 2, s: 1, at: BASE + 510, hid: "h_b" },
    { k: "step_end", t: 2, s: 1, at: BASE + 600, st: "complete", u: { output: 5, input: 120 } },
    { k: "turn_end", t: 2, at: BASE + 610, st: "complete" },
  ];
}

function layoutOf(events, extra = {}) {
  return deriveTrajectoryLayout({ ledger: buildTrajectoryLedger(events), ...extra });
}

test("the initial header becomes a leading section above turn 1", () => {
  const turns = layoutOf(twoTurnEvents());
  assert.equal(turns[0].turn, null);
  assert.equal(turns[0].groups[0].records[0].kind, "system");
  const firstHeaderId = turns[0].groups[0].records[0].headerId;
  assert.equal(buildTrajectoryLedger(twoTurnEvents()).headers.get(firstHeaderId).contentId, "h_a");
  assert.equal(turns[1].turn, 1);
});

test("a later header change lands inside the step group where it took effect", () => {
  const turns = layoutOf(twoTurnEvents());
  const secondTurn = turns.find((entry) => entry.turn === 2);
  const stepGroup = secondTurn.groups.find((group) => group.title === "Step 1");
  assert.equal(stepGroup.records[0].kind, "system");
  const ledger = buildTrajectoryLedger(twoTurnEvents());
  assert.equal(ledger.headers.get(stepGroup.records[0].headerId).contentId, "h_b");
  assert.equal(
    ledger.headers.get(stepGroup.records[0].previousHeaderId).contentId,
    "h_a",
  );
  assert.equal(stepGroup.records[1].kind, "message");
});

test("re-activating earlier header content creates a fresh SYSTEM occurrence", () => {
  const events = [
    { k: "header", at: BASE, hid: "h_a", sec: ["s_a", null, null, null, null, null], ch: "initial" },
    { k: "step_start", t: 1, s: 1, at: BASE + 1, hid: "h_a" },
    { k: "step_end", t: 1, s: 1, at: BASE + 2, st: "complete" },
    { k: "header", at: BASE + 10, hid: "h_b", sec: ["s_b", null, null, null, null, null], ch: "system", prev: "h_a" },
    { k: "step_start", t: 1, s: 2, at: BASE + 11, hid: "h_b" },
    { k: "step_end", t: 1, s: 2, at: BASE + 12, st: "complete" },
    { k: "header", at: BASE + 20, hid: "h_a", sec: ["s_a", null, null, null, null, null], ch: "system", prev: "h_b" },
    { k: "step_start", t: 1, s: 3, at: BASE + 21, hid: "h_a" },
    { k: "step_end", t: 1, s: 3, at: BASE + 22, st: "complete" },
  ];
  const ledger = buildTrajectoryLedger(events);
  const systems = flattenTrajectoryRecords(
    deriveTrajectoryLayout({ ledger }),
  ).filter((record) => record.kind === "system");
  assert.equal(systems.length, 3);
  assert.deepEqual(
    systems.map((record) => ledger.headers.get(record.headerId).contentId),
    ["h_a", "h_b", "h_a"],
  );
  assert.equal(systems[2].previousHeaderId, systems[1].headerId);
});

test("record indexes are 1-based, unique and monotonic in display order", () => {
  const records = flattenTrajectoryRecords(layoutOf(twoTurnEvents()));
  assert.deepEqual(
    records.map((record) => record.index),
    records.map((_, offset) => offset + 1),
  );
  assert.equal(lastRecordIndex(layoutOf(twoTurnEvents())), records.length);
});

test("same-millisecond context inputs have distinct stable record identities", () => {
  const records = flattenTrajectoryRecords(
    layoutOf([
      { k: "user", t: 1, at: BASE, id: "u1" },
      { k: "context", t: 1, at: BASE + 1, src: "memory", tx: "A" },
      { k: "context", t: 1, at: BASE + 1, src: "skills", tx: "B" },
    ]),
  ).filter((record) => record.kind === "context");
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.recordId)).size, 2);
});

test("context record identity survives an earlier input being prepended", () => {
  const later = { k: "context", t: 1, at: BASE + 2, src: "memory", tx: "later" };
  const tail = flattenTrajectoryRecords(layoutOf([later])).find(
    (record) => record.kind === "context",
  );
  const full = flattenTrajectoryRecords(
    layoutOf([
      { k: "context", t: 1, at: BASE + 1, src: "skills", tx: "earlier" },
      later,
    ]),
  ).find((record) => record.kind === "context" && record.text === "later");
  assert.ok(tail);
  assert.ok(full);
  assert.equal(full.recordId, tail.recordId);
});

test("record identities survive index shifts from prepended history", () => {
  const full = flattenTrajectoryRecords(layoutOf(twoTurnEvents()));
  const tail = flattenTrajectoryRecords(layoutOf(twoTurnEvents().slice(8)));
  const toolFull = full.find((record) => record.callId === "c1");
  const turnTwoFull = full.find((record) => record.kind === "message" && record.turn === 2);
  const turnTwoTail = tail.find((record) => record.kind === "message" && record.turn === 2);
  assert.ok(toolFull);
  assert.notEqual(turnTwoFull.index, turnTwoTail.index);
  assert.equal(turnTwoFull.recordId, turnTwoTail.recordId);
});

test("assistant records carry own model time and cumulative usage", () => {
  const records = flattenTrajectoryRecords(layoutOf(twoTurnEvents()));
  const [first, second] = records.filter((record) => record.kind === "message");
  assert.equal(first.timeSeconds, 0.09);
  assert.deepEqual(first.usage, { output: 10, input: 100 });
  assert.deepEqual(first.cumulativeUsage, { input: 100, output: 10 });
  assert.deepEqual(second.cumulativeUsage, { input: 220, output: 15 });
  assert.equal(first.assistantMetrics.timingRecorded, true);
  assert.equal(first.assistantMetrics.firstTokenAt, BASE + 40);
  assert.equal(second.assistantMetrics.timingRecorded, false);
});

test("tool records carry their own duration, not the step's", () => {
  const tool = flattenTrajectoryRecords(layoutOf(twoTurnEvents())).find(
    (record) => record.kind === "tool",
  );
  assert.equal(tool.timeSeconds, 0.1);
  assert.equal(tool.toolName, "Bash");
  assert.equal(tool.result, "listed");
});

test("joins content from the index instead of the event stream", () => {
  const content = {
    userByTurn: new Map([[1, { text: "first ask" }]]),
    assistantByStep: new Map([[stepKey(1, 1), { text: "here you go" }]]),
    toolByCallId: new Map([["c1", { args: '{"cmd":"ls"}', result: "a\nb" }]]),
  };
  const records = flattenTrajectoryRecords(layoutOf(twoTurnEvents(), { content }));
  assert.equal(records.find((record) => record.kind === "message").text, "here you go");
  const tool = records.find((record) => record.kind === "tool");
  assert.equal(tool.inputDetail, '{"cmd":"ls"}');
  assert.equal(tool.result, "a b");
});

test("subagent runs expand into subtool rows under their parent call", () => {
  const events = [
    { k: "user", t: 1, at: BASE, tx: "delegate" },
    { k: "step_start", t: 1, s: 1, at: BASE + 10 },
    { k: "step_end", t: 1, s: 1, at: BASE + 20, st: "complete" },
    { k: "tool_start", t: 1, s: 1, at: BASE + 30, id: "agent1", n: "Agent" },
    { k: "tool_end", at: BASE + 900, id: "agent1", run: ["run-a"] },
    { k: "turn_end", t: 1, at: BASE + 950, st: "complete" },
  ];
  const subagentRuns = [
    {
      runId: "run-a",
      agentId: "reviewer",
      status: "complete",
      startedAt: BASE + 40,
      endedAt: BASE + 880,
      steps: [
        {
          step: 1,
          startedAt: BASE + 40,
          endedAt: BASE + 400,
          tools: [{ callId: "sub1", name: "Grep", isError: false }],
        },
      ],
    },
  ];
  const records = flattenTrajectoryRecords(layoutOf(events, { subagentRuns }));
  const subtool = records.find((record) => record.kind === "subtool");
  assert.equal(subtool.toolName, "Grep");
  assert.equal(subtool.subagentRunId, "run-a");
  assert.equal(records.indexOf(subtool), records.findIndex((r) => r.callId === "agent1") + 1);
});

test("subtool rows carry per-tool timing and fall back to the step span for legacy runs", () => {
  const events = [
    { k: "user", t: 1, at: BASE, tx: "delegate" },
    { k: "step_start", t: 1, s: 1, at: BASE + 10 },
    { k: "step_end", t: 1, s: 1, at: BASE + 20, st: "complete" },
    { k: "tool_start", t: 1, s: 1, at: BASE + 30, id: "agent1", n: "Agent" },
    { k: "tool_end", at: BASE + 900, id: "agent1", run: ["run-a"] },
    { k: "turn_end", t: 1, at: BASE + 950, st: "complete" },
  ];
  const subagentRuns = [
    {
      runId: "run-a",
      agentId: "reviewer",
      status: "complete",
      startedAt: BASE + 40,
      endedAt: BASE + 880,
      steps: [
        {
          step: 1,
          startedAt: BASE + 100,
          endedAt: BASE + 800,
          tools: [
            // 新数据：工具自身有起止。
            { callId: "t-own", name: "Grep", isError: false, startedAt: BASE + 120, endedAt: BASE + 200 },
            // 新数据：有起点无终点（崩溃遗留）→ 时长为空，不借用 step 终点。
            { callId: "t-open", name: "Bash", isError: false, startedAt: BASE + 300, endedAt: null },
            // 旧数据：无任何时间字段 → 回退 step 跨度。
            { callId: "t-legacy", name: "Read", isError: false },
          ],
        },
      ],
    },
  ];
  const byCallId = new Map(
    flattenTrajectoryRecords(layoutOf(events, { subagentRuns }))
      .filter((record) => record.kind === "subtool")
      .map((record) => [record.callId, record]),
  );
  assert.equal(byCallId.size, 3);
  assert.equal(byCallId.get("t-own").timeSeconds, 0.08);
  assert.equal(byCallId.get("t-own").startedAt, BASE + 120);
  assert.equal(byCallId.get("t-open").timeSeconds, null);
  assert.equal(byCallId.get("t-open").startedAt, BASE + 300);
  assert.equal(byCallId.get("t-legacy").timeSeconds, 0.7);
  assert.equal(byCallId.get("t-legacy").startedAt, BASE + 100);
});

test("an unknown subagent run is skipped rather than throwing", () => {
  const records = flattenTrajectoryRecords(
    layoutOf([
      { k: "step_start", t: 1, s: 1, at: BASE },
      { k: "tool_start", t: 1, s: 1, at: BASE + 1, id: "a", n: "Agent" },
      { k: "tool_end", at: BASE + 2, id: "a", run: ["missing"] },
    ]),
  );
  assert.equal(records.filter((record) => record.kind === "subtool").length, 0);
});

test("compaction becomes its own group ordered by time", () => {
  const turns = layoutOf([
    { k: "user", t: 1, at: BASE },
    { k: "compaction_start", t: 1, at: BASE + 5 },
    { k: "compaction_end", t: 1, at: BASE + 8, st: "complete", before: 900, after: 100 },
    { k: "step_start", t: 1, s: 1, at: BASE + 10 },
    { k: "step_end", t: 1, s: 1, at: BASE + 20, st: "complete" },
  ]);
  const titles = turns.find((entry) => entry.turn === 1).groups.map((group) => group.title);
  assert.deepEqual(titles, ["Message", "Compaction", "Step 1"]);
  const compacted = flattenTrajectoryRecords(turns).find((record) => record.kind === "compacted");
  assert.equal(compacted.tokensBefore, 900);
  assert.equal(compacted.tokensAfter, 100);
});

test("timeline lanes follow record kind", () => {
  assert.equal(trajectoryLaneFor("user"), 0);
  assert.equal(trajectoryLaneFor("system"), 0);
  assert.equal(trajectoryLaneFor("context"), 0);
  assert.equal(trajectoryLaneFor("message"), 1);
  assert.equal(trajectoryLaneFor("compacted"), 1);
  assert.equal(trajectoryLaneFor("tool"), 2);
  assert.equal(trajectoryLaneFor("subtool"), 2);
});

test("sequence projection gives every record equal width", () => {
  const turns = layoutOf(twoTurnEvents());
  const model = deriveTrajectoryTimeline(turns, "sequence");
  assert.equal(model.start, 0);
  assert.equal(model.end, model.spans.length);
  assert.ok(model.spans.every((span) => span.end - span.start === 1));
  assert.deepEqual(
    model.turnBoundaries.map((boundary) => boundary.turn),
    [1, 2],
  );
});

test("duration projection removes idle gaps between operations", () => {
  const turns = layoutOf([
    { k: "step_start", t: 1, s: 1, at: BASE },
    { k: "step_end", t: 1, s: 1, at: BASE + 100, st: "complete" },
    // 200ms 空转后才有下一步：压缩后这段间隙必须消失。
    { k: "step_start", t: 1, s: 2, at: BASE + 300 },
    { k: "step_end", t: 1, s: 2, at: BASE + 400, st: "complete" },
    { k: "turn_end", t: 1, at: BASE + 400, st: "complete" },
  ]);
  const model = deriveTrajectoryTimeline(turns, "duration");
  assert.equal(model.end - model.start, 200);
  const [first, second] = model.spans;
  assert.equal(second.start - first.end, 0);
});

test("duration projection is empty when the ledger has no timing", () => {
  const turns = layoutOf([{ k: "user", t: 1, at: Number.NaN }]);
  assert.equal(deriveTrajectoryTimeline(turns, "duration"), null);
});

test("parallel tools in one step get separate rows in duration mode", () => {
  const turns = layoutOf([
    { k: "step_start", t: 1, s: 1, at: BASE },
    { k: "tool_start", t: 1, s: 1, at: BASE + 10, id: "a", n: "Bash" },
    { k: "tool_start", t: 1, s: 1, at: BASE + 20, id: "b", n: "Read" },
    { k: "tool_end", at: BASE + 60, id: "b" },
    { k: "tool_end", at: BASE + 120, id: "a" },
    { k: "step_end", t: 1, s: 1, at: BASE + 130, st: "complete" },
  ]);
  const model = deriveTrajectoryTimeline(turns, "duration");
  const tools = model.spans.filter((span) => span.kind === "tool");
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].row, tools[1].row);
  assert.deepEqual(model.laneRows, [1, 1, 2]);

  // sequence 模式每条记录独占单位区间，同泳道不重叠 → 恒一行。
  const sequence = deriveTrajectoryTimeline(turns, "sequence");
  assert.deepEqual(sequence.laneRows, [1, 1, 1]);
});

test("sequential tools that merely touch share one row", () => {
  const turns = layoutOf([
    { k: "step_start", t: 1, s: 1, at: BASE },
    { k: "tool_start", t: 1, s: 1, at: BASE + 10, id: "a", n: "Bash" },
    { k: "tool_end", at: BASE + 60, id: "a" },
    { k: "tool_start", t: 1, s: 1, at: BASE + 60, id: "b", n: "Read" },
    { k: "tool_end", at: BASE + 120, id: "b" },
    { k: "step_end", t: 1, s: 1, at: BASE + 130, st: "complete" },
  ]);
  const model = deriveTrajectoryTimeline(turns, "duration");
  const rows = new Set(model.spans.filter((span) => span.kind === "tool").map((span) => span.row));
  assert.equal(rows.size, 1);
  assert.equal(model.laneRows[2], 1);
});

test("duration projection reports the idle gaps it compressed", () => {
  const turns = layoutOf([
    { k: "step_start", t: 1, s: 1, at: BASE },
    { k: "step_end", t: 1, s: 1, at: BASE + 100, st: "complete" },
    { k: "step_start", t: 1, s: 2, at: BASE + 300 },
    { k: "step_end", t: 1, s: 2, at: BASE + 400, st: "complete" },
    { k: "turn_end", t: 1, at: BASE + 400, st: "complete" },
  ]);
  const model = deriveTrajectoryTimeline(turns, "duration");
  // 200ms 空转被压缩：位置 = 第一步结束的投影位置，毫秒数 = 原始间隙。
  assert.deepEqual(model.idleGaps, [{ at: BASE + 100, ms: 200 }]);
});

test("turn boundaries carry segment ends for the turn band", () => {
  const sequence = deriveTrajectoryTimeline(layoutOf(twoTurnEvents()), "sequence");
  for (const boundary of sequence.turnBoundaries) {
    assert.ok(boundary.end > boundary.time);
    assert.ok(boundary.end <= sequence.end);
  }
  const duration = deriveTrajectoryTimeline(layoutOf(twoTurnEvents()), "duration");
  assert.equal(duration.turnBoundaries.length, 2);
  const [first, second] = duration.turnBoundaries;
  // turn 1 墙钟 209ms（user@1 → tool_end@210），压缩掉 9ms+10ms 两段间隙 → 190ms。
  assert.equal(first.end - first.time, 190);
  assert.equal(second.end, duration.end);
  // 回合净活跃毫秒与投影模式无关：sequence 的 time/end 是序号，差值是记录条数，
  // 不能拿来当时长 —— activeMs 必须两模式一致，回合带数字才不会在切换模式时漂移。
  assert.equal(sequence.turnBoundaries.length, 2);
  assert.equal(first.activeMs, 190);
  assert.equal(second.activeMs, 90);
  assert.deepEqual(
    sequence.turnBoundaries.map((boundary) => boundary.activeMs),
    duration.turnBoundaries.map((boundary) => boundary.activeMs),
  );
});

test("spans carry record status for running pulse and aborted hatch", () => {
  const model = deriveTrajectoryTimeline(
    layoutOf([
      { k: "user", t: 1, at: BASE },
      { k: "step_start", t: 1, s: 1, at: BASE + 10 },
      { k: "tool_start", t: 1, s: 1, at: BASE + 20, id: "live", n: "Grep" },
    ]),
    "duration",
  );
  const running = model.spans.find((span) => span.kind === "tool");
  assert.equal(running.status, "running");
});

test("focus indexes cover records intersecting the selection", () => {
  const turns = layoutOf(twoTurnEvents());
  const all = trajectoryTimelineFocusIndexes(turns, { start: 0, end: 999 }, "sequence");
  assert.equal(all.size, flattenTrajectoryRecords(turns).length);
  const firstOnly = trajectoryTimelineFocusIndexes(turns, { start: 0, end: 0.5 }, "sequence");
  assert.deepEqual([...firstOnly], [1]);
});


test("timeline viewport clamps reversed and out-of-bounds selections", () => {
  assert.deepEqual(normalizeTimelineViewport({ start: 0, end: 10 }, { start: 12, end: 3 }), {
    start: 3,
    end: 10,
  });
  assert.deepEqual(normalizeTimelineViewport({ start: 0, end: 10 }, { start: 5, end: 5 }), {
    start: 0,
    end: 10,
  });
});

test("timeline wheel zoom keeps its pointer anchor and resets at the full domain", () => {
  const zoomed = zoomTimelineViewport({
    model: { start: 0, end: 100 },
    viewport: { start: 0, end: 100 },
    anchorFraction: 0.25,
    wheelDeltaY: -400,
    minimumSpan: 1,
  });
  assert.ok(zoomed.end - zoomed.start < 100);
  assert.ok(Math.abs(zoomed.start + (zoomed.end - zoomed.start) * 0.25 - 25) < 1e-9);
  assert.equal(
    zoomTimelineViewport({
      model: { start: 0, end: 100 },
      viewport: zoomed,
      anchorFraction: 0.5,
      wheelDeltaY: 10_000,
      minimumSpan: 1,
    }),
    null,
  );
});

test("virtual rows fold zero-height separators into the next content row", () => {
  const records = flattenTrajectoryRecords(layoutOf(twoTurnEvents()));
  const items = [
    { record: { ...records[0], requestOnly: true } },
    { record: records[1] },
    { record: records[2], collapsedSummaryKind: "turn" },
  ];
  const rows = groupTrajectoryVirtualRows(items);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entries.length, 2);
  assert.equal(rows[0].height, 30);
  assert.equal(rows[1].height, 20);
  assert.ok(rows.every((row) => row.height > 0));
});

test("a trailing separator keeps its own measurable row", () => {
  const records = flattenTrajectoryRecords(layoutOf(twoTurnEvents()));
  const rows = groupTrajectoryVirtualRows([
    { record: records[0] },
    { record: { ...records[1], requestOnly: true } },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].height, 9);
});

test("search matches across joined content and reports record indexes", () => {
  const content = {
    userByTurn: new Map(),
    assistantByStep: new Map([[stepKey(1, 1), { text: "the needle is here" }]]),
    toolByCallId: new Map(),
  };
  const turns = layoutOf(twoTurnEvents(), { content });
  const index = new TrajectorySearchIndex();
  const layouts = [turns];
  assert.equal(index.update(layouts), true);
  assert.equal(index.search(""), null);
  const matched = index.search("needle");
  assert.equal(matched.size, 1);
  const indexes = trajectorySearchMatchIndexes(layouts, matched);
  const target = flattenTrajectoryRecords(turns).find((record) => record.kind === "message");
  assert.deepEqual([...indexes], [target.index]);
});

test("search requires every term to match", () => {
  const content = {
    userByTurn: new Map(),
    assistantByStep: new Map([[stepKey(1, 1), { text: "alpha beta" }]]),
    toolByCallId: new Map(),
  };
  const index = new TrajectorySearchIndex();
  index.update([layoutOf(twoTurnEvents(), { content })]);
  assert.equal(index.search("alpha beta").size, 1);
  assert.equal(index.search("alpha gamma").size, 0);
});

test("re-updating with the same layout reference is a no-op", () => {
  const layouts = [layoutOf(twoTurnEvents())];
  const index = new TrajectorySearchIndex();
  assert.equal(index.update(layouts), true);
  assert.equal(index.update(layouts), false);
});

test("tool record identities include their turn and step when call ids are reused", () => {
  const records = flattenTrajectoryRecords(
    layoutOf([
      { k: "user", t: 1, at: BASE, mi: 0 },
      { k: "step_start", t: 1, s: 1, at: BASE + 1 },
      { k: "tool_start", t: 1, s: 1, at: BASE + 2, id: "call_1", n: "Read" },
      { k: "tool_end", t: 1, s: 1, at: BASE + 3, id: "call_1" },
      { k: "step_end", t: 1, s: 1, at: BASE + 4, st: "complete" },
      { k: "turn_end", t: 1, at: BASE + 5, st: "complete" },
      { k: "user", t: 2, at: BASE + 10, mi: 2 },
      { k: "step_start", t: 2, s: 1, at: BASE + 11 },
      { k: "tool_start", t: 2, s: 1, at: BASE + 12, id: "call_1", n: "Read" },
      { k: "tool_end", t: 2, s: 1, at: BASE + 13, id: "call_1" },
      { k: "step_end", t: 2, s: 1, at: BASE + 14, st: "complete" },
      { k: "turn_end", t: 2, at: BASE + 15, st: "complete" },
    ]),
  ).filter((record) => record.kind === "tool");
  assert.equal(records.length, 2);
  assert.notEqual(records[0].recordId, records[1].recordId);
});
