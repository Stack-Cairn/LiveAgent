import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2b wiring through the real K-brain turn: the approval carries the edit it approves,
// and a prompt K-brain puts back after refusing to store a rule (400) says why, on the
// desktop bar and in the call synced to WebUI. Assertions compare strings and booleans.

const loader = createTsModuleLoader();
const { runAgentConversationTurn } = loader.loadModule("src/pages/chat/turns/runAgentConversationTurn.ts");
const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

async function runTurn(t, { answers, events, onPermissionPost, answerFilter = () => true }) {
  const conversationId = `conv-${Math.random().toString(36).slice(2)}`;
  const posts = [];
  const urls = [];
  let stream;
  let sequence = 0;
  const event = (type, payload) => stream.write(`data: ${JSON.stringify({
    version: "kbrain.agent.v1", seq: ++sequence, conversation_id: "session", run_id: "run", type,
    created_at: new Date().toISOString(), payload,
  })}\n\n`);
  const finish = () => {
    event("assistant.message.created", { role: "assistant", content: [{ type: "text", text: "done" }] });
    event("run.completed", { state: "completed" });
    stream.end();
  };
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    urls.push(`${request.method} ${request.url}`);
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
      events(event);
      return;
    }
    if (request.url.startsWith("/v1/sessions/session/permissions/")) {
      const decision = JSON.parse(body).decision;
      posts.push(decision);
      const handled = onPermissionPost?.(decision, posts.length, json, { event, finish });
      if (handled) return;
      json({ ok: true });
      event("permission.resolved", { permission_id: decision.permission_id });
      finish();
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
  const listed = [];
  const answered = new Set();
  const dispose = approval.subscribeToolApprovalsForConversation(conversationId, () => queueMicrotask(() => {
    for (const pending of approval.listPendingToolApprovalsForConversation(conversationId)) {
      const key = `${pending.toolCallId}#${listed.length}`;
      if (answered.has(key) || !answerFilter(pending)) continue;
      answered.add(key);
      listed.push(pending);
      const [decision, options] = answers[Math.min(listed.length - 1, answers.length - 1)];
      approval.answerToolApproval(pending.toolCallId, decision, { conversationId, ...options });
    }
  }));
  t.after(dispose);
  const context = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }] };
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
  return { posts, listed, gatewayEvents, errors, urls, finish, event };
}

const allowAlwaysOptions = [
  { id: "allow_once", kind: "allow_once" },
  { id: "reject", kind: "reject_once" },
  { id: "allow_always", label: "Allow and remember", kind: "allow_always" },
];

test("a prompt put back after a refused rule carries the refusal to the bar and WebUI", async (t) => {
  const refusal = "project rules are not available on this backend";
  const { listed, gatewayEvents, errors } = await runTurn(t, {
    answers: [["approve_session", { scope: "project" }], ["approve"]],
    events: (event) => {
      event("tool.call", { tool_call: { id: "call", name: "Bash", arguments: { command: "npm test" } } });
      event("permission.requested", {
        permission_id: "permission", tool: "Bash", command: "npm test", rule: "npm test", shell: "bash", tool_call_id: "call",
        options: allowAlwaysOptions, suggestion: { rules: ["Bash(npm test:*)"], default_scope: "session" },
      });
    },
    onPermissionPost: (decision, count, json) => {
      if (count === 1) {
        json({ error: refusal }, 400);
        return true;
      }
      return false;
    },
  });
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  assert.equal(listed[0]?.notice ?? "", "", "the first prompt has no notice");
  assert.equal(listed[1]?.notice ?? "", refusal, "the prompt asked again says why");
  const synced = gatewayEvents.some((value) => value.type === "tool_call" && value.id === "call" && value.arguments?.__toolApprovalNotice === refusal);
  assert.equal(synced, true, "WebUI gets the refusal on the pending call");
});

test("an Edit approval carries its diff preview from the tool call", async (t) => {
  const { listed, errors } = await runTurn(t, {
    answers: [["approve"]],
    events: (event) => {
      event("tool.call", { tool_call: { id: "edit", name: "Edit", arguments: { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } } });
      event("permission.requested", {
        permission_id: "permission", tool: "Edit", command: "src/a.ts", rule: "Edit(src/a.ts)", tool_call_id: "edit",
        options: allowAlwaysOptions,
      });
    },
  });
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  assert.equal(JSON.stringify(listed[0]?.preview), JSON.stringify({ path: "src/a.ts", before: "const a = 1;", after: "const a = 2;", truncated: false }));
});

test("WebUI rebuilds the Edit preview from the synced call and marks a cut one", async (t) => {
  const { pendingToolApprovalFromToolCall } = loader.loadModule("../agent-ui/src/lib/chat/toolApprovalArgs.ts");
  const long = "x".repeat(200_000);
  const { gatewayEvents, errors } = await runTurn(t, {
    answers: [["approve"]],
    events: (event) => {
      event("tool.call", { tool_call: { id: "edit", name: "Edit", arguments: { path: "src/big.ts", old_string: "a", new_string: long } } });
      event("permission.requested", {
        permission_id: "permission", tool: "Edit", command: "src/big.ts", rule: "Edit(src/big.ts)", tool_call_id: "edit",
        options: allowAlwaysOptions,
      });
    },
  });
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  const synced = gatewayEvents.find((value) => value.type === "tool_call" && value.id === "edit" && value.arguments?.__toolApprovalPending === true);
  assert.equal(Boolean(synced), true, "the pending call reached WebUI");
  const remote = pendingToolApprovalFromToolCall({ type: "toolCall", id: "edit", name: "Edit", arguments: synced.arguments });
  assert.equal(remote?.preview?.path, "src/big.ts");
  assert.equal(remote?.preview?.before, "a");
  assert.equal(remote?.preview?.truncated, true, "the cut preview is marked");
  assert.equal((remote?.preview?.after.length ?? 0) < long.length, true, "WebUI does not get the whole 200k text");
});

// The WebUI reads a mirrored tool result from `content`/`isError` in the call's round;
// a result sent as `result` arrived empty and never marked as failed.
test("a denied call's result reaches WebUI with its content, error flag and the call's round", async (t) => {
  const { gatewayEvents, errors } = await runTurn(t, {
    answers: [["deny"]],
    events: (event) => {
      event("tool.call", { tool_call: { id: "call", name: "Bash", arguments: { command: "npm test" } } });
      event("permission.requested", {
        permission_id: "permission", tool: "Bash", command: "npm test", rule: "npm test", tool_call_id: "call",
        options: allowAlwaysOptions,
      });
    },
    onPermissionPost: (decision, count, json, { event, finish }) => {
      json({ ok: true });
      event("permission.resolved", { permission_id: decision.permission_id });
      event("tool.result", { tool_result: { id: "call", name: "Bash", output: "Permission denied: the user rejected this action", failed: true } });
      finish();
      return true;
    },
  });
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  const call = gatewayEvents.find((value) => value.type === "tool_call" && value.id === "call");
  const result = gatewayEvents.find((value) => value.type === "tool_result" && value.id === "call");
  assert.equal(Boolean(result), true, "the result is mirrored");
  assert.equal(JSON.stringify(result.content ?? null).includes("Permission denied"), true, `content: ${JSON.stringify(result)}`);
  assert.equal(result.isError, true);
  assert.equal(result.round, call.round);
  assert.equal("result" in result, false, "no unread result field");
});
