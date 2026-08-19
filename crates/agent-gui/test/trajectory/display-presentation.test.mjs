import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildTrajectoryLedger } = loader.loadModule("@liveagent/ui/lib/trajectory/eventLog.ts");
const { deriveTrajectoryLayout, flattenTrajectoryRecords } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/layout.ts",
);
const {
  buildTrajectoryDisplayItems,
  collapsibleTrajectoryAssistants,
  collapsibleTrajectoryTurns,
  trajectoryDisplayItemHeight,
} = loader.loadModule("@liveagent/ui/lib/trajectory/displayItems.ts");
const {
  formatTrajectoryDuration,
  trajectoryAssistantSegments,
  trajectoryFallbackLabelKey,
  trajectoryLedgerHasPartialTiming,
  trajectorySystemLabelKey,
  trajectoryThroughputTokensPerSecond,
} = loader.loadModule("@liveagent/ui/lib/trajectory/presentation.ts");
const { buildTrajectorySubagentRun, concatSubagentSegmentMessages, extractSubagentSteps } =
  loader.loadModule("@liveagent/ui/lib/trajectory/subagentRuns.ts");
const { toTrajectoryMessages } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/transcriptMessages.ts",
);
const {
  clampTrajectoryDetailsWidth,
  resolveTrajectoryDetailsDragWidth,
  resolveTrajectoryDetailsKeyboardWidth,
  trajectoryDetailsWidthBounds,
} = loader.loadModule("@liveagent/ui/lib/trajectory/detailsResize.ts");
const { conversationViewForId, updateConversationViewState } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/conversationViewState.ts",
);

const BASE = 1_700_000_000_000;

function twoTurnLayout() {
  return deriveTrajectoryLayout({
    ledger: buildTrajectoryLedger([
      { k: "user", t: 1, at: BASE },
      { k: "step_start", t: 1, s: 1, at: BASE + 10 },
      { k: "step_end", t: 1, s: 1, at: BASE + 20, st: "complete" },
      { k: "tool_start", t: 1, s: 1, at: BASE + 30, id: "c1", n: "Bash" },
      { k: "tool_end", at: BASE + 40, id: "c1" },
      { k: "tool_start", t: 1, s: 1, at: BASE + 50, id: "c2", n: "Read" },
      { k: "tool_end", at: BASE + 60, id: "c2" },
      { k: "turn_end", t: 1, at: BASE + 70, st: "complete" },
      { k: "user", t: 2, at: BASE + 100 },
      { k: "step_start", t: 2, s: 1, at: BASE + 110 },
      { k: "step_end", t: 2, s: 1, at: BASE + 120, st: "complete" },
      { k: "turn_end", t: 2, at: BASE + 130, st: "complete" },
    ]),
  });
}

const NO_COLLAPSE = {
  collapsedTurns: new Set(),
  collapsedAssistants: new Set(),
  searchMatchIndexes: null,
};

test("every turn gets a header row followed by its records", () => {
  const items = buildTrajectoryDisplayItems(twoTurnLayout(), NO_COLLAPSE);
  assert.equal(items[0].kind, "turnHeader");
  assert.equal(items[0].turn, 1);
  assert.equal(items[1].kind, "record");
  const headers = items.filter((item) => item.kind === "turnHeader");
  assert.deepEqual(
    headers.map((header) => header.turn),
    [1, 2],
  );
});

test("collapsing a turn keeps only its first row and reports the hidden count", () => {
  const turns = twoTurnLayout();
  const expanded = buildTrajectoryDisplayItems(turns, NO_COLLAPSE);
  const collapsed = buildTrajectoryDisplayItems(turns, {
    ...NO_COLLAPSE,
    collapsedTurns: new Set([1]),
  });
  const turnOneExpanded = expanded.filter(
    (item) => item.kind === "record" && item.record.turn === 1,
  );
  const turnOneCollapsed = collapsed.filter(
    (item) => item.kind === "record" && item.record.turn === 1,
  );
  assert.ok(turnOneExpanded.length > 1);
  assert.equal(turnOneCollapsed.length, 1);
  const header = collapsed.find((item) => item.kind === "turnHeader" && item.turn === 1);
  assert.equal(header.collapsed, true);
  assert.equal(header.hiddenCount, turnOneExpanded.length - 1);
});

