import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Real HTTP/SSE through the shipped conversation runner, with a deterministic
// backend fixture. This does not claim to reproduce K-brain's task scheduler.
for (const mode of ["cancelled", "failed", "reconnect", "rejected", "mixed", "preack"]) {
  test(`${mode}: consecutive sends reconcile authority without losing or duplicating input`, async (t) => {
    const loader = createTsModuleLoader({ mocks: { react: { useRef: current => ({ current }) } } });
    const { runTextConversationTurn } = loader.loadModule("src/pages/chat/turns/runTextConversationTurn.ts");
    const { createConversationStateFromContext, appendMessagesToConversation } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
    const { hasUnacceptedKBrainInput } = loader.loadModule("src/lib/kbrain/historySync.ts");
    const connection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
    const messages = [];
    const posts = [];
    const events = [];
    const subscriptions = [];
    let seq = 0;
    let runId;
    let currentPrompt;
    let acceptedSeq;
    let stream;
    let activeController;
    let historyReads = 0;
    let cancelled = false;
    let firstSubscription = true;
    const json = (response, value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const event = (type, payload = {}) => {
      const value = { version: "kbrain.agent.v1", conversation_id: "session", run_id: runId, seq: ++seq, type, payload };
      const line = `data: ${JSON.stringify(value)}\n\n`;
      events.push({ seq, line });
      stream?.write(line);
    };
    const finish = (reason) => {
      messages.push({ id: `assistant-${runId}`, role: "assistant", content: [{ type: "text", text: `authority:${currentPrompt}` }], stop_reason: reason });
      event(`run.${reason === "error" ? "failed" : reason === "cancelled" ? "cancelled" : "completed"}`, { error: reason === "error" ? "fixture failure" : undefined });
      stream?.end();
    };
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/v1/health") return json(response, { version: "kbrain.agent.v1", capabilities: [] });
      if (url.pathname === "/v1/sessions") return json(response, { id: "session" }, 201);
      if (url.pathname.endsWith("/runs")) {
        if (request.method === "GET") {
          return json(response, { version: "kbrain.agent.v1", conversation_id: "session", run_id: runId, accepted_seq: acceptedSeq });
        }
        posts.push(JSON.parse(body));
        if (mode === "rejected" || (mode === "mixed" && posts.length <= 2)) {
          // An older run remains alive after the local stream has ended. Its real
          // result lands while newer inputs are being rejected as session-busy.
          if (mode === "mixed" && posts.length === 2) messages.push({ id: "late-result", role: "assistant", content: [{ type: "text", text: "old task actually completed" }] });
          return json(response, { error: "fixture rejected input" }, 503);
        }
        runId = `run-${posts.length}`;
        currentPrompt = posts.at(-1).prompt;
        acceptedSeq = ++seq;
        messages.push({ id: posts.at(-1).turn_id || `user-${runId}`, role: "user", content: [{ type: "text", text: currentPrompt }] });
        cancelled = false;
        firstSubscription = true;
        stream = undefined;
        if (mode === "preack") {
          // The mutation committed, but Stop arrives before its response.
          activeController.abort();
          return;
        }
        return json(response, { version: "kbrain.agent.v1", conversation_id: "session", run_id: runId, accepted_seq: acceptedSeq }, 202);
      }
      if (url.pathname.endsWith("/cancel")) {
        cancelled = true;
        finish("cancelled");
        return json(response, { ok: true });
      }
      if (url.pathname.endsWith("/events")) {
        const after = Number(url.searchParams.get("after_seq"));
        subscriptions.push(after);
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (cancelled) {
          response.end(events.filter(item => item.seq > after).map(item => item.line).join(""));
          return;
        }
        if (mode === "reconnect" && !firstSubscription) {
          // Resume at the last delivered cursor without reposting the run.
          assert.equal(after, events.at(-1).seq);
          event("assistant.text.delta", { text: "reply" });
          finish("stop");
          return;
        }
        firstSubscription = false;
        event("assistant.text.delta", { text: "partial " });
        if (mode === "reconnect") response.end();
        else if (mode === "failed") finish("error");
        else if (mode === "mixed") finish("stop");
        return;
      }
      if (url.pathname.endsWith("/history")) {
        historyReads++;
        const session = { id: "session", revision: `rev-${messages.length}`, model: { provider: "fixture", model: "model" }, messages, message_count: messages.length, last_seq: seq };
        return json(response, { session, revision: session.revision, active_messages: messages, oldest_offset: 0, has_more_before: false, total_message_count: messages.length });
      }
      return json(response, { error: `unexpected request ${request.url}` }, 404);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const originalStorage = globalThis.localStorage;
    const storage = new Map();
    globalThis.localStorage = {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    };
    connection.setKBrainRuntimeConnection({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "fixture", protocolVersion: "kbrain.agent.v1" });
    t.after(() => {
      connection.clearKBrainRuntimeConnection();
      if (originalStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = originalStorage;
      server.closeAllConnections();
      server.close();
    });
    if (mode === "mixed") messages.push({ id: "old-input", role: "user", content: "old task" });
    let state = createConversationStateFromContext({ messages: mode === "mixed" ? [{ id: "old-input", role: "user", content: "old task", timestamp: 0 }] : [] });
    const conversationId = `interrupt-${mode}`;
    const cache = new Map();
    const { useConversationHistoryActions } = loader.loadModule("src/pages/chat/history/useConversationHistoryActions.ts");
    let visibleError = null;
    const historyActions = useConversationHistoryActions({
      conversationRuntimeCacheRef: { current: cache },
      conversationPersistenceCursorRef: { current: new Map() },
      currentConversationIdRef: { current: conversationId },
      isConversationRunning: () => false,
      syncVisibleConversationRuntime: (_id, entry) => { state = entry.state; },
      setErrorMessage: error => { visibleError = error; },
      markLocalHistorySnapshotSynced() {},
      sidebarStore: { upsertLocal() {} },
    });
    for (let index = 1; index <= 3; index++) {
      // Retry the second rejected message after the old task has finished. The
      // first rejected message must survive this successful acceptance too.
      const prompt = mode === "mixed" && index === 3 ? "message-2" : `message-${index}`;
      if (!(mode === "mixed" && index === 3)) {
        state = appendMessagesToConversation(state, [{ id: `local-${index}`, role: "user", content: prompt, timestamp: index }]);
      }
      const context = { messages: state.segments.flatMap(segment => segment.messages) };
      const controller = new AbortController();
      activeController = controller;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
      let persisted = false;
      const input = {
        providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
        runtime: { backend: "kbrain" }, conversationId, sessionId: "frontend", trajectoryMessageId: `request-${index}`,
        conversationCwd: "/workspace", createdAt: 1, fallbackTitle: "Interrupted", titlePromise: null,
        transcriptStore: {}, cancellation: { userStop: controller },
        // Preparation may strip local message IDs; turn_id must retain the
        // original input identity so authority/overlay reconciliation can dedupe.
        buildPreparedContext: () => ({ messages: context.messages.map(({ id, ...message }) => message) }),
        getNextConversationState: () => state,
        applyConversationState: next => { state = next; }, batchLiveRoundsUpdate() {},
        updateToolStatus() {}, updateGatewayBridgeToolStatus() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
        persistConversationWithHistorySync: async () => { persisted = true; return true; },
        gatewayBridgeEvents: { queueToken: text => { if (mode === "cancelled" && text) controller.abort(); }, queueEvent() {}, queueToolStatus() {}, emitError() {} },
        hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map(key => [key, () => {}])),
      };
      const rejected = mode === "rejected" || (mode === "mixed" && index <= 2);
      try {
        if (rejected) await assert.rejects(runTextConversationTurn(input), /fixture rejected input/);
        else if (mode === "preack") await assert.rejects(runTextConversationTurn(input), /K-brain turn aborted/);
        else await runTextConversationTurn(input);
      } finally {
        clearTimeout(timeout);
      }
      assert.equal(timedOut, false, "the fixture must settle without the watchdog cancelling it");
      assert.equal(posts.at(-1).turn_id, `local-${mode === "mixed" && index === 3 ? 2 : index}`);
      assert.equal(persisted, !rejected && mode !== "preack");
      assert.equal(hasUnacceptedKBrainInput(conversationId), mode === "rejected" || mode === "mixed");
      if (mode === "mixed") {
        cache.set(conversationId, { state, isSending: false, errorMessage: "session busy; retry" });
        await historyActions.reloadConversation(conversationId, { onlyIfIdle: true });
        const visible = state.segments.flatMap(segment => segment.messages);
        assert.equal(visible.filter(message => message.role === "user").length, index === 1 ? 2 : 3);
        assert.equal(visible.filter(message => message.id === "local-1").length, 1);
        if (index >= 2) {
          assert.equal(visible.filter(message => message.id === "local-2").length, 1);
          assert.ok(JSON.stringify(state.transcript.items).includes("old task actually completed"));
        }
        if (index === 3) {
          assert.ok(JSON.stringify(state.transcript.items).includes("authority:message-2"));
          assert.equal(visible.at(-1).id, "local-1", "the other rejected input remains retryable after success");
        }
        assert.equal(visibleError, "session busy; retry");
        continue;
      }
      const visible = state.segments.flatMap(segment => segment.messages);
      assert.equal(visible.filter(message => message.role === "user").length, index);
      if (mode !== "rejected") {
        assert.deepEqual(visible.map(message => message.id), messages.map(message => message.id));
        assert.equal(visible.filter(message => message.role === "assistant").length, index);
        assert.equal(visible.at(-1).content[0].text, `authority:${prompt}`);
      }
    }
    assert.equal(posts.length, 3, "exactly one POST per send, including failures");
    assert.equal(new Set(posts.map(post => post.client_request_id)).size, 3);
    assert.equal(historyReads, mode === "rejected" ? 0 : mode === "mixed" ? 4 : 3);
    if (mode === "reconnect") assert.equal(subscriptions.length, 6);
  });
}
