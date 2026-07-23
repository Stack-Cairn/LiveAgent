import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { buildRowsFromEntries, buildTurnRows, dedupeRowKeys } = loader.loadModule(
  "src/lib/chat/transcript/rows.ts",
);
const { createTurn, applyEventToTurn } = loader.loadModule(
  "src/lib/chat/transcript/turnReducer.ts",
);
const { alignHistory, groupHistoryEntriesIntoTurns } = loader.loadModule(
  "src/lib/chat/transcript/historyAlignment.ts",
);
const { parseHistoryMessagesJson } = loader.loadModule("src/lib/chatUi.ts");

function rowText(row) {
  if (row.kind === "assistant") {
    return row.rounds
      .map((round) =>
        round.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join(""),
      )
      .join("\n");
  }
  return row.text ?? "";
}

function ref(messageId, messageIndex = 0) {
  return {
    segmentIndex: 0,
    messageIndex,
    segmentId: "segment-1",
    messageId,
    role: "user",
    contentHash: `hash-${messageId}`,
  };
}

// ---------------------------------------------------------------------------
// Row builder

test("meta-only assistant entries never emit an avatar row", () => {
  const rows = buildRowsFromEntries(
    [{ id: "a-1", kind: "assistant", text: "", round: 1, meta: { provider: "deepseek" } }],
    "history",
  );
  assert.equal(rows.length, 0, "a content-less round renders nothing");
});

test("a meta carrier merges into the round that has content", () => {
  const rows = buildRowsFromEntries(
    [
      { id: "a-meta", kind: "assistant", text: "", round: 1, meta: { provider: "deepseek" } },
      { id: "th-1", kind: "thinking", text: "reasoning", round: 1 },
      { id: "a-1", kind: "assistant", text: "answer", round: 1 },
    ],
    "history",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "assistant");
  assert.equal(rows[0].rounds.length, 1);
  assert.equal(rows[0].rounds[0].meta?.provider, "deepseek", "meta survives on the visible round");
});

test("thinking-only rounds count as content", () => {
  const rows = buildRowsFromEntries(
    [{ id: "th-1", kind: "thinking", text: "chain of thought", round: 1 }],
    "stream",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "assistant");
});

test("checkpoint and error entries flush the assistant group", () => {
  const rows = buildRowsFromEntries(
    [
      { id: "a-1", kind: "assistant", text: "before", round: 1 },
      {
        id: "checkpoint-s1",
        kind: "checkpoint",
        content: "summary",
        summaryId: "s1",
        coveredMessageCount: 3,
        generatedBy: { providerId: "liveagent", model: "summary" },
      },
      { id: "a-2", kind: "assistant", text: "after", round: 1 },
      { id: "err-1", kind: "error", text: "boom" },
    ],
    "history",
  );
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["assistant", "checkpoint", "assistant", "error"],
  );
  assert.equal(rowText(rows[0]), "before");
  assert.equal(rowText(rows[2]), "after");
});

test("buildTurnRows emits the user bubble before any assistant content, tagged with the turn key", () => {
  let turn = createTurn({ key: "req:c1", runId: "run-1" });
  turn = { ...turn, user: { id: "ou:c1", kind: "user", text: "prompt", attachments: [] } };
  turn = applyEventToTurn(turn, { type: "token", text: "reply", round: 1 });
  const rows = buildTurnRows(turn);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["user", "assistant"],
  );
  assert.equal(rows[0].key, "ou:c1");
  assert.equal(rows[0].origin, "stream");
  assert.equal(rows[1].turnKey, "req:c1");
});

