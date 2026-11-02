// Regression for duplicated settled replies in long sessions.
// Drives the row model with timeline items produced by the production K-brain
// history projection (real `segment-kbrain:<id>-user-<offset>-<ts>` /
// `assistant-<start>-<end>-<ts>` keys, the optimistic user bubble appended via
// appendMessagesToConversation, a newest-N window served over HTTP) instead of
// hand-written stable keys.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const DEFAULT_KBRAIN_URL = "http://127.0.0.1:47321";

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    get length() {
      return values.size;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

function loadModules() {
  const root = createTsModuleLoader();
  const loader = createTsModuleLoader({
    mocks: {
      [root.resolveLocal("src/lib/providers/runtime/providerRuntimeConfig.ts")]: {
        getProviderRuntimeBackend: () => "kbrain",
      },
      [root.resolveLocal("src/shims/tauriCore.ts")]: {
        invoke(command) {
          throw new Error(`unexpected Tauri invoke: ${command}`);
        },
      },
    },
  });
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl: DEFAULT_KBRAIN_URL,
    token: "",
    protocolVersion: "kbrain.agent.v1",
  });
  return {
    history: loader.loadModule("src/lib/chat/history/chatHistory.ts"),
    state: loader.loadModule("src/lib/chat/conversation/conversationState.ts"),
    rows: loader.loadModule("src/pages/chat/transcript/rowModel.ts"),
  };
}

let clock = Date.parse("2026-10-20T00:00:00Z");
const iso = () => new Date((clock += 1000)).toISOString();

function exchange(tag, toolRounds) {
  const messages = [
    {
      id: `${tag}-u`,
      role: "user",
      content: [{ type: "text", text: `prompt ${tag}` }],
      created_at: iso(),
    },
  ];
  for (let index = 0; index < toolRounds; index += 1) {
    const callId = `${tag}-call-${index}`;
    messages.push({
      id: `${tag}-a${index}`,
      role: "assistant",
      content: [],
      tool_calls: [{ id: callId, name: "read", arguments: { path: `f${index}` } }],
      provider: "fixture",
      model: "m",
      created_at: iso(),
    });
    messages.push({
      id: `${tag}-t${index}`,
      role: "tool",
      tool_call_id: callId,
      name: "read",
      content: [{ type: "text", text: "ok" }],
      created_at: iso(),
    });
  }
  messages.push({
    id: `${tag}-final`,
    role: "assistant",
    content: [{ type: "text", text: `answer ${tag}` }],
    provider: "fixture",
    model: "m",
    created_at: iso(),
  });
  return messages;
}

