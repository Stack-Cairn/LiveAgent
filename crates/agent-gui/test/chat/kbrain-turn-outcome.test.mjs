import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// How a K-brain turn ended, from the backend's optional outcome fields: a reply
// cut off by a failure (stop_reason "error" + error), a failure's classification
// (error_detail), a turn stopped before any output (assistant-stopped-<run id>)
// and why a run was cancelled (cancel_reason). Older backends send none of them.

const loader = createTsModuleLoader();
const { convertMessages } = loader.loadModule("src/lib/kbrain/history.ts");
const { contextToKBrainMessages, retryMax, runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const { buildUiMessages } = loader.loadModule("src/lib/chat/messages/uiMessages.ts");
const { classifyTurnError, isKBrainStoppedMarkerId } = loader.loadModule(
  "@liveagent/ui/lib/chat/turnError.ts",
);
const { isInterruptedByShutdown, isStoppedReply, turnErrorDetailOf, turnErrorOf } = loader.loadModule(
  "@liveagent/ui/lib/chat/assistantStatus.ts",
);

const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }] });
const reply = (messages) => buildUiMessages(convertMessages(messages)).at(-1);
const replyText = (item) =>
  item.rounds.flatMap((round) => round.blocks).filter((block) => block.kind === "text").map((block) => block.text).join("");

test("a reply cut off by a failure reopens with its text and the stored error", () => {
  const item = reply([
    user("u1", "tell me a story"),
    {
      id: "m1",
      role: "assistant",
      content: [{ type: "text", text: "Here is the first part" }],
      stop_reason: "error",
      error: "unexpected EOF",
      error_detail: { kind: "connection_lost" },
    },
  ]);
  assert.equal(replyText(item), "Here is the first part");
  assert.equal(turnErrorOf(item.rounds), "unexpected EOF");
  assert.deepEqual(turnErrorDetailOf(item.rounds), { kind: "connection_lost" });
});

test("history's leading thinking block reopens as the turn's reasoning", () => {
  const [, assistant] = convertMessages([
    user("u1", "q"),
    {
      id: "m1",
      role: "assistant",
      content: [
        { type: "thinking", text: "Let me check the readme." },
        { type: "text", text: "Done." },
      ],
    },
  ]);
  assert.deepEqual(assistant.content, [
    { type: "thinking", thinking: "Let me check the readme." },
    { type: "text", text: "Done." },
  ]);
});

test("a failure before any reply carries its classification to the error row", () => {
  const item = reply([
    user("u1", "hello"),
    {
      id: "assistant-error-r1",
      role: "assistant",
      content: [{ type: "text", text: "400 Bad Request: prompt is too long" }],
      stop_reason: "error",
      error_detail: { kind: "context_limit", upstream_status: 400, provider_message: "prompt is too long" },
    },
  ]);
  assert.equal(replyText(item), "");
  const detail = turnErrorDetailOf(item.rounds);
  assert.deepEqual(detail, { kind: "context_limit", upstreamStatus: 400, providerMessage: "prompt is too long" });
  assert.deepEqual(classifyTurnError(turnErrorOf(item.rounds), detail), {
    kind: "context_limit",
    status: 400,
    detail: "prompt is too long",
    raw: "400 Bad Request: prompt is too long",
  });
});

test("error_detail decides the notice kind; text classification is the fallback", () => {
  const cases = [
    ["invalid_api_key", "auth"],
    ["rate_limited", "rate_limit"],
    ["server_error", "server"],
    ["connection_lost", "connection"],
    ["unreachable", "connection"],
    ["timeout", "timeout"],
    ["context_limit", "context_limit"],
    ["bad_request", "bad_request"],
    ["not_found", "bad_request"],
    ["something_new", "unknown"],
  ];
  for (const [kind, expected] of cases) {
    // The raw text alone would read as a rate limit; the detail wins.
    assert.equal(classifyTurnError("429 Too Many Requests", { kind }).kind, expected, kind);
  }
  assert.equal(classifyTurnError("429 Too Many Requests").kind, "rate_limit");
  assert.equal(classifyTurnError("429 Too Many Requests", null).kind, "rate_limit");
});

test("a turn stopped before any output reopens as stopped; a backend restart says so", () => {
  for (const [cancel_reason, interrupted] of [[undefined, false], ["shutdown", true], ["user", false]]) {
    const item = reply([
      user("u1", "say something"),
      { id: "assistant-stopped-r1", role: "assistant", stop_reason: "cancelled", ...(cancel_reason ? { cancel_reason } : {}) },
    ]);
    assert.equal(item.role, "assistant");
    assert.ok(isStoppedReply(item.rounds));
    assert.equal(isInterruptedByShutdown(item.rounds), interrupted, String(cancel_reason));
  }
});

test("a stop marker is never replayed to the backend as an empty reply", () => {
  assert.equal(isKBrainStoppedMarkerId("assistant-stopped-r1"), true);
  assert.equal(isKBrainStoppedMarkerId("assistant-error-r1"), false);
  const messages = convertMessages([
    user("u1", "say something"),
    { id: "assistant-stopped-r1", role: "assistant", stop_reason: "cancelled" },
    user("u2", "again"),
  ]);
  assert.deepEqual(
    contextToKBrainMessages({ messages }).map((message) => message.role),
    ["user", "user"],
  );
});

test("retries_remaining gives the exact retry count; max is the fallback", () => {
  // Three attempts allow two retries.
  assert.equal(retryMax(1, 3), 2);
  assert.equal(retryMax(1, 3, 2), 2);
  // The backend stops early: the second of five attempts with one retry left.
  assert.equal(retryMax(2, 5, 1), 2);
  assert.equal(retryMax(1, 5, 0), 1);
  assert.equal(retryMax(2), 2);
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

const turnParams = (fetch, conversationId) => ({
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
});

test("a live failure keeps the reply it streamed and its classification", async () => {
  const message = await runKBrainTurn(
    turnParams(
      sseFixture([
        ["assistant.text.delta", { text: "Here is the first part" }],
        [
          "assistant.message.created",
          {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "Here is the first part" }],
            stop_reason: "error",
            error: "unexpected EOF",
            error_detail: { kind: "connection_lost" },
          },
        ],
        ["run.failed", { state: "failed", error: "unexpected EOF", error_detail: { kind: "connection_lost" } }],
      ]),
      "outcome-drop",
    ),
  );
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "unexpected EOF");
  assert.deepEqual(message.errorDetail, { kind: "connection_lost" });
  assert.deepEqual(message.content, [{ type: "text", text: "Here is the first part" }]);
});

test("a run cancelled by a backend restart is marked interrupted", async () => {
  const message = await runKBrainTurn(
    turnParams(sseFixture([["run.cancelled", { state: "cancelled", cancel_reason: "shutdown" }]]), "outcome-shutdown"),
  );
  assert.equal(message.stopReason, "aborted");
  assert.equal(message.cancelReason, "shutdown");
});
