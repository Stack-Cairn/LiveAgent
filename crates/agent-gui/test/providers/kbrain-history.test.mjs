import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
const history = loader.loadModule("src/lib/kbrain/history.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const DEFAULT_KBRAIN_URL = "http://127.0.0.1:47321";
const runtimeConnection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
  return values;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, value, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function withHttpFixture(handler, callback) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  runtimeConnection.setKBrainRuntimeConnection({ baseUrl: DEFAULT_KBRAIN_URL, token: "", protocolVersion: "kbrain.agent.v1" });
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin === DEFAULT_KBRAIN_URL) {
      url.protocol = "http:";
      url.host = new URL(fixtureUrl).host;
    }
    return originalFetch(url, init);
  };
  try {
    return await callback(fixtureUrl);
  } finally {
    globalThis.fetch = originalFetch;
    runtimeConnection.clearKBrainRuntimeConnection();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function makeSession(overrides = {}) {
  return {
    id: "remote-session",
    title: "Imported",
    cwd: "/tmp/project",
    model: { provider: "fixture", model: "fixture-model" },
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:01:00Z",
    message_count: 2,
    messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "hello" }], created_at: "2026-09-28T00:00:01Z" },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "world" }], provider: "fixture", model: "fixture-model", created_at: "2026-09-28T00:00:02Z" },
    ],
    tasks: [
      { id: "child-success", parent_id: "run-1", description: "Review", status: "done", model: { provider: "fixture", model: "fixture-model" }, report: "Reviewed" },
      { id: "child-failed", parent_id: "run-1", description: "Inspect", status: "failed", model: { provider: "fixture", model: "fixture-model" }, error: "upstream failed" },
    ],
    last_seq: 2,
    revision: "rev-1",
    ...overrides,
  };
}

test("background continuation history never substitutes row offsets for missing clocks", async () => {
  installStorage();
  const session = makeSession({ tasks: [], messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "read all materials" }], created_at: "2026-10-19T10:00:00Z" },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "first agent done" }], created_at: "2026-10-19T10:00:08Z" },
    { id: "u2", role: "user", content: [{ type: "text", text: "second agent finished" }] },
    { id: "a2", role: "assistant", content: [{ type: "text", text: "second report" }], created_at: "2026-10-19T10:00:10Z" },
    { id: "u3", role: "user", content: [{ type: "text", text: "third agent finished" }], created_at: "invalid" },
    { id: "a3", role: "assistant", content: [{ type: "text", text: "third report" }], created_at: "2026-10-19T10:00:12Z" },
  ] });
  const { chatDuration } = loader.loadModule("@liveagent/ui/lib/chat/workTiming.ts");
  await withHttpFixture(async (_request, response) => sendJson(response, {
    session, revision: session.revision, oldest_offset: 0, has_more_before: false,
    total_message_count: session.messages.length, active_messages: session.messages,
  }), async () => {
    mapping.setKBrainSessionId("three-agents", session.id);
    const restored = await history.getKBrainHistoryWindow("three-agents");
    for (const messages of [restored.activeSegment.messages, restored.segments.flatMap((segment) => segment.messages)]) {
      assert.equal(chatDuration(messages[0].timestamp, messages[1].timestamp), 8000);
      assert.equal(messages[2].timestamp, 0);
      assert.equal(messages[4].timestamp, 0);
      assert.equal(chatDuration(messages[2].timestamp, messages[3].timestamp), undefined);
      assert.equal(chatDuration(messages[4].timestamp, messages[5].timestamp), undefined);
    }
  });
});

test("K-brain mapping keeps local and backend IDs bidirectionally without sessionId in the key", () => {
  installStorage();
  mapping.setKBrainSessionId("local-conversation", "remote-session", "http://kbrain.test/");
  assert.equal(mapping.getKBrainSessionId("local-conversation", "http://kbrain.test"), "remote-session");
  assert.equal(mapping.getKBrainConversationId("remote-session", "http://kbrain.test"), "local-conversation");
  assert.match([...globalThis.localStorage.getItem("kbrain-session-map:v1")].join(""), /remote-session/);
  assert.doesNotMatch([...globalThis.localStorage.getItem("kbrain-session-map:v1")].join(""), /host-session/);
});

