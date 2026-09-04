import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTranscriptRowModel } = loader.loadModule("src/pages/chat/transcript/rowModel.ts");
const {
  getToolActivityCategory,
  resolveActiveThinkingEntryKey,
  resolveActiveWorkEntry,
  resolveAssistantTurnLayout,
} = loader.loadModule("@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts");
const { createLiveTranscriptStore } = loader.loadModule(
  "src/lib/chat/conversation/liveTranscriptStore.ts",
);
const { createEntranceRegistry, ENTRANCE_ANIMATION_WINDOW_MS } = loader.loadModule(
  "@liveagent/ui/lib/transcript-virtual/entranceOnce.ts",
);
const { extractRenderUnitRange } = loader.loadModule(
  "src/pages/chat/transcript/renderUnitRangeExtractor.ts",
);
const { collectChangedFiles } = loader.loadModule("@liveagent/ui/lib/chat/changedFiles.ts");
const transcriptListSource = fs.readFileSync(
  new URL("../../src/pages/chat/transcript/TranscriptList.tsx", import.meta.url),
  "utf8",
);

function userItem(key, text = "prompt") {
  return {
    kind: "user",
    key,
    segmentIndex: 0,
    text,
    attachments: [],
    timestamp: 1,
    isFromCompactedSegment: false,
  };
}

function assistantItem(key, rounds) {
  return {
    kind: "assistant",
    key,
    segmentIndex: 0,
    rounds,
    timestamp: 2,
    isFromCompactedSegment: false,
  };
}

function round(key, text) {
  return {
    round: Number(key.slice(1)),
    key,
    blocks: [{ kind: "text", id: "text-1", text }],
  };
}

function toolBlock(id, name, result) {
  return {
    kind: "tool",
    item: {
      toolCall: { type: "toolCall", id, name, arguments: {} },
      ...(result === undefined
        ? {}
        : {
            toolResult: {
              role: "toolResult",
              toolCallId: id,
              isError: result === "error",
              content: [],
            },
          }),
    },
  };
}

function blockRows(snapshot) {
  return snapshot.rows
    .flatMap((row) => (row.kind === "assistant-activity" ? row.units : [row]))
    .filter((row) => row.kind === "assistant-unit" && row.unit.kind === "block");
}

function workTraceRows(snapshot) {
  return snapshot.rows
    .flatMap((row) => (row.kind === "assistant-activity" ? row.units : [row]))
    .filter((row) => row.kind === "assistant-unit" && row.unit.kind === "work-trace");
}

function footerRows(snapshot) {
  return snapshot.rows
    .flatMap((row) => (row.kind === "assistant-activity" ? row.units : [row]))
    .filter((row) => row.kind === "assistant-unit" && row.unit.kind === "footer");
}

const idleLive = {
  isSending: false,
  draftAssistantText: "",
  toolStatus: null,
  liveRounds: [],
  retryAttempts: [],
  isSettled: false,
};

test("live work trace keeps reasoning entries with their streaming flag", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];

  const waiting = model.build(history, { ...idleLive, isSending: true });
  assert.equal(workTraceRows(waiting)[0].unit.entries.length, 0);

  const reasoning = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [
      {
        round: 1,
        key: "r1",
        blocks: [{ kind: "thinking", id: "thinking-1", text: "检查当前请求" }],
        runningToolCallIds: [],
        thinkingOpen: true,
      },
    ],
  });
  const reasoningEntries = workTraceRows(reasoning)[0].unit.entries;
  assert.deepEqual(
    reasoningEntries.map((entry) => entry.block.kind),
    ["thinking"],
  );
  assert.equal(reasoningEntries[0].block.text, "检查当前请求");
  assert.equal(reasoningEntries[0].thinkingOpen, true);
  assert.equal(resolveActiveThinkingEntryKey(reasoningEntries), reasoningEntries[0].key);

  const runningTool = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [
      {
        round: 1,
        key: "r1",
        blocks: [toolBlock("read-1", "Read")],
        runningToolCallIds: ["read-1"],
        thinkingOpen: false,
      },
    ],
  });
  const toolEntries = workTraceRows(runningTool)[0].unit.entries;
  assert.deepEqual(
    toolEntries.map((entry) => entry.block.kind),
    ["toolGroup"],
  );
  assert.equal(resolveActiveThinkingEntryKey(toolEntries), null);
});

test("settling a live turn promotes trailing prose out of the work trace", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];

  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "partial"), runningToolCallIds: [], thinkingOpen: false }],
  });
  assert.equal(streaming.liveStartIndex, 1);
  const liveWorkKey = workTraceRows(streaming)[0].key;
  assert.match(liveWorkKey, /^live-turn-/);
  assert.deepEqual(
    workTraceRows(streaming)[0].unit.entries.map((entry) => entry.block.kind),
    ["text"],
  );
  assert.equal(blockRows(streaming).length, 0);

  const settledHistory = [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])];
  const settled = model.build(settledHistory, idleLive);
  assert.equal(settled.liveStartIndex, -1);
  assert.equal(settled.rows.length, 2);
  assert.ok(blockRows(settled)[0].key.startsWith(liveWorkKey.split(":work-trace")[0]));
  assert.equal(blockRows(settled)[0].renderMode, "streaming");
  assert.equal(footerRows(settled).length, 1);
  assert.ok(footerRows(settled)[0].key.startsWith(liveWorkKey.split(":work-trace")[0]));
  assert.equal(workTraceRows(settled).length, 0);

  const rebuilt = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])],
    idleLive,
  );
  assert.equal(blockRows(rebuilt)[0].key, blockRows(settled)[0].key);
});

test("persist lag: block-unit aliases still land one build later", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];
  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "partial"), runningToolCallIds: [], thinkingOpen: false }],
  });
  const liveWorkKey = workTraceRows(streaming)[0].key;

  const waitingForHistory = model.build(history, idleLive);
  assert.equal(waitingForHistory.rows.length, 2, "the live activity must not disappear while persistence lags");
  assert.equal(workTraceRows(waitingForHistory)[0].key, liveWorkKey);
  assert.equal(waitingForHistory.rows.at(-1).kind, "assistant-activity");
  assert.equal(waitingForHistory.rows.at(-1).live, false);
  assert.deepEqual(
    waitingForHistory.rows.at(-1).units.map((unit) => unit.unit.kind),
    ["work-trace"],
    "the settling activity retains only the processing trace",
  );
  const settled = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])],
    idleLive,
  );
  assert.ok(blockRows(settled)[0].key.startsWith(liveWorkKey.split(":work-trace")[0]));
});

