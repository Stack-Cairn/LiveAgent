import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2a: a K-brain approval carries the rules "allow and remember" would store and
// their default scope to the desktop bar and to WebUI, waits without a deadline, and
// answers with the scope or the denial reason; permission.auto_resolved marks the call.

const loader = createTsModuleLoader();
const { runAgentConversationTurn } = loader.loadModule("src/pages/chat/turns/runAgentConversationTurn.ts");
const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
const autoResolved = loader.loadModule("src/lib/tools/permissionAutoResolved.ts");
const { buildGatewayToolCallPreviewArguments } = loader.loadModule("src/pages/chat/turns/gatewayToolPreview.ts");
const args = loader.loadModule("../agent-ui/src/lib/chat/toolApprovalArgs.ts");
const { toolCallArgsForDisplay } = loader.loadModule("../agent-ui/src/lib/chat/uiMessages.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

test("the Gateway overlay carries remember rules and no deadline for a waiting K-brain approval", async () => {
  const pending = approval.requestToolApproval({
    toolCallId: "overlay-1",
    toolName: "Bash",
    summary: "npm test",
    conversationId: "conv-overlay",
    allowSession: true,
    sessionScope: "Bash(npm test:*)",
    rememberRules: ["Bash(npm test:*)"],
    defaultScope: "project",
    timeoutMs: null,
  });
  const overlay = buildGatewayToolCallPreviewArguments({ id: "overlay-1", name: "Bash", arguments: { command: "npm test" } });
  assert.deepEqual(overlay[args.TOOL_APPROVAL_REMEMBER_RULES_ARG], ["Bash(npm test:*)"]);
  assert.equal(overlay[args.TOOL_APPROVAL_DEFAULT_SCOPE_ARG], "project");
  assert.equal(args.TOOL_APPROVAL_DEADLINE_ARG in overlay, false, "no deadline is sent for an approval that waits");
  const remote = args.pendingToolApprovalFromToolCall({ id: "overlay-1", name: "Bash", arguments: overlay });
  assert.deepEqual(
    { rememberRules: remote.rememberRules, defaultScope: remote.defaultScope, deadlineAt: remote.deadlineAt },
    { rememberRules: ["Bash(npm test:*)"], defaultScope: "project", deadlineAt: undefined },
  );
  approval.answerToolApproval("overlay-1", "deny");
  await pending;
});

test("an approval without rules sends no remember fields, and old payloads read as before", () => {
  const remote = args.pendingToolApprovalFromToolCall({
    id: "old-1",
    name: "computer_exec",
    arguments: { [args.TOOL_APPROVAL_PENDING_ARG]: true, [args.TOOL_APPROVAL_DEADLINE_ARG]: 123, [args.TOOL_APPROVAL_ALLOW_SESSION_ARG]: true },
  });
  assert.equal(remote.rememberRules, undefined);
  assert.equal(remote.defaultScope, undefined);
  assert.equal(remote.deadlineAt, 123);
});

test("an auto-resolved call is marked on the Gateway copy and hidden from the shown arguments", () => {
  autoResolved.recordPermissionAutoResolved("auto-1", { source: "rule", rule: "Bash(npm test:*)", scope: "project" });
  const overlay = buildGatewayToolCallPreviewArguments({ id: "auto-1", name: "Bash", arguments: { command: "npm test" } });
  assert.deepEqual(args.readToolPermissionAutoResolved(overlay), { source: "rule", rule: "Bash(npm test:*)", scope: "project" });
  assert.deepEqual(autoResolved.getPermissionAutoResolved("auto-1"), { source: "rule", rule: "Bash(npm test:*)", scope: "project" });
  const shown = toolCallArgsForDisplay({
    type: "toolCall",
    id: "x",
    name: "mcp__fs__write",
    arguments: {
      path: "a",
      [args.TOOL_APPROVAL_REMEMBER_RULES_ARG]: ["r"],
      [args.TOOL_APPROVAL_DEFAULT_SCOPE_ARG]: "project",
      [args.TOOL_PERMISSION_AUTO_RESOLVED_ARG]: { source: "read_only" },
    },
  });
  assert.deepEqual(Object.keys(shown), ["path"]);
});

test("unknown auto-resolved sources are ignored", () => {
  autoResolved.recordPermissionAutoResolved("auto-2", { source: "maybe" });
  assert.equal(autoResolved.getPermissionAutoResolved("auto-2"), null);
});

test("the WebUI decision payload carries scope and reason and still parses old payloads", () => {
  assert.equal(args.buildToolApprovalRequestJson("approve_session", { scope: "project", reason: "x" }), '{"decision":"approve_session","scope":"project"}');
  assert.equal(args.buildToolApprovalRequestJson("deny", { scope: "project", reason: " no " }), '{"decision":"deny","reason":"no"}');
  assert.equal(args.buildToolApprovalRequestJson("approve"), '{"decision":"approve"}');
  assert.deepEqual(args.parseToolApprovalRequestJson('{"decision":"approve_session","scope":"user"}'), { decision: "approve_session", scope: "user" });
  assert.deepEqual(args.parseToolApprovalRequestJson('{"decision":"deny","reason":"use utils.ts"}'), { decision: "deny", reason: "use utils.ts" });
  assert.deepEqual(args.parseToolApprovalRequestJson('{"decision":"approve_session","scope":"galaxy"}'), { decision: "approve_session" });
  assert.deepEqual(args.parseToolApprovalRequestJson('"approve"'), { decision: "approve" });
  assert.equal(args.parseToolApprovalRequestJson('{"decision":"maybe"}'), null);
  assert.equal(args.parseToolApprovalRequestJson("{oops"), null);
});

async function runTurn(t, { answer, events }) {
  const conversationId = `conv-${Math.random().toString(36).slice(2)}`;
  const posts = [];
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
      if (!events.waitForAnswer) finish();
      return;
    }
    if (request.url.startsWith("/v1/sessions/session/permissions/")) {
      posts.push(JSON.parse(body).decision);
      json({ ok: true });
      event("permission.resolved", { permission_id: JSON.parse(body).decision.permission_id });
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
  const dispose = approval.subscribeToolApprovalsForConversation(conversationId, () => queueMicrotask(() => {
    for (const pending of approval.listPendingToolApprovalsForConversation(conversationId)) {
      listed.push(pending);
      const [decision, options] = answer;
      approval.answerToolApproval(pending.toolCallId, decision, { conversationId, ...options });
    }
  }));
  t.after(dispose);
  const context = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }] };
  let state = createConversationStateFromContext(context);
  let rounds = [];
  const gatewayEvents = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  t.after(() => clearTimeout(timeout));
  await runAgentConversationTurn({
    providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
    runtime: { backend: "kbrain", baseUrl: "https://must-not-be-called.invalid", apiKey: "unused" }, sessionId: "frontend-session", conversationId,
    trajectoryMessageId: "message", conversationCwd: "/workspace", effectiveWorkdir: "/workspace", createdAt: 1, fallbackTitle: "t", titlePromise: null,
    transcriptStore: {}, cancellation: { userStop: controller },
    gatewayBridgeEvents: { queueToken() {}, queueEvent(value) { gatewayEvents.push(value); }, queueToolStatus() {}, emitError() {} },
    hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])),
    buildPreparedContext: () => context, getNextConversationState: () => state,
    applyConversationState: (value) => { state = value; },
    batchLiveRoundsUpdate: (update) => { rounds = update(rounds); },
    updateToolStatus() {}, updateGatewayBridgeToolStatus() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
    persistConversationWithHistorySync: async () => true,
  });
  return { posts, listed, gatewayEvents };
}

