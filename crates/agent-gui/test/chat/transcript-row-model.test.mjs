import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTranscriptRowModel } = loader.loadModule("src/pages/chat/transcript/rowModel.ts");
const { createLiveTranscriptStore } = loader.loadModule(
  "src/lib/chat/conversation/liveTranscriptStore.ts",
);
const { createEntranceRegistry, ENTRANCE_ANIMATION_WINDOW_MS } = loader.loadModule(
  "@liveagent/ui/lib/transcript-virtual/entranceOnce.ts",
);
const { extractRenderUnitRange } = loader.loadModule(
  "src/pages/chat/transcript/renderUnitRangeExtractor.ts",
);
const { collectChangedFiles } = loader.loadModule("src/lib/chat/messages/changedFiles.ts");
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

function blockRows(snapshot) {
  return snapshot.rows
    .flatMap((row) => (row.kind === "assistant-activity" ? row.units : [row]))
    .filter((row) => row.kind === "assistant-unit" && row.unit.kind === "block");
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

test("settling a live turn preserves every block-unit key and adds one footer unit", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];

  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "partial"), runningToolCallIds: [], thinkingOpen: false }],
  });
  assert.equal(streaming.liveStartIndex, 1);
  const liveBlockKey = blockRows(streaming)[0].key;
  assert.match(liveBlockKey, /^live-turn-/);
  assert.equal(blockRows(streaming)[0].renderMode, "streaming");

  const settledHistory = [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])];
  const settled = model.build(settledHistory, idleLive);
  assert.equal(settled.liveStartIndex, -1);
  assert.equal(settled.rows.length, 2);
  assert.equal(blockRows(settled)[0].key, liveBlockKey);
  assert.equal(blockRows(settled)[0].renderMode, "streaming");
  assert.equal(footerRows(settled).length, 1);
  assert.ok(footerRows(settled)[0].key.startsWith(liveBlockKey.split(":round:")[0]));

  const rebuilt = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])],
    idleLive,
  );
  assert.equal(blockRows(rebuilt)[0].key, liveBlockKey);
});

test("persist lag: block-unit aliases still land one build later", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];
  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "partial"), runningToolCallIds: [], thinkingOpen: false }],
  });
  const liveBlockKey = blockRows(streaming)[0].key;

  const waitingForHistory = model.build(history, idleLive);
  assert.equal(waitingForHistory.rows.length, 2, "the live activity must not disappear while persistence lags");
  assert.equal(blockRows(waitingForHistory)[0].key, liveBlockKey);
  assert.equal(waitingForHistory.rows.at(-1).kind, "assistant-activity");
  assert.equal(waitingForHistory.rows.at(-1).live, false);
  assert.equal(waitingForHistory.rows.at(-1).units.at(-1).unit.kind, "status");
  assert.equal("active" in waitingForHistory.rows.at(-1).units.at(-1).unit, false);
  const settled = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])],
    idleLive,
  );
  assert.equal(blockRows(settled)[0].key, liveBlockKey);
});

test("a new turn supersedes an unresolved settle so aliases never cross turns", () => {
  const model = createTranscriptRowModel();
  const sendingLive = {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "x"), runningToolCallIds: [], thinkingOpen: false }],
  };

  const firstStreaming = model.build([userItem("u1")], sendingLive);
  const firstLiveBlockKey = blockRows(firstStreaming).at(-1).key;
  model.build([userItem("u1")], idleLive);
  const secondStreaming = model.build([userItem("u1"), userItem("u2")], sendingLive);
  const secondLiveBlockKey = blockRows(secondStreaming).at(-1).key;

  const delayedFirstTwin = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "reply 1")]), userItem("u2")],
    sendingLive,
  );
  assert.equal(blockRows(delayedFirstTwin)[0].key, firstLiveBlockKey);
  assert.equal(blockRows(delayedFirstTwin).at(-1).key, secondLiveBlockKey);

  const settled = model.build(
    [
      userItem("u1"),
      assistantItem("a1", [round("r1", "reply 1")]),
      userItem("u2"),
      assistantItem("a2", [round("r1", "reply 2")]),
    ],
    idleLive,
  );
  assert.equal(blockRows(settled)[0].key, firstLiveBlockKey);
  assert.equal(blockRows(settled).at(-1).key, secondLiveBlockKey);
});