test("a new turn supersedes an unresolved settle so aliases never cross turns", () => {
  const model = createTranscriptRowModel();
  const sendingLive = {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "x"), runningToolCallIds: [], thinkingOpen: false }],
  };

  const firstStreaming = model.build([userItem("u1")], sendingLive);
  const firstLiveWorkKey = workTraceRows(firstStreaming).at(-1).key;
  model.build([userItem("u1")], idleLive);
  const secondStreaming = model.build([userItem("u1"), userItem("u2")], sendingLive);
  const secondLiveWorkKey = workTraceRows(secondStreaming).at(-1).key;

  const delayedFirstTwin = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "reply 1")]), userItem("u2")],
    sendingLive,
  );
  assert.ok(blockRows(delayedFirstTwin)[0].key.startsWith(firstLiveWorkKey.split(":work-trace")[0]));
  assert.equal(workTraceRows(delayedFirstTwin).at(-1).key, secondLiveWorkKey);

  const settled = model.build(
    [
      userItem("u1"),
      assistantItem("a1", [round("r1", "reply 1")]),
      userItem("u2"),
      assistantItem("a2", [round("r1", "reply 2")]),
    ],
    idleLive,
  );
  assert.ok(blockRows(settled)[0].key.startsWith(firstLiveWorkKey.split(":work-trace")[0]));
  assert.ok(blockRows(settled).at(-1).key.startsWith(secondLiveWorkKey.split(":work-trace")[0]));
});

test("draft text stays inside the live processing trace until the turn is terminal", () => {
  const model = createTranscriptRowModel();
  const streaming = model.build([userItem("u1")], {
    ...idleLive,
    isSending: true,
    draftAssistantText: "hello",
  });
  const entry = workTraceRows(streaming)[0].unit.entries[0];
  assert.equal(entry.block.kind, "text");
  assert.equal(entry.block.key, "text-1");
  assert.equal(entry.block.text, "hello");
  assert.equal(blockRows(streaming).length, 0);
});

test("settled units reuse identities across live-store emits", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1"), assistantItem("a1", [round("r1", "done")])];
  const sendingLive = {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "x"), runningToolCallIds: [], thinkingOpen: false }],
  };
  const first = model.build(history, sendingLive);
  const second = model.build(history, { ...sendingLive });
  assert.equal(first.rows[0], second.rows[0]);
  assert.equal(first.rows[1], second.rows[1]);
  assert.equal(first.rows[2], second.rows[2]);
});

test("entrance registry: initial rows never animate, new rows animate once", () => {
  let clock = 1_000;
  const registry = createEntranceRegistry(() => clock);
  registry.observeBirths(["a", "b"], true);
  assert.equal(registry.shouldAnimate("a"), false);

  clock += 50;
  registry.observeBirths(["c"], false);
  assert.equal(registry.shouldAnimate("c"), true);
  assert.equal(registry.shouldAnimate("a"), false);

  clock += ENTRANCE_ANIMATION_WINDOW_MS + 1;
  assert.equal(registry.shouldAnimate("c"), false);
  registry.observeBirths(["c"], false);
  assert.equal(registry.shouldAnimate("c"), false);

  registry.reset();
  registry.observeBirths(["c"], true);
  assert.equal(registry.shouldAnimate("c"), false);
});

test("row model reports unit births once and reuses the history array", () => {
  const births = [];
  const model = createTranscriptRowModel({
    onRowsBorn: (keys, isInitialBuild) => births.push([keys.slice(), isInitialBuild]),
  });
  const history = [userItem("u1"), assistantItem("a1", [round("r1", "done")])];

  const first = model.build(history, idleLive);
  assert.deepEqual(births, [
    [["u1", "a1:round:r1:block:text-1", "a1:footer"], true],
  ]);

  const second = model.build(history, idleLive);
  assert.equal(second.rows, first.rows);
  assert.equal(births.length, 1);

  const sendingLive = {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "x"), runningToolCallIds: [], thinkingOpen: false }],
  };
  const streaming = model.build(history, sendingLive);
  assert.equal(births.length, 2);
  assert.equal(births[1][1], false);
  assert.match(births[1][0][0], /^live-turn-/);
  assert.equal(streaming.rows[0], first.rows[0]);

  model.build(history, { ...sendingLive });
  assert.equal(births.length, 2);
});

test("a committed twin that races persistence is re-keyed at settle", () => {
  const model = createTranscriptRowModel();
  const sendingLive = {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "x"), runningToolCallIds: [], thinkingOpen: false }],
  };

  model.build([userItem("u1")], sendingLive);
  const midRun = [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])];
  const racing = model.build(midRun, sendingLive);
  const racingBlockKey = blockRows(racing).at(-1).key;
  assert.equal(racingBlockKey, "a1:round:r1:block:text-1");

  const settled = model.build(midRun, idleLive);
  assert.equal(settled.rows.length, 2);
  assert.ok(blockRows(settled)[0].key.startsWith("live-turn-1:"));
  assert.notEqual(blockRows(settled)[0].key, racingBlockKey);
});

test("terminal settlement removes the live tail before sending clears", () => {
  const model = createTranscriptRowModel();
  const store = createLiveTranscriptStore();
  const history = [userItem("u1")];

  store.reset();
  store.updateLiveRounds(() => [
    { ...round("r1", "full reply"), runningToolCallIds: [], thinkingOpen: false },
  ]);
  const streaming = model.build(history, { ...store.getSnapshot(), isSending: true });
  const liveWorkKey = workTraceRows(streaming)[0].key;

  store.settle();
  const committed = [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])];
  const finalizing = model.build(committed, { ...store.getSnapshot(), isSending: true });

  assert.equal(finalizing.rows.length, 2);
  assert.equal(finalizing.liveStartIndex, -1);
  assert.ok(blockRows(finalizing)[0].key.startsWith(liveWorkKey.split(":work-trace")[0]));
  assert.equal(blockRows(finalizing)[0].live, false);

  const released = model.build(committed, { ...store.getSnapshot(), isSending: false });
  assert.equal(released.rows.length, 2);

  store.reset();
  const nextPending = model.build(committed, { ...store.getSnapshot(), isSending: true });
  assert.equal(nextPending.rows.length, 3);
  assert.equal(nextPending.liveStartIndex, 2);
  assert.equal(nextPending.rows[2].kind, "assistant-activity");
  assert.equal(nextPending.rows[2].units.at(-1).mutable, true);
});

