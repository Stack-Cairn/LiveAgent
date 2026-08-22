import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTrajectoryRecorder, NOOP_TRAJECTORY_RECORDER } = loader.loadModule(
  "src/lib/trajectory/recorder.ts",
);

function harness(overrides = {}) {
  const persisted = [];
  const persistedSections = [];
  const published = [];
  const ports = {
    persist: async (conversationId, segmentIndex, eventsJson) => {
      persisted.push({ conversationId, segmentIndex, events: JSON.parse(eventsJson) });
    },
    persistSections: async (conversationId, sections) => {
      persistedSections.push({ conversationId, sections: [...sections] });
    },
    publish: (events) => {
      published.push(...events);
    },
    ...overrides,
  };
  const recorder = createTrajectoryRecorder({
    conversationId: "conv-1",
    getSegmentIndex: () => 3,
    ports,
    // Timer pushed far out: these tests drive flushes explicitly so nothing
    // depends on wall-clock timing.
    flushIntervalMs: 1_000_000,
  });
  return { recorder, persisted, persistedSections, published };
}

test("events are published immediately and persisted in one batch", async () => {
  const { recorder, persisted, published } = harness();
  recorder.beginTurn({ turn: 1, messageIndex: 0, text: "hi" });
  recorder.stepStart(1, "h_a");
  recorder.stepEnd(1, { status: "complete", usage: { output: 3 } });

  assert.equal(published.length, 3);
  assert.equal(persisted.length, 0, "nothing is written before an explicit flush");

  await recorder.flush();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].conversationId, "conv-1");
  assert.equal(persisted[0].segmentIndex, 3);
  assert.deepEqual(
    persisted[0].events.map((event) => event.k),
    ["user", "step_start", "step_end"],
  );
});

test("user events preserve the global message index for lifecycle trimming", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 7, messageIndex: 42, messageId: "user-42" });
  assert.equal(published[0].k, "user");
  assert.equal(published[0].t, 7);
  assert.equal(published[0].mi, 42);
  assert.equal(published[0].id, "user-42");
});

test("steps inherit the turn opened by beginTurn", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 4 });
  recorder.stepStart(2);
  recorder.toolStart(2, { id: "c1", name: "Bash" });
  recorder.endTurn({ status: "complete" });
  assert.deepEqual(
    published.map((event) => event.t),
    [4, 4, 4, 4, 4],
  );
});

test("turn failure closes an open provider step with the same error before turn_end", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 3 });
  recorder.stepStart(2, "h_provider");
  recorder.endTurn({ status: "error", error: "provider exploded" });

  assert.deepEqual(
    published.map((event) => event.k),
    ["user", "step_start", "step_end", "turn_end"],
  );
  const stepEnd = published.find((event) => event.k === "step_end");
  assert.equal(stepEnd.t, 3);
  assert.equal(stepEnd.s, 2);
  assert.equal(stepEnd.st, "error");
  assert.equal(stepEnd.err, "provider exploded");
});

test("events before any beginTurn fall back to turn 1 instead of being dropped", () => {
  const { recorder, published } = harness();
  recorder.stepStart(1);
  assert.equal(published[0].t, 1);
});

test("a flush with an empty buffer does not touch storage", async () => {
  const { recorder, persisted } = harness();
  await recorder.flush();
  assert.equal(persisted.length, 0);
});

test("an unchanged prompt reuses the header id and emits nothing", async () => {
  const { recorder, published, persistedSections } = harness();
  const input = { base: "BASE", memory: "MEM", toolCatalog: "TOOLS" };
  const first = recorder.captureHeader(input);
  const second = recorder.captureHeader(input);

  assert.equal(typeof first, "string");
  assert.equal(second, first);
  assert.equal(published.filter((event) => event.k === "header").length, 1);

  await recorder.flush();
  assert.equal(persistedSections.length, 1);
  assert.equal(persistedSections[0].sections.length, 3);
});

test("only the changed slot is persisted on the next header", async () => {
  const { recorder, persistedSections } = harness();
  recorder.captureHeader({ base: "BASE", memory: "MEM-1" });
  await recorder.flush();
  recorder.captureHeader({ base: "BASE", memory: "MEM-2" });
  await recorder.flush();

  assert.equal(persistedSections.length, 2);
  assert.deepEqual(
    persistedSections[1].sections.map((section) => section.slot),
    ["memory"],
  );
});

