import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const DEFAULT_KBRAIN_URL = "http://127.0.0.1:47321";

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
}

function loadChatHistory(invokeCalls) {
  const root = createTsModuleLoader();
  const loader = createTsModuleLoader({
    mocks: {
      [root.resolveLocal("src/lib/providers/runtime/providerRuntimeConfig.ts")]: {
        getProviderRuntimeBackend: () => "kbrain",
      },
      [root.resolveLocal("src/shims/tauriCore.ts")]: {
        invoke(command, args) {
          invokeCalls.push({ command, args });
          throw new Error(`unexpected Tauri invoke: ${command}`);
        },
      },
    },
  });
  const runtimeConnection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtimeConnection.setKBrainRuntimeConnection({
    baseUrl: DEFAULT_KBRAIN_URL,
    token: "",
    protocolVersion: "kbrain.agent.v1",
  });
  return loader.loadModule("src/lib/chat/history/chatHistory.ts");
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
    tasks: [],
    last_seq: 2,
    revision: "rev-1",
    ...overrides,
  };
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
    Promise.resolve(handler(request, response)).catch((error) => response.destroy(error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
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
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("chatHistory K-brain list/get and model changes use production HTTP history without Tauri", async () => {
  installStorage();
  const invokeCalls = [];
  const history = loadChatHistory(invokeCalls);
  const session = makeSession();
  const updated = makeSession({ model: { provider: "fixture-new", model: "model-2" } });
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
    const listed = await history.listChatHistory(1, 20);
    assert.equal(listed.items.length, 1);
    const localId = listed.items[0].id;
    assert.equal(listed.items[0].sessionId, "remote-session");

    const changed = await history.setChatHistoryModel(localId, '{"customProviderId":"fixture-new","model":"model-2"}');
    assert.equal(changed.id, localId);
    assert.equal(changed.providerId, "fixture-new");
    assert.equal(changed.model, "model-2");

    const window = await history.getChatHistoryWindow({
      id: localId,
      maxMessages: 20,
      includeActiveSegment: true,
    });
    assert.equal(window.conversation.sessionId, "remote-session");
    assert.equal(window.conversation.model, "fixture-model");
    assert.equal(window.activeSegment.messages.length, 2);
    assert.equal(window.hasMoreBefore, false);
    assert.deepEqual(invokeCalls, []);
    assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
      ["GET", "/v1/sessions"],
      ["PATCH", "/v1/sessions/remote-session"],
      ["GET", "/v1/sessions/remote-session/history"],
    ]);
  });
});

test("chatHistory K-brain HTTP failures do not fall through to Tauri", async () => {
  installStorage();
  const invokeCalls = [];
  const history = loadChatHistory(invokeCalls);
  const requests = [];
  await withHttpFixture(async (request, response) => {
    requests.push({ method: request.method, path: request.url });
    return sendJson(response, { error: "fixture unavailable" }, 503);
  }, async () => {
    await assert.rejects(() => history.listChatHistory(1, 20), /fixture unavailable/);
    assert.deepEqual(invokeCalls, []);
    assert.deepEqual(requests, [{ method: "GET", path: "/v1/sessions?page=1&page_size=20" }]);
  });
});

test("chatHistory K-brain invalid JSON and null models make no HTTP or Tauri calls", async () => {
  installStorage();
  const invokeCalls = [];
  const history = loadChatHistory(invokeCalls);
  const requests = [];
  await withHttpFixture(async (request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.url.startsWith("/v1/sessions?")) return sendJson(response, { sessions: [makeSession()] });
    return sendJson(response, { error: "unexpected route" }, 404);
  }, async () => {
    const listed = await history.listChatHistory(1, 20);
    const localId = listed.items[0].id;
    await assert.rejects(() => history.setChatHistoryModel(localId, "not-json"), /invalid/);
    await assert.rejects(() => history.setChatHistoryModel(localId, null), /invalid/);
    assert.deepEqual(invokeCalls, []);
    assert.deepEqual(requests, [{ method: "GET", path: "/v1/sessions?page=1&page_size=20" }]);
  });
});