test("assistant rounds hide task tools while preserving grouped top-level render units", () => {
  const model = createTranscriptRowModel();
  const tool = (id, name = "Read") => ({
    kind: "tool",
    item: { toolCall: { type: "toolCall", id, name, arguments: {} } },
  });
  const rounds = [
    {
      round: 1,
      key: "r1",
      blocks: [
        { kind: "text", id: "text-1", text: "answer" },
        { kind: "thinking", id: "thinking-1", text: "thought" },
        tool("task-1", "TaskCreate"),
        tool("call-1"),
        tool("call-2"),
        { kind: "hostedSearch", item: { id: "search-1" } },
      ],
    },
  ];
  const snapshot = model.build([userItem("u1"), assistantItem("a1", rounds)], idleLive);
  assert.deepEqual(
    workTraceRows(snapshot)[0].unit.entries.map((entry) => entry.block.kind),
    ["text", "thinking", "toolGroup"],
  );
  // The trailing hosted-search result is the durable answer-layer block.
  assert.deepEqual(
    blockRows(snapshot).map((row) => row.unit.block.kind),
    ["hostedSearchGroup"],
  );
  assert.equal(footerRows(snapshot).length, 1);
  assert.equal(workTraceRows(snapshot)[0].showAvatar, true);
  assert.ok(blockRows(snapshot).every((row) => !row.showAvatar));
});

test("turn layout keeps every intermediate round in one trace and exposes only final prose", () => {
  const rounds = [
    {
      round: 1,
      key: "r1",
      blocks: [
        { kind: "thinking", id: "thinking-1", text: "inspect" },
        toolBlock("read-1", "Read", "ok"),
        { kind: "text", id: "progress-1", text: "I found the relevant component." },
      ],
      meta: { stopReason: "toolUse" },
    },
    {
      round: 2,
      key: "r2",
      blocks: [
        toolBlock("edit-1", "Edit", "ok"),
        { kind: "text", id: "answer-1", text: "Implemented and verified." },
      ],
      meta: { stopReason: "stop" },
    },
  ];

  const settled = resolveAssistantTurnLayout(rounds, { live: false });
  assert.deepEqual(
    settled.work.map((entry) => entry.block.kind),
    ["thinking", "toolGroup", "text", "toolGroup"],
  );
  assert.deepEqual(
    settled.answer.map((entry) => entry.block.kind),
    ["text"],
  );
  assert.equal(settled.answer[0].block.text, "Implemented and verified.");

  const streaming = resolveAssistantTurnLayout(
    [{ ...rounds[1], meta: undefined, runningToolCallIds: ["edit-1"] }],
    { live: true },
  );
  assert.equal(streaming.answer.length, 0);
  assert.deepEqual(
    streaming.work.map((entry) => entry.block.kind),
    ["toolGroup", "text"],
  );
});

test("turn layout keeps reasoning segments as stage boundaries between tool batches", () => {
  const layout = resolveAssistantTurnLayout(
    [
      {
        round: 1,
        key: "r1",
        blocks: [
          { kind: "thinking", id: "thinking-1", text: "find the entry point" },
          toolBlock("read-1", "Read", "ok"),
        ],
        meta: { stopReason: "toolUse" },
      },
      {
        round: 2,
        key: "r2",
        blocks: [
          { kind: "thinking", id: "thinking-2", text: "follow the component tree" },
          toolBlock("grep-1", "Grep", "ok"),
          toolBlock("list-1", "List", "ok"),
          { kind: "text", id: "progress-1", text: "I found the relevant UI path." },
        ],
        meta: { stopReason: "toolUse" },
      },
      {
        round: 3,
        key: "r3",
        blocks: [
          { kind: "thinking", id: "thinking-3", text: "verify the result" },
          toolBlock("bash-1", "Bash", "ok"),
          { kind: "text", id: "answer-1", text: "Implemented and verified." },
        ],
        meta: { stopReason: "stop" },
      },
    ],
    { live: false },
  );

  // Reasoning stays visible; tools merge into one batch only until the next
  // reasoning segment or progress note starts a new stage.
  assert.deepEqual(
    layout.work.map((entry) => entry.block.kind),
    ["thinking", "toolGroup", "thinking", "toolGroup", "text", "thinking", "toolGroup"],
  );
  assert.deepEqual(
    layout.work[1].block.items.map((item) => item.toolCall.name),
    ["Read"],
  );
  assert.deepEqual(
    layout.work[3].block.items.map((item) => item.toolCall.name),
    ["Grep", "List"],
  );
  assert.deepEqual(
    layout.work[6].block.items.map((item) => item.toolCall.name),
    ["Bash"],
  );
});

test("live turn keeps reasoning rows and the tool-group anchor stable across phases", () => {
  const layout = resolveAssistantTurnLayout(
    [
      {
        round: 1,
        key: "r1",
        thinkingOpen: true,
        blocks: [
          { kind: "thinking", id: "thinking-1", text: "a very long private reasoning stream" },
          toolBlock("read-1", "Read", "ok"),
        ],
      },
    ],
    { live: true },
  );

  assert.deepEqual(
    layout.work.map((entry) => entry.block.kind),
    ["thinking", "toolGroup"],
  );

  const betweenTools = resolveAssistantTurnLayout(
    [
      {
        round: 1,
        key: "r1",
        thinkingOpen: false,
        blocks: [
          { kind: "thinking", id: "thinking-1", text: "finished reasoning" },
          toolBlock("read-1", "Read", "ok"),
        ],
      },
    ],
    { live: true },
  );
  // Both the reasoning row and the tool group keep their identities while the
  // streaming flag flips, so neither remounts between provider phases.
  assert.equal(betweenTools.work[0].key, layout.work[0].key);
  assert.equal(betweenTools.work[1].key, layout.work[1].key);
  assert.equal(resolveActiveThinkingEntryKey(layout.work), layout.work[0].key);
  assert.equal(resolveActiveThinkingEntryKey(betweenTools.work), null);
});

