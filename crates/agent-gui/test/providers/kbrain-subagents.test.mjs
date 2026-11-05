import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const events = loader.loadModule("src/lib/kbrain/subagentEvents.ts");
const pane = loader.loadModule("src/lib/subagents/kbrainPane.ts");
const store = loader.loadModule("src/lib/subagents/kbrainSubagentStore.ts");
const { kbrainSubagentView } = loader.loadModule("src/lib/subagents/kbrainSubagentView.ts");
const { subagentTranscriptItems } = loader.loadModule(
  "src/lib/subagents/kbrainSubagentTranscript.ts",
);
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const contract = loader.loadModule("@liveagent/ui/contracts/subagentPane.ts");

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

function event(seq, type, payload = {}, runId = "run-1") {
  return {
    version: "kbrain.agent.v1",
    seq,
    conversation_id: "backend-session-1",
    run_id: runId,
    type,
    created_at: "2026-11-05T00:00:00Z",
    payload,
  };
}

function subagent(overrides = {}) {
  return {
    id: "task-1",
    parent_id: "run-1",
    description: "Survey the parser",
    status: "running",
    model: { provider: "fixture", model: "fixture-model" },
    parent_tool_call_id: "call-1",
    started_at: "2026-11-05T00:00:00Z",
    ...overrides,
  };
}

const started = (seq, overrides) => event(seq, "subagent.started", { subagent: subagent(overrides) });
const child = (seq, kind, payload) =>
  event(seq, `trajectory.child.${kind}`, { task_id: "task-1", ...payload });

test("child events rebuild the transcript the way the backend does", () => {
  let messages = [{ role: "user", content: [{ type: "text", text: "Survey the parser" }] }];
  const apply = (value) => {
    messages = events.applyChildEvent(messages, value, { provider: "fixture", model: "m" });
  };
  apply(child(2, "thinking", { text: "Plan " }));
  apply(child(3, "thinking", { text: "first." }));
  apply(child(4, "text", { text: "Reading." }));
  apply(child(5, "tool_start", { id: "c1", name: "Read", arguments: '{"path":"a.go"}' }));
  apply(child(6, "tool_start", { id: "c2", name: "Grep", arguments: "not json" }));
  apply(child(7, "tool_end", { id: "c1", name: "Read", output: "package a" }));
  apply(child(8, "tool_end", { id: "c2", name: "Grep", output: "boom", failed: true }));
  apply(child(9, "thinking", { text: "Next." }));
  apply(child(10, "text", { text: "Done." }));
  apply(child(11, "steer", { text: "Also check b.go" }));
  apply(child(12, "text", { text: "Checked." }));

  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "assistant", "user", "assistant"],
  );
  assert.deepEqual(messages[1].content, [
    { type: "thinking", text: "Plan first." },
    { type: "text", text: "Reading." },
  ]);
  assert.equal(messages[1].model, "m");
  assert.deepEqual(messages[1].tool_calls, [
    { id: "c1", name: "Read", arguments: { path: "a.go" } },
    { id: "c2", name: "Grep", arguments: {} },
  ]);
  assert.equal(messages[3].stop_reason, "error");
  assert.deepEqual(messages[4].content, [
    { type: "thinking", text: "Next." },
    { type: "text", text: "Done." },
  ]);
  assert.equal(messages[5].content[0].text, "Also check b.go");
  assert.equal(messages[6].content[0].text, "Checked.");
});

test("applying an event never mutates the previous transcript", () => {
  const before = [{ role: "assistant", content: [{ type: "text", text: "a" }] }];
  const frozen = JSON.stringify(before);
  const after = events.applyChildEvent(before, child(2, "text", { text: "b" }));
  assert.equal(JSON.stringify(before), frozen);
  assert.equal(after[0].content[0].text, "ab");
  assert.notEqual(after, before);
});