test("shipped history seam mutates, validates refs, paginates and shares without Tauri", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  const requests = [];
  let session = makeSession();
  let share = { conversation_id: session.id, enabled: false, redact_tool_content: true };
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    const body = await readBody(request);
    requests.push({ method: request.method, url, body });
    if (url.pathname === "/v1/sessions") return sendJson(response, { sessions: [session], total_count: 1, version: "kbrain.agent.v1" });
    if (url.pathname.endsWith("/history")) {
      const expected = url.searchParams.get("expected_revision");
      if (expected && expected !== session.revision) return sendJson(response, { error: "history revision conflict" }, 409);
      const end = Number(url.searchParams.get("before_offset") ?? session.messages.length);
      const start = Math.max(0, end - Number(url.searchParams.get("max_messages")));
      return sendJson(response, { session: { ...session, messages: session.messages.slice(start, end) }, revision: session.revision, oldest_offset: start, has_more_before: start > 0, total_message_count: session.messages.length, ...(url.searchParams.get("include_active") === "true" ? { active_messages: session.messages } : {}) });
    }
    if (url.pathname.endsWith("/branch")) return sendJson(response, { ...session, id: "branched", title: "Branch" }, 201);
    if (url.pathname.endsWith("/edit")) {
      session = { ...session, revision: "rev-2", messages: [{ ...body.replacement, id: "edited-u" }], message_count: 1 };
      return sendJson(response, session);
    }
    if (url.pathname.endsWith("/share")) {
      if (request.method === "POST") share = { ...share, ...body, token: body.enabled ? "public-token" : undefined, updated_at: "2026-09-28T01:00:00Z" };
      return sendJson(response, share);
    }
    if (request.method === "PATCH") { session = { ...session, ...body }; return sendJson(response, session); }
    if (request.method === "DELETE") return sendJson(response, { ok: true });
    return sendJson(response, session);
  }, async () => {
    const listed = await history.listChatHistory(1, 20, { cwd: "/tmp/project" });
    const id = listed.items[0].id;
    const opened = await history.getChatHistoryWindow({ id, maxMessages: 2, includeActiveSegment: true });
    const state = history.buildConversationStateFromWindow(opened);
    const ref = state.transcript.items.find(item => item.kind === "user").messageRef;
    assert.equal(ref.messageId, "u1");
    assert.equal(ref.segmentId, "kbrain:remote-session");
    assert.equal(opened.activeSegment.messages[1].id, "a1");
    assert.equal(opened.revision, "rev-1");
    const tail = await history.getChatHistoryWindow({ id, maxMessages: 1, includeActiveSegment: true });
    assert.equal(tail.segments[0].startMessageIndex, 1);
    assert.equal(tail.activeSegment.messages.length, 2);
    assert.equal(tail.hasMoreBefore, true);
    const earlier = await history.getChatHistoryWindow({ id, maxMessages: 1, beforeOffset: tail.oldestOffset, expectedRevision: tail.revision, includeActiveSegment: false });
    assert.equal(earlier.segments[0].messages[0].id, "u1");
    assert.equal(earlier.activeSegment, undefined);
    await assert.rejects(() => history.branchChatHistory(id, { ...ref, contentHash: "wrong" }), /reference/);
    const branched = await history.branchChatHistory(id, ref);
    assert.equal(branched.sessionId, "branched");
    assert.notEqual(branched.id, id);
    const branch = requests.find(r => r.url.pathname.endsWith("/branch"));
    assert.deepEqual(branch.body, { message_ref: { segment_index: 0, message_index: 0, segment_id: ref.segmentId, message_id: "u1", role: "user", content_hash: ref.contentHash }, expected_revision: "rev-1" });
    assert.equal((await history.renameChatHistory(id, "Server title")).title, "Server title");
    assert.equal((await history.setChatHistoryPinned(id, true)).isPinned, true);
    const moved = await history.setChatHistoryCwd(id, "/tmp/other-project");
    assert.equal(moved.cwd, "/tmp/other-project");
    assert.equal(moved.id, id);
    assert.deepEqual(requests.findLast(r => r.method === "PATCH").body, { cwd: "/tmp/other-project" });
    assert.equal(globalThis.localStorage.getItem("kbrain-history-titles:v1"), null);
    const edited = await history.replaceChatHistoryFromMessage({ id, baseMessageRef: ref, replacementMessage: { role: "user", content: [{ type: "text", text: "new" }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }, expectedRevision: "rev-1", maxMessages: 1 });
    assert.equal(edited.revision, "rev-2");
    assert.equal(edited.activeSegment.messages[0].id, "edited-u");
    assert.equal(edited.activeSegment.messages[0].kbrainEditPending, true);
    const edit = requests.find(r => r.url.pathname.endsWith("/edit"));
    assert.deepEqual(edit.body.replacement.content[1], { type: "image", image_url: "data:image/png;base64,AA==", mime_type: "image/png" });
    await assert.rejects(() => history.replaceChatHistoryFromMessage({ id, baseMessageRef: ref, replacementMessage: { role: "user", content: "stale", timestamp: 1 }, expectedRevision: "rev-1", maxMessages: 1 }), /revision/);
    assert.equal((await history.getChatHistoryShare(id)).enabled, false);
    const enabled = await history.setChatHistoryShare(id, true, { redactToolContent: false });
    assert.equal(enabled.conversationId, id);
    assert.equal(enabled.token, "public-token");
    assert.equal(enabled.redactToolContent, false);
    await history.listSharedChatHistory(1, 20);
    assert.equal(requests.at(-1).url.searchParams.get("shared"), "true");
    await history.setChatHistoryShare(id, false);
    await history.deleteChatHistory(id);
    await assert.rejects(() => history.getChatHistoryWindow({ id, maxMessages: 1, includeActiveSegment: true }), /mapping/);
    assert.deepEqual(invokes, []);
  });
});