test("the collapsed-trace active entry tracks the newest in-progress block", () => {
  const liveWork = (blocks, runningToolCallIds, thinkingOpen) =>
    resolveAssistantTurnLayout(
      [{ round: 1, key: "r1", blocks, runningToolCallIds, thinkingOpen }],
      { live: true },
    ).work;

  const streamingThinking = liveWork(
    [toolBlock("read-1", "Read", "ok"), { kind: "thinking", id: "thinking-1", text: "review" }],
    [],
    true,
  );
  assert.equal(resolveActiveWorkEntry(streamingThinking)?.block.kind, "thinking");

  const runningTool = liveWork(
    [{ kind: "thinking", id: "thinking-1", text: "review" }, toolBlock("edit-1", "Edit")],
    ["edit-1"],
    false,
  );
  assert.equal(resolveActiveWorkEntry(runningTool)?.block.kind, "toolGroup");

  // A streaming progress note is the active tail while it lasts.
  const streamingText = liveWork(
    [
      toolBlock("read-1", "Read", "ok"),
      { kind: "text", id: "progress-1", text: "Reading the config now." },
    ],
    [],
    false,
  );
  assert.equal(resolveActiveWorkEntry(streamingText)?.block.kind, "text");

  // A settled trailing block yields nothing: the sparkle alone covers the gap.
  const idleGap = liveWork(
    [{ kind: "thinking", id: "thinking-1", text: "review" }, toolBlock("edit-1", "Edit", "ok")],
    [],
    false,
  );
  assert.equal(resolveActiveWorkEntry(idleGap), null);
});

test("interactive prose and cards render outside the processing disclosure", () => {
  const liveRound = {
    round: 1,
    key: "r1",
    thinkingOpen: false,
    runningToolCallIds: ["ask-1"],
    blocks: [
      { kind: "thinking", id: "thinking-1", text: "inspect" },
      toolBlock("read-1", "Read", "ok"),
      { kind: "text", id: "question-context", text: "I need you to choose the target." },
      toolBlock("ask-1", "AskUserQuestion"),
    ],
    meta: { stopReason: "toolUse" },
  };
  const layout = resolveAssistantTurnLayout([liveRound], { live: true });

  assert.deepEqual(
    layout.work.map((entry) => entry.block.kind),
    ["thinking", "toolGroup"],
  );
  assert.deepEqual(
    layout.interaction.map((entry) => entry.block.kind),
    ["text", "tool"],
  );
  assert.equal(layout.interaction[1].block.item.toolCall.name, "AskUserQuestion");
  assert.equal(layout.answer.length, 0);

  const model = createTranscriptRowModel();
  const snapshot = model.build([userItem("u1")], {
    ...idleLive,
    isSending: true,
    liveRounds: [liveRound],
  });
  assert.deepEqual(
    workTraceRows(snapshot)[0].unit.entries.map((entry) => entry.block.kind),
    ["thinking", "toolGroup"],
  );
  assert.equal(
    workTraceRows(snapshot)[0].unit.latestToolGroupKey,
    workTraceRows(snapshot)[0].unit.entries[1].key,
  );
  assert.deepEqual(
    blockRows(snapshot).map((row) => row.unit.block.kind),
    ["text", "tool"],
  );
});

test("an answered interaction card flows back into the trace timeline", () => {
  const answeredRound = {
    round: 1,
    key: "r1",
    thinkingOpen: false,
    runningToolCallIds: [],
    blocks: [
      { kind: "text", id: "question-context", text: "I need you to choose the target." },
      toolBlock("ask-1", "AskUserQuestion", "ok"),
      { kind: "thinking", id: "thinking-2", text: "the user picked one" },
    ],
    meta: { stopReason: "toolUse" },
  };
  const layout = resolveAssistantTurnLayout([answeredRound], { live: true });

  // Once answered, the card is ordinary timeline activity: later reasoning
  // and tools stack below it instead of the card trailing the whole turn.
  assert.equal(layout.interaction.length, 0);
  assert.deepEqual(
    layout.work.map((entry) => entry.block.kind),
    ["text", "tool", "thinking"],
  );
  assert.equal(layout.work[1].block.item.toolCall.name, "AskUserQuestion");
});

test("failed operations stay inspectable in the trace while the failure summary remains outside", () => {
  const layout = resolveAssistantTurnLayout(
    [
      {
        round: 1,
        key: "r1",
        blocks: [
          toolBlock("bash-1", "Bash", "error"),
          { kind: "text", id: "failure", text: "The command failed; no files were changed." },
        ],
        meta: { stopReason: "error" },
      },
    ],
    { live: false },
  );
  assert.equal(layout.work[0].block.kind, "toolGroup");
  assert.equal(layout.work[0].block.items[0].toolResult.isError, true);
  assert.equal(layout.answer[0].block.kind, "text");
});

test("tool activity taxonomy exposes all seven gallery categories", () => {
  const categories = [
    getToolActivityCategory("Read"),
    getToolActivityCategory("Grep"),
    getToolActivityCategory("Edit"),
    getToolActivityCategory("Bash"),
    getToolActivityCategory("List"),
    getToolActivityCategory("Agent"),
    getToolActivityCategory("mcp_github_search_issues"),
  ];
  assert.deepEqual(categories, ["read", "search", "edit", "command", "list", "agent", "other"]);
  assert.equal(new Set(categories).size, 7);
});

test("Markdown text blocks stay whole instead of being string-sliced", () => {
  const model = createTranscriptRowModel();
  const markdown = `${"paragraph content ".repeat(8_000)}\n\n\`\`\`ts\nconst value = 1;\n\`\`\``;
  const snapshot = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", markdown)])],
    idleLive,
  );
  assert.equal(blockRows(snapshot).length, 1);
  assert.equal(blockRows(snapshot)[0].unit.block.text, markdown);
  assert.ok(blockRows(snapshot)[0].renderCost > 1);
});