test("dedupeRowKeys suffixes collisions deterministically without touching unique keys", () => {
  const rows = [
    { key: "a", origin: "history", kind: "error", text: "1" },
    { key: "a", origin: "history", kind: "error", text: "2" },
    { key: "b", origin: "history", kind: "error", text: "3" },
  ];
  const deduped = dedupeRowKeys(rows);
  assert.deepEqual(
    deduped.map((row) => row.key),
    ["a", "a#2", "b"],
  );
  const untouched = [
    { key: "a", origin: "history", kind: "error", text: "1" },
    { key: "b", origin: "history", kind: "error", text: "2" },
  ];
  assert.equal(dedupeRowKeys(untouched), untouched, "no copy when keys are already unique");
});

// ---------------------------------------------------------------------------
// Deterministic history parse ids

test("parseHistoryMessagesJson yields identical ids across reparses", () => {
  const raw = JSON.stringify([
    {
      role: "user",
      id: "m1",
      content: "问题",
      liveAgentHistoryRef: {
        segmentIndex: 0,
        messageIndex: 0,
        segmentId: "seg-1",
        messageId: "m1",
        role: "user",
        contentHash: "h1",
      },
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考" },
        { type: "text", text: "回答" },
      ],
      provider: "deepseek",
    },
    { role: "user", content: "继续" },
    { role: "user", content: "继续" },
  ]);
  const first = parseHistoryMessagesJson(raw);
  const second = parseHistoryMessagesJson(raw);
  assert.deepEqual(
    first.map((entry) => entry.id),
    second.map((entry) => entry.id),
    "reparse is id-stable",
  );
  assert.equal(first[0].id, "hu:m1", "ref-anchored user id");
  assert.ok(first[1].id.startsWith("ht:hu:m1>"), "turn-anchored block id");
  const dupIds = first.filter((entry) => entry.kind === "user" && entry.text === "继续");
  assert.equal(new Set(dupIds.map((entry) => entry.id)).size, 2, "identical prompts get distinct ids");
});

test("thinking-first persisted replies emit a meta carrier that rows suppress", () => {
  const raw = JSON.stringify([
    { role: "user", id: "m1", content: "查询" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "推理" },
        { type: "text", text: "结论" },
      ],
      provider: "deepseek",
      model: "deepseek-v4",
    },
  ]);
  const entries = parseHistoryMessagesJson(raw);
  const metaCarrier = entries.find((entry) => entry.kind === "assistant" && entry.text === "");
  assert.ok(metaCarrier, "parser keeps the meta carrier entry");
  const rows = buildRowsFromEntries(entries, "history");
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["user", "assistant"],
    "no avatar-only row from the meta carrier",
  );
});

// ---------------------------------------------------------------------------
// History alignment

function settledTurn(key, runId, userText, replyText, userRef) {
  let turn = createTurn({ key, runId, phase: "settled" });
  turn = {
    ...turn,
    user: {
      id: `ou:${key}`,
      kind: "user",
      text: userText,
      attachments: [],
      ...(userRef ? { messageRef: userRef } : {}),
    },
  };
  if (replyText !== null) {
    turn = applyEventToTurn(turn, { type: "token", text: replyText, round: 1 });
  }
  return { ...turn, phase: "settled" };
}