async function withKBrain(store, callback) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    const session = {
      id: "s",
      title: "Long",
      cwd: "/tmp/p",
      model: { provider: "fixture", model: "m" },
      created_at: "2026-10-20T00:00:00Z",
      updated_at: "2026-10-20T00:00:00Z",
      message_count: store.messages.length,
      tasks: store.tasks ?? [],
      last_seq: store.messages.length,
      revision: `rev-${store.messages.length}`,
    };
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/sessions") {
      response.end(JSON.stringify({ sessions: [{ ...session, messages: [] }] }));
      return;
    }
    if (url.pathname === "/v1/sessions/s/history") {
      const max = Number(url.searchParams.get("max_messages"));
      const oldest = Math.max(0, store.messages.length - max);
      response.end(
        JSON.stringify({
          session: { ...session, messages: store.messages.slice(oldest) },
          revision: session.revision,
          oldest_offset: oldest,
          has_more_before: oldest > 0,
          total_message_count: store.messages.length,
          active_messages: store.messages,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin === DEFAULT_KBRAIN_URL) url.host = host;
    return originalFetch(url, init);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

const idle = {
  isSending: false,
  draftAssistantText: "",
  toolStatus: null,
  liveRounds: [],
  retryAttempts: [],
  isSettled: false,
};
const streaming = {
  ...idle,
  isSending: true,
  liveRounds: [
    {
      round: 1,
      key: "r1",
      blocks: [{ kind: "text", id: "text-1", text: "answer new" }],
      runningToolCallIds: [],
      thinkingOpen: false,
    },
  ],
};

function replyCount(snapshot) {
  return snapshot.rows.filter(
    (row) =>
      row.kind === "assistant-activity" ||
      (row.kind === "assistant-unit" && row.unit.kind === "footer"),
  ).length;
}

function historyReplyCount(items) {
  return items.filter((item, index) => {
    if (item.kind !== "assistant") return false;
    const previous = items[index - 1];
    return !previous || previous.kind !== "assistant";
  }).length;
}

async function runTurn({ window, before, reply, tasks, settleWithStaleHistoryFirst }) {
  installStorage();
  const { history, state, rows } = loadModules();
  const store = { messages: before.flat(), tasks };
  return withKBrain(store, async () => {
    const id = (await history.listChatHistory(1, 20)).items[0].id;
    const read = async () =>
      history.buildConversationStateFromWindow(
        await history.getChatHistoryWindow({ id, maxMessages: window, includeActiveSegment: true }),
      );
    const opened = await read();
    // useSendChatTurn: optimistic user bubble appended locally before the run.
    const atStart = state.appendMessagesToConversation(opened, [
      { role: "user", content: "prompt new", timestamp: Date.now() },
    ]);
    const model = rows.createTranscriptRowModel();
    const startItems = atStart.transcript.items;
    model.build(startItems, streaming);

    store.messages.push(...reply);
    const refreshed = (await read()).transcript.items;

    let settled;
    if (settleWithStaleHistoryFirst) {
      // isSettled (external store) can render before the refreshed
      // conversation state lands: settle sees the start-of-turn items first.
      model.build(startItems, { ...idle, isSettled: true });
      settled = model.build(refreshed, idle);
    } else {
      // runKBrainConversationTurn applies the refreshed window, then settles.
      model.build(refreshed, streaming);
      settled = model.build(refreshed, idle);
    }
    return { startItems, refreshed, settled, historyReplies: historyReplyCount(refreshed) };
  });
}

test("real K-brain keys: window slides and shrinks while a tool-heavy reply persists", async () => {
  const before = [exchange("e1", 1), exchange("e2", 1), exchange("e3", 1)];
  const reply = exchange("new", 4);
  const { startItems, refreshed, settled, historyReplies } = await runTurn({
    window: 8,
    before,
    reply,
  });
  assert.ok(
    refreshed.length <= startItems.length,
    `window must not grow (start ${startItems.length}, refreshed ${refreshed.length})`,
  );
  assert.equal(settled.liveStartIndex, -1);
  assert.equal(replyCount(settled), historyReplies);
});

test("real K-brain keys: settle renders before the refreshed window lands", async () => {
  const before = [exchange("e1", 1), exchange("e2", 1), exchange("e3", 1)];
  const reply = exchange("new", 4);
  const { settled, historyReplies } = await runTurn({
    window: 12,
    before,
    reply,
    settleWithStaleHistoryFirst: true,
  });
  assert.equal(settled.liveStartIndex, -1);
  assert.equal(replyCount(settled), historyReplies);
});

test("real K-brain keys: reply longer than the window (prompt and previous reply slid out)", async () => {
  const before = [exchange("e1", 1), exchange("e2", 1)];
  const reply = exchange("new", 8);
  const { settled, refreshed } = await runTurn({ window: 6, before, reply });
  assert.ok(!refreshed.some((item) => item.kind === "user"));
  assert.equal(settled.liveStartIndex, -1);
  assert.equal(replyCount(settled), 1);
});

test("real K-brain keys: completed subagent tasks re-key the previous reply group", async () => {
  const before = [exchange("e1", 1), exchange("e2", 1), exchange("e3", 1)];
  const reply = exchange("new", 3);
  const tasks = [
    {
      id: "task-1",
      description: "scan",
      status: "completed",
      report: "done",
      model: { provider: "fixture", model: "m" },
      started_at: "2026-10-20T00:00:01Z",
      updated_at: "2026-10-20T00:00:02Z",
      ended_at: "2026-10-20T00:00:02Z",
    },
  ];
  const { startItems, refreshed, settled, historyReplies } = await runTurn({
    window: 12,
    before,
    reply,
    tasks,
  });
  const startKeys = new Set(startItems.map((item) => item.key));
  const rekeyedAssistants = refreshed.filter(
    (item) => item.kind === "assistant" && !startKeys.has(item.key),
  );
  assert.ok(rekeyedAssistants.length >= 2, "previous reply and new reply both carry unseen keys");
  assert.equal(settled.liveStartIndex, -1);
  assert.equal(replyCount(settled), historyReplies);
});