test("collapsing an assistant hides the tool calls that follow it", () => {
  const turns = twoTurnLayout();
  const assistant = flattenTrajectoryRecords(turns).find(
    (record) => record.kind === "message" && record.turn === 1,
  );
  const collapsed = buildTrajectoryDisplayItems(turns, {
    ...NO_COLLAPSE,
    collapsedAssistants: new Set([assistant.recordId]),
  });
  assert.equal(collapsed.filter((item) => item.kind === "record" && item.record.kind === "tool").length, 0);
  // assistant 本身仍然可见，折叠的是它名下的调用。
  assert.ok(
    collapsed.some((item) => item.kind === "record" && item.record.recordId === assistant.recordId),
  );
});

test("search overrides collapse so a hit is never hidden", () => {
  const turns = twoTurnLayout();
  const tool = flattenTrajectoryRecords(turns).find((record) => record.kind === "tool");
  const assistant = flattenTrajectoryRecords(turns).find((record) => record.kind === "message");
  const items = buildTrajectoryDisplayItems(turns, {
    collapsedTurns: new Set([1, 2]),
    collapsedAssistants: new Set([assistant.recordId]),
    searchMatchIndexes: new Set([tool.index]),
  });
  const records = items.filter((item) => item.kind === "record");
  assert.equal(records.length, 1);
  assert.equal(records[0].record.index, tool.index);
});

test("a search with no hits yields an empty list, not a header-only list", () => {
  const items = buildTrajectoryDisplayItems(twoTurnLayout(), {
    ...NO_COLLAPSE,
    searchMatchIndexes: new Set([9999]),
  });
  assert.deepEqual(items, []);
});

test("collapsible sets only include turns and assistants that have something to fold", () => {
  const turns = twoTurnLayout();
  // 两个 turn 都有不止一行（user + assistant），都可折叠。
  assert.deepEqual([...collapsibleTrajectoryTurns(turns)], [1, 2]);
  // 只有名下紧跟工具调用的 assistant 才可折叠，turn 2 的 assistant 没有。
  const assistants = collapsibleTrajectoryAssistants(turns);
  assert.equal(assistants.length, 1);
});

test("a turn with a single visible row is not collapsible", () => {
  const turns = deriveTrajectoryLayout({
    ledger: buildTrajectoryLedger([{ k: "user", t: 1, at: BASE }]),
  });
  assert.deepEqual([...collapsibleTrajectoryTurns(turns)], []);
  const header = buildTrajectoryDisplayItems(turns, NO_COLLAPSE).find(
    (item) => item.kind === "turnHeader",
  );
  assert.equal(header.collapsible, false);
});

test("virtualized headers and records keep the same fixed row height", () => {
  const items = buildTrajectoryDisplayItems(twoTurnLayout(), NO_COLLAPSE);
  const header = items.find((item) => item.kind === "turnHeader");
  const record = items.find((item) => item.kind === "record");
  assert.equal(trajectoryDisplayItemHeight(header), 30);
  assert.equal(trajectoryDisplayItemHeight(record), 30);
});

