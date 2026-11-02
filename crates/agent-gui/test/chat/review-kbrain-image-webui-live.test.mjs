import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Review round 5 (playbook A: the second consumer of a contract).
// K-brain Image results now render through `display_image` details built in
// turn.ts toolResult(). The desktop keeps them, but runKBrainConversationTurn
// projectToolResult() mirrors the result to WebUI as a `tool_result` event with
// only content/isError, although the WebUI reducer reads `details`. A WebUI
// viewer of a live K-brain turn therefore gets no display_image payload, so
// the Image row renders nothing until a history reload rebuilds it.
// Real K-brain turn over a real HTTP/SSE fixture -> real WebUI reducer/rows ->
// the shared getNativeDisplayImagePayload render gate. Plain-value asserts only.

const loader = createTsModuleLoader();
const { runAgentConversationTurn } = loader.loadModule("src/pages/chat/turns/runAgentConversationTurn.ts");
const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

const webLoader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../../../agent-gateway/web", import.meta.url)),
});
const { createTurn, applyEventToTurn } = webLoader.loadModule("src/lib/chat/transcript/turnReducer.ts");
const { buildTurnRows } = webLoader.loadModule("src/lib/chat/transcript/rows.ts");
const { getNativeDisplayImagePayload } = webLoader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ToolImages.tsx",
);

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function runImageTurn(t) {
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
      event("tool.call", { tool_call: { id: "img-1", name: "Image", arguments: { path: "chart.png" } } });
      event("tool.result", {
        tool_result: {
          id: "img-1",
          name: "Image",
          output: "Display image: chart.png",
          content: [{ type: "image", image_url: `data:image/png;base64,${PNG_BASE64}`, mime_type: "image/png" }],
        },
      });
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
  const context = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "show it" }], timestamp: 1 }] };
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

function findDetailsKind(value, toolCallId) {
  // Walk the desktop live rounds for the toolResult of this call.
  const seen = new Set();
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current.role === "toolResult" && current.toolCallId === toolCallId) return current.details?.kind ?? "";
    for (const child of Object.values(current)) stack.push(child);
  }
  return "missing";
}

test("K-brain Image: desktop live rounds carry display_image details (control)", async (t) => {
  const { rounds, errors } = await runImageTurn(t);
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  assert.equal(findDetailsKind(rounds, "img-1"), "display_image");
});

test("K-brain Image: the WebUI mirror of a live turn can render the image", async (t) => {
  const { gatewayEvents, errors } = await runImageTurn(t);
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  let turn = createTurn({ key: "req:image", runId: "run", phase: "streaming" });
  for (const value of gatewayEvents) {
    if (value.type === "tool_call" || value.type === "tool_result") turn = applyEventToTurn(turn, value);
  }
  const assistant = buildTurnRows(turn).find((row) => row.kind === "assistant");
  const block = assistant?.rounds.flatMap((round) => round.blocks).find((item) => item.kind === "tool");
  assert.equal(Boolean(block?.item?.toolResult), true, "WebUI attached the tool result");
  assert.equal(
    block.item.toolResult.details?.kind ?? "none",
    "display_image",
    "the mirrored tool_result carries no display_image details",
  );
  assert.equal(Boolean(getNativeDisplayImagePayload(block.item)), true, "WebUI render gate finds the image");
});

test("control: the same mirrored event plus the desktop's details renders in WebUI", async (t) => {
  const { gatewayEvents, rounds, errors } = await runImageTurn(t);
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  let desktopDetails;
  const stack = [rounds];
  const seen = new Set();
  while (stack.length && !desktopDetails) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current.role === "toolResult" && current.toolCallId === "img-1") desktopDetails = current.details;
    for (const child of Object.values(current)) stack.push(child);
  }
  let turn = createTurn({ key: "req:image", runId: "run", phase: "streaming" });
  for (const value of gatewayEvents) {
    if (value.type === "tool_call") turn = applyEventToTurn(turn, value);
    if (value.type === "tool_result") turn = applyEventToTurn(turn, { ...value, details: desktopDetails });
  }
  const assistant = buildTurnRows(turn).find((row) => row.kind === "assistant");
  const block = assistant?.rounds.flatMap((round) => round.blocks).find((item) => item.kind === "tool");
  assert.equal(Boolean(getNativeDisplayImagePayload(block.item)), true);
});
