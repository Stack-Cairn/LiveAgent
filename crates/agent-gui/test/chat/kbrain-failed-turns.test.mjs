import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Failed and interrupted K-brain turns: the error is the turn's, never reply
// markdown, and the transcript keeps what the turn streamed (or its stopped
// state) when K-brain's history does not store it.

const loader = createTsModuleLoader();
const { classifyTurnError } = loader.loadModule("@liveagent/ui/lib/chat/turnError.ts");
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const { parseRunProgress } = loader.loadModule("@liveagent/ui/lib/chat/runProgress.ts");
const { resolveRunPhaseTarget } = loader.loadModule("@liveagent/ui/lib/chat/runPhase.ts");
const { buildUiMessages } = loader.loadModule("src/lib/chat/messages/uiMessages.ts");
const { turnErrorOf } = loader.loadModule("@liveagent/ui/lib/chat/assistantStatus.ts");

const AUTH_ERROR =
  '401 Unauthorized: {"error":{"message":"Incorrect API key provided: sk-fake***.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}';
const syntheticError = (runId, text) => ({
  id: `assistant-error-${runId}`,
  role: "assistant",
  content: [{ type: "text", text }],
  stop_reason: "error",
});

test("turn errors are classified from the raw provider or transport error", () => {
  assert.deepEqual(classifyTurnError(AUTH_ERROR), {
    kind: "auth",
    status: 401,
    detail: "Incorrect API key provided: sk-fake***.",
    raw: AUTH_ERROR,
  });
  assert.equal(classifyTurnError("429 Too Many Requests: rate limit reached").kind, "rate_limit");
  assert.equal(classifyTurnError("HTTP 503 Service Unavailable").kind, "server");
  assert.equal(classifyTurnError('500 Internal Server Error: {"error":{}}').status, 500);
  assert.equal(classifyTurnError("unexpected EOF").kind, "connection");
  assert.equal(
    classifyTurnError("K-brain event stream ended before the run reached a terminal event").kind,
    "connection",
  );
  assert.equal(classifyTurnError("tool budget exhausted").kind, "unknown");
});

function sseFixture(events) {
  const line = (seq, type, payload) =>
    `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", seq, type, payload })}\n\n`;
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/sessions") return Response.json({ id: "s" });
    if (path.endsWith("/runs"))
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 });
    if (path.endsWith("/events")) {
      return new Response(events.map(([type, payload], index) => line(index + 2, type, payload)).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  };
}

function turnParams(fetch, conversationId, extra = {}) {
  return {
    baseUrl: "http://fixture.test",
    fetch,
    model: { provider: "fixture", model: "test" },
    sessionId: "frontend",
    conversationId,
    cwd: "/tmp",
    context: { messages: [] },
    prompt: "hello",
    signal: new AbortController().signal,
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall() {},
    onToolResult() {},
    ...extra,
  };
}

test("a run that fails before replying carries its error separately, not as reply text", async () => {
  const message = await runKBrainTurn(
    turnParams(
      sseFixture([
        ["assistant.message.created", syntheticError("r", AUTH_ERROR)],
        ["run.failed", { state: "failed", error: AUTH_ERROR }],
      ]),
      "failed-auth",
    ),
  );
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, AUTH_ERROR);
  assert.deepEqual(message.content, []);
});

test("a stream that drops mid-reply keeps the streamed text and reports the error", async () => {
  const message = await runKBrainTurn(
    turnParams(
      sseFixture([
        ["assistant.text.delta", { text: "Here is the first part " }],
        ["assistant.message.created", syntheticError("r", "unexpected EOF")],
        ["run.failed", { state: "failed", error: "unexpected EOF" }],
      ]),
      "failed-drop",
    ),
  );
  assert.equal(message.errorMessage, "unexpected EOF");
  assert.deepEqual(message.content, [{ type: "text", text: "Here is the first part " }]);
});