test("history mutation HTTP failures propagate and never call Tauri", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    if (url.pathname === "/v1/sessions") return sendJson(response, { sessions: [makeSession()], total_count: 1 });
    return sendJson(response, { error: "session has active child task" }, 409);
  }, async () => {
    const id = (await history.listChatHistory(1, 20)).items[0].id;
    for (const operation of [() => history.deleteChatHistory(id), () => history.setChatHistoryPinned(id, true), () => history.setChatHistoryCwd(id, "/tmp/other"), () => history.renameChatHistory(id, "name"), () => history.getChatHistoryShare(id), () => history.setChatHistoryShare(id, true)]) {
      await assert.rejects(operation, error => error.status === 409 && /active child/.test(error.message));
    }
    assert.deepEqual(invokes, []);
  });
});

test("workdir aggregation walks finite pages rather than MAX_SAFE_INTEGER", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  const pages = [];
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    assert.equal(url.searchParams.get("page_size"), "200");
    const sessions = Array.from({ length: page === 1 ? 200 : 1 }, (_, i) => makeSession({ id: `s-${page}-${i}` }));
    sendJson(response, { sessions, total_count: 201 });
  }, async () => {
    const result = await history.listChatHistoryWorkdirs();
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.workdirs[0].conversationCount, 201);
    assert.deepEqual(invokes, []);
  });
});

