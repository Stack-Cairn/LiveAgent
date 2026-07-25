import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const {
  adoptHistoryWindowState,
  evaluateHistoryWindowResponse,
  noteHistoryWindowTotal,
  planHistoryWindowRequest,
  readHistoryWindowCounts,
  trimLeadingHeadlessEntries,
} = loader.loadModule("src/lib/chat/historyWindow.ts");

const INITIAL = 360;

test("readHistoryWindowCounts accepts a complete producer report", () => {
  const counts = readHistoryWindowCounts({
    total_message_count: 1000,
    returned_message_count: 360,
    has_more: true,
  });
  assert.deepEqual(counts, {
    totalMessageCount: 1000,
    returnedMessageCount: 360,
    hasMore: true,
  });
});

test("readHistoryWindowCounts rejects missing/zero/inconsistent counts", () => {
  assert.equal(readHistoryWindowCounts({}), null);
  assert.equal(readHistoryWindowCounts({ total_message_count: 100 }), null);
  assert.equal(
    readHistoryWindowCounts({ total_message_count: 0, returned_message_count: 0 }),
    null,
  );
  assert.equal(
    readHistoryWindowCounts({ total_message_count: 10, returned_message_count: 20 }),
    null,
  );
  assert.equal(
    readHistoryWindowCounts({ total_message_count: -1, returned_message_count: 5 }),
    null,
  );
});

test("first open plans the initial window", () => {
  assert.equal(planHistoryWindowRequest(undefined, { initialWindowMessages: INITIAL }), INITIAL);
});

test("a partially-loaded window always plans a bounded request", () => {
  const state = { oldestOffset: 500, lastTotal: 1000 };
  assert.equal(planHistoryWindowRequest(state, { initialWindowMessages: INITIAL }), 500);
});

test("a fully-loaded conversation stays fully loaded", () => {
  const counts = readHistoryWindowCounts({
    total_message_count: 200,
    returned_message_count: 200,
    has_more: false,
  });
  const state = adoptHistoryWindowState(counts);
  assert.equal(state.oldestOffset, 0);
  assert.equal(planHistoryWindowRequest(state, { initialWindowMessages: INITIAL }), undefined);
});

test("quiet refresh spans from the established edge to the tail", () => {
  // 1000 total, window covered the last 360 → edge at 640.
  const state = adoptHistoryWindowState({
    totalMessageCount: 1000,
    returnedMessageCount: 360,
    hasMore: true,
  });
  assert.equal(state.oldestOffset, 640);
  // 12 new messages appended since: span request covers them all.
  state.lastTotal = 1012;
  assert.equal(
    planHistoryWindowRequest(state, { initialWindowMessages: INITIAL }),
    1012 - 640,
  );
});

test("span never plans below the initial window", () => {
  const state = { oldestOffset: 995, lastTotal: 1000 };
  assert.equal(planHistoryWindowRequest(state, { initialWindowMessages: INITIAL }), INITIAL);
});

test("load-earlier extends the span by a page", () => {
  const state = { oldestOffset: 640, lastTotal: 1000 };
  assert.equal(
    planHistoryWindowRequest(state, {
      initialWindowMessages: INITIAL,
      extendMessages: INITIAL,
    }),
    360 + INITIAL,
  );
});

test("stable response applies and keeps the edge", () => {
  const previous = { oldestOffset: 640, lastTotal: 1000 };
  const verdict = evaluateHistoryWindowResponse({
    previous,
    counts: { totalMessageCount: 1000, returnedMessageCount: 360, hasMore: true },
  });
  assert.equal(verdict.action, "apply");
  assert.deepEqual(verdict.nextState, { oldestOffset: 640, lastTotal: 1000 });
});

test("edge-raising response (load earlier) applies", () => {
  const previous = { oldestOffset: 640, lastTotal: 1000 };
  const verdict = evaluateHistoryWindowResponse({
    previous,
    counts: { totalMessageCount: 1000, returnedMessageCount: 720, hasMore: true },
  });
  assert.equal(verdict.action, "apply");
  assert.deepEqual(verdict.nextState, { oldestOffset: 280, lastTotal: 1000 });
});

test("complete response applies and clears the edge", () => {
  const previous = { oldestOffset: 640, lastTotal: 1000 };
  const verdict = evaluateHistoryWindowResponse({
    previous,
    counts: { totalMessageCount: 1002, returnedMessageCount: 1002, hasMore: false },
  });
  assert.equal(verdict.action, "apply");
  assert.deepEqual(verdict.nextState, { oldestOffset: 0, lastTotal: 1002 });
});