test("a later subagent view wins field by field and a restart clears the end", () => {
  const done = subagent({
    status: "done",
    ended_at: "2026-11-05T00:01:00Z",
    report: "ok",
    usage: { input_tokens: 10, output_tokens: 5 },
    duration_ms: 60_000,
  });
  const merged = events.mergeSubagent(done, { id: "task-1", status: "done", description: "" });
  assert.equal(merged.description, "Survey the parser");
  assert.deepEqual(merged.usage, { input_tokens: 10, output_tokens: 5 });
  const restarted = events.mergeSubagent(done, { id: "task-1", status: "running" });
  assert.equal(restarted.ended_at, undefined);
  assert.equal(restarted.report, undefined);
  assert.equal(restarted.duration_ms, undefined);
  assert.equal(events.subagentEventTaskId(child(1, "text", {})), "task-1");
  assert.equal(events.subagentEventTaskId(started(1)), "task-1");
  assert.equal(events.subagentEventTaskId(event(1, "run.completed")), "");
});

test("the pane keeps a bounded set of tabs and falls back sensibly on close", () => {
  let state = pane.CLOSED_SUBAGENT_PANE;
  state = pane.openSubagentTab(state, "a");
  state = pane.openSubagentTab(state, "b");
  assert.deepEqual(state, { open: true, tabs: ["a", "b"], active: "b" });
  assert.deepEqual(pane.openSubagentTab(state, "a").tabs, ["a", "b"]);
  assert.deepEqual(pane.closeSubagentTab(state, "b"), { open: true, tabs: ["a"], active: "a" });
  assert.deepEqual(pane.closeSubagentTab(state, "a"), { open: true, tabs: ["b"], active: "b" });
  // Closing the last tab closes the pane, unless the directory was in front.
  const single = pane.openSubagentTab(pane.CLOSED_SUBAGENT_PANE, "a");
  assert.equal(pane.closeSubagentTab(single, "a").open, false);
  const directory = pane.showSubagentDirectory(single);
  assert.deepEqual(pane.closeSubagentTab(directory, "a"), { open: true, tabs: [], active: null });

  let many = pane.CLOSED_SUBAGENT_PANE;
  for (let index = 0; index < pane.MAX_SUBAGENT_TABS + 2; index += 1) {
    many = pane.openSubagentTab(many, `t${index}`);
  }
  assert.equal(many.tabs.length, pane.MAX_SUBAGENT_TABS);
  assert.equal(many.tabs.at(-1), `t${pane.MAX_SUBAGENT_TABS + 1}`);
  assert.equal(many.tabs[0], "t2");
  assert.deepEqual(pane.pruneSubagentTabs(state, new Set(["a"])), {
    open: true,
    tabs: ["a"],
    active: null,
  });
});

test("the directory lists running subagents first, then ended ones by end time, paged", () => {
  const list = [
    subagent({ id: "old-run", started_at: "2026-11-05T00:00:00Z" }),
    subagent({ id: "new-run", started_at: "2026-11-05T00:05:00Z" }),
    ...Array.from({ length: pane.SUBAGENT_DIRECTORY_PAGE_SIZE + 3 }, (_, index) =>
      subagent({
        id: `ended-${index}`,
        status: index % 2 ? "failed" : "done",
        ended_at: new Date(Date.UTC(2026, 10, 5, 1, index)).toISOString(),
      }),
    ),
  ];
  const first = pane.subagentDirectory(list);
  assert.deepEqual(
    first.running.map((item) => item.id),
    ["new-run", "old-run"],
  );
  assert.equal(first.ended.length, pane.SUBAGENT_DIRECTORY_PAGE_SIZE);
  assert.equal(first.ended[0].id, `ended-${pane.SUBAGENT_DIRECTORY_PAGE_SIZE + 2}`);
  assert.equal(first.endedTotal, pane.SUBAGENT_DIRECTORY_PAGE_SIZE + 3);
  assert.equal(first.hasMoreEnded, true);
  const second = pane.subagentDirectory(list, 2);
  assert.equal(second.ended.length, pane.SUBAGENT_DIRECTORY_PAGE_SIZE + 3);
  assert.equal(second.hasMoreEnded, false);
});

