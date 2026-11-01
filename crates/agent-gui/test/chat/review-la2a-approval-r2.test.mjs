import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2a independent review, round 2 (after the clamp and 400-retry fixes): regressions driven through the real K-brain turn
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
      const entry = answers[Math.min(listed.length - 1, answers.length - 1)];
      if (typeof entry === "function") { entry({ pending, controller, index: listed.length - 1 }); continue; }
      const [decision, options] = entry;
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

const { buildGatewayToolCallPreviewArguments } = loader.loadModule("src/pages/chat/turns/gatewayToolPreview.ts");

const copiesOf = (gatewayEvents, id) => gatewayEvents.filter((value) => value.type === "tool_call" && value.id === id);
const hasMarker = (value) => value.arguments[args.TOOL_APPROVAL_PENDING_ARG] === true;

// First subscribe plays the prompt; a later subscribe (waitForCancelledRun after a stop)
// sees the run cancelled, as K-brain would publish it.
function promptEvents(extra = {}) {
  let subscribes = 0;
  return (event) => {
    subscribes += 1;
    if (subscribes > 1) {
      event("run.cancelled", { state: "cancelled" });
      return;
    }
    event("tool.call", { tool_call: { id: "call", name: "Bash", arguments: { command: "npm test" } } });
    event("permission.requested", {
      permission_id: "permission", tool: "Bash", command: "npm test", rule: "npm test", shell: "bash", tool_call_id: "call",
      options: allowAlwaysOptions, suggestion: { rules: ["Bash(npm test:*)"], default_scope: "session" },
      ...extra,
    });
  };
}

test("verify: a user stop while the re-asked prompt is shown ends the loop without asking again", async (t) => {
  const { posts, listed, gatewayEvents } = await runTurn(t, {
    answers: [["approve_session", { scope: "project" }], ({ controller }) => controller.abort()],
    events: promptEvents(),
    onPermissionPost: (decision, count, json) => {
      if (count === 1) {
        json({ error: "project rules are not available on this backend" }, 400);
        return true;
      }
      json({ ok: true });
      return true;
    },
  });
  assert.equal(listed.length, 2, `prompt shown ${listed.length} times`);
  assert.equal(approval.hasPendingToolApproval("call"), false, "nothing left in the desktop store");
  // At most one reject may follow the stop (pre-existing: the stop races the answer); no scoped retry.
  assert.equal(posts.filter((post) => post.decision !== "reject").length, 1, JSON.stringify(posts));
  assert.equal(hasMarker(copiesOf(gatewayEvents, "call").at(-1)), false, "WebUI copy cleared");
});

test("verify: permission.resolved while the re-asked prompt is shown clears it; Gateway re-pushed the marker for the retry", async (t) => {
  const { posts, listed, gatewayEvents } = await runTurn(t, {
    answers: [["approve_session", { scope: "project" }], () => {}],
    events: promptEvents(),
    onPermissionPost: (decision, count, json, { event, finish }) => {
      json({ error: "project rules are not available on this backend" }, 400);
      setTimeout(() => {
        event("permission.resolved", { permission_id: "permission", decision: "allow_once" });
        setTimeout(finish, 30);
      }, 50);
      return true;
    },
  });
  assert.equal(posts.length, 1);
  assert.equal(listed.length, 2, "re-asked once");
  assert.equal(listed[1].sessionScope.length <= 300, true);
  assert.equal(approval.hasPendingToolApproval("call"), false);
  const copies = copiesOf(gatewayEvents, "call");
  const markerFlips = copies.map((value) => (hasMarker(value) ? "P" : "-")).join("");
  // tool.call (-), first ask (P), settle (-), retry ask (P), released (-)
  assert.equal(/P-+P-+$/.test(markerFlips), true, `marker sequence ${markerFlips}`);
});

test("verify: run.completed while the re-asked prompt is shown clears it", async (t) => {
  const { posts, gatewayEvents } = await runTurn(t, {
    answers: [["approve_session", { scope: "project" }], () => {}],
    events: promptEvents(),
    onPermissionPost: (decision, count, json, { finish }) => {
      json({ error: "refused" }, 400);
      setTimeout(finish, 50);
      return true;
    },
  });
  assert.equal(posts.length, 1);
  assert.equal(approval.hasPendingToolApproval("call"), false);
  assert.equal(hasMarker(copiesOf(gatewayEvents, "call").at(-1)), false);
});

test("verify: after PERMISSION_ANSWER_RETRIES refusals the run fails as before", async (t) => {
  const { posts, urls } = await runTurn(t, {
    answers: [["approve_session", { scope: "project" }]],
    events: promptEvents(),
    onPermissionPost: (decision, count, json) => {
      json({ error: "refused" }, 400);
      return true;
    },
  });
  assert.equal(posts.length, 4, `posted ${posts.length} times`);
  assert.equal(urls.some((url) => url.includes("/cancel")), true);
});

// clampApprovalRules promises a bound on the *serialized* length, but measures each rule
// by its raw length. Rules with quotes or backslashes (python -c "...", Windows paths)
// grow when JSON-encoded.
test("remember rules synced to WebUI stay within 2000 serialized chars when they contain quotes", () => {
  const rule = `Bash(python -c "${'print("x");'.repeat(160)}")`; // ~1940 raw chars, many quotes
  const toolCallId = `clamp-${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  void approval.requestToolApproval({
    toolCallId, toolName: "Bash", conversationId: "clamp-conv", allowSession: true,
    rememberRules: [rule], timeoutMs: null, signal: controller.signal,
  });
  try {
    const synced = buildGatewayToolCallPreviewArguments({ id: toolCallId, name: "Bash", arguments: { command: "x" } });
    const serialized = JSON.stringify(synced[args.TOOL_APPROVAL_REMEMBER_RULES_ARG]).length;
    assert.equal(serialized <= SYNCED_APPROVAL_TEXT_MAX, true, `serialized rules are ${serialized} chars (raw rule ${rule.length})`);
  } finally {
    controller.abort();
  }
});

test("verify: clampApprovalRules boundaries for plain rules", () => {
  const max = SYNCED_APPROVAL_TEXT_MAX;
  const size = (rules) => JSON.stringify(rules).length;
  assert.equal(size(args.clampApprovalRules([], max)), 2);
  // The bound is the serialized length: ["…"] adds 4 characters around the rule.
  const fits = "a".repeat(max - 4);
  const kept = args.clampApprovalRules([fits], max);
  assert.equal(kept.length === 1 && kept[0] === fits, true, "a rule that fits is kept whole");
  assert.equal(size(kept) <= max, true);
  const over = args.clampApprovalRules(["a".repeat(max - 3)], max);
  assert.equal(over.length === 1 && over[0].endsWith("…") && size(over) <= max, true, `one over: ${size(over)}`);
  const many = args.clampApprovalRules(["a".repeat(900), "b".repeat(900), "c".repeat(900), "d"], max);
  assert.equal(many.length, 3, "stops after the truncated rule");
  assert.equal(many[2].endsWith("…"), true);
  assert.equal(size(many) <= max, true, `accumulated ${size(many)}`);
  assert.equal(args.clampApprovalRules(["x"], 5).length, 1, "[\"x\"] is exactly 5 characters");
  assert.equal(args.clampApprovalRules(["xy"], 5).length, 0, "no room for a cut rule yields an empty list");
});
