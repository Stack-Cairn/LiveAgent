import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Independent review: real TS history/actions/runner and real HTTP/SSE. Only
// React's hook container is replaced; no history or merge implementation mocks.
const user = (id, text = "same text") => ({ id, role: "user", content: text, timestamp: 1 });
const wireUser = (id, text = "same text") => ({ id, role: "user", content: [{ type: "text", text }] });
const wireAnswer = (id, text = "old task completed") => ({ id, role: "assistant", content: [{ type: "text", text }], stop_reason: "stop" });
const flatten = state => state.segments.flatMap(segment => segment.messages);
const ids = state => flatten(state).map(message => message.id);
const noop = () => {};

async function fixture(t) {
  const loader = createTsModuleLoader({ mocks: { react: { useRef: current => ({ current }) } } });
  const stateModule = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
  const sync = loader.loadModule("src/lib/kbrain/historySync.ts");
  const { useConversationHistoryActions } = loader.loadModule("src/pages/chat/history/useConversationHistoryActions.ts");
  const { runTextConversationTurn } = loader.loadModule("src/pages/chat/turns/runTextConversationTurn.ts");
  const runtime = loader.loadModule("src/pages/chat/runtime/chatPageRuntime.ts");
  const { setKBrainSessionId } = loader.loadModule("src/lib/kbrain/mapping.ts");
  const connection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const backend = {
    messages: [wireUser("old", "old input"), wireAnswer("late")],
    posts: [], reads: [], reject: false, historyFails: false, terminal: "completed", seq: 0,
    revision: "rev-review", page: null,
  };
  const json = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/v1/health") return json(response, { version: "kbrain.agent.v1", capabilities: [] });
    if (url.pathname.endsWith("/runs")) {
      if (request.method === "GET") return json(response, { version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: backend.seq });
      const post = JSON.parse(body);
      backend.posts.push(post);
      if (backend.reject) return json(response, { error: "session busy; retry" }, 503);
      backend.current = post;
      backend.messages.push(wireUser(post.turn_id, post.prompt));
      ++backend.seq;
      if (backend.preack) {
        backend.activeController.abort();
        return;
      }
      return json(response, { version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: backend.seq }, 202);
    }
    if (url.pathname.endsWith("/cancel")) {
      backend.cancelled = true;
      backend.messages.push(wireAnswer("cancel-answer", "authoritative cancellation result"));
      return json(response, { ok: true });
    }
    if (url.pathname.endsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type, payload = {}) => response.write(`data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", seq: ++backend.seq, type, payload })}\n\n`);
      if (backend.cancelled) {
        emit("run.cancelled");
        response.end();
        return;
      }
      emit("assistant.text.delta", { text: "reply" });
      backend.messages.push(wireAnswer("new-answer", "reply"));
      emit(`run.${backend.terminal}`);
      response.end();
      return;
    }
    if (url.pathname.endsWith("/history")) {
      backend.reads.push(url);
      if (backend.historyFails) return json(response, { error: "history unavailable" }, 503);
      const page = backend.page && url.searchParams.has("before_offset") ? backend.page : null;
      const session = { id: "session", revision: backend.revision, title: "Review", cwd: "/repo", created_at: 1, updated_at: 2, model: { provider: "fixture", model: "model" }, messages: page ?? backend.messages, message_count: backend.messages.length, last_seq: backend.seq };
      return json(response, { session, revision: backend.revision, active_messages: backend.messages, oldest_offset: page ? 0 : (backend.page ? backend.page.length : 0), has_more_before: !page && !!backend.page, total_message_count: backend.messages.length + (backend.page?.length ?? 0) });
    }
    return json(response, { error: `unexpected ${request.method} ${request.url}` }, 404);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  connection.setKBrainRuntimeConnection({ baseUrl, token: "fixture", protocolVersion: "kbrain.agent.v1" });
  setKBrainSessionId("review", "session", baseUrl);
  t.after(() => {
    connection.clearKBrainRuntimeConnection();
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    server.closeAllConnections();
    server.close();
  });

  const currentId = { current: "other" };
  const cache = new Map();
  const cursors = new Map();
  const visible = { state: stateModule.createConversationStateFromContext({ messages: [] }) };
  const entry = state => runtime.createConversationRuntimeEntry({ state, sessionId: "session", createdAt: 1, workdir: "/repo", errorMessage: "session busy; retry" });
  const actions = useConversationHistoryActions({
    conversationState: visible.state,
    currentConversationIdRef: currentId,
    conversationRuntimeCacheRef: { current: cache },
    conversationPersistenceCursorRef: { current: cursors },
    conversationLoadSequenceRef: { current: 0 },
    markLocalHistorySnapshotSynced: noop,
    isConversationRunning: () => false,
    sidebarStore: { peek: id => ({ id, isPending: false }), upsertLocal: noop },
    titleJobRef: { current: null }, t: key => key,
    buildRuntimeEntryFromVisibleState: () => entry(visible.state),
    syncVisibleConversationRuntime: (_id, next) => { visible.state = next.state; },
    updateConversationRuntimeEntry: (id, update) => {
      const next = update(cache.get(id)); cache.set(id, next);
      if (currentId.current === id) visible.state = next.state;
      return next;
    },
    cancelConversationLoad: noop, resetVisibleTransientState: noop,
    deleteConversationArtifacts: noop, resolveConversationSelectedModel: () => undefined,
    setCurrentConversationId: id => { currentId.current = id; }, setErrorMessage: noop,
    hydration: { markHydrating: noop, clearHydrating: noop, markFailed: noop },
  });
  const frozen = [], persisted = [], errors = [];
  async function send(message, { append = true } = {}) {
    currentId.current = "review";
    if (append) visible.state = stateModule.appendMessagesToConversation(visible.state, [message]);
    cache.set("review", entry(visible.state));
    const controller = new AbortController();
    backend.activeController = controller;
    await runTextConversationTurn({
      providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
      runtime: { backend: "kbrain" }, conversationId: "review", sessionId: "session",
      trajectoryMessageId: `request-${message.id}`, conversationCwd: "/repo", createdAt: 1,
      fallbackTitle: "Review", titlePromise: null, transcriptStore: {},
      cancellation: { userStop: controller },
      // Model context deliberately omits attachments; protection must use the original.
      buildPreparedContext: state => ({ messages: flatten(state).map(({ attachments, ...rest }) => rest) }),
      getNextConversationState: () => visible.state,
      applyConversationState: state => { visible.state = state; cache.set("review", entry(state)); },
      batchLiveRoundsUpdate: noop, updateToolStatus: noop, updateGatewayBridgeToolStatus: noop,
      freezeGatewayFinalProjection: state => frozen.push(state), settleLiveTranscript: noop,
      persistConversationWithHistorySync: async params => { persisted.push(params.state); return true; },
      gatewayBridgeEvents: { queueToken: noop, queueEvent: noop, queueToolStatus: noop, emitError: error => errors.push(error) },
      hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map(key => [key, noop])),
    });
  }
  async function rejectedPair() {
    backend.reject = true;
    await assert.rejects(send({ ...user("pending-a"), attachments: [{ id: "attachment-a", name: "local.png" }] }), /session busy/);
    await assert.rejects(send(user("pending-b")), /session busy/);
    backend.reject = false;
  }
  return { loader, stateModule, sync, runtime, backend, currentId, cache, cursors, visible, entry, actions, send, rejectedPair, frozen, persisted, errors };
}