test("a model request retry shows a live retrying status with the countdown target", async () => {
  const statuses = [];
  const before = Date.now();
  await runKBrainTurn(
    turnParams(
      sseFixture([
        [
          "trajectory.retry",
          { request_id: "q", task_id: "t1", attempt: 1, max: 3, delay_ms: 9000, error: "429" },
        ],
        [
          "trajectory.retry",
          { request_id: "q", task_id: "", attempt: 2, max: 3, delay_ms: 4000, error: "429" },
        ],
        ["assistant.text.delta", { text: "ok" }],
        ["assistant.message.created", { role: "assistant", content: [{ type: "text", text: "ok" }] }],
        ["run.completed", {}],
      ]),
      "retry-status",
      { onStatus: (status) => statuses.push(status) },
    ),
  );
  const retrying = statuses.map(parseRunProgress).filter((progress) => progress?.stage === "retrying");
  // The background task's retry is not the turn's; three attempts allow two retries.
  assert.equal(retrying.length, 1);
  assert.equal(retrying[0].retry_attempt, 2);
  assert.equal(retrying[0].retry_max, 2);
  assert.ok(retrying[0].retry_at_ms >= before + 4000 && retrying[0].retry_at_ms <= Date.now() + 4000);
  const target = resolveRunPhaseTarget(statuses.find((status) => parseRunProgress(status)?.stage === "retrying"));
  assert.equal(target.phase, "retrying");
  assert.equal(target.delayMs, 0);
});

test("a failed round renders its error once, as round meta, even with no content", () => {
  const user = { role: "user", content: "hi", timestamp: 1 };
  const failed = buildUiMessages([
    user,
    { role: "assistant", content: [], stopReason: "error", errorMessage: AUTH_ERROR, timestamp: 2 },
  ]);
  const rounds = failed.at(-1).rounds;
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0].blocks, []);
  assert.equal(turnErrorOf(rounds), AUTH_ERROR);
  // Replies saved before errors were separate repeat the error as text.
  const legacy = buildUiMessages([
    user,
    {
      role: "assistant",
      content: [{ type: "text", text: "boom" }],
      stopReason: "error",
      errorMessage: "boom",
      timestamp: 2,
    },
  ]);
  assert.deepEqual(legacy.at(-1).rounds[0].blocks, []);
  assert.equal(turnErrorOf(legacy.at(-1).rounds), "boom");
});