test("the header event links back to the previous header", () => {
  const { recorder, published } = harness();
  const first = recorder.captureHeader({ base: "A" });
  recorder.captureHeader({ base: "B" });
  const headers = published.filter((event) => event.k === "header");
  assert.equal(headers[0].prev, undefined);
  assert.equal(headers[1].prev, first);
  assert.equal(headers[1].ch, "system");
});

test("sections are written before the events that reference them", async () => {
  const order = [];
  const { recorder } = harness({
    persist: async () => {
      order.push("events");
    },
    persistSections: async () => {
      order.push("sections");
    },
  });
  recorder.captureHeader({ base: "BASE" });
  recorder.stepStart(1, "h_x");
  await recorder.flush();
  assert.deepEqual(order, ["sections", "events"]);
});

test("first token is recorded once per step", () => {
  const { recorder, published } = harness();
  recorder.firstToken(1);
  recorder.firstToken(1);
  recorder.firstToken(2);
  assert.equal(published.filter((event) => event.k === "first_token").length, 2);
});

test("noteRetry carries the provider label and planned delay for the audit trail", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 2 });
  recorder.noteRetry(1, {
    attempt: 1,
    maxRetries: 5,
    delayMs: 200,
    error: "503 service unavailable",
    provider: "P1 · claude-x",
  });
  const retry = published.find((event) => event.k === "retry");
  assert.equal(retry.t, 2);
  assert.equal(retry.s, 1);
  assert.equal(retry.n, 1);
  assert.equal(retry.max, 5);
  assert.equal(retry.delay, 200);
  assert.equal(retry.err, "503 service unavailable");
  assert.equal(retry.p, "P1 · claude-x");
});

test("noteFailover emits a failover event with switch identity", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 3 });
  recorder.noteFailover(2, {
    attempt: 1,
    fromLabel: "P1 · claude-x",
    toLabel: "P2 · claude-x",
    targetIndex: 1,
    error: "503 from primary",
  });
  const failover = published.find((event) => event.k === "failover");
  assert.equal(failover.t, 3);
  assert.equal(failover.s, 2);
  assert.equal(failover.n, 1);
  assert.equal(failover.from, "P1 · claude-x");
  assert.equal(failover.to, "P2 · claude-x");
  assert.equal(failover.ti, 1);
  assert.equal(failover.err, "503 from primary");
});

test("noteTransport records header names and routing flags without values", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 1 });
  recorder.noteTransport(1, {
    provider: "P1 · claude-x",
    upstreamOrigin: "https://api.example.com",
    useSystemProxy: true,
    fullUrl: false,
    headerNames: ["x-liveagent-proxy-token", "x-liveagent-upstream-origin"],
  });
  const transport = published.find((event) => event.k === "transport");
  assert.equal(transport.p, "P1 · claude-x");
  assert.equal(transport.o, "https://api.example.com");
  assert.equal(transport.sp, true);
  assert.equal(transport.fu, false);
  assert.deepEqual(transport.hn, ["x-liveagent-proxy-token", "x-liveagent-upstream-origin"]);
  const serialized = JSON.stringify(transport);
  assert.ok(!serialized.includes("Bearer"), "transport events must never carry header values");
});

test("error text entering the ledger is scrubbed of URL keys and bearer tokens", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 1 });
  recorder.noteRetry(1, {
    attempt: 1,
    error:
      "fetch failed: https://api.example.com/v1?key=AIzaSyC-secret-sample-0123456789012 Authorization: Bearer sk-proj-abcdef1234567890abcdef",
  });
  recorder.stepEnd(1, { status: "error", error: "401 x-goog-api-key=AIzaSyD_other_key_0123456789" });
  recorder.endTurn({ status: "error", error: "Bearer sk-ant-api03-verysecretvalue12345" });

  for (const event of published) {
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes("AIzaSy"), `leaked google key in ${event.k}`);
    assert.ok(!serialized.includes("sk-proj-"), `leaked openai key in ${event.k}`);
    assert.ok(!serialized.includes("sk-ant-"), `leaked anthropic key in ${event.k}`);
  }
  const retry = published.find((event) => event.k === "retry");
  assert.ok(retry.err.includes("[redacted]"));
  assert.ok(retry.err.includes("fetch failed"), "non-secret prose survives scrubbing");
});