test("review: late authority and two same-text IDs coexist; accepting one retains the other", async t => {
  const h = await fixture(t);
  await h.rejectedPair();
  await h.actions.reloadConversation("review", { onlyIfIdle: true });
  assert.deepEqual(ids(h.visible.state), ["old", "late", "pending-a", "pending-b"]);
  assert.equal(flatten(h.visible.state).find(m => m.id === "pending-a").attachments[0].name, "local.png");
  const acceptB = h.sync.protectKBrainInput("review", user("pending-b"));
  h.backend.messages.push(wireUser("pending-b"));
  acceptB();
  await h.actions.reloadConversation("review", { onlyIfIdle: true });
  assert.deepEqual(ids(h.visible.state), ["old", "late", "pending-b", "pending-a"]);
  assert.equal(h.sync.hasUnacceptedKBrainInput("review"), true);
});

test("review: HTTP retry accepts pending-b and final snapshots retain only pending-a as overlay", async t => {
  const h = await fixture(t);
  await h.rejectedPair();
  await h.actions.reloadConversation("review", { onlyIfIdle: true });
  await h.send(user("pending-b"), { append: false });
  for (const state of [h.visible.state, h.frozen.at(-1), h.persisted.at(-1)]) {
    assert.deepEqual(ids(state), ["old", "late", "pending-b", "new-answer", "pending-a"]);
  }
  assert.deepEqual(ids(h.sync.mergeUnacceptedKBrainInputs("review", h.stateModule.createConversationStateFromContext({ messages: [] }))), ["pending-a"]);
  assert.equal(h.backend.posts.length, 3);
});

test("review: stale acceptance cannot release the latest same-ID retry or another input", async t => {
  const h = await fixture(t);
  const stale = h.sync.protectKBrainInput("review", user("retry", "first"));
  const latest = h.sync.protectKBrainInput("review", user("retry", "latest"));
  const other = h.sync.protectKBrainInput("review", user("other-input"));
  stale();
  const empty = h.stateModule.createConversationStateFromContext({ messages: [] });
  let merged = h.sync.mergeUnacceptedKBrainInputs("review", empty);
  assert.deepEqual(ids(merged), ["retry", "other-input"]);
  assert.equal(flatten(merged)[0].content, "latest");
  latest();
  merged = h.sync.mergeUnacceptedKBrainInputs("review", empty);
  assert.deepEqual(ids(merged), ["other-input"]);
  other();
  assert.equal(h.sync.hasUnacceptedKBrainInput("review"), false);
});