test("one live activity is pinned while its completed prefix units keep stable keys", () => {
  const model = createTranscriptRowModel();
  const liveRound = {
    round: 1,
    key: "r1",
    blocks: [
      { kind: "text", id: "text-1", text: "prefix" },
      { kind: "thinking", id: "thinking-1", text: "done thinking" },
      { kind: "text", id: "text-2", text: "streaming tail" },
    ],
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  const snapshot = model.build([userItem("u1")], {
    ...idleLive,
    isSending: true,
    liveRounds: [liveRound],
  });
  const workUnits = workTraceRows(snapshot);
  const answerUnits = blockRows(snapshot);
  assert.equal(workUnits.length, 1);
  assert.deepEqual(
    workUnits[0].unit.entries.map((entry) => entry.block.kind),
    ["text", "thinking", "text"],
  );
  assert.equal(workUnits[0].mutable, true);
  assert.equal(answerUnits.length, 0);
  const activity = snapshot.rows.find((row) => row.kind === "assistant-activity");
  assert.ok(activity);
  assert.deepEqual(
    activity.units
      .filter((unit) => unit.unit.kind === "work-trace" || unit.unit.kind === "block")
      .map((unit) => unit.key),
    workUnits.map((unit) => unit.key),
  );
  assert.equal(activity.units.at(-1).unit.kind, "work-trace");
  assert.equal(snapshot.liveStartIndex, snapshot.rows.indexOf(activity));
  assert.equal(snapshot.liveStartIndex, snapshot.rows.length - 1);
});

test("the active assistant turn stays one outer activity row through growth and settlement", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];
  const firstRound = {
    round: 1,
    key: "r1",
    blocks: [{ kind: "thinking", id: "thinking-1", text: "first thought" }],
    runningToolCallIds: [],
    thinkingOpen: true,
  };
  const first = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [firstRound],
  });
  const firstActivity = first.rows.find((row) => row.kind === "assistant-activity");
  assert.ok(firstActivity);
  assert.equal(first.rows.filter((row) => row.kind === "assistant-activity").length, 1);
  const stableWorkKey = firstActivity.units.at(-1).key;
  assert.equal(firstActivity.units.at(-1).unit.kind, "work-trace");

  const toolItem = {
    toolCall: { type: "toolCall", id: "call-1", name: "Bash", arguments: { command: "pwd" } },
  };
  const grownRound = {
    ...firstRound,
    blocks: [...firstRound.blocks, { kind: "tool", item: toolItem }],
    runningToolCallIds: ["call-1"],
    thinkingOpen: false,
  };
  const grown = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [grownRound],
  });
  const grownActivity = grown.rows.find((row) => row.kind === "assistant-activity");
  assert.ok(grownActivity);
  assert.equal(grownActivity.key, firstActivity.key);
  assert.equal(grown.liveStartIndex, grown.rows.indexOf(grownActivity));
  assert.equal(grownActivity.units.at(-1).key, stableWorkKey);
  assert.equal(grownActivity.units.at(-1).unit.kind, "work-trace");

  const settledHistory = [
    userItem("u1"),
    assistantItem("a1", [
      { round: grownRound.round, key: grownRound.key, blocks: grownRound.blocks },
    ]),
  ];
  const settled = model.build(settledHistory, idleLive);
  const settledActivity = settled.rows.find((row) => row.kind === "assistant-activity");
  assert.ok(settledActivity);
  assert.equal(settledActivity.key, firstActivity.key);
  assert.equal(settledActivity.units[0].key, stableWorkKey);
  assert.equal(settledActivity.units.at(-1).unit.kind, "footer");
  assert.equal(settledActivity.units[0].unit.kind, "work-trace");
});

test("the work trace flags a final answer only once the turn has settled with one", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];
  const toolItem = {
    toolCall: { type: "toolCall", id: "call-1", name: "Bash", arguments: { command: "pwd" } },
    toolResult: { role: "toolResult", toolCallId: "call-1", isError: false, content: [] },
  };
  const liveRound = {
    round: 1,
    key: "r1",
    blocks: [
      { kind: "tool", item: toolItem },
      { kind: "text", id: "text-1", text: "进度说明" },
    ],
    runningToolCallIds: [],
    thinkingOpen: false,
  };

  // Live and non-terminal: trailing prose is still a progress note inside the
  // trace, so nothing counts as an answer yet.
  const streaming = model.build(history, { ...idleLive, isSending: true, liveRounds: [liveRound] });
  const liveWorkTrace = workTraceRows(streaming)[0];
  assert.equal(liveWorkTrace.unit.hasAnswer, false);

  // Settled with trailing prose: the prose becomes the answer layer and the
  // trace is flagged so the GUI auto-collapses it, matching the WebUI.
  const settledWithAnswer = model.build(
    [
      userItem("u1"),
      assistantItem("a1", [{ round: 1, key: "r1", blocks: liveRound.blocks }]),
    ],
    idleLive,
  );
  const settledWorkTrace = workTraceRows(settledWithAnswer)[0];
  assert.equal(settledWorkTrace.key, liveWorkTrace.key);
  assert.equal(settledWorkTrace.unit.hasAnswer, true);
  assert.equal(blockRows(settledWithAnswer).length, 1);

  // Settled with tools only: no answer layer, so the trace must not be told
  // to collapse — it is the whole reply.
  const toolOnlyModel = createTranscriptRowModel();
  const settledToolOnly = toolOnlyModel.build(
    [
      userItem("u1"),
      assistantItem("a1", [{ round: 1, key: "r1", blocks: [{ kind: "tool", item: toolItem }] }]),
    ],
    idleLive,
  );
  assert.equal(workTraceRows(settledToolOnly)[0].unit.hasAnswer, false);
  assert.equal(blockRows(settledToolOnly).length, 0);
});