test("context previews are bounded while preserving their source", () => {
  const { recorder, published } = harness();
  recorder.noteContext({ source: "parent-message-bus", text: "x".repeat(2_000) });
  const event = published.find((entry) => entry.k === "context");
  assert.equal(event.src, "parent-message-bus");
  assert.ok(event.tx.length <= 513);
  assert.ok(event.tx.endsWith("…"));
});

test("tool arguments are truncated before they reach the wire", () => {
  const { recorder, published } = harness();
  recorder.toolStart(1, { id: "c1", name: "Bash", arguments: { cmd: "x".repeat(5_000) } });
  const event = published.find((entry) => entry.k === "tool_start");
  assert.ok(event.a.length <= 201, `expected a truncated preview, got ${event.a.length}`);
  assert.ok(event.a.endsWith("…"));
});

test("a tool with no arguments omits the field entirely", () => {
  const { recorder, published } = harness();
  recorder.toolStart(1, { id: "c1", name: "Bash" });
  assert.equal(published.find((entry) => entry.k === "tool_start").a, undefined);
});

test("subagent run ids ride on tool_end", () => {
  const { recorder, published } = harness();
  recorder.toolEnd("c1", { subagentRunIds: ["r1", "r2"] });
  assert.deepEqual(published.find((entry) => entry.k === "tool_end").run, ["r1", "r2"]);
});

test("standalone compaction is recorded outside any turn", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 2 });
  recorder.compactionStart();
  recorder.compactionEnd({ status: "complete", tokensBefore: 900, tokensAfter: 100 });
  recorder.compactionStart({ standalone: true });
  recorder.compactionEnd({ status: "complete", standalone: true });

  const compactions = published.filter((event) => event.k.startsWith("compaction"));
  assert.deepEqual(
    compactions.map((event) => event.t),
    [2, 2, null, null],
  );
  assert.equal(compactions[1].before, 900);
});

test("a failing persist never propagates to the caller", async () => {
  const { recorder } = harness({
    persist: async () => {
      throw new Error("disk on fire");
    },
  });
  recorder.beginTurn({ turn: 1 });
  await recorder.flush();
});

test("a throwing publish never propagates to the caller", () => {
  const { recorder } = harness({
    publish: () => {
      throw new Error("socket closed");
    },
  });
  recorder.beginTurn({ turn: 1 });
  recorder.stepStart(1);
});

test("dispose drains the buffer and then goes quiet", async () => {
  const { recorder, persisted, published } = harness();
  recorder.beginTurn({ turn: 1 });
  await recorder.dispose();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].events.length, 1);

  const publishedBefore = published.length;
  recorder.stepStart(1);
  assert.equal(published.length, publishedBefore, "events after dispose are dropped");
});

test("the noop recorder satisfies the same shape without side effects", async () => {
  assert.equal(NOOP_TRAJECTORY_RECORDER.captureHeader({ base: "X" }), undefined);
  NOOP_TRAJECTORY_RECORDER.beginTurn({ turn: 1 });
  NOOP_TRAJECTORY_RECORDER.toolEnd("c1", {});
  await NOOP_TRAJECTORY_RECORDER.flush();
  await NOOP_TRAJECTORY_RECORDER.dispose();
});

test("a failed event write is retried without losing the batch", async () => {
  let attempts = 0;
  const stored = [];
  const { recorder } = harness({
    persist: async (_conversationId, _segmentIndex, eventsJson) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient write failure");
      stored.push(...JSON.parse(eventsJson));
    },
  });
  recorder.beginTurn({ turn: 1 });
  await recorder.flush();
  assert.equal(stored.length, 0);
  await recorder.flush();
  assert.equal(attempts, 2);
  assert.deepEqual(stored.map((event) => event.k), ["user"]);
});