test("slipped edge (concurrent append) retries with corrected size", () => {
  const previous = { oldestOffset: 640, lastTotal: 1000 };
  // Requested 360 but 8 messages were appended while in flight: the response
  // window starts at offset 648 — below the established edge.
  const verdict = evaluateHistoryWindowResponse({
    previous,
    counts: { totalMessageCount: 1008, returnedMessageCount: 360, hasMore: true },
  });
  assert.equal(verdict.action, "retry");
  assert.equal(verdict.retryMaxMessages, 1008 - 640);
});

test("slipped edge retry carries the extend page", () => {
  const previous = { oldestOffset: 640, lastTotal: 1000 };
  const verdict = evaluateHistoryWindowResponse({
    previous,
    counts: { totalMessageCount: 1008, returnedMessageCount: 360, hasMore: true },
    extendMessages: INITIAL,
  });
  assert.equal(verdict.action, "retry");
  assert.equal(verdict.retryMaxMessages, 1008 - 640 + INITIAL);
});

test("first observation always applies (no established edge)", () => {
  const verdict = evaluateHistoryWindowResponse({
    previous: undefined,
    counts: { totalMessageCount: 1000, returnedMessageCount: 360, hasMore: true },
  });
  assert.equal(verdict.action, "apply");
  assert.deepEqual(verdict.nextState, { oldestOffset: 640, lastTotal: 1000 });
});

test("noteHistoryWindowTotal folds a fresher upsert total forward", () => {
  const state = { oldestOffset: 640, lastTotal: 1000 };
  const noted = noteHistoryWindowTotal(state, 1002);
  assert.deepEqual(noted, { oldestOffset: 640, lastTotal: 1002 });
});

test("noteHistoryWindowTotal is identity for stale or invalid totals", () => {
  const state = { oldestOffset: 640, lastTotal: 1000 };
  assert.equal(noteHistoryWindowTotal(state, 1000), state);
  assert.equal(noteHistoryWindowTotal(state, 998), state);
  assert.equal(noteHistoryWindowTotal(state, -1), state);
  assert.equal(noteHistoryWindowTotal(state, Number.NaN), state);
  assert.equal(noteHistoryWindowTotal(state, undefined), state);
  assert.equal(noteHistoryWindowTotal(state, "1002"), state);
});

test("upsert-bumped post-turn refresh applies in a single request", () => {
  // Regression: without folding the upsert total into the bookkeeping, every
  // post-turn quiet refresh planned from the previous fetch's total, came up
  // short by exactly the flushed message count, and burned the slipped-edge
  // retry — two full window fetches per turn in the steady state.
  let state = adoptHistoryWindowState({
    totalMessageCount: 1000,
    returnedMessageCount: 360,
    hasMore: true,
  });
  // The desktop flushes a 2-message turn and publishes the upsert before the
  // conversation flips idle.
  state = noteHistoryWindowTotal(state, 1002);
  const planned = planHistoryWindowRequest(state, { initialWindowMessages: INITIAL });
  assert.equal(planned, 1002 - 640);
  const verdict = evaluateHistoryWindowResponse({
    previous: state,
    counts: { totalMessageCount: 1002, returnedMessageCount: 362, hasMore: true },
  });
  assert.equal(verdict.action, "apply");
  assert.deepEqual(verdict.nextState, { oldestOffset: 640, lastTotal: 1002 });
});

test("trimLeadingHeadlessEntries drops assistant-side entries before the first user turn", () => {
  const entries = [
    { kind: "assistant" },
    { kind: "tool_call" },
    { kind: "user" },
    { kind: "assistant" },
  ];
  const trimmed = trimLeadingHeadlessEntries(entries);
  assert.deepEqual(
    trimmed.map((entry) => entry.kind),
    ["user", "assistant"],
  );
});

test("trimLeadingHeadlessEntries keeps leading checkpoints", () => {
  const entries = [
    { kind: "checkpoint" },
    { kind: "assistant" },
    { kind: "user" },
    { kind: "assistant" },
  ];
  const trimmed = trimLeadingHeadlessEntries(entries);
  assert.deepEqual(
    trimmed.map((entry) => entry.kind),
    ["checkpoint", "user", "assistant"],
  );
});

test("trimLeadingHeadlessEntries is identity for user-first and headless-only windows", () => {
  const userFirst = [{ kind: "user" }, { kind: "assistant" }];
  assert.equal(trimLeadingHeadlessEntries(userFirst), userFirst);
  const headlessOnly = [{ kind: "assistant" }, { kind: "tool_call" }];
  assert.equal(trimLeadingHeadlessEntries(headlessOnly), headlessOnly);
});