test("one outer activity row stays stable across one hundred appended tools", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];
  let outerKey = "";
  let toolActivityKey = "";

  for (let count = 1; count <= 100; count += 1) {
    const blocks = Array.from({ length: count }, (_, index) => ({
      kind: "tool",
      item: {
        toolCall: {
          type: "toolCall",
          id: `call-${index + 1}`,
          name: "Bash",
          arguments: { command: `Write-Output ${index + 1}` },
        },
      },
    }));
    const snapshot = model.build(history, {
      ...idleLive,
      isSending: true,
      liveRounds: [
        {
          round: 1,
          key: "r1",
          blocks,
          runningToolCallIds: [`call-${count}`],
          thinkingOpen: false,
        },
      ],
    });
    const activity = snapshot.rows.find((row) => row.kind === "assistant-activity");
    assert.ok(activity);
    const workTrace = activity.units.find((unit) => unit.unit.kind === "work-trace");
    const groupedTool = workTrace?.unit.entries.find(
      (entry) => entry.block.kind === "toolGroup",
    );
    assert.ok(workTrace);
    assert.ok(groupedTool);
    if (count === 1) {
      outerKey = activity.key;
      toolActivityKey = groupedTool.key;
    } else {
      assert.equal(activity.key, outerKey);
      assert.equal(groupedTool.key, toolActivityKey);
    }
  }
});

test("assistant unit keys do not depend on the history-window-relative index", () => {
  const model = createTranscriptRowModel();
  const assistant = assistantItem("assistant-stable", [round("r1", "reply")]);
  const first = model.build([userItem("u1"), assistant], idleLive);
  const firstKeys = first.rows
    .filter((row) => row.kind === "assistant-unit")
    .map((row) => row.key);
  assert.ok(
    first.rows
      .filter((row) => row.kind === "assistant-unit")
      .every((row) => row.anchorUserKey === "u1"),
  );

  const shifted = model.build([userItem("older"), userItem("u1"), assistant], idleLive);
  const shiftedKeys = shifted.rows
    .filter((row) => row.kind === "assistant-unit")
    .map((row) => row.key);
  assert.deepEqual(shiftedKeys, firstKeys);
  assert.ok(
    shifted.rows
      .filter((row) => row.kind === "assistant-unit")
      .every((row) => row.anchorUserKey === "u1"),
  );
});

test("usage metadata stays available without reserving inline panel height", () => {
  const model = createTranscriptRowModel();
  const usage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
  };
  const writeTool = {
    kind: "tool",
    item: {
      toolCall: {
        type: "toolCall",
        id: "write-1",
        name: "Write",
        arguments: { path: "src/result.ts", content: "export {};" },
      },
      toolResult: { role: "toolResult", toolCallId: "write-1", isError: false, content: [] },
    },
  };
  const rounds = [
    {
      round: 1,
      key: "r1",
      blocks: [
        { kind: "text", id: "text-1", text: "first" },
        { kind: "text", id: "text-2", text: "second" },
      ],
      meta: { usage },
    },
    { round: 2, key: "r2", blocks: [writeTool] },
  ];
  const snapshot = model.build([userItem("u1"), assistantItem("a1", rounds)], idleLive);
  const entries = workTraceRows(snapshot)[0].unit.entries;
  assert.deepEqual(
    entries.map((entry) => entry.block.kind),
    ["text", "text", "toolGroup"],
  );
  assert.equal(entries[1].roundMeta.usage, usage);
  const withoutUsage = createTranscriptRowModel().build(
    [
      userItem("u1"),
      assistantItem("a1", [
        {
          ...rounds[0],
          meta: undefined,
        },
        rounds[1],
      ]),
    ],
    idleLive,
  );
  assert.equal(workTraceRows(snapshot)[0].estimate, workTraceRows(withoutUsage)[0].estimate);
  const footer = footerRows(snapshot)[0];
  assert.equal(footer.unit.hasChangedFilesCandidate, true);
  assert.equal(collectChangedFiles(footer.unit.rounds).files[0].path, "src/result.ts");
  assert.equal(footer.unit.replyText, "firstsecond");
});