const permissionEvents = (suggestion) => {
  const emit = (event) => {
    event("tool.call", { tool_call: { id: "call", name: "Bash", arguments: { command: "npm test && echo done" } } });
    event("permission.requested", {
      permission_id: "permission", tool: "Bash", command: "npm test && echo done", rule: "npm test", shell: "bash", tool_call_id: "call",
      options: [{ id: "allow_once", kind: "allow_once" }, { id: "allow_always", label: "Allow and remember", kind: "allow_always" }, { id: "reject", kind: "reject_once" }],
      ...(suggestion ? { suggestion } : {}),
    });
  };
  emit.waitForAnswer = true;
  return emit;
};

test("a suggestion reaches the bar, the approval has no deadline, and approve_session remembers for this session", async (t) => {
  const { posts, listed, gatewayEvents } = await runTurn(t, {
    answer: ["approve_session"],
    events: permissionEvents({ rules: ["Bash(npm test:*)", "Bash(echo:*)"], default_scope: "project" }),
  });
  assert.equal(listed[0].deadlineAt, null);
  assert.deepEqual(listed[0].rememberRules, ["Bash(npm test:*)", "Bash(echo:*)"]);
  assert.equal(listed[0].defaultScope, "project");
  // The session item names what will be stored, not just the prompt's first segment.
  assert.equal(listed[0].sessionScope, "Bash(npm test:*), Bash(echo:*)");
  // The existing bar's "allow for this session" stays a session rule.
  assert.deepEqual(posts, [{ permission_id: "permission", decision: "allow_always", scope: "session" }]);
  const marked = gatewayEvents.find((value) => value.type === "tool_call" && value.arguments[args.TOOL_APPROVAL_PENDING_ARG] === true);
  assert.deepEqual(marked.arguments[args.TOOL_APPROVAL_REMEMBER_RULES_ARG], ["Bash(npm test:*)", "Bash(echo:*)"]);
});