test("branch and edit POST conflicts propagate after successful local projection validation", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  const session = makeSession();
  const mutations = [];
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    if (url.pathname === "/v1/sessions") return sendJson(response, { sessions: [session], total_count: 1 });
    if (url.pathname.endsWith("/history")) return sendJson(response, { session, revision: session.revision, oldest_offset: 0, has_more_before: false, total_message_count: 2, active_messages: session.messages });
    if (request.method === "POST") {
      mutations.push(url.pathname);
      return sendJson(response, { error: "history revision conflict" }, 409);
    }
    return sendJson(response, session);
  }, async () => {
    const id = (await history.listChatHistory(1, 20)).items[0].id;
    const window = await history.getChatHistoryWindow({ id, maxMessages: 2, includeActiveSegment: true });
    const ref = history.buildConversationStateFromWindow(window).transcript.items.find(item => item.kind === "user").messageRef;
    await assert.rejects(() => history.branchChatHistory(id, ref), error => error.status === 409);
    await assert.rejects(() => history.replaceChatHistoryFromMessage({ id, baseMessageRef: ref, replacementMessage: { role: "user", content: "new", timestamp: 1 }, expectedRevision: window.revision, maxMessages: 2 }), error => error.status === 409);
    assert.deepEqual(mutations, ["/v1/sessions/remote-session/branch", "/v1/sessions/remote-session/edit"]);
    assert.deepEqual(invokes, []);
  });
});

test("sparse raw offsets survive shipped projection, pagination, branch and edit with filtered rows", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  const canonical = (id, role, text, extra = {}) => ({ id, role, content: [{ type: "text", text }], ...extra });
  let offsets = [2, 5, 6, 10, 14, 20, 21, 25];
  let session = makeSession({ messages: [
    canonical("sys", "system", "system prompt"),
    canonical("early", "user", "earlier user"),
    canonical("early-answer", "assistant", "earlier answer"),
    canonical("dev", "developer", "developer prompt"),
    canonical("later", "user", "later user"),
    canonical("later-answer", "assistant", "later answer"),
    canonical("failed-tool", "tool", "failed", { tool_call_id: "tool-1", stop_reason: "error" }),
    canonical("cancelled-tool", "tool", "cancelled", { tool_call_id: "tool-2", stop_reason: "cancelled" }),
  ], message_count: 8, tasks: [{ id: "child", description: "Review", status: "done", model: { provider: "fixture", model: "fixture-model" }, report: "Reviewed" }] });
  const mutations = [];
  const cursors = [];
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    if (url.pathname === "/v1/sessions") return sendJson(response, { sessions: [session], total_count: 1 });
    if (url.pathname.endsWith("/history")) {
      const before = Number(url.searchParams.get("before_offset") ?? Infinity);
      const limit = Number(url.searchParams.get("max_messages"));
      if (url.searchParams.has("before_offset")) cursors.push(before);
      const eligible = offsets.map((offset, index) => ({ offset, message: session.messages[index] })).filter(row => row.offset < before);
      const rows = eligible.slice(-limit);
      return sendJson(response, {
        session: { ...session, messages: rows.map(row => row.message) },
        message_offsets: rows.map(row => row.offset), revision: session.revision,
        oldest_offset: rows[0]?.offset ?? 0, has_more_before: eligible.length > rows.length,
        total_message_count: session.messages.length,
        ...(url.searchParams.get("include_active") === "true" ? { active_messages: session.messages } : {}),
      });
    }
    if (request.method === "POST") {
      const body = await readBody(request);
      mutations.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/branch")) return sendJson(response, { ...session, id: "sparse-branch" }, 201);
      const end = session.messages.findIndex(message => message.id === body.message_ref.message_id);
      session = { ...session, revision: "rev-edited", messages: [...session.messages.slice(0, end), { ...body.replacement, id: "edited-sparse" }], tasks: [], message_count: end + 1 };
      offsets = offsets.slice(0, end + 1);
      return sendJson(response, session);
    }
    return sendJson(response, session);
  }, async () => {
    const id = (await history.listChatHistory(1, 20)).items[0].id;
    const tail = await history.getChatHistoryWindow({ id, maxMessages: 5, includeActiveSegment: true });
    assert.deepEqual(tail.segments.map(slice => [slice.startMessageIndex, slice.messages.length]), [[14, 1], [20, 2], [25, 2]]);
    assert.equal(tail.oldestOffset, 10);
    assert.equal(tail.returnedMessageCount, 5);
    assert.equal(tail.meta.totalMessageCount, 9);
    assert.equal(tail.activeSegment.messages.length, 7);
    assert.equal(tail.meta.systemPrompt, "system prompt\n\ndeveloper prompt");
    assert.deepEqual(tail.activeSegment.messages.filter(message => message.role === "toolResult").map(message => message.isError), [true, true, false]);
    const state = history.buildConversationStateFromWindow(tail);
    const laterRef = state.transcript.items.find(item => item.kind === "user").messageRef;
    assert.equal(laterRef.messageIndex, 14);
    assert.equal(laterRef.messageId, "later");
    assert.equal(laterRef.segmentId, "kbrain:remote-session");
    const earlier = await history.getChatHistoryWindow({ id, maxMessages: 10, beforeOffset: tail.oldestOffset, expectedRevision: tail.revision, includeActiveSegment: false });
    assert.deepEqual(cursors, [10]);
    assert.deepEqual(earlier.segments.map(slice => [slice.startMessageIndex, slice.messages.length]), [[5, 2]]);
    assert.equal(earlier.oldestOffset, 2);
    assert.equal(earlier.hasMoreBefore, false);
    assert.equal(earlier.returnedMessageCount, 2);
    const earlierState = history.buildConversationStateFromWindow({ ...earlier, activeSegment: tail.activeSegment });
    const earlyRef = earlierState.transcript.items.find(item => item.kind === "user").messageRef;
    assert.equal(earlyRef.messageIndex, 5);
    await assert.rejects(() => history.branchChatHistory(id, { ...laterRef, messageIndex: 4 }), /reference/);
    await history.branchChatHistory(id, earlyRef);
    await history.branchChatHistory(id, laterRef);
    assert.deepEqual(mutations.map(mutation => mutation.body.message_ref.message_index), [5, 14]);
    const edited = await history.replaceChatHistoryFromMessage({ id, baseMessageRef: laterRef, replacementMessage: { role: "user", content: "replacement", timestamp: 1 }, expectedRevision: "rev-1", maxMessages: 3 });
    const editedState = history.buildConversationStateFromWindow(edited);
    const editedRef = editedState.transcript.items.find(item => item.kind === "user").messageRef;
    assert.equal(editedRef.messageIndex, 14);
    assert.equal(editedRef.messageId, "edited-sparse");
    assert.equal(edited.activeSegment.messages.at(-1).kbrainEditPending, true);
    await history.branchChatHistory(id, editedRef);
    assert.deepEqual(mutations.map(mutation => mutation.body.message_ref.message_index), [5, 14, 14, 14]);
    assert.deepEqual(invokes, []);
  });
});