test("production K-brain history uses HTTP list, PATCH model mapping, and get restoration", async () => {
  installStorage();
  const session = makeSession();
  const updated = makeSession({
    model: { provider: "fixture-new", model: "model-2" },
    updated_at: "2026-09-28T00:02:00Z",
  });
  const requests = [];
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    const body = await readBody(request);
    requests.push({ method: request.method, path: url.pathname, body });
    if (request.method === "GET" && url.pathname === "/v1/sessions") return sendJson(response, { sessions: [session] });
    if (request.method === "GET" && url.pathname === "/v1/sessions/remote-session/history") return sendJson(response, { session, revision: session.revision, oldest_offset: 0, has_more_before: false, total_message_count: session.messages.length, ...(url.searchParams.get("include_active") === "true" ? { active_messages: session.messages } : {}) });
    if (request.method === "GET" && url.pathname === "/v1/sessions/remote-session") return sendJson(response, session);
    if (request.method === "PATCH" && url.pathname === "/v1/sessions/remote-session") {
      assert.deepEqual(body, { model: { provider: "fixture-new", model: "model-2" } });
      return sendJson(response, updated);
    }
    return sendJson(response, { error: "unexpected route" }, 404);
  }, async () => {
    const listed = await history.listKBrainHistory(1, 20);
    assert.equal(listed.items.length, 1);
    const localId = listed.items[0].id;
    assert.notEqual(localId, "remote-session");
    assert.equal(listed.items[0].selectedModelJson, '{"customProviderId":"fixture","model":"fixture-model"}');

    const changed = await history.setKBrainHistoryModel(localId, '{"customProviderId":"fixture-new","model":"model-2"}');
    assert.equal(changed.id, localId);
    assert.equal(changed.providerId, "fixture-new");
    assert.equal(changed.model, "model-2");
    assert.equal(changed.selectedModelJson, '{"customProviderId":"fixture-new","model":"model-2"}');

    const window = await history.getKBrainHistoryWindow(localId);
    assert.equal(window.conversation.sessionId, "remote-session");
    assert.equal(window.conversation.model, "fixture-model");
    assert.equal(window.activeSegment.messages.length, 4);
    assert.equal(window.hasMoreBefore, false);
    assert.equal(mapping.getKBrainSessionId(localId), "remote-session");
    assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
      ["GET", "/v1/sessions"],
      ["PATCH", "/v1/sessions/remote-session"],
      ["GET", "/v1/sessions/remote-session/history"],
    ]);
  });
});

test("invalid or null K-brain models fail before any HTTP request", async () => {
  installStorage();
  const requests = [];
  await withHttpFixture(async (request, response) => {
    requests.push({ method: request.method, path: request.url });
    return sendJson(response, { sessions: [makeSession()] });
  }, async () => {
    const listed = await history.listKBrainHistory(1, 20);
    const localId = listed.items[0].id;
    await assert.rejects(() => history.setKBrainHistoryModel(localId, "not-json"), /invalid/);
    await assert.rejects(() => history.setKBrainHistoryModel(localId, null), /invalid/);
    assert.deepEqual(requests, [{ method: "GET", path: "/v1/sessions?page=1&page_size=20" }]);
  });
});

test("HTTP history restoration preserves cancelled, truncated and tool-use assistant states", async () => {
  installStorage();
  const reasons = ["cancelled", "length", "tool_use", "error", "stop"];
  const session = makeSession({
    tasks: [],
    messages: reasons.map((reason, index) => ({
      id: `a-${index}`, role: "assistant", stop_reason: reason,
      content: [{ type: "text", text: `response ${reason}` }],
      provider: "fixture", model: "fixture-model",
    })),
    message_count: reasons.length,
  });
  await withHttpFixture(async (request, response) => {
    assert.equal(request.method, "GET");
    assert.match(request.url, /^\/v1\/sessions\/remote-session\/history\?/);
    sendJson(response, {
      session, revision: session.revision, oldest_offset: 0, has_more_before: false,
      total_message_count: session.messages.length, active_messages: session.messages,
    });
  }, async () => {
    mapping.setKBrainSessionId("stop-reasons", session.id);
    const restored = await history.getKBrainHistoryWindow("stop-reasons");
    const expected = ["aborted", "length", "toolUse", "error", "stop"];
    assert.deepEqual(restored.activeSegment.messages.map((message) => message.stopReason), expected);
    assert.deepEqual(restored.segments.flatMap((segment) => segment.messages.map((message) => message.stopReason)), expected);
    assert.deepEqual(restored.activeSegment.messages.map((message) => message.responseId), reasons.map((_, index) => `a-${index}`));
  });
});

test("background notices from K-brain render as notices, not as user messages", async () => {
  installStorage();
  const notice = "[wait w1 done] condition met (ran every 2s):\n$ cat build.log\n\nBUILD-READY";
  const session = makeSession({
    tasks: [],
    messages: [
      { id: "u-1", role: "user", content: [{ type: "text", text: "build it, then continue" }] },
      { id: "a-1", role: "assistant", content: [{ type: "text", text: "started" }], provider: "fixture", model: "fixture-model" },
      { id: "u-2", role: "user", origin: "background", content: [{ type: "text", text: notice }] },
      { id: "a-2", role: "assistant", content: [{ type: "text", text: "continuing" }], provider: "fixture", model: "fixture-model" },
    ],
    message_count: 4,
  });
  await withHttpFixture(async (_request, response) => {
    sendJson(response, {
      session, revision: session.revision, oldest_offset: 0, has_more_before: false,
      total_message_count: session.messages.length, active_messages: session.messages,
    });
  }, async () => {
    mapping.setKBrainSessionId("background-notice", session.id);
    const restored = await history.getKBrainHistoryWindow("background-notice");
    const users = restored.segments.flatMap((segment) => segment.messages).filter((message) => message.role === "user");
    assert.deepEqual(users.map((message) => message.liveAgentBackgroundNotice === true), [false, true]);
    const state = conversationState.createConversationStateFromContext({ messages: [] });
    const withHistory = conversationState.appendMessagesToConversation(state, restored.segments.flatMap((segment) => segment.messages));
    const items = withHistory.transcript.items.filter((item) => item.kind === "user");
    assert.deepEqual(items.map((item) => [item.text, item.backgroundNotice === true]), [
      ["build it, then continue", false],
      [notice, true],
    ]);
  });
});