test("cost-aware overscan spends one giant unit instead of five fixed rows", () => {
  const range = { startIndex: 3, endIndex: 4, overscan: 0, count: 10 };
  const costs = [1, 1, 20, 1, 1, 1, 1, 1, 1, 1];
  const readIndexes = [];
  const getCost = (index) => {
    readIndexes.push(index);
    return costs[index];
  };
  assert.deepEqual(extractRenderUnitRange(range, getCost, -1), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(readIndexes, [2, 5, 6, 7]);

  const tailPinned = extractRenderUnitRange(
    { startIndex: 0, endIndex: 0, overscan: 0, count: 6 },
    () => 20,
    5,
    8,
    1,
  );
  assert.deepEqual(tailPinned, [0, 1, 5]);
});

test("transcript virtualizer keeps scroll updates off the full React measurement path", () => {
  assert.match(transcriptListSource, /const estimateRowSize = useCallback/);
  assert.match(transcriptListSource, /const getRowKey = useCallback/);
  assert.match(transcriptListSource, /const extractVirtualRange = useCallback/);
  assert.match(transcriptListSource, /estimateSize:\s*estimateRowSize/);
  assert.match(transcriptListSource, /getItemKey:\s*getRowKey/);
  assert.match(transcriptListSource, /rangeExtractor:\s*extractVirtualRange/);
  assert.match(transcriptListSource, /anchorTo:\s*viewportFollowing \? "start" : "end"/);
  assert.match(transcriptListSource, /data-row-key=\{row\.key\}/);
  assert.match(transcriptListSource, /directDomUpdates:\s*true/);
  assert.match(transcriptListSource, /directDomUpdatesMode:\s*"transform"/);
  assert.match(transcriptListSource, /ref=\{virtualizer\.containerRef\}/);
  assert.doesNotMatch(transcriptListSource, /rows\.map\(\(row\) => row\.renderCost\)/);
  assert.doesNotMatch(transcriptListSource, /height:\s*virtualizer\.getTotalSize\(\)/);
  assert.doesNotMatch(transcriptListSource, /transform:\s*`translateY\(/);
});

test("a status-only live tail (idle manual compaction) closes without a stranded settling row", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1"), assistantItem("a1", [round("r1", "reply")])];

  // 手动压缩空闲态：TranscriptList 以 isCompactionRunning 激活 live tail（不置
  // isSending，这正是发布出去的真实状态形状），经 LiveTailInput.isCompactionRunning
  // 走可见性 gate；live store 只有 toolStatus——live 行是纯状态行（CompactingText），
  // 没有内容块。
  const compacting = model.build(history, {
    ...idleLive,
    isSending: false,
    isCompactionRunning: true,
    toolStatus: "正在压缩上下文…",
  });
  const compactingTail = compacting.rows.at(-1);
  assert.equal(compactingTail.kind, "assistant-activity");
  assert.equal(compactingTail.units.length, 1);
  assert.equal(compactingTail.units[0].unit.kind, "work-trace");

  // 压缩落定：历史被重排成检查点卡片（没有可收养的 assistant 孪生项）。
  // 无内容的 live 轮必须直接收尾，不能留下冻结的 settling 状态行。
  const compactedHistory = [
    {
      kind: "summary",
      key: "summary-seg-1",
      segmentIndex: 1,
      summaryId: "s1",
      content: "checkpoint body",
      coveredMessageCount: 2,
      coversThroughMessageId: "m2",
      generatedBy: { providerId: "openai", model: "gpt-test" },
      timestamp: 3,
      collapsed: true,
    },
  ];
  const closed = model.build(compactedHistory, idleLive);
  assert.equal(closed.liveStartIndex, -1);
  assert.equal(closed.rows.length, 1);
  assert.equal(closed.rows[0].kind, "summary");

  const stable = model.build(compactedHistory, idleLive);
  assert.equal(stable.rows.length, 1);
});

test("a cancelled run's abort-notice twin is adopted by the live turn (no remount)", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];

  // 被取消的 run：内容在取消瞬间尚未成块（这里以纯状态 live tail 模拟），
  // live tail 没有任何可见 block 单元——producedContent 为 false。
  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    toolStatus: "…",
  });
  assert.equal(blockRows(streaming).length, 0);
  const liveActivity = streaming.rows.at(-1);
  assert.equal(liveActivity.kind, "assistant-activity");
  const liveTurnKey = liveActivity.replyKey;
  assert.match(liveTurnKey, /^live-turn-/);

  // 取消落定：中止提示 assistant 项持久化为孪生行（有真实文本内容）。
  const settledHistory = [userItem("u1"), assistantItem("a1", [round("r1", "partial final")])];
  const settled = model.build(settledHistory, idleLive);

  // 孪生行必须被同一 live turn 领养：以 streaming renderMode 渲染、包在一个
  // activity 行里、key 沿用 live turn 的 replyKey（零 remount），而不是以新的
  // static key 重挂载。
  assert.equal(settled.liveStartIndex, -1);
  const settledActivity = settled.rows.find((row) => row.kind === "assistant-activity");
  assert.ok(settledActivity, "the abort-notice twin must be adopted into a streaming activity row");
  assert.equal(settledActivity.replyKey, liveTurnKey);
  const twinBlocks = blockRows(settled);
  assert.equal(twinBlocks.length, 1);
  assert.equal(twinBlocks[0].renderMode, "streaming");
  assert.ok(twinBlocks[0].key.startsWith(liveTurnKey));
});

test("a Task-only run's twin (all blocks filtered) is adopted by the live turn (no remount)", () => {
  const model = createTranscriptRowModel();
  const taskTool = {
    kind: "tool",
    item: { toolCall: { type: "toolCall", id: "task-1", name: "TaskCreate", arguments: {} } },
  };
  const history = [userItem("u1")];

  // 仅输出 Task 工具的 run：块被 isVisibleGroupedBlock 全部过滤，live tail 没有
  // 任何可见 block 单元（只剩状态行）——producedContent 为 false。
  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [{ round: 1, key: "r1", blocks: [taskTool], runningToolCallIds: [], thinkingOpen: false }],
  });
  assert.equal(blockRows(streaming).length, 0);
  const liveTurnKey = streaming.rows.at(-1).replyKey;
  assert.match(liveTurnKey, /^live-turn-/);

  // 落定：任务列表更新的 assistant 项持久化为孪生行（块同样被过滤）。孪生行必须
  // 被 live turn 领养 → 渲染成一个 streaming activity 行、replyKey 沿用 live turn，
  // 而不是以新的 static key 重挂载。
  const settledHistory = [
    userItem("u1"),
    assistantItem("a1", [{ round: 1, key: "r1", blocks: [taskTool] }]),
  ];
  const settled = model.build(settledHistory, idleLive);
  assert.equal(settled.liveStartIndex, -1);
  const settledActivity = settled.rows.find((row) => row.kind === "assistant-activity");
  assert.ok(settledActivity, "the Task-only twin must be adopted into a streaming activity row");
  assert.equal(settledActivity.replyKey, liveTurnKey);
  assert.ok(settledActivity.units.every((unit) => unit.renderMode === "streaming"));
});

// ---------------------------------------------------------------------------
// Reply continuity across a mid-reply context compaction

function summaryItem(key, summaryId = key) {
  return {
    kind: "summary",
    key,
    segmentIndex: 1,
    summaryId,
    content: "summary body",
    coveredMessageCount: 7,
    coversThroughMessageId: "m-7",
    generatedBy: { providerId: "deepseek", model: "deepseek-v4-flash" },
    contextUsageTokens: 9000,
    timestamp: 3,
    collapsed: true,
  };
}

function writeBlock(id, path) {
  return {
    kind: "tool",
    item: {
      toolCall: { type: "toolCall", id, name: "Write", arguments: { path, content: "x\n" } },
      toolResult: {
        role: "toolResult",
        toolCallId: id,
        isError: false,
        content: [],
        details: { path },
      },
    },
  };
}

test("history: a compaction inside a reply renders one avatar, one trace with a seam, one footer", () => {
  const model = createTranscriptRowModel();
  const history = [
    userItem("u1"),
    assistantItem("a1", [{ round: 1, key: "r1", blocks: [writeBlock("w1", "a.ts")] }]),
    summaryItem("s1"),
    assistantItem("a2", [
      { round: 1, key: "r1", blocks: [writeBlock("w2", "b.ts")], meta: { stopReason: "toolUse" } },
      { ...round("r2", "all done"), meta: { stopReason: "stop" } },
    ]),
  ];
  const snapshot = model.build(history, idleLive);

  assert.deepEqual(
    snapshot.rows.map((row) => row.kind),
    ["user", "assistant-unit", "assistant-unit", "assistant-unit"],
    "no summary row and no second reply",
  );
  const units = snapshot.rows.slice(1);
  assert.deepEqual(
    units.map((row) => row.unit.kind),
    ["work-trace", "block", "footer"],
  );
  assert.deepEqual(
    units.map((row) => row.showAvatar),
    [true, false, false],
    "exactly one avatar for the whole reply",
  );
  assert.deepEqual(
    units[0].unit.entries.map((entry) => entry.block.kind),
    ["toolGroup", "checkpoint", "toolGroup"],
    "the checkpoint is a seam inside the processing trace",
  );
  assert.equal(units[0].unit.entries[1].block.seam.summaryId, "s1");
  assert.equal(units[0].unit.hasAnswer, true);
  assert.equal(units[1].unit.block.text, "all done");
  assert.equal(units[2].unit.hasChangedFilesCandidate, true);
  assert.deepEqual(
    collectChangedFiles(units[2].unit.rounds).files.map((file) => file.path),
    ["a.ts", "b.ts"],
    "changed files aggregate across the seam",
  );
  assert.equal(units[2].unit.replyText, "all done");
  assert.equal(new Set(units[0].unit.entries.map((entry) => entry.key)).size, 3, "unique keys");
});

test("history: a checkpoint that ends an exchange stays a standalone divider card", () => {
  const model = createTranscriptRowModel();
  const history = [
    userItem("u1"),
    assistantItem("a1", [round("r1", "reply")]),
    summaryItem("s1"),
    userItem("u2"),
    assistantItem("a2", [round("r1", "reply 2")]),
  ];
  const snapshot = model.build(history, idleLive);
  assert.deepEqual(
    snapshot.rows.map((row) => row.kind),
    ["user", "assistant-unit", "assistant-unit", "summary", "user", "assistant-unit", "assistant-unit"],
  );
});

test("live: a mid-run compaction absorbs the committed half into the live reply and settles remount-free", () => {
  const model = createTranscriptRowModel();
  const sending = (liveRounds) => ({ ...idleLive, isSending: true, liveRounds });
  const firstHalfRound = {
    round: 1,
    key: "r1",
    blocks: [writeBlock("w1", "a.ts")],
    runningToolCallIds: [],
    thinkingOpen: false,
  };

  // Streaming the first half.
  const streaming = model.build([userItem("u1")], sending([firstHalfRound]));
  const activityKey = streaming.rows.at(-1).key;
  const workKey = workTraceRows(streaming)[0].key;

  // Compaction lands: the first half + checkpoint are committed to history and
  // the live transcript restarts empty (rebaseConversationStateDuringRun).
  const committed = [
    userItem("u1"),
    assistantItem("a1", [{ round: 1, key: "r1", blocks: firstHalfRound.blocks }]),
    summaryItem("s1"),
  ];
  const rebased = model.build(committed, sending([]));
  assert.deepEqual(
    rebased.rows.map((row) => row.kind),
    ["user", "assistant-activity"],
    "the committed half and the checkpoint fold into the live activity row",
  );
  assert.equal(rebased.rows.at(-1).key, activityKey);
  assert.equal(rebased.liveStartIndex, 1);
  const rebasedTrace = workTraceRows(rebased)[0];
  assert.equal(rebasedTrace.key, workKey);
  assert.deepEqual(
    rebasedTrace.unit.entries.map((entry) => entry.block.kind),
    ["toolGroup", "checkpoint"],
  );

  // The continuation streams.
  const continuationRound = {
    round: 1,
    key: "r1",
    blocks: [writeBlock("w2", "b.ts")],
    runningToolCallIds: ["w2"],
    thinkingOpen: false,
  };
  const continuing = model.build(committed, sending([continuationRound]));
  const continuingTrace = workTraceRows(continuing)[0];
  assert.equal(continuingTrace.key, workKey);
  assert.deepEqual(
    continuingTrace.unit.entries.map((entry) => entry.block.kind),
    ["toolGroup", "checkpoint", "toolGroup"],
  );
  assert.equal(
    new Set(continuingTrace.unit.entries.map((entry) => entry.key)).size,
    3,
    "both halves' r1 rounds are re-keyed apart",
  );
  const liveContinuationKey = continuingTrace.unit.entries[2].key;

  // Settle: the persisted twin is assistant → summary → assistant.
  const settledHistory = [
    ...committed,
    assistantItem("a2", [
      { round: 1, key: "r1", blocks: continuationRound.blocks, meta: { stopReason: "toolUse" } },
      { ...round("r2", "all done"), meta: { stopReason: "stop" } },
    ]),
  ];
  const settled = model.build(settledHistory, idleLive);
  assert.deepEqual(
    settled.rows.map((row) => row.kind),
    ["user", "assistant-activity"],
    "the settled reply is adopted as one activity row",
  );
  assert.equal(settled.rows.at(-1).key, activityKey, "zero remount: same activity key");
  const settledTrace = workTraceRows(settled)[0];
  assert.equal(settledTrace.key, workKey);
  assert.equal(
    settledTrace.unit.entries[2].key,
    liveContinuationKey,
    "the continuation entry keeps the key it streamed under",
  );
  assert.deepEqual(
    settled.rows.at(-1).units.map((unit) => unit.unit.kind),
    ["work-trace", "block", "footer"],
  );
  assert.deepEqual(
    settled.rows.at(-1).units.map((unit) => unit.showAvatar),
    [true, false, false],
  );
});

test("live: an idle manual compaction still settles into a standalone checkpoint card", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1"), assistantItem("a1", [round("r1", "reply")])];
  model.build(history, { ...idleLive, isCompactionRunning: true });
  const withCheckpoint = [...history, summaryItem("s1")];
  const running = model.build(withCheckpoint, { ...idleLive, isCompactionRunning: true });
  assert.equal(
    running.rows.filter((row) => row.kind === "summary").length,
    1,
    "no reply content ⇒ the checkpoint is not absorbed",
  );
  const settled = model.build(withCheckpoint, idleLive);
  assert.deepEqual(
    settled.rows.map((row) => row.kind),
    ["user", "assistant-unit", "assistant-unit", "summary"],
  );
});