function fakeClient(overrides = {}) {
  const calls = { list: 0, transcript: [], cancel: [], subscribe: [] };
  const client = {
    calls,
    listSubagents: async () => {
      calls.list += 1;
      return overrides.list ? overrides.list() : { subagents: [], last_seq: 0 };
    },
    getSubagentTranscript: async (_session, id) => {
      calls.transcript.push(id);
      return overrides.transcript(id);
    },
    cancelSubagent: async (session, id) => {
      calls.cancel.push([session, id]);
    },
    subscribeSubagent: (session, id, afterSeq, handlers, signal) => {
      calls.subscribe.push({ session, id, afterSeq, handlers, signal });
      return new Promise((resolve) => signal?.addEventListener("abort", resolve));
    },
  };
  return client;
}

function setup(client) {
  store.resetKBrainSubagentStore();
  store.configureKBrainSubagentStore({ client: () => client, resolveSession: () => "backend-session-1" });
}

test("the store merges a subagent's events, drops duplicates and links its tool call", () => {
  const client = fakeClient();
  setup(client);
  store.noteKBrainSubagentTurnStarted("chat-1");
  const ingest = (value) => store.ingestKBrainSubagentEvent("chat-1", "backend-session-1", value);
  // Child output before the start event cannot be placed.
  ingest(child(1, "text", { text: "early" }));
  assert.equal(store.getKBrainConversationSubagents("chat-1")?.order.length ?? 0, 0);
  ingest(started(2));
  ingest(child(3, "tool_start", { id: "c1", name: "Read", arguments: '{"path":"a.go"}' }));
  ingest(child(3, "tool_start", { id: "c1", name: "Read", arguments: '{"path":"a.go"}' }));
  const linked = store.getKBrainSubagentForToolCall("call-1");
  assert.equal(linked.conversationId, "chat-1");
  assert.equal(linked.entry.lastSeq, 3);
  assert.equal(linked.entry.liveToolCount, 1);
  assert.deepEqual(linked.entry.latestTool, { name: "Read", arguments: '{"path":"a.go"}' });
  assert.equal(store.countRunningKBrainSubagents(store.getKBrainConversationSubagents("chat-1")), 1);
  // A running turn delivers the events itself: nothing is followed separately.
  assert.equal(client.calls.subscribe.length, 0);

  const view = kbrainSubagentView(linked.entry);
  assert.equal(view.status, "running");
  assert.equal(view.model, "fixture-model");
  assert.equal(view.toolCount, 1);
  assert.deepEqual(view.latestTool, { name: "Read", arguments: { path: "a.go" } });
  assert.equal(kbrainSubagentView(linked.entry), view);

  ingest(
    event(4, "subagent.completed", {
      subagent: subagent({
        status: "done",
        usage: { input_tokens: 1200, output_tokens: 300 },
        tool_count: 4,
        duration_ms: 65_000,
      }),
    }),
  );
  const done = kbrainSubagentView(store.getKBrainSubagentForToolCall("call-1").entry);
  assert.equal(done.status, "done");
  assert.equal(done.tokens, 1500);
  assert.equal(done.toolCount, 4);
  assert.equal(done.durationMs, 65_000);
  assert.equal(done.latestTool, undefined);
  assert.equal(store.countRunningKBrainSubagents(store.getKBrainConversationSubagents("chat-1")), 0);
});

test("subagents still running when the turn ends are followed from their last seq", async () => {
  const client = fakeClient();
  setup(client);
  store.noteKBrainSubagentTurnStarted("chat-2");
  store.ingestKBrainSubagentEvent("chat-2", "backend-session-1", started(7, { background: true }));
  store.noteKBrainSubagentTurnEnded("chat-2");
  assert.equal(client.calls.subscribe.length, 1);
  const follow = client.calls.subscribe[0];
  assert.deepEqual([follow.session, follow.id, follow.afterSeq], ["backend-session-1", "task-1", 7]);
  // Ending another turn does not open a second stream for the same subagent.
  store.noteKBrainSubagentTurnEnded("chat-2");
  assert.equal(client.calls.subscribe.length, 1);
  follow.handlers.onEvent(event(9, "subagent.completed", { subagent: subagent({ status: "done" }) }));
  assert.equal(follow.signal.aborted, true);
  await store.stopKBrainSubagent("chat-2", "task-1");
  assert.deepEqual(client.calls.cancel, [["backend-session-1", "task-1"]]);
});