test("absent message_offsets keep canonical indices across filtered system and developer rows", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  const session = makeSession({ messages: [
    { id: "system", role: "system", content: [{ type: "text", text: "system" }] },
    makeSession().messages[0],
    { id: "developer", role: "developer", content: [{ type: "text", text: "developer" }] },
    { ...makeSession().messages[0], id: "u2" },
  ], message_count: 4 });
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    if (url.pathname === "/v1/sessions") return sendJson(response, { sessions: [session], total_count: 1 });
    if (url.pathname.endsWith("/history")) return sendJson(response, { session, active_messages: session.messages, revision: "rev-1", oldest_offset: 30, has_more_before: true, total_message_count: 34 });
    return sendJson(response, session);
  }, async () => {
    const id = (await history.listChatHistory(1, 20)).items[0].id;
    const window = await history.getChatHistoryWindow({ id, maxMessages: 4, includeActiveSegment: true });
    assert.deepEqual(window.segments.map(slice => slice.startMessageIndex), [31, 33]);
    const refs = history.buildConversationStateFromWindow(window).transcript.items.filter(item => item.kind === "user").map(item => item.messageRef);
    assert.deepEqual(refs.map(ref => ref.messageIndex), [31, 33]);
    await history.branchChatHistory(id, refs[1]);
    assert.deepEqual(invokes, []);
  });
});