test("an explicit scope is posted with allow_always", async (t) => {
  const { posts } = await runTurn(t, {
    answer: ["approve_session", { scope: "project" }],
    events: permissionEvents({ rules: ["Bash(npm test:*)"], default_scope: "project" }),
  });
  assert.deepEqual(posts, [{ permission_id: "permission", decision: "allow_always", scope: "project" }]);
});

test("a denial posts its reason", async (t) => {
  const { posts } = await runTurn(t, {
    answer: ["deny", { reason: "run the unit tests only" }],
    events: permissionEvents({ rules: ["Bash(npm test:*)"], default_scope: "project" }),
  });
  assert.deepEqual(posts, [{ permission_id: "permission", decision: "reject", reason: "run the unit tests only" }]);
});

test("a backend without suggestions keeps the old session answer", async (t) => {
  const { posts, listed } = await runTurn(t, { answer: ["approve_session", { scope: "project" }], events: permissionEvents(undefined) });
  assert.deepEqual(listed[0].rememberRules, []);
  assert.equal(listed[0].sessionScope, "npm test");
  assert.deepEqual(posts, [{ permission_id: "permission", decision: "allow_always" }]);
});

test("permission.auto_resolved marks the call before or after it arrives", async (t) => {
  const { gatewayEvents } = await runTurn(t, {
    answer: ["approve"],
    events: (event) => {
      event("tool.call", { tool_call: { id: "after", name: "Bash", arguments: { command: "git status" } } });
      event("permission.auto_resolved", { tool_call_id: "after", tool: "Bash", command: "git status", source: "read_only" });
      event("permission.auto_resolved", { tool_call_id: "before", tool: "Bash", command: "npm test", source: "rule", rule: "Bash(npm test:*)", scope: "project" });
      event("tool.call", { tool_call: { id: "before", name: "Bash", arguments: { command: "npm test" } } });
    },
  });
  assert.deepEqual(autoResolved.getPermissionAutoResolved("after"), { source: "read_only" });
  assert.deepEqual(autoResolved.getPermissionAutoResolved("before"), { source: "rule", rule: "Bash(npm test:*)", scope: "project" });
  const last = (id) => gatewayEvents.filter((value) => value.type === "tool_call" && value.id === id).at(-1);
  assert.deepEqual(args.readToolPermissionAutoResolved(last("after").arguments), { source: "read_only" });
  assert.deepEqual(args.readToolPermissionAutoResolved(last("before").arguments), { source: "rule", rule: "Bash(npm test:*)", scope: "project" });
});

test("WebUI decisions carry scope and reason through the bridge, the Gateway RPC and the desktop queue", async () => {
  const web = createTsModuleLoader({ rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)) });
  const bridge = web.loadModule("src/lib/chat/toolApprovalBridge.ts");
  const received = [];
  bridge.registerToolApprovalDecisionHandler(async (...value) => {
    received.push(value);
    return { ok: true };
  });
  await bridge.submitToolApprovalDecision("call", "approve_session", "conv", { scope: "project" });
  await bridge.submitToolApprovalDecision("call", "deny", undefined, { reason: "no" });
  assert.deepEqual(received, [["call", "approve_session", "conv", { scope: "project" }], ["call", "deny", undefined, { reason: "no" }]]);
  bridge.registerToolApprovalDecisionHandler(null);

  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(read("../../../agent-gateway/web/src/app/GatewayApp.tsx"), /buildToolApprovalRequestJson\(decision, options\)/);
  for (const file of [
    "../../../agent-gateway/web/src/app/hooks/useGatewayChatPresentation.tsx",
    "../../../agent-gateway/web/src/app/workbench/GatewayConversationPaneHost.tsx",
    "../../src/pages/chat/components/PendingToolApprovalBar.tsx",
  ]) {
    assert.match(read(file), /onDecide=\{\(toolCallId, decision, options\)/, file);
  }
  const queue = read("../../src/pages/chat/queue/useChatTurnQueue.ts");
  assert.match(queue, /parseToolApprovalRequestJson\(request\.requestJson\)/);
  assert.match(queue, /answerToolApproval\(itemId, parsed\.decision, \{\s*conversationId,\s*scope: parsed\.scope,\s*reason: parsed\.reason,?\s*\}\)/);
});