test("the virtualized table remeasures projected rows by stable display identity", () => {
  const source = readFileSync(
    new URL("../../../agent-ui/src/components/trajectory/TrajectoryTable.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /getItemKey:\s*getDisplayItemKey/);
  assert.match(source, /key=\{virtualRow\.key\}/);
  assert.match(source, /ref=\{virtualizer\.measureElement\}/);
  assert.match(source, /data-index=\{virtualRow\.index\}/);
  assert.match(source, /const measuredProjectionRef = useRef/);
  assert.match(source, /useLayoutEffect\(\(\) => \{/);
  assert.match(source, /virtualizer\.measure\(\);/);
});

test("trajectory details resizing preserves usable list and panel widths", () => {
  assert.deepEqual(trajectoryDetailsWidthBounds(1400), { min: 160, max: 720 });
  assert.deepEqual(trajectoryDetailsWidthBounds(465), { min: 160, max: 325 });
  assert.deepEqual(trajectoryDetailsWidthBounds(320), { min: 160, max: 180 });
  assert.equal(clampTrajectoryDetailsWidth(100, 1400), 160);
  assert.equal(clampTrajectoryDetailsWidth(900, 1400), 720);
  assert.equal(clampTrajectoryDetailsWidth(420, 465), 325);
  assert.equal(resolveTrajectoryDetailsDragWidth(420, -100, 1000), 520);
  assert.equal(resolveTrajectoryDetailsDragWidth(420, 300, 1000), 160);
});

test("trajectory details separator supports accessible keyboard resizing", () => {
  assert.equal(resolveTrajectoryDetailsKeyboardWidth("ArrowLeft", 420, 1000, false), 444);
  assert.equal(resolveTrajectoryDetailsKeyboardWidth("ArrowRight", 420, 1000, true), 348);
  assert.equal(resolveTrajectoryDetailsKeyboardWidth("Home", 420, 1000, false), 160);
  assert.equal(resolveTrajectoryDetailsKeyboardWidth("End", 420, 1000, false), 720);
  assert.equal(resolveTrajectoryDetailsKeyboardWidth("Enter", 420, 1000, false), null);
});

test("conversation trajectory selection is isolated by conversation id", () => {
  const empty = new Map();
  const conversationA = updateConversationViewState(empty, "conversation-a", "trajectory");
  assert.equal(conversationViewForId(conversationA, "conversation-a"), "trajectory");
  assert.equal(conversationViewForId(conversationA, "conversation-b"), "conversation");
  assert.equal(conversationViewForId(empty, "conversation-a"), "conversation");

  const both = updateConversationViewState(conversationA, "conversation-b", "trajectory");
  const resetA = updateConversationViewState(both, "conversation-a", "conversation");
  assert.equal(conversationViewForId(resetA, "conversation-a"), "conversation");
  assert.equal(conversationViewForId(resetA, "conversation-b"), "trajectory");
});

test("system label follows the header change kind", () => {
  assert.equal(trajectorySystemLabelKey("initial"), "trajectory.system.initial");
  assert.equal(trajectorySystemLabelKey("tools"), "trajectory.system.tools");
  assert.equal(trajectorySystemLabelKey("system"), "trajectory.system.system");
  assert.equal(trajectorySystemLabelKey("system-and-tools"), "trajectory.system.systemAndTools");
  assert.equal(trajectorySystemLabelKey(undefined), "trajectory.system.initial");
});

test("rows with no text fall back to a label key, rows with text do not", () => {
  assert.equal(
    trajectoryFallbackLabelKey({ kind: "system", text: "", headerChange: "tools" }),
    "trajectory.system.tools",
  );
  assert.equal(
    trajectoryFallbackLabelKey({ kind: "compacted", text: "" }),
    "trajectory.compaction.title",
  );
  assert.equal(trajectoryFallbackLabelKey({ kind: "tool", text: "Bash" }), undefined);
  assert.equal(trajectoryFallbackLabelKey({ kind: "user", text: "" }), undefined);
});

test("partial timing is reported only for settled untimed operations in a timed ledger", () => {
  const baseLedger = {
    headers: new Map(),
    standaloneCompactions: [],
    hasTiming: true,
    turns: [],
  };
  const untimedStep = {
    turn: 1,
    step: 1,
    startedAt: null,
    firstTokenAt: null,
    endedAt: null,
    status: "complete",
    retries: [],
    tools: [],
  };
  assert.equal(
    trajectoryLedgerHasPartialTiming({
      ...baseLedger,
      turns: [
        {
          turn: 1,
          startedAt: null,
          endedAt: null,
          status: "complete",
          inputs: [],
          steps: [untimedStep],
          compactions: [],
        },
      ],
    }),
    true,
  );
  assert.equal(
    trajectoryLedgerHasPartialTiming({
      ...baseLedger,
      turns: [
        {
          turn: 1,
          startedAt: BASE,
          endedAt: null,
          status: "running",
          inputs: [],
          steps: [{ ...untimedStep, status: "running" }],
          compactions: [],
        },
      ],
    }),
    false,
  );
  assert.equal(trajectoryLedgerHasPartialTiming({ ...baseLedger, hasTiming: false }), false);
});

test("durations switch to seconds past the one-second mark", () => {
  assert.equal(formatTrajectoryDuration(null, "en-US"), "—");
  assert.equal(formatTrajectoryDuration(Number.NaN, "en-US"), "—");
  assert.equal(formatTrajectoryDuration(842, "en-US"), "842 ms");
  assert.equal(formatTrajectoryDuration(1500, "en-US"), "1.5 s");
});

test("throughput and segments stay null unless every timing fact is present", () => {
  const complete = {
    assistantMetrics: {
      timingRecorded: true,
      stepStartAt: BASE,
      firstTokenAt: BASE + 200,
      completedAt: BASE + 1200,
      outputTokens: 100,
    },
  };
  assert.equal(Math.round(trajectoryThroughputTokensPerSecond(complete)), 100);
  assert.deepEqual(trajectoryAssistantSegments(complete), { ttftMs: 200, decodingMs: 1000 });

  assert.equal(trajectoryThroughputTokensPerSecond({}), null);
  assert.equal(
    trajectoryThroughputTokensPerSecond({
      assistantMetrics: { ...complete.assistantMetrics, outputTokens: null },
    }),
    null,
  );
  // 时间戳倒序说明记录不可信，宁可不显示也不给出负数分段。
  assert.equal(
    trajectoryAssistantSegments({
      assistantMetrics: { ...complete.assistantMetrics, firstTokenAt: BASE - 1 },
    }),
    null,
  );
});

test("subagent steps come from assistant messages and pair errors by call id", () => {
  const steps = extractSubagentSteps([
    {
      role: "assistant",
      timestamp: BASE,
      content: [
        { type: "text", text: "working" },
        { type: "toolCall", id: "s1", name: "Grep" },
        { type: "toolCall", id: "s2", name: "Read" },
      ],
    },
    { role: "toolResult", toolCallId: "s1", isError: false, timestamp: BASE + 50 },
    { role: "toolResult", toolCallId: "s2", isError: true, timestamp: BASE + 90 },
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].startedAt, BASE);
  assert.equal(steps[0].endedAt, BASE + 90);
  assert.deepEqual(
    steps[0].tools.map((tool) => [tool.name, tool.isError]),
    [
      ["Grep", false],
      ["Read", true],
    ],
  );
  // 子工具自带起止：起点 = assistant 消息时间戳，终点 = toolResult 时间戳。
  assert.deepEqual(
    steps[0].tools.map((tool) => [tool.startedAt, tool.endedAt]),
    [
      [BASE, BASE + 50],
      [BASE, BASE + 90],
    ],
  );
});

test("a subagent tool without a matching result keeps a null end timestamp", () => {
  const steps = extractSubagentSteps([
    {
      role: "assistant",
      timestamp: BASE + 10,
      content: [{ type: "toolCall", id: "gone", name: "Bash" }],
    },
  ]);
  assert.equal(steps[0].tools[0].startedAt, BASE + 10);
  assert.equal(steps[0].tools[0].endedAt, null);
});

test("malformed subagent payloads degrade to an empty run instead of throwing", () => {
  assert.deepEqual(extractSubagentSteps(null), []);
  assert.deepEqual(extractSubagentSteps("nope"), []);
  assert.deepEqual(extractSubagentSteps([null, 7, { role: "assistant", content: "bad" }])[0].tools, []);
  assert.deepEqual(concatSubagentSegmentMessages(undefined), []);
  assert.deepEqual(concatSubagentSegmentMessages([{ messagesJson: "{oops" }]), []);
});

test("segment messages concatenate in order and skip the corrupt ones", () => {
  const merged = concatSubagentSegmentMessages([
    { messagesJson: '[{"role":"assistant","content":[]}]' },
    { messagesJson: "not json" },
    { messagesJson: '[{"role":"toolResult","toolCallId":"x"}]' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].role, "assistant");
  assert.equal(merged[1].role, "toolResult");
});

test("a subagent run normalizes its status and exposes its steps", () => {
  const run = buildTrajectorySubagentRun({
    runId: "r1",
    agentId: "reviewer",
    status: "succeeded",
    startedAt: BASE,
    endedAt: BASE + 500,
    messages: [{ role: "assistant", timestamp: BASE, content: [{ type: "toolCall", id: "s1", name: "Glob" }] }],
  });
  assert.equal(run.status, "complete");
  assert.equal(run.steps[0].tools[0].name, "Glob");

  assert.equal(buildTrajectorySubagentRun({ runId: "r", agentId: "a", status: "cancelled", messages: [] }).status, "aborted");
  assert.equal(buildTrajectorySubagentRun({ runId: "r", agentId: "a", status: "weird", messages: [] }).status, "running");
  assert.equal(buildTrajectorySubagentRun({ runId: "r", agentId: "a", status: "x", messages: [] }).startedAt, null);
});

test("transcript rows convert to messages and checkpoints are skipped", () => {
  const messages = toTrajectoryMessages([
    {
      kind: "user",
      key: "u1",
      text: "hello",
      attachments: [],
      messageRef: { messageId: "persisted-user-1" },
    },
    { kind: "checkpoint", key: "c1", content: "summary" },
    { kind: "assistant", key: "a1", rounds: [{ round: 1, blocks: [] }] },
    { kind: "error", key: "e1", text: "boom" },
  ]);
  assert.deepEqual(
    messages.map((message) => [message.role, message.key]),
    [
      ["user", "u1"],
      ["assistant", "a1"],
    ],
  );
  assert.equal(messages[0].text, "hello");
  assert.equal(messages[0].attachments, undefined);
  assert.equal(messages[0].messageId, "persisted-user-1");
  assert.equal(messages[1].rounds.length, 1);
});

test("rows missing a key still get a stable synthetic one", () => {
  const messages = toTrajectoryMessages([{ kind: "user", text: "hi" }]);
  assert.equal(messages[0].key, "row-0");
});
