import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// MCP form elicitations (Stack-Cairn/K-brain#174) through the production conversation
// turn: the form opens from elicitation.requested, answers go to
// /v1/sessions/{id}/elicitations/{eid}, a 400 keeps it open with K-brain's field errors,
// and only K-brain's redacted copy of an answer is ever kept.

const SECRET = "tok-very-secret-123";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const request = {
  elicitation_id: "el-1", tool_call_id: "call-1", run_id: "run-1",
  deadline_at: Date.now() + 300_000, server: "deploy", tool: "ship", message: "Confirm the release",
  fields: [
    { name: "name", type: "string", title: "Release name", required: true, min_length: 2 },
    { name: "token", type: "string", title: "API token", sensitive: true, required: true },
    { name: "env", type: "string", options: [{ value: "prod", label: "Production" }, { value: "stage" }] },
  ],
  requested_schema: { type: "object" },
};

function loadProduction() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  const projectedResults = [];
  const upserts = [];
  const ui = {
    updateLiveRound: (rounds, number, apply) => rounds.map((round) => round.round === number ? apply(round) : round),
    collapseThinking: (round) => round,
    upsertToolCallToRound: (round, call) => { upserts.push(call); return round; },
    attachToolResultToRound: (round, _call, result) => { projectedResults.push(result); return round; },
    appendTextDeltaToRound: (round) => round,
    appendThinkingDeltaToRound: (round) => round,
    upsertHostedSearchToRound: (round) => round,
  };
  const production = createTsModuleLoader({ mocks: {
    "../../../lib/chat/messages/uiMessages": ui,
    "../../../lib/chat/conversation/conversationState": { appendMessagesToConversation: (state, messages) => ({ ...state, messages }) },
    "../../../lib/chat/history/chatHistory": { buildConversationStateFromWindow: (window) => window },
    "../../../lib/kbrain/history": { getKBrainHistoryWindow: async () => ({ messages: [] }) },
    "../../../lib/kbrain/runtimeConnection": { getConfiguredKBrainConnection: () => ({ baseUrl: "http://elicit.test" }) },
    "./runtimeConnection": {
      getConfiguredKBrainConnection: () => ({ baseUrl: "http://elicit.test" }),
      resolveKBrainClientOptions: (options) => ({ ...options, baseUrl: options.baseUrl ?? "http://elicit.test" }),
      getKBrainRuntimeConnection: () => undefined,
    },
  } });
  return {
    store,
    projectedResults,
    upserts,
    elicitations: production.loadModule("src/lib/tools/mcpElicitations.ts"),
    turn: production.loadModule("src/pages/chat/turns/runKBrainConversationTurn.ts"),
  };
}

