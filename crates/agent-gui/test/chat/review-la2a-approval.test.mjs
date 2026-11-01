import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2a independent review: regressions driven through the real K-brain turn
// (runAgentConversationTurn -> runKBrainTurn -> toolApproval -> gatewayToolPreview)
// against an http.createServer K-brain fixture. Assertions compare strings,
// numbers and booleans only.

const loader = createTsModuleLoader();
const { runAgentConversationTurn } = loader.loadModule("src/pages/chat/turns/runAgentConversationTurn.ts");
const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
const args = loader.loadModule("../agent-ui/src/lib/chat/toolApprovalArgs.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

// Same limit gatewayToolPreview applies to __toolApprovalSummary ("不能不设上限").
const SYNCED_APPROVAL_TEXT_MAX = 2000;

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

// K-brain permissions/suggest.go: an interpreter segment (python/node/bash -c ...) is
// suggested as an exact rule holding the whole segment, so a long inline script makes a
// rule as long as the command itself.
test("rules synced to WebUI are bounded like the approval summary", async (t) => {
  const script = "print(1);".repeat(1200); // 10800 chars
  const command = `python -c '${script}'`;
  const rule = `Bash(${command})`;
  const { gatewayEvents } = await runTurn(t, {
    answers: [["approve"]],
    events: (event) => {
      event("tool.call", { tool_call: { id: "call", name: "Bash", arguments: { command } } });
      event("permission.requested", {
        permission_id: "permission", tool: "Bash", command, rule: "python", shell: "bash", tool_call_id: "call",
        options: allowAlwaysOptions, suggestion: { rules: [rule], default_scope: "project" },
      });
    },
  });
  const marked = gatewayEvents.find((value) => value.type === "tool_call" && value.arguments[args.TOOL_APPROVAL_PENDING_ARG] === true);
  assert.equal(Boolean(marked), true, "a pending Gateway copy was pushed");
  const summary = String(marked.arguments[args.TOOL_APPROVAL_SUMMARY_ARG]);
  const sessionScope = String(marked.arguments[args.TOOL_APPROVAL_SESSION_SCOPE_ARG] ?? "");
  const rulesChars = JSON.stringify(marked.arguments[args.TOOL_APPROVAL_REMEMBER_RULES_ARG] ?? []).length;
  assert.equal(summary.length <= SYNCED_APPROVAL_TEXT_MAX, true, `summary is clamped (${summary.length})`);
  assert.equal(sessionScope.length <= SYNCED_APPROVAL_TEXT_MAX, true, `__toolApprovalSessionScope is ${sessionScope.length} chars`);
  assert.equal(rulesChars <= SYNCED_APPROVAL_TEXT_MAX, true, `__toolApprovalRememberRules is ${rulesChars} chars`);
});

// K-brain server.go permission(): when storing the suggestion fails (a refused scope such
// as "project rules are not available on this backend", or an unreadable rules file) it
// answers 400 and puts the prompt back: "A refused scope or a failed write leaves the
// prompt waiting." The run is still alive and the prompt can be answered again.
test("a refused remember scope (400, prompt kept waiting) does not kill the run", async (t) => {
  const { posts, errors, urls, listed } = await runTurn(t, {
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
        json({ error: "project rules are not available on this backend" }, 400);
        return true;
      }
      return false;
    },
  });
  assert.equal(posts[0]?.scope, "project", "the scoped answer was sent first");
  const cancelled = urls.some((url) => url.includes("/cancel"));
  assert.equal(cancelled, false, `the client cancelled the K-brain run: ${urls.filter((url) => url.includes("/cancel")).join(", ")}`);
  assert.equal(errors.length, 0, `turn failed: ${errors.join(" | ")}`);
  assert.equal(listed.length >= 2, true, `the still-waiting prompt was offered again (listed ${listed.length})`);
});

// --- Verification (expected to pass): without a deadline the approval still settles. ---

const lastCopy = (gatewayEvents, id) => gatewayEvents.filter((value) => value.type === "tool_call" && value.id === id).at(-1);

test("verify: a prompt K-brain releases by a new rule (permission.resolved) leaves bar and WebUI", async (t) => {
  const { posts, gatewayEvents, errors } = await runTurn(t, {
    answers: [["approve_session"]],
    answerFilter: (pending) => pending.toolCallId === "a",
    events: (event) => {
      event("tool.call", { tool_call: { id: "a", name: "Bash", arguments: { command: "npm test" } } });
      event("tool.call", { tool_call: { id: "b", name: "Bash", arguments: { command: "npm test -- x" } } });
      for (const [pid, call] of [["pa", "a"], ["pb", "b"]]) {
        event("permission.requested", {
          permission_id: pid, tool: "Bash", command: "npm test", rule: "npm test", shell: "bash", tool_call_id: call,
          options: allowAlwaysOptions, suggestion: { rules: ["Bash(npm test:*)"], default_scope: "project" },
        });
      }
    },
    onPermissionPost: (decision, count, json, { event, finish }) => {
      json({ ok: true });
      // settleCoveredPermissions releases pb; waitPermission publishes permission.resolved for both.
      event("permission.resolved", { permission_id: "pa", decision: "allow_always" });
      event("permission.resolved", { permission_id: "pb", decision: "allow_once" });
      setTimeout(finish, 50);
      return true;
    },
  });
  assert.equal(errors.length, 0, errors.join(" | "));
  assert.equal(posts.length, 1, "only the answered prompt was posted");
  assert.equal(posts[0].scope, "session");
  assert.equal(approval.hasPendingToolApproval("a"), false);
  assert.equal(approval.hasPendingToolApproval("b"), false, "released prompt left the desktop store");
  assert.equal(lastCopy(gatewayEvents, "b").arguments[args.TOOL_APPROVAL_PENDING_ARG] === true, false, "WebUI got a copy without the pending marker");
});

test("verify: run.failed while a prompt waits settles it and re-pushes the call without the marker", async (t) => {
  const { gatewayEvents } = await runTurn(t, {
    answers: [["approve"]],
    answerFilter: () => false,
    events: (event) => {
      event("tool.call", { tool_call: { id: "c", name: "Bash", arguments: { command: "npm test" } } });
      event("permission.requested", {
        permission_id: "pc", tool: "Bash", command: "npm test", rule: "npm test", shell: "bash", tool_call_id: "c",
        options: allowAlwaysOptions, suggestion: { rules: ["Bash(npm test:*)"], default_scope: "project" },
      });
      setTimeout(() => event("run.failed", { state: "failed", error: "boom" }), 50);
    },
  });
  assert.equal(approval.hasPendingToolApproval("c"), false);
  const copies = gatewayEvents.filter((value) => value.type === "tool_call" && value.id === "c");
  assert.equal(copies.some((value) => value.arguments[args.TOOL_APPROVAL_PENDING_ARG] === true), true, "marker was pushed while waiting");
  assert.equal(copies.at(-1).arguments[args.TOOL_APPROVAL_PENDING_ARG] === true, false, "last copy has no marker");
});