test("replace keeps pending/streaming turns and trims their persisted echoes", () => {
  const base = settledTurn("req:c9", "run-9", "active prompt", null);
  const streaming = {
    ...base,
    user: { ...base.user, messageId: "m9" },
    phase: "streaming",
  };
  const result = alignHistory({
    historyEntries: [],
    turns: [streaming],
    entries: [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: ref("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
      { id: "hu:m9", kind: "user", text: "active prompt", attachments: [], messageRef: ref("m9", 2) },
    ],
    mode: "replace",
  });
  assert.equal(result.turns.length, 1, "streaming turn kept");
  assert.equal(result.turns[0].user.messageRef?.messageId, "m9", "echo's ref adopted");
  assert.deepEqual(
    result.historyEntries.map((entry) => entry.id),
    ["hu:m1", "ht:hu:m1>0"],
    "persisted echo of the active prompt trimmed",
  );
});

test("replace trims a partially persisted reply for the active exchange", () => {
  const base = settledTurn(
    "req:c9",
    "run-9",
    "active prompt",
    "persisted partial plus live tail",
  );
  const streaming = {
    ...base,
    user: { ...base.user, messageId: "m9" },
    phase: "streaming",
  };
  const result = alignHistory({
    historyEntries: [],
    turns: [streaming],
    entries: [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: ref("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
      {
        id: "hu:m9",
        kind: "user",
        text: "active prompt",
        attachments: [],
        messageRef: ref("m9", 2),
      },
      { id: "ht:hu:m9>0", kind: "assistant", text: "persisted partial", round: 1 },
    ],
    mode: "replace",
  });
  assert.equal(result.turns.length, 1, "streaming turn remains authoritative");
  assert.equal(result.turns[0].user.messageRef?.messageId, "m9");
  assert.deepEqual(
    result.historyEntries.map((entry) => entry.id),
    ["hu:m1", "ht:hu:m1>0"],
    "the whole persisted copy of the active exchange is trimmed",
  );
});

test("replace keeps an older completed exchange when the active prompt repeats its text", () => {
  const base = settledTurn("req:c9", "run-9", "same prompt", "old completed reply plus new tail");
  const streaming = {
    ...base,
    user: { ...base.user, messageId: "m9" },
    phase: "streaming",
  };
  const result = alignHistory({
    historyEntries: [],
    turns: [streaming],
    entries: [
      {
        id: "hu:m1",
        kind: "user",
        text: "same prompt",
        attachments: [],
        messageRef: ref("m1"),
      },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old completed reply", round: 1 },
    ],
    mode: "replace",
  });

  assert.deepEqual(
    result.historyEntries.map((entry) => entry.id),
    ["hu:m1", "ht:hu:m1>0"],
    "matching prompt text alone must not consume the previous exchange",
  );
  assert.equal(result.turns[0].user.messageRef, undefined);
});

test("replace drops settled turns in favor of the parsed history", () => {
  const settled = settledTurn("req:c1", "run-1", "prompt", "reply");
  const result = alignHistory({
    historyEntries: [],
    turns: [settled],
    entries: [
      { id: "hu:m1", kind: "user", text: "prompt", attachments: [], messageRef: ref("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "reply", round: 1 },
    ],
    mode: "replace",
  });
  assert.equal(result.turns.length, 0);
  assert.equal(result.historyEntries.length, 2);
});

test("enrich pairs the trailing turns and upgrades tool payloads by id", () => {
  let turn = settledTurn("req:c1", "run-1", "prompt", null, undefined);
  turn = applyEventToTurn(turn, {
    type: "tool_call",
    id: "call-1",
    name: "Read",
    arguments: {},
    round: 1,
  });
  turn = { ...turn, phase: "settled" };
  const entryId = turn.entries[0].id;

  const result = alignHistory({
    historyEntries: [],
    turns: [turn],
    entries: [
      { id: "hu:m1", kind: "user", text: "prompt", attachments: [], messageRef: ref("m1") },
      {
        id: "ht:hu:m1>0",
        kind: "tool_call",
        round: 1,
        toolCall: { type: "toolCall", id: "call-1", name: "Read", arguments: { file: "a.ts" } },
        summary: "Read a.ts",
        text: '{"file":"a.ts"}',
      },
    ],
    mode: "enrich",
  });
  assert.equal(result.changed, true);
  const enriched = result.turns[0];
  assert.equal(enriched.user.messageRef?.messageId, "m1");
  assert.equal(enriched.entries[0].id, entryId, "tool entry keeps its rendered id");
  assert.deepEqual(enriched.entries[0].toolCall.arguments, { file: "a.ts" }, "full args adopted");
});

test("enrich with a partial suffix window leaves the history region untouched", () => {
  const region = [
    { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: ref("m1") },
    { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
  ];
  const turn = settledTurn("req:c2", "run-2", "new", "new reply");
  const result = alignHistory({
    historyEntries: region,
    turns: [turn],
    entries: [
      { id: "hu:m2", kind: "user", text: "new", attachments: [], messageRef: ref("m2", 2) },
      { id: "ht:hu:m2>0", kind: "assistant", text: "new reply", round: 1 },
    ],
    mode: "enrich",
  });
  assert.equal(result.historyEntries, region, "suffix window cannot truncate the region");
  assert.equal(result.turns[0].user.messageRef?.messageId, "m2", "pairing still enriches");
});

test("enrich replaces wholesale when history is ahead of the store", () => {
  const turn = settledTurn("req:c1", "run-1", "known", "known reply");
  const entries = [
    { id: "hu:m1", kind: "user", text: "known", attachments: [], messageRef: ref("m1") },
    { id: "ht:hu:m1>0", kind: "assistant", text: "known reply", round: 1 },
    { id: "hu:m2", kind: "user", text: "foreign", attachments: [], messageRef: ref("m2", 2) },
    { id: "ht:hu:m2>0", kind: "assistant", text: "foreign reply", round: 1 },
  ];
  const result = alignHistory({ historyEntries: [], turns: [turn], entries, mode: "enrich" });
  assert.deepEqual(result.turns, [], "stale turns dropped");
  assert.equal(result.historyEntries, entries, "history becomes authoritative");
});

test("enrich repaints on a messageRef conflict but never loses unpersisted exchanges", () => {
  const conflicted = settledTurn("req:c1", "run-1", "prompt", "reply", ref("expected"));
  const covered = settledTurn("req:c0", "run-0", "known", "known reply", ref("other"));
  const entries = [
    { id: "hu:other", kind: "user", text: "known", attachments: [], messageRef: ref("other") },
    { id: "ht:hu:other>0", kind: "assistant", text: "known reply", round: 1 },
    { id: "hu:foreign", kind: "user", text: "foreign", attachments: [], messageRef: ref("foreign") },
    { id: "ht:hu:foreign>0", kind: "assistant", text: "foreign reply", round: 1 },
  ];
  const result = alignHistory({
    historyEntries: [],
    turns: [covered, conflicted],
    entries,
    mode: "enrich",
  });
  assert.equal(result.changed, true);
  assert.equal(result.historyEntries, entries, "history becomes authoritative");
  assert.deepEqual(
    result.turns.map((turn) => turn.key),
    ["req:c1"],
    "the turn history covers is dropped; the one it cannot know survives",
  );
});

test("enrich never replaces streamed text with the persisted shape", () => {
  const turn = settledTurn("req:c1", "run-1", "as typed", "streamed reply");
  const result = alignHistory({
    historyEntries: [],
    turns: [turn],
    entries: [
      {
        id: "hu:m1",
        kind: "user",
        text: "as persisted (expanded mentions)",
        attachments: [],
        messageRef: ref("m1"),
      },
      { id: "ht:hu:m1>0", kind: "assistant", text: "persisted reply shape", round: 1 },
    ],
    mode: "enrich",
  });
  const enriched = result.turns[0];
  assert.equal(enriched.user.text, "as typed", "display text stays the streamed one");
  assert.equal(enriched.user.messageRef?.messageId, "m1");
  const replyEntry = enriched.entries.find((entry) => entry.kind === "assistant");
  assert.equal(replyEntry.text, "streamed reply", "assistant text never replaced");
});

test("groupHistoryEntriesIntoTurns keeps a headless leading turn", () => {
  const turns = groupHistoryEntriesIntoTurns([
    { id: "ht:^>0", kind: "assistant", text: "cut mid-turn", round: 1 },
    { id: "hu:m1", kind: "user", text: "prompt", attachments: [] },
    { id: "ht:hu:m1>0", kind: "assistant", text: "reply", round: 1 },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].user, null);
  assert.equal(turns[1].user?.id, "hu:m1");
});