test("review: unknown acceptance found by ID in authority renders once while another input stays", async t => {
  const h = await fixture(t);
  h.sync.protectKBrainInput("review", user("unknown"));
  h.sync.protectKBrainInput("review", user("still-local"));
  h.backend.messages.push(wireUser("unknown"));
  h.cache.set("review", h.entry(h.visible.state));
  h.currentId.current = "review";
  for (let i = 0; i < 2; i++) await h.actions.reloadConversation("review", { onlyIfIdle: true });
  assert.deepEqual(ids(h.visible.state), ["old", "late", "unknown", "still-local"]);
  assert.equal(h.visible.state.transcript.revision, h.backend.revision);
});

for (const terminal of ["completed", "cancelled"]) {
  for (const historyFails of [false, true]) {
    test(`review: ${terminal}, history failure=${historyFails}: runner freeze and persist preserve other unaccepted inputs`, async t => {
      const h = await fixture(t);
      await h.rejectedPair();
      await h.actions.reloadConversation("review", { onlyIfIdle: true });
      h.backend.terminal = terminal;
      h.backend.historyFails = historyFails;
      await h.send(user("accepted-c", "third input"));
      for (const state of [h.visible.state, h.frozen.at(-1), h.persisted.at(-1)]) {
        assert.ok(state, "runner must freeze/persist a final state");
        const actual = ids(state);
        for (const id of ["old", "late", "pending-a", "pending-b", "accepted-c"]) {
          assert.equal(actual.filter(value => value === id).length, 1, `${id} must occur once`);
        }
        assert.equal(flatten(state).filter(m => m.role === "assistant").length, 2);
      }
      assert.equal(h.sync.hasUnacceptedKBrainInput("review"), true);
      assert.equal(h.errors.length, historyFails ? 1 : 0);
    });
  }
}

test("review: Stop before acceptance response recovers authority and retains both rejected inputs", async t => {
  const h = await fixture(t);
  await h.rejectedPair();
  await h.actions.reloadConversation("review", { onlyIfIdle: true });
  h.backend.preack = true;
  await assert.rejects(h.send(user("accepted-c", "third input")), /K-brain turn aborted/);
  assert.deepEqual(ids(h.visible.state), ["old", "late", "accepted-c", "cancel-answer", "pending-a", "pending-b"]);
  assert.equal(h.sync.hasUnacceptedKBrainInput("review"), true);
  assert.deepEqual(ids(h.sync.mergeUnacceptedKBrainInputs("review", h.stateModule.createConversationStateFromContext({ messages: [] }))), ["pending-a", "pending-b"]);
});

test("review: pagination preserves pending overlays and backend revision", async t => {
  const h = await fixture(t);
  await h.rejectedPair();
  h.backend.page = [wireUser("earlier", "earlier page")];
  await h.actions.reloadConversation("review", { onlyIfIdle: true });
  await h.actions.loadEarlier("review");
  assert.deepEqual(ids(h.visible.state), ["old", "late", "pending-a", "pending-b"]);
  assert.equal(h.visible.state.transcript.items.filter(item => item.kind === "user").length, 4);
  assert.equal(h.visible.state.transcript.revision, h.backend.revision);
  assert.equal(h.visible.state.transcript.hasMoreBefore, false);
});

for (const reopen of ["openInitial", "hydrateInBackground"]) {
  test(`review: ${reopen} after real cache eviction restores rejected input overlays`, async t => {
    const h = await fixture(t);
    await h.rejectedPair();
    await h.actions.reloadConversation("review", { onlyIfIdle: true });
    h.currentId.current = "other";
    h.visible.state = h.stateModule.createConversationStateFromContext({ messages: [] });
    h.cache.set("other", h.entry(h.visible.state));
    // Exercise the shipping cache limit (12 idle entries), not a test-only limit.
    for (let index = 0; index < 13; index++) h.cache.set(`idle-${index}`, h.entry(h.visible.state));
    const pruned = h.runtime.pruneIdleConversationRuntimeCaches({
      runtimeCache: h.cache, persistenceCursors: h.cursors,
      keepConversationIds: ["other"], isConversationRunning: () => false,
    });
    assert.ok(pruned.includes("review"));
    assert.equal(h.sync.hasUnacceptedKBrainInput("review"), true);
    await h.actions[reopen]("review");
    assert.deepEqual(ids(h.cache.get("review").state), ["old", "late", "pending-a", "pending-b"], "cold history reads must retain the protected local input IDs");
  });
}

test("review: deleting a rejected conversation releases retained messages and attachments", async t => {
  const h = await fixture(t);
  await h.rejectedPair();
  h.currentId.current = "other";
  h.actions.cleanupDeletedConversation("review");
  assert.equal(h.cache.has("review"), false);
  assert.equal(h.cursors.has("review"), false);
  // The store has already removed the backend row when this public cleanup runs.
  // A rejected POST will never invoke onAccepted; deletion is its last cleanup.
  const retained = h.sync.mergeUnacceptedKBrainInputs("review", h.stateModule.createConversationStateFromContext({ messages: [] }));
  assert.deepEqual(ids(retained), [], "deleted messages and attachment objects must no longer be retained by the overlay registry");
  assert.equal(h.sync.hasUnacceptedKBrainInput("review"), false, "deletion must release the module-global overlay registry");
});