test("task projections are counted once on newest windows while full active context stays intact", async () => {
  installStorage();
  const session = makeSession();
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    const earlier = url.searchParams.has("before_offset");
    return sendJson(response, {
      session: { ...session, messages: session.messages.slice(earlier ? 0 : 1, earlier ? 1 : 2) },
      revision: "rev-1", oldest_offset: earlier ? 0 : 1, has_more_before: !earlier,
      total_message_count: 2,
      ...(url.searchParams.get("include_active") === "true" ? { active_messages: session.messages } : {}),
    });
  }, async () => {
    mapping.setKBrainSessionId("task-local", session.id);
    const tail = await history.getKBrainHistoryWindow("task-local", { maxMessages: 1 });
    assert.equal(tail.activeSegment.messages.length, 4);
    assert.equal(tail.meta.totalMessageCount, 4);
    assert.equal(tail.returnedMessageCount, 3);
    assert.equal(tail.segments[0].startMessageIndex, 1);
    assert.equal(tail.segments[0].messages[1].toolCallId, "kbrain-subagent:child-success");
    const page = await history.getKBrainHistoryWindow("task-local", { maxMessages: 1, beforeOffset: 1, expectedRevision: "rev-1", includeActive: false });
    assert.equal(page.meta.totalMessageCount, 4);
    assert.equal(page.returnedMessageCount, 1);
    assert.equal(page.activeSegment, undefined);
  });
});

test("K-brain history summaries carry branch lineage only when the backend reports it", async () => {
  installStorage();
  const source = makeSession({ id: "source-session", title: "Source" });
  const branch = makeSession({ id: "branch-session", title: "Source", forked_from: "source-session", fork_seq: 2 });
  const blank = makeSession({ id: "blank-session", forked_from: "  " });
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    if (request.method === "GET" && url.pathname === "/v1/sessions") return sendJson(response, { sessions: [source, branch, blank] });
    return sendJson(response, { error: "unexpected route" }, 404);
  }, async () => {
    const listed = await history.listKBrainHistory(1, 20);
    const bySession = new Map(listed.items.map((item) => [item.sessionId, item]));
    assert.equal(bySession.get("branch-session").forkedFromSessionId, "source-session");
    assert.equal("forkedFromSessionId" in bySession.get("source-session"), false);
    assert.equal("forkedFromSessionId" in bySession.get("blank-session"), false);
  });
});

test("history restoration normalizes null hosted search queries and sources from K-brain (#1069)", async () => {
  installStorage();
  const session = makeSession({
    tasks: [],
    messages: [{
      id: "a-search", role: "assistant",
      content: [{ type: "text", text: "北京海淀今天晴" }],
      // Go 端 nil 切片序列化为 null：OpenAI web_search_call 在没有 action 时就是这样。
      hosted_search: [
        { type: "hostedSearch", id: "ws_1", provider: "openai", status: "completed", queries: null, sources: null },
        { type: "hostedSearch", id: "ws_2", provider: "openai", status: "completed", queries: ["北京海淀 天气"], sources: [{ url: "https://weather.example.com/haidian", title: "海淀天气" }] },
      ],
      provider: "fixture", model: "fixture-model",
    }],
    message_count: 1,
  });
  await withHttpFixture(async (_request, response) => {
    sendJson(response, {
      session, revision: session.revision, oldest_offset: 0, has_more_before: false,
      total_message_count: 1, active_messages: session.messages,
    });
  }, async () => {
    mapping.setKBrainSessionId("hosted-search-null", session.id);
    const restored = await history.getKBrainHistoryWindow("hosted-search-null");
    const content = restored.activeSegment.messages[0].content;
    const searches = content.filter((block) => block.type === "hostedSearch");
    assert.equal(searches.length, 2);
    for (const search of searches) {
      assert.ok(Array.isArray(search.queries), "queries must be an array");
      assert.ok(Array.isArray(search.sources), "sources must be an array");
    }
    assert.deepEqual(searches[0].queries, []);
    assert.deepEqual(searches[0].sources, []);
    assert.deepEqual(searches[1].queries, ["北京海淀 天气"]);
    assert.equal(searches[1].sources[0].url, "https://weather.example.com/haidian");
  });
});