async function runTurn({ mode, capability = true }) {
  const { store, projectedResults, upserts, elicitations, turn } = loadProduction();
  const posted = [];
  const events = [];
  const outcomes = [];
  let runOptions;
  let controller;
  let seq = 1;
  const emit = (type, payload) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
    version: "kbrain.agent.v1", seq: ++seq, conversation_id: "session-1", run_id: "run-1", type, payload,
  })}\n\n`));
  const resolution = (action, reason, content) => ({
    elicitation_id: "el-1", tool_call_id: "call-1", run_id: "run-1", server: "deploy", tool: "ship",
    message: request.message, action, reason,
    ...(content ? { content, redacted: ["token"] } : {}),
  });
  const finish = (record) => {
    // A reconnect replays both events; the card must not reopen or duplicate.
    emit("elicitation.resolved", record);
    emit("elicitation.requested", request);
    emit("elicitation.resolved", record);
    emit("tool.result", { tool_result: { id: "call-1", name: "mcp__deploy__ship", output: "done", elicitations: [{ ...record, fields: request.fields }] } });
    emit("run.completed", {});
    controller.close();
  };
  let answered = false;
  const unsubscribe = elicitations.subscribeMcpElicitations(() => {
    if (answered || !elicitations.hasPendingMcpElicitationRequest("call-1", "el-1")) return;
    answered = true;
    queueMicrotask(async () => {
      // Another conversation cannot answer this form.
      outcomes.push(await elicitations.answerMcpElicitation("call-1", "el-1", "decline", undefined, { conversationId: "other" }));
      if (mode === "accept") {
        outcomes.push(await elicitations.answerMcpElicitation("call-1", "el-1", "accept", { name: "x", token: SECRET }, { conversationId: "ui-conversation" }));
        // Still pending after the refusal: answer again.
        assert.equal(elicitations.hasPendingMcpElicitationRequest("call-1", "el-1"), true);
        outcomes.push(await elicitations.answerMcpElicitation("call-1", "el-1", "accept", { name: "Ada", token: SECRET, env: "prod" }, { conversationId: "ui-conversation" }));
      } else if (mode === "decline" || mode === "cancel") {
        outcomes.push(await elicitations.answerMcpElicitation("call-1", "el-1", mode, { name: "ignored" }, { conversationId: "ui-conversation" }));
      } else if (mode === "timeout") {
        finish(resolution("cancel", "timeout"));
      }
    });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/health") return response({ status: "ok", version: "kbrain.agent.v1", capabilities: capability ? { mcp_elicitation: 1 } : {} });
    if (path === "/v1/sessions") return response({ id: "session-1" });
    if (path.endsWith("/runs")) {
      runOptions = JSON.parse(init.body).options ?? {};
      return response({ version: "kbrain.agent.v1", conversation_id: "session-1", run_id: "run-1", accepted_seq: 1 }, 202);
    }
    if (path.endsWith("/events")) return new Response(new ReadableStream({ start(value) {
      controller = value;
      emit("tool.call", { tool_call: { id: "call-1", name: "mcp__deploy__ship", arguments: { release: "v2", __mcpElicitationPending: [{ elicitation_id: "fake" }] } } });
      if (capability) {
        emit("elicitation.requested", request);
        emit("elicitation.requested", request);
      } else {
        // Without the option K-brain declines on its own and records it on the call.
        emit("tool.result", { tool_result: { id: "call-1", name: "mcp__deploy__ship", output: "declined", elicitations: [{ server: "deploy", message: request.message, fields: request.fields, action: "decline", reason: "no_client" }] } });
        emit("run.completed", {});
        controller.close();
      }
    } }), { headers: { "content-type": "text/event-stream" } });
    if (path === "/v1/sessions/session-1/elicitations/el-1") {
      const body = JSON.parse(init.body);
      posted.push(body);
      if (body.action === "accept" && body.content.name.length < 2) {
        return response({ version: "kbrain.agent.v1", error: "invalid content: name: too short", field_errors: { name: "must be at least 2 characters" } }, 400);
      }
      const content = body.action === "accept" ? { name: body.content.name, env: body.content.env } : undefined;
      queueMicrotask(() => finish(resolution(body.action, "user", content)));
      return response({ ok: true });
    }
    if (path.endsWith("/cancel")) return response({ ok: true });
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    await turn.runKBrainConversationTurn({
      conversationId: "ui-conversation", sessionId: "host-1", trajectoryMessageId: "turn-1",
      runtime: {}, selectedModel: {}, providerId: "fixture", model: "fixture",
      cancellation: { userStop: new AbortController() },
      buildPreparedContext: () => ({ messages: [{ role: "user", content: "ship it" }] }),
      getNextConversationState: () => ({ messages: [] }),
      batchLiveRoundsUpdate: (apply) => { apply([]); },
      gatewayBridgeEvents: { queueEvent: (event) => events.push(event), queueToken() {}, queueToolStatus() {}, emitError: (error) => assert.fail(error) },
      hookLifecycle: { startAgent() {}, startTurn() {}, ensureMessageEnded() {}, endTurn() {}, endAgent() {} },
      updateToolStatus() {}, applyConversationState() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
      persistConversationWithHistorySync: async () => {},
    });
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
  return { store, projectedResults, upserts, elicitations, posted, events, outcomes, runOptions };
}

function callEvents(events) {
  return events.filter((event) => event.type === "tool_call" && event.id === "call-1");
}

function assertNoSecret(label, value) {
  assert.equal(JSON.stringify(value ?? null).includes(SECRET), false, `${label} holds the sensitive value`);
}

for (const mode of ["accept", "decline", "cancel", "timeout"]) {
  test(`K-brain MCP elicitation through the production turn: ${mode}`, async () => {
    const result = await runTurn({ mode });
    assert.equal(result.runOptions.mcp_elicitation, true);
    assert.equal(result.outcomes[0].ok, false, "another conversation answered the form");
    assert.equal(result.elicitations.hasPendingMcpElicitationRequest("call-1", "el-1"), false);

    // The WebUI saw the form open, exactly once, then closed with one summary.
    const calls = callEvents(result.events);
    const opened = calls.filter((event) => Array.isArray(event.arguments.__mcpElicitationPending));
    assert.ok(opened.length >= 1);
    for (const event of opened) {
      assert.equal(event.arguments.__mcpElicitationPending.length, 1);
      assert.equal(event.arguments.__mcpElicitationPending[0].elicitationId, "el-1");
      assert.equal(event.arguments.__mcpElicitationPending[0].server, "deploy");
    }
    // The model's own copy of the synthetic key never reaches a card.
    assert.equal(calls.some((event) => JSON.stringify(event.arguments).includes("fake")), false);
    assert.equal(result.upserts.some((call) => JSON.stringify(call.arguments).includes("fake")), false);
    const last = calls.at(-1).arguments;
    assert.equal(last.__mcpElicitationPending, undefined);
    assert.equal(last.__mcpElicitations.length, 1);

    const expectedAction = mode === "timeout" ? "cancel" : mode;
    const expectedReason = mode === "timeout" ? "timeout" : "user";
    const record = last.__mcpElicitations[0];
    assert.equal(record.action, expectedAction);
    assert.equal(record.reason, expectedReason);

    // The tool result carries the recorded elicitations for the summary and the WebUI.
    const details = result.projectedResults.at(-1).details;
    assert.equal(details.kbrainElicitations.length, 1);
    assert.equal(details.kbrainElicitations[0].action, expectedAction);
    const bridgedResult = result.events.find((event) => event.type === "tool_result");
    assert.equal(bridgedResult.details.kbrainElicitations.length, 1);

    if (mode === "accept") {
      assert.equal(result.outcomes[1].ok, false);
      assert.deepEqual(result.outcomes[1].fieldErrors, { name: "must be at least 2 characters" });
      assert.equal(result.outcomes[1].message, "invalid content: name: too short");
      assert.equal(result.outcomes[2].ok, true);
      assert.equal(result.posted.length, 2);
      assert.deepEqual(result.posted[1], {
        conversation_id: "session-1", run_id: "run-1", elicitation_id: "el-1", action: "accept",
        content: { name: "Ada", token: SECRET, env: "prod" },
      });
      assert.deepEqual(record.content, { name: "Ada", env: "prod" });
      assert.deepEqual(record.redacted, ["token"]);
    } else if (mode === "timeout") {
      assert.equal(result.posted.length, 0);
    } else {
      assert.equal(result.outcomes[1].ok, true);
      assert.deepEqual(result.posted, [{ conversation_id: "session-1", run_id: "run-1", elicitation_id: "el-1", action: mode }]);
    }

    // The typed secret went to K-brain only: never to storage, the WebUI or the transcript.
    assertNoSecret("events", result.events);
    assertNoSecret("transcript", result.upserts);
    assertNoSecret("tool results", result.projectedResults);
    assertNoSecret("storage", [...result.store.entries()]);
  });
}

test("K-brain MCP elicitation: no capability, no option, auto-decline shown as a note", async () => {
  const result = await runTurn({ mode: "none", capability: false });
  assert.equal("mcp_elicitation" in result.runOptions, false);
  assert.equal(result.posted.length, 0);
  const records = result.projectedResults.at(-1).details.kbrainElicitations;
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, "no_client");
  assert.equal(callEvents(result.events).some((event) => event.arguments.__mcpElicitationPending), false);
});

test("a failed health read does not ask K-brain for elicitations", async () => {
  const loader = createTsModuleLoader();
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
  let reads = 0;
  const client = createKBrainClient({
    baseUrl: "http://kbrain.test",
    fetch: async () => {
      reads += 1;
      return reads === 1 ? new Response("down", { status: 503 }) : response({ status: "ok", version: "kbrain.agent.v1", capabilities: { mcp_elicitation: 1 } });
    },
  });
  assert.equal(await client.supportsMcpElicitation(), false);
  // A failed read is not cached: the next run reads again.
  assert.equal(await client.supportsMcpElicitation(), true);
});

test("history reload carries recorded elicitations and drops sensitive values", () => {
  const loader = createTsModuleLoader();
  const history = loader.loadModule("src/lib/kbrain/history.ts");
  const turnModule = loader.loadModule("src/lib/kbrain/turn.ts");
  const shared = loader.loadModule("@liveagent/ui/lib/chat/mcpElicitation.ts");
  const messages = history.convertMessages([
    {
      role: "assistant",
      tool_calls: [{
        id: "call-1", name: "mcp__deploy__ship", arguments: { release: "v2" },
        elicitations: [
          { elicitation_id: "el-1", server: "deploy", message: "Confirm", fields: request.fields, action: "accept", reason: "user", content: { name: "Ada", token: SECRET }, redacted: ["token"] },
          { server: "deploy", message: "Again?", fields: [], action: "decline", reason: "unattended" },
        ],
      }],
    },
    { role: "tool", tool_call_id: "call-1", name: "mcp__deploy__ship", content: [{ type: "text", text: "shipped" }] },
  ]);
  const [assistant, result] = messages;
  const entries = shared.collectMcpElicitationEntries({ args: assistant.content.find((part) => part.id === "call-1").arguments, details: result.details });
  assert.deepEqual(entries.map((entry) => entry.kind), ["record", "record"]);
  assert.equal(entries[0].record.action, "accept");
  assert.equal(entries[0].record.content.name, "Ada");
  assert.equal("token" in entries[0].record.content, false);
  assert.deepEqual(entries[0].record.redacted, ["token"]);
  assert.equal(entries[1].record.reason, "unattended");
  assert.equal(shared.MCP_ELICITATION_AUTO_DECLINE_REASONS.has(shared.mcpElicitationOutcome(entries[1].record)), true);

  // A transcript sent back to K-brain carries the model's arguments only.
  const live = { ...assistant, content: assistant.content.map((part) => part.type === "toolCall" ? { ...part, arguments: { ...part.arguments, __mcpElicitations: [{ elicitation_id: "el-1" }] } } : part) };
  const [back] = turnModule.contextToKBrainMessages({ messages: [live] });
  assert.deepEqual(back.tool_calls[0].arguments, { release: "v2" });
});