test("dispose retries a transient final write before releasing the recorder", async () => {
  let attempts = 0;
  const stored = [];
  const { recorder } = harness({
    persist: async (_conversationId, _segmentIndex, eventsJson) => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary database lock");
      stored.push(...JSON.parse(eventsJson));
    },
  });
  recorder.beginTurn({ turn: 1 });
  await recorder.dispose();
  assert.equal(attempts, 3);
  assert.deepEqual(stored.map((event) => event.k), ["user"]);
});

test("dispose remains bounded when persistence stays unavailable", async () => {
  let attempts = 0;
  const { recorder } = harness({
    persist: async () => {
      attempts += 1;
      throw new Error("database unavailable");
    },
  });
  recorder.beginTurn({ turn: 1 });
  await recorder.dispose();
  assert.equal(attempts, 3);
});

test("discard drops pending diagnostic data without issuing a write", async () => {
  const { recorder, persisted } = harness();
  recorder.beginTurn({ turn: 1 });
  recorder.discard();
  await recorder.flush();
  assert.equal(persisted.length, 0);
});

test("events keep the segment that was active when they were emitted", async () => {
  let segmentIndex = 1;
  const persisted = [];
  const recorder = createTrajectoryRecorder({
    conversationId: "conv-segments",
    getSegmentIndex: () => segmentIndex,
    ports: {
      persist: async (_conversationId, segment, eventsJson) => {
        persisted.push({ segment, events: JSON.parse(eventsJson) });
      },
      persistSections: async () => {},
    },
    flushIntervalMs: 1_000_000,
  });
  recorder.beginTurn({ turn: 1 });
  segmentIndex = 2;
  recorder.stepStart(1);
  await recorder.flush();
  assert.deepEqual(
    persisted.map((entry) => [entry.segment, entry.events.map((event) => event.k)]),
    [
      [1, ["user"]],
      [2, ["step_start"]],
    ],
  );
});

test("events emitted while a write is in flight are drained in the same flush", async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const persisted = [];
  const { recorder } = harness({
    persist: async (_conversationId, _segmentIndex, eventsJson) => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      persisted.push(...JSON.parse(eventsJson));
    },
  });
  recorder.beginTurn({ turn: 1 });
  const flushing = recorder.flush();
  await Promise.resolve();
  recorder.stepStart(1);
  releaseFirst();
  await flushing;
  assert.deepEqual(persisted.map((event) => event.k), ["user", "step_start"]);
});

test("turn end is idempotent across happy-path and finalizer calls", () => {
  const { recorder, published } = harness();
  recorder.beginTurn({ turn: 1 });
  recorder.endTurn({ status: "complete" });
  recorder.endTurn({ status: "error", error: "late finalizer" });
  assert.equal(published.filter((event) => event.k === "turn_end").length, 1);
  assert.equal(published.find((event) => event.k === "turn_end").st, "complete");
});

test("new request headers declare the seven-slot runtime layout version", () => {
  const { recorder, published } = harness();
  const headerId = recorder.captureHeader({
    base: "base",
    runtime: "runtime-only context",
    toolsSuffix: "rules",
    toolCatalog: "[]",
  });
  assert.ok(headerId);
  const header = published.find((event) => event.k === "header");
  assert.ok(header);
  assert.equal(header.v, 2);
  assert.equal(header.sec.length, 7);
  assert.notEqual(header.sec[4], null);
});

test("runtime prompt sections are backward-compatible and classified as system changes", () => {
  const { recorder, published } = harness();
  recorder.captureHeader({
    base: "base prompt",
    toolsSuffix: "tool rules",
    toolCatalog: "[]",
    runtime: "runtime A",
  });
  recorder.captureHeader({
    base: "base prompt",
    toolsSuffix: "tool rules",
    toolCatalog: "[]",
    runtime: "runtime B",
  });

  const headers = published.filter((event) => event.k === "header");
  assert.equal(headers.length, 2);
  assert.equal(headers[0].sec.length, 7);
  assert.equal(typeof headers[0].sec[6], "string");
  assert.equal(headers[0].ch, "initial");
  assert.equal(headers[1].ch, "system");
  assert.equal(headers[0].sec[4], headers[1].sec[4]);
  assert.equal(headers[0].sec[5], headers[1].sec[5]);
  assert.notEqual(headers[0].sec[6], headers[1].sec[6]);
});