test("opening a subagent loads its transcript and applies events that raced the load", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = fakeClient({
    transcript: async () => {
      await gate;
      return {
        subagent: subagent(),
        messages: [
          { role: "user", content: [{ type: "text", text: "Survey the parser" }] },
          { role: "assistant", content: [{ type: "text", text: "One" }] },
        ],
        last_seq: 5,
        live: true,
      };
    },
  });
  setup(client);
  store.noteKBrainSubagentTurnStarted("chat-3");
  const ingest = (value) => store.ingestKBrainSubagentEvent("chat-3", "backend-session-1", value);
  ingest(started(2));
  store.openKBrainSubagent("chat-3", "task-1");
  const state = () => store.getKBrainConversationSubagents("chat-3");
  assert.deepEqual(state().pane, { open: true, tabs: ["task-1"], active: "task-1" });
  assert.equal(state().entries["task-1"].transcript.status, "loading");
  ingest(child(5, "text", { text: " already counted" }));
  ingest(child(6, "text", { text: " two" }));
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const transcript = state().entries["task-1"].transcript;
  assert.equal(transcript.status, "ready");
  assert.equal(transcript.messages[1].content[0].text, "One two");
  ingest(child(7, "tool_start", { id: "c9", name: "Bash", arguments: '{"command":"ls"}' }));
  const live = state().entries["task-1"].transcript.messages;
  assert.equal(live[1].tool_calls[0].id, "c9");

  const items = subagentTranscriptItems(live, true);
  assert.deepEqual(
    items.map((item) => item.role),
    ["user", "assistant"],
  );
  assert.deepEqual(items[1].rounds.flatMap((round) => round.runningToolCallIds), ["c9"]);
  assert.equal(subagentTranscriptItems(live, true), items);
  assert.deepEqual(
    subagentTranscriptItems(live, false)[1].rounds.flatMap((round) => round.runningToolCallIds ?? []),
    [],
  );

  store.closeKBrainSubagentTab("chat-3", "task-1");
  assert.equal(state().pane.open, false);
  store.showKBrainSubagentDirectory("chat-3");
  assert.deepEqual(state().pane, { open: true, tabs: [], active: null });
});

test("a reload lists the subagents; an older list never overwrites newer events", async () => {
  let list = {
    subagents: [subagent({ status: "done", report: "ok", ended_at: "2026-11-05T00:02:00Z" })],
    last_seq: 20,
  };
  const client = fakeClient({ list: () => list });
  setup(client);
  await store.loadKBrainSubagents("chat-4");
  const entry = () => store.getKBrainSubagentForToolCall("call-1").entry;
  assert.equal(entry().subagent.status, "done");
  assert.equal(entry().lastSeq, 20);
  assert.equal(client.calls.subscribe.length, 0);

  store.ingestKBrainSubagentEvent("chat-4", "backend-session-1", started(25, { attempt: 2 }));
  list = { subagents: [subagent({ status: "done" })], last_seq: 21 };
  await store.loadKBrainSubagents("chat-4");
  assert.equal(entry().subagent.status, "running");
  assert.equal(entry().lastSeq, 25);
});

test("an older K-brain without the subagent routes marks the conversation unsupported", async () => {
  const client = fakeClient({
    list: () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  });
  setup(client);
  await store.loadKBrainSubagents("chat-5");
  assert.equal(store.getKBrainConversationSubagents("chat-5").unsupported, true);
  await store.loadKBrainSubagents("chat-5");
  assert.equal(client.calls.list, 1);
});

