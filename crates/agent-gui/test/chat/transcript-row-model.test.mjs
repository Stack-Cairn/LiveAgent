import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTranscriptRowModel } = loader.loadModule("src/pages/chat/transcript/rowModel.ts");
const { createEntranceRegistry, ENTRANCE_ANIMATION_WINDOW_MS } = loader.loadModule(
  "src/lib/transcript-virtual/entranceOnce.ts",
);
const { extractLiveRange } = loader.loadModule("src/lib/transcript-virtual/liveRangeExtractor.ts");

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

const idleLive = { isSending: false, draftAssistantText: "", toolStatus: null, liveRounds: [] };

test("settling a live turn keys the committed twin with the live row key", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];

  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "partial"), runningToolCallIds: [], thinkingOpen: false }],
  });
  assert.equal(streaming.liveStartIndex, 1);
  const liveKey = streaming.rows[1].key;
  assert.ok(liveKey.startsWith("live-turn-"));
  assert.equal(streaming.rows[1].renderMode, "streaming");

  const settledHistory = [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])];
  const settled = model.build(settledHistory, idleLive);
  assert.equal(settled.liveStartIndex, -1);
  assert.equal(settled.rows.length, 2);
  assert.equal(settled.rows[1].key, liveKey, "committed twin adopts the live row key");
  assert.equal(settled.rows[1].renderMode, "streaming", "stream-born rows stay in streaming mode");

  // Later rebuilds (new item identities, same item keys) keep the alias.
  const rebuilt = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])],
    idleLive,
  );
  assert.equal(rebuilt.rows[1].key, liveKey);
});

test("persist lag: the alias still lands when history commits a build later", () => {
  const model = createTranscriptRowModel();
  const history = [userItem("u1")];

  const streaming = model.build(history, {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "partial"), runningToolCallIds: [], thinkingOpen: false }],
  });
  const liveKey = streaming.rows[1].key;

  // Run ended but the committed twin has not landed yet.
  const gap = model.build(history, idleLive);
  assert.equal(gap.rows.length, 1);

  const settled = model.build(
    [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])],
    idleLive,
  );
  assert.equal(settled.rows[1].key, liveKey);
});

test("a new turn supersedes an unresolved settle so aliases never cross turns", () => {
  const model = createTranscriptRowModel();
  const sendingLive = {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "x"), runningToolCallIds: [], thinkingOpen: false }],
  };

  model.build([userItem("u1")], sendingLive);
  model.build([userItem("u1")], idleLive); // twin never landed
  model.build([userItem("u1"), userItem("u2")], sendingLive); // next turn starts
  const secondLiveKey = model.build([userItem("u1"), userItem("u2")], sendingLive).rows.at(-1).key;

  const settled = model.build(
    [userItem("u1"), userItem("u2"), assistantItem("a2", [round("r1", "reply 2")])],
    idleLive,
  );
  assert.equal(settled.rows.at(-1).key, secondLiveKey, "alias belongs to the second turn");
});

test("draft text synthesizes the round shape buildUiMessages will commit", () => {
  const model = createTranscriptRowModel();
  const streaming = model.build([userItem("u1")], {
    ...idleLive,
    isSending: true,
    draftAssistantText: "hello",
  });
  const liveRow = streaming.rows[1];
  assert.equal(liveRow.rounds.length, 1);
  assert.equal(liveRow.rounds[0].key, "r1");
  assert.deepEqual(liveRow.rounds[0].blocks, [{ kind: "text", id: "text-1", text: "hello" }]);
});

test("settled rows reuse identities across builds while streaming", () => {
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
});

test("entrance registry: initial rows never animate, new rows animate once", () => {
  let clock = 1_000;
  const registry = createEntranceRegistry(() => clock);
  registry.observeBirths(["a", "b"], true);
  assert.equal(registry.shouldAnimate("a"), false, "initial rows are pre-registered");

  clock += 50;
  registry.observeBirths(["c"], false);
  assert.equal(registry.shouldAnimate("c"), true, "new row animates in its birth window");
  assert.equal(registry.shouldAnimate("a"), false);

  clock += ENTRANCE_ANIMATION_WINDOW_MS + 1;
  assert.equal(registry.shouldAnimate("c"), false, "virtualizer re-entry does not replay");

  // Replayed births (StrictMode double-build) keep the original stamp.
  registry.observeBirths(["c"], false);
  assert.equal(registry.shouldAnimate("c"), false, "replayed birth does not re-animate");

  registry.reset();
  registry.observeBirths(["c"], true);
  assert.equal(registry.shouldAnimate("c"), false, "after reset the first build re-seeds");
});

test("row model reports births once and reuses the history array between emits", () => {
  const births = [];
  const model = createTranscriptRowModel({
    onRowsBorn: (keys, isInitialBuild) => births.push([keys.slice(), isInitialBuild]),
  });
  const history = [userItem("u1"), assistantItem("a1", [round("r1", "done")])];

  const first = model.build(history, idleLive);
  assert.deepEqual(births, [[["u1", "a1"], true]]);

  // Same history identity → the same rows array comes back, no new births.
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
  assert.ok(births[1][0][0].startsWith("live-turn-"));
  assert.equal(streaming.rows[0], first.rows[0], "cached history rows survive the live tail");

  // Streaming emits with unchanged history report nothing further.
  model.build(history, { ...sendingLive });
  assert.equal(births.length, 2);
});

test("a twin that lands while still sending is re-keyed onto the live row at settle", () => {
  const model = createTranscriptRowModel();
  const sendingLive = {
    ...idleLive,
    isSending: true,
    liveRounds: [{ ...round("r1", "x"), runningToolCallIds: [], thinkingOpen: false }],
  };

  model.build([userItem("u1")], sendingLive);
  // The committed twin lands while the run is still sending (persist raced
  // the settle): it gets built un-aliased next to the live tail.
  const midRun = [userItem("u1"), assistantItem("a1", [round("r1", "full reply")])];
  const racing = model.build(midRun, sendingLive);
  const liveKey = racing.rows.at(-1).key;
  assert.equal(racing.rows[1].key, "a1");

  // Settle with the same history identity: the twin must adopt the live key
  // in place instead of keeping the stale un-aliased row.
  const settled = model.build(midRun, idleLive);
  assert.equal(settled.rows.length, 2);
  assert.equal(settled.rows[1].key, liveKey);
});

test("live range extractor unions the live tail with the visible window", () => {
  const range = { startIndex: 2, endIndex: 4, overscan: 0, count: 10 };
  assert.deepEqual(extractLiveRange(range, 8), [2, 3, 4, 8, 9]);
  assert.deepEqual(extractLiveRange(range, -1), [2, 3, 4]);
  assert.deepEqual(extractLiveRange(range, 3), [2, 3, 4, 5, 6, 7, 8, 9]);
});