// Real HTTP/SSE through the shipped conversation runner, including the history
// replace that follows every turn.
for (const mode of ["drop", "auth", "stop-before-output"]) {
  test(`${mode}: the transcript after the history refresh keeps what the turn showed`, async (t) => {
    const turnLoader = createTsModuleLoader({ mocks: { react: { useRef: (current) => ({ current }) } } });
    const { runTextConversationTurn } = turnLoader.loadModule("src/pages/chat/turns/runTextConversationTurn.ts");
    const { createConversationStateFromContext, appendMessagesToConversation } = turnLoader.loadModule(
      "src/lib/chat/conversation/conversationState.ts",
    );
    const connection = turnLoader.loadModule("src/lib/kbrain/runtimeConnection.ts");
    const messages = [];
    const events = [];
    let seq = 0;
    let stream;
    let cancelled = false;
    const runId = "run-1";
    const controller = new AbortController();
    const json = (response, value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const event = (type, payload = {}) => {
      const line = `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", run_id: runId, seq: ++seq, type, payload })}\n\n`;
      events.push({ seq, line });
      stream?.write(line);
    };
    const fail = (error) => {
      const message = syntheticError(runId, error);
      messages.push(message);
      event("assistant.message.created", message);
      event("run.failed", { state: "failed", error });
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
          return json(response, { version: "kbrain.agent.v1", conversation_id: "session", run_id: runId, accepted_seq: 1 });
        }
        const post = JSON.parse(body);
        seq = 1;
        messages.push({ id: post.turn_id, role: "user", content: [{ type: "text", text: post.prompt }] });
        return json(response, { version: "kbrain.agent.v1", conversation_id: "session", run_id: runId, accepted_seq: 1 }, 202);
      }
      if (url.pathname.endsWith("/cancel")) {
        // K-brain stores no assistant message for a run stopped before any output.
        cancelled = true;
        event("run.cancelled", {});
        stream?.end();
        return json(response, { ok: true });
      }
      if (url.pathname.endsWith("/events")) {
        const after = Number(url.searchParams.get("after_seq"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (cancelled || events.length > 0) {
          response.end(events.filter((item) => item.seq > after).map((item) => item.line).join(""));
          return;
        }
        stream = response;
        if (mode === "drop") {
          // K-brain drops the partial reply of a stream that fails mid-reply.
          event("assistant.text.delta", { text: "Here is the first part " });
          fail("unexpected EOF");
        } else if (mode === "auth") {
          fail(AUTH_ERROR);
        } else {
          setTimeout(() => controller.abort(), 50);
        }
        return;
      }
      if (url.pathname.endsWith("/history")) {
        const session = { id: "session", revision: `rev-${messages.length}`, model: { provider: "fixture", model: "model" }, messages, message_count: messages.length, last_seq: seq };
        return json(response, { session, revision: session.revision, active_messages: messages, oldest_offset: 0, has_more_before: false, total_message_count: messages.length });
      }
      return json(response, { error: `unexpected request ${request.url}` }, 404);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const originalStorage = globalThis.localStorage;
    const storage = new Map();
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    };
    connection.setKBrainRuntimeConnection({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "fixture", protocolVersion: "kbrain.agent.v1" });
    t.after(() => {
      connection.clearKBrainRuntimeConnection();
      if (originalStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = originalStorage;
      server.closeAllConnections();
      server.close();
    });
    let state = appendMessagesToConversation(createConversationStateFromContext({ messages: [] }), [
      { id: "local-1", role: "user", content: "hello", timestamp: 1 },
    ]);
    const context = { messages: state.segments.flatMap((segment) => segment.messages) };
    const input = {
      providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
      runtime: { backend: "kbrain" }, conversationId: `failed-${mode}`, sessionId: "frontend", trajectoryMessageId: "request-1",
      conversationCwd: "/workspace", createdAt: 1, fallbackTitle: "Failed", titlePromise: null,
      transcriptStore: {}, cancellation: { userStop: controller },
      buildPreparedContext: () => ({ messages: context.messages.map(({ id, ...message }) => message) }),
      getNextConversationState: () => state,
      applyConversationState: (next) => { state = next; }, batchLiveRoundsUpdate() {},
      updateToolStatus() {}, updateGatewayBridgeToolStatus() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
      persistConversationWithHistorySync: async () => true,
      gatewayBridgeEvents: { queueToken() {}, queueEvent() {}, queueToolStatus() {}, emitError() {} },
      hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])),
    };
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await runTextConversationTurn(input).catch((error) => {
        if (mode !== "stop-before-output") throw error;
      });
    } finally {
      clearTimeout(timeout);
    }
    const items = state.transcript.items;
    const reply = items.at(-1);
    assert.equal(reply?.kind, "assistant", JSON.stringify(items));
    const lastRound = reply.rounds.at(-1);
    const text = reply.rounds.flatMap((round) => round.blocks).filter((block) => block.kind === "text").map((block) => block.text).join("");
    if (mode === "drop") {
      assert.equal(text, "Here is the first part ");
      assert.equal(turnErrorOf(reply.rounds), "unexpected EOF");
      // Reopening the conversation later in this app session reads the same history.
      const { getKBrainHistoryWindow } = turnLoader.loadModule("src/lib/kbrain/history.ts");
      const reread = (await getKBrainHistoryWindow(`failed-${mode}`)).segments.at(-1).messages.at(-1);
      assert.deepEqual(reread.content, [{ type: "text", text: "Here is the first part " }]);
      assert.equal(reread.errorMessage, "unexpected EOF");
    } else if (mode === "auth") {
      assert.equal(text, "", "the raw error is not reply markdown");
      assert.equal(turnErrorOf(reply.rounds), AUTH_ERROR);
    } else {
      assert.equal(lastRound.meta?.stopReason, "aborted");
      // Reopening the conversation later in this app session still shows it stopped.
      const { getKBrainHistoryWindow } = turnLoader.loadModule("src/lib/kbrain/history.ts");
      const { buildConversationStateFromWindow } = turnLoader.loadModule("src/lib/chat/history/chatHistory.ts");
      const { mergeUnacceptedKBrainInputs } = turnLoader.loadModule("src/lib/kbrain/historySync.ts");
      const reopened = mergeUnacceptedKBrainInputs(
        `failed-${mode}`,
        buildConversationStateFromWindow(await getKBrainHistoryWindow(`failed-${mode}`)),
      );
      const reopenedReply = reopened.transcript.items.at(-1);
      assert.equal(reopenedReply?.kind, "assistant");
      assert.equal(reopenedReply.rounds.at(-1).meta?.stopReason, "aborted");
    }
  });
}