test("draft text becomes one complete text render unit", () => {
  const model = createTranscriptRowModel();
  const streaming = model.build([userItem("u1")], {
    ...idleLive,
    isSending: true,
    draftAssistantText: "hello",
  });
  const liveBlock = blockRows(streaming)[0];
  assert.equal(liveBlock.unit.block.kind, "text");
  assert.equal(liveBlock.unit.block.key, "text-1");
  assert.equal(liveBlock.unit.block.text, "hello");
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
  const liveBlockKey = blockRows(racing).at(-1).key;
  assert.equal(blockRows(racing)[0].key, "a1:round:r1:block:text-1");

  const settled = model.build(midRun, idleLive);
  assert.equal(settled.rows.length, 2);
  assert.equal(blockRows(settled)[0].key, liveBlockKey);
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
  const liveBlockKey = blockRows(streaming)[0].key;

  store.settle();
  const committed = [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])];
  const finalizing = model.build(committed, { ...store.getSnapshot(), isSending: true });

  assert.equal(finalizing.rows.length, 2);
  assert.equal(finalizing.liveStartIndex, -1);
  assert.equal(blockRows(finalizing)[0].key, liveBlockKey);
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
    blockRows(snapshot).map((row) => row.unit.block.kind),
    ["text", "thinking", "toolGroup", "hostedSearchGroup"],
  );
  assert.equal(footerRows(snapshot).length, 1);
  assert.equal(blockRows(snapshot)[0].showAvatar, true);
  assert.ok(blockRows(snapshot).slice(1).every((row) => !row.showAvatar));
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
  const units = blockRows(snapshot);
  assert.equal(units.length, 3);
  assert.deepEqual(
    units.map((row) => row.mutable),
    [false, false, true],
  );
  const activity = snapshot.rows.find((row) => row.kind === "assistant-activity");
  assert.ok(activity);
  assert.deepEqual(
    activity.units.filter((unit) => unit.unit.kind === "block").map((unit) => unit.key),
    units.map((unit) => unit.key),
  );
  assert.equal(activity.units.at(-1).unit.kind, "status");
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
  const stableStatusKey = firstActivity.units.at(-1).key;
  assert.equal(firstActivity.units.at(-1).unit.kind, "status");

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
  assert.equal(grownActivity.units.at(-1).key, stableStatusKey);
  assert.equal(grownActivity.units.at(-1).unit.kind, "status");
  assert.deepEqual(
    grownActivity.units
      .filter((unit) => unit.unit.kind !== "status")
      .slice(0, firstActivity.units.length - 1)
      .map((unit) => unit.key),
    firstActivity.units.filter((unit) => unit.unit.kind !== "status").map((unit) => unit.key),
  );

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
  assert.equal(settledActivity.units.at(-1).key, stableStatusKey);
  assert.equal(settledActivity.units.at(-1).unit.kind, "footer");
  assert.deepEqual(
    settledActivity.units
      .filter((unit) => unit.unit.kind === "block")
      .map((unit) => unit.key),
    grownActivity.units.filter((unit) => unit.unit.kind === "block").map((unit) => unit.key),
  );
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
    const groupedTool = activity.units.find(
      (unit) => unit.unit.kind === "block" && unit.unit.block.kind === "toolGroup",
    );
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

test("usage stays on each round tail and changed files stay on the reply footer", () => {
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
  const units = blockRows(snapshot);
  assert.deepEqual(
    units.map((row) => row.unit.isRoundTail),
    [false, true, true],
  );
  assert.equal(units[1].unit.roundMeta.usage, usage);
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
  assert.deepEqual(extractRenderUnitRange(range, getCost, -1), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(readIndexes, [2, 5, 6, 7, 8, 9]);

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
