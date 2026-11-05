import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Bridge mode (WebUI through the desktop): K-brain running-output snapshots and
// hosted search updates used to stay on the desktop live round only. The desktop
// now mirrors them as `tool_output` (full latest snapshot, replace semantics) and
// `hosted_search` gateway events. Real K-brain turn over an HTTP/SSE fixture ->
// mirrored events -> the real WebUI reducer and row builder.

const loader = createTsModuleLoader();
const { runAgentConversationTurn } = loader.loadModule("src/pages/chat/turns/runAgentConversationTurn.ts");
const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

const webLoader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../../../agent-gateway/web", import.meta.url)),
});
const { createTurn, applyEventToTurn } = webLoader.loadModule("src/lib/chat/transcript/turnReducer.ts");
const { buildTurnRows } = webLoader.loadModule("src/lib/chat/transcript/rows.ts");

async function runLiveTurn(t) {
  const conversationId = `conv-${Math.random().toString(36).slice(2)}`;
  let stream;
  let sequence = 0;
  const event = (type, payload) => stream.write(`data: ${JSON.stringify({
    version: "kbrain.agent.v1", seq: ++sequence, conversation_id: "session", run_id: "run", type,
    created_at: new Date().toISOString(), payload,
  })}\n\n`);
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const json = (value, code = 200) => {
      response.writeHead(code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/sessions") return json({ id: "session" }, 201);
    if (request.url === "/v1/sessions/session/runs") return json({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }, 202);
    if (request.url === "/v1/sessions/session" || request.url.startsWith("/v1/sessions/session/history")) {
      const session = { id: "session", revision: "r", title: "t", model: { provider: "fixture", model: "model" }, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:01Z", message_count: 0, last_seq: sequence, messages: [] };
      return json(request.url.includes("/history") ? { session, revision: "r", oldest_offset: 0, has_more_before: false, total_message_count: 0, active_messages: [] } : session);
    }
    if (request.url.startsWith("/v1/sessions/session/events")) {
      stream = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      sequence = Number(new URL(request.url, "http://localhost").searchParams.get("after_seq") ?? 0);
      event("assistant.sources", {
        type: "hostedSearch", id: "search-1", provider: "fixture", status: "searching", queries: ["kbrain"], sources: [],
      });
      event("assistant.sources", {
        type: "hostedSearch", id: "search-1", provider: "fixture", status: "completed", queries: ["kbrain"],
        sources: [{ url: "https://example.com/a", title: "A" }],
      });
      event("tool.call", { tool_call: { id: "bash-1", name: "Bash", arguments: { command: "make" } } });
      event("tool.status", { tool_call_id: "unknown", status: "running", message: "stray" });
      event("tool.status", { tool_call_id: "bash-1", status: "running", message: "step 1\n" });
      event("tool.status", { tool_call_id: "bash-1", status: "running", message: "step 1\nstep 2\n" });
      event("tool.result", { tool_result: { id: "bash-1", name: "Bash", output: "step 1\nstep 2\ndone" } });
      event("tool.status", { tool_call_id: "bash-1", status: "running", message: "late" });
      event("assistant.message.created", { role: "assistant", content: [{ type: "text", text: "done" }] });
      event("run.completed", { state: "completed" });
      stream.end();
      return;
    }
    json({ error: `Unexpected path ${request.url}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
  };
  setKBrainRuntimeConnection({ baseUrl: origin, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  t.after(() => {
    clearKBrainRuntimeConnection();
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    server.closeAllConnections();
    server.close();
  });
  const context = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "build it" }], timestamp: 1 }] };
  let state = createConversationStateFromContext(context);
  let rounds = [];
  const gatewayEvents = [];
  const errors = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  t.after(() => clearTimeout(timeout));
  await runAgentConversationTurn({
    providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
    runtime: { backend: "kbrain", baseUrl: "https://must-not-be-called.invalid", apiKey: "unused" }, sessionId: "frontend-session", conversationId,
    trajectoryMessageId: "message", conversationCwd: "/workspace", effectiveWorkdir: "/workspace", createdAt: 1, fallbackTitle: "t", titlePromise: null,
    transcriptStore: {}, cancellation: { userStop: controller },
    gatewayBridgeEvents: { queueToken() {}, queueEvent(value) { gatewayEvents.push(value); }, queueToolStatus() {}, emitError(message) { errors.push(String(message)); } },
    hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])),
    buildPreparedContext: () => context, getNextConversationState: () => state,
    applyConversationState: (value) => { state = value; },
    batchLiveRoundsUpdate: (update) => { rounds = update(rounds); },
    updateToolStatus() {}, updateGatewayBridgeToolStatus() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
    persistConversationWithHistorySync: async () => true,
  });
  return { gatewayEvents, errors, rounds };
}


test("bridge mirrors live tool output snapshots for known running calls only", async (t) => {
  const { gatewayEvents, errors } = await runLiveTurn(t);
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  const outputs = gatewayEvents.filter((value) => value.type === "tool_output");
  assert.deepEqual(
    outputs.map(({ id, output, round }) => ({ id, output, round })),
    [
      { id: "bash-1", output: "step 1\n", round: 1 },
      { id: "bash-1", output: "step 1\nstep 2\n", round: 1 },
    ],
  );
  const call = gatewayEvents.find((value) => value.type === "tool_call" && value.id === "bash-1");
  assert.equal(outputs[0].conversation_id, call.conversation_id);
  // Ordered after the call and before the result.
  const order = gatewayEvents.map((value) => `${value.type}:${value.id ?? ""}`);
  assert.ok(order.indexOf("tool_call:bash-1") < order.indexOf("tool_output:bash-1"));
  assert.ok(order.lastIndexOf("tool_output:bash-1") < order.indexOf("tool_result:bash-1"));
});

test("bridge mirrors hosted search updates in the WebUI event shape", async (t) => {
  const { gatewayEvents } = await runLiveTurn(t);
  const searches = gatewayEvents.filter((value) => value.type === "hosted_search");
  assert.equal(searches.length, 2);
  assert.deepEqual(
    searches.map(({ id, provider, status, queries, round }) => ({ id, provider, status, queries, round })),
    [
      { id: "search-1", provider: "fixture", status: "searching", queries: ["kbrain"], round: 1 },
      { id: "search-1", provider: "fixture", status: "completed", queries: ["kbrain"], round: 1 },
    ],
  );
  assert.equal(searches[1].sources[0].url, "https://example.com/a");
  assert.equal(typeof searches[0].conversation_id, "string");
});

function toolBlock(turn) {
  const assistant = buildTurnRows(turn).find((row) => row.kind === "assistant");
  return assistant?.rounds.flatMap((round) => round.blocks).find((item) => item.kind === "tool");
}

test("WebUI shows the mirrored live output on the running card and drops it with the result", async (t) => {
  const { gatewayEvents } = await runLiveTurn(t);
  let turn = createTurn({ key: "req:live", runId: "run", phase: "streaming" });
  let liveSeen = "";
  for (const value of gatewayEvents) {
    const next = applyEventToTurn(turn, value);
    turn = next;
    if (value.type === "tool_output") liveSeen = toolBlock(turn)?.item?.liveOutput ?? "";
  }
  // Replace, not append.
  assert.equal(liveSeen, "step 1\nstep 2\n");
  const settled = toolBlock(turn);
  assert.equal(Boolean(settled?.item?.toolResult), true);
  assert.equal(settled.item.liveOutput, undefined);
  const search = buildTurnRows(turn)
    .find((row) => row.kind === "assistant")
    .rounds.flatMap((round) => round.blocks)
    .find((item) => item.kind === "hostedSearch" || item.kind === "hostedSearchGroup");
  assert.ok(search, "WebUI renders the mirrored hosted search");
});