test("malformed message_offsets fail closed instead of fabricating history indices", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  let offsets = [];
  const session = makeSession();
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    if (url.pathname === "/v1/sessions") return sendJson(response, { sessions: [session], total_count: 1 });
    return sendJson(response, { session, message_offsets: offsets, active_messages: session.messages, revision: "rev-1", oldest_offset: 0, has_more_before: false, total_message_count: 2 });
  }, async () => {
    const id = (await history.listChatHistory(1, 20)).items[0].id;
    for (const value of [[], [0], [1, 1], [4, 2], [-1, 1], [0, 1.5]]) {
      offsets = value;
      await assert.rejects(() => history.getChatHistoryWindow({ id, maxMessages: 2, includeActiveSegment: true }), /message_offsets/);
    }
    assert.deepEqual(invokes, []);
  });
});

test("restored subagent tasks retain the visible parent answer in shipped buildUiMessages", async () => {
  installStorage();
  const invokes = [];
  const history = loadChatHistory(invokes);
  const { buildUiMessages } = createTsModuleLoader().loadModule("src/lib/chat/messages/uiMessages.ts");
  const task = { id: "browser-child", description: "Browser child report", status: "done", model: { provider: "fixture", model: "fixture-model" }, report: "Browser child report" };
  const session = makeSession({ messages: [
    { id: "browser-user", role: "user", content: [{ type: "text", text: "Run child" }] },
    { id: "browser-call", role: "assistant", tool_calls: [{ id: "spawn-1", name: "spawn_agent", arguments: { task: "Browser child report" } }] },
    { id: "browser-result", role: "tool", tool_call_id: "spawn-1", name: "spawn_agent", content: [{ type: "text", text: "Started browser-child" }] },
    { id: "browser-answer", role: "assistant", content: [{ type: "text", text: "Browser parent received child report" }] },
  ], message_count: 4, tasks: [task, task] });
  await withHttpFixture(async (request, response) => {
    const url = new URL(request.url, DEFAULT_KBRAIN_URL);
    if (url.pathname === "/v1/sessions") return sendJson(response, { sessions: [session], total_count: 1 });
    const tailOnly = url.searchParams.get("max_messages") === "1";
    sendJson(response, { session: { ...session, messages: tailOnly ? session.messages.slice(-1) : session.messages }, active_messages: session.messages, message_offsets: tailOnly ? [14] : [3, 5, 6, 14], oldest_offset: tailOnly ? 14 : 3, has_more_before: tailOnly, total_message_count: 4, revision: "rev-1" });
  }, async () => {
    const id = (await history.listChatHistory(1, 20)).items[0].id;
    for (const maxMessages of [4, 1]) {
      const window = await history.getChatHistoryWindow({ id, maxMessages, includeActiveSegment: true });
      const ui = buildUiMessages(window.activeSegment.messages);
      assert.equal(ui.at(-1).text, "Browser parent received child report");
      const state = history.buildConversationStateFromWindow(window);
      const finalRound = state.transcript.items.filter(item => item.kind === "assistant").at(-1).rounds.at(-1);
      assert.equal(finalRound.blocks.at(-1).text, "Browser parent received child report");
      for (const rounds of [ui.flatMap(item => item.rounds ?? []), state.transcript.items.flatMap(item => item.rounds ?? [])]) {
        const cards = rounds.flatMap(round => round.blocks).filter(block => block.kind === "tool" && block.item.toolCall.id === "kbrain-subagent:browser-child");
        assert.equal(cards.length, 1);
        assert.equal(cards[0].item.toolResult.content[0].text, "Browser child report");
      }
      assert.equal(window.activeSegment.messages.filter(message => message.role === "assistant").at(-1).id, "browser-answer");
      assert.equal(window.segments.at(-1).startMessageIndex, 14);
      assert.equal(window.meta.totalMessageCount, 5);
      if (maxMessages === 4) assert.equal(state.transcript.items.find(item => item.kind === "user").messageRef.messageIndex, 3);
    }
    assert.deepEqual(invokes, []);
  });
});