test("the client reads the subagent routes and follows a non-contiguous stream", async () => {
  const requests = [];
  const body = [event(4, "trajectory.child.text", { task_id: "t", text: "a" }), event(9, "subagent.completed", { subagent: subagent({ id: "t", status: "done" }) })]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("");
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      requests.push([init.method ?? "GET", `${parsed.pathname}${parsed.search}`]);
      if (parsed.pathname.endsWith("/events")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (parsed.pathname.endsWith("/cancel")) return Response.json({ ok: true });
      if (parsed.pathname.endsWith("/subagents")) return Response.json({ subagents: [], last_seq: 3 });
      return Response.json({ subagent: subagent({ id: "t" }), messages: [], last_seq: 3, live: true });
    },
  });
  assert.deepEqual(await client.listSubagents("backend-session-1"), { subagents: [], last_seq: 3 });
  assert.equal((await client.getSubagentTranscript("backend-session-1", "t")).live, true);
  await client.cancelSubagent("backend-session-1", "t");
  const seen = [];
  await client.subscribeSubagent("backend-session-1", "t", 3, { onEvent: (value) => seen.push(value.seq) });
  assert.deepEqual(seen, [4, 9]);
  assert.deepEqual(requests.slice(0, 3), [
    ["GET", "/v1/sessions/backend-session-1/subagents"],
    ["GET", "/v1/sessions/backend-session-1/subagents/t"],
    ["POST", "/v1/sessions/backend-session-1/subagents/t/cancel"],
  ]);
  assert.match(requests[3][1], /^\/v1\/sessions\/backend-session-1\/subagents\/t\/events/);
});

test("the turn forwards every subagent event and skips the synthetic card for linked ones", async () => {
  const forwarded = [];
  const synthetic = [];
  const lines = [
    event(2, "subagent.started", { subagent: subagent() }),
    event(3, "trajectory.child.text", { task_id: "task-1", text: "hi" }),
    // A background subagent of an earlier run still reaches the store.
    event(4, "trajectory.child.text", { task_id: "old", text: "late" }, "run-0"),
    event(5, "subagent.started", { subagent: subagent({ id: "legacy", parent_tool_call_id: undefined }) }),
    event(6, "run.completed"),
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("");
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      return Response.json({ id: "backend-session-1", model: { provider: "fixture", model: "m" }, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/runs")) {
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "backend-session-1", run_id: "run-1", accepted_seq: 1 }, { status: 202 });
    }
    if (parsed.pathname.endsWith("/events")) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(lines));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({});
  };
  storage.clear();
  await runKBrainTurn({
    conversationId: "conversation-1",
    sessionId: "host-session-1",
    cwd: "/tmp/workspace",
    model: { provider: "fixture", model: "m" },
    prompt: "hello",
    context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    signal: new AbortController().signal,
    fetch,
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall() {},
    onToolResult() {},
    onSubagentEvent: (value) => forwarded.push(value.seq),
    onSubagent: (value) => synthetic.push(value.id),
  });
  assert.deepEqual(forwarded, [2, 3, 4, 5]);
  // The runner drops linked subagents from onSubagent; turn.ts still reports both.
  assert.ok(synthetic.includes("legacy"));
});

test("subagent durations and token counts format compactly", () => {
  assert.equal(contract.formatSubagentDuration(8_400), "8s");
  assert.equal(contract.formatSubagentDuration(125_000), "2m 05s");
  assert.equal(contract.formatSubagentDuration(3_780_000), "1h 03m");
  assert.equal(contract.formatSubagentDuration(undefined), "");
  assert.equal(contract.formatSubagentTokens(950), "950");
  assert.equal(contract.formatSubagentTokens(12_345), "12k");
  assert.equal(contract.formatSubagentTokens(1_234), "1.2k");
  assert.equal(contract.formatSubagentTokens(1_200_000), "1.2M");
  assert.equal(contract.subagentViewStatus("completed"), "done");
  assert.equal(contract.subagentViewStatus("failed"), "error");
  assert.equal(
    contract.subagentElapsedMs({ status: "running", startedAtMs: 1_000 }, 61_000),
    60_000,
  );
});
