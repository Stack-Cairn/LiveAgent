import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 审查回归:K-brain permission.requested 按 tool_call_id 登记审批后,回合向 Gateway
// 重推该 tool_call 的生命周期。用真实 K-brain SSE 固件跑真实 runAgentConversationTurn,
// 覆盖:用户停止回合(abort)、tool_call_id 指向未到达的调用、同一调用并发两次授权请求、
// 同一调用先后两次授权请求。
const loader = createTsModuleLoader();
const { runAgentConversationTurn } = loader.loadModule("src/pages/chat/turns/runAgentConversationTurn.ts");
const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

/**
 * scenario.permissions: 依次推送的 permission.requested 载荷(permission_id 必填)。
 * scenario.onPending(pendings, helpers): 每次挂起表变化时调用(微任务里),返回 true 表示已处理。
 * 服务器在所有 permission 都收到决定后推送 tool.result / assistant.message.created / run.completed。
 */
async function runScenario(t, scenario) {
  const requests = [];
  const decisions = [];
  const gatewayEvents = [];
  let stream;
  let sequence = 0;
  const event = (type, payload) => stream.write(`data: ${JSON.stringify({
    version: "kbrain.agent.v1", seq: ++sequence, conversation_id: "session", run_id: "run", type,
    created_at: new Date().toISOString(), payload,
  })}\n\n`);
  const expected = new Set(scenario.permissions.map((item) => item.permission_id));
  const finishRun = () => {
    event("tool.result", { tool_result: { id: "call", name: "computer_exec", output: "clicked", failed: false } });
    event("assistant.message.created", { role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1, output_tokens: 1 } });
    event("run.completed", { state: "completed" });
    stream.end();
  };
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: body ? JSON.parse(body) : undefined });
    const json = (value, code = 200) => {
      response.writeHead(code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/sessions") return json({ id: "session" }, 201);
    if (request.url === "/v1/sessions/session/runs") return json({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }, 202);
    if (request.url === "/v1/sessions/session" || request.url.startsWith("/v1/sessions/session/history")) {
      const messages = [
        { id: "user-persisted", role: "user", content: [{ type: "text", text: "click it" }] },
        { id: "assistant-persisted", role: "assistant", content: [{ type: "text", text: "Done" }], tool_calls: [{ id: "call", name: "computer_exec", arguments: { action: "call", tool: "click" } }] },
        { id: "tool-persisted", role: "tool", tool_call_id: "call", name: "computer_exec", content: [{ type: "text", text: "clicked" }], stop_reason: "stop" },
      ];
      const session = { id: "session", revision: "rev", title: "Click", model: { provider: "fixture", model: "model" }, created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:01Z", message_count: messages.length, last_seq: sequence, messages, tasks: [] };
      return json(request.url.includes("/history") ? { session, revision: session.revision, oldest_offset: 0, has_more_before: false, total_message_count: messages.length, active_messages: messages } : session);
    }
    if (request.url.startsWith("/v1/sessions/session/events")) {
      stream = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      sequence = Number(new URL(request.url, "http://localhost").searchParams.get("after_seq") ?? 0);
      event("user.message.appended", { role: "user", content: [{ type: "text", text: "click it" }] });
      event("assistant.text.delta", { text: "Clicking" });
      if (scenario.announceCall !== false) {
        event("tool.call", { tool_call: { id: "call", name: "computer_exec", arguments: { action: "call", tool: "click" } } });
      }
      if (scenario.resolveExternally) {
        event("tool.call", { tool_call: { id: "second-call", name: "computer_exec", arguments: { action: "call", tool: "click" } } });
      }
      for (const permission of scenario.permissions.slice(0, scenario.initialPermissions ?? scenario.permissions.length)) {
        event("permission.requested", { tool: "computer_exec", command: '{"action":"call","tool":"click"}', rule: "call:click", scope: "session", options: [{ id: "allow_once", label: "Allow for this session", kind: "allow_once" }, { id: "reject", kind: "reject_once" }], ...permission });
      }
      return;
    }
    const permissionMatch = request.url.match(/^\/v1\/sessions\/session\/permissions\/(.+)$/);
    if (permissionMatch) {
      const permissionId = permissionMatch[1];
      decisions.push([permissionId, JSON.parse(body).decision.decision]);
      if (scenario.raceResolvedDecision && permissionId === "p-second") {
        json({ error: "permission request not found" }, 404);
        setTimeout(() => {
          event("permission.resolved", { permission_id: "p-second", decision: "allow_once" });
          finishRun();
        }, 50);
        return;
      }
      json({ ok: true });
      if (scenario.raceResolvedDecision) {
        event("permission.resolved", { permission_id: permissionId, decision: "allow_once" });
        return;
      }
      if (scenario.resolveExternally && permissionId === "p-first") {
        event("permission.resolved", { permission_id: "p-first", decision: "allow_once" });
        event("permission.resolved", { permission_id: "p-second", decision: "allow_once", reason: "computer use allowed for this session" });
        event("tool.result", { tool_result: { id: "second-call", name: "computer_exec", output: "clicked", failed: false } });
        setTimeout(() => {
          scenario.afterExternalResolution?.(approval.listPendingToolApprovalsForConversation(`conversation-${scenario.name}`));
          finishRun();
        }, 100);
        return;
      }
      event("permission.resolved", { permission_id: permissionId, decision: JSON.parse(body).decision.decision });
      expected.delete(permissionId);
      // 先后两次授权:第一次落定后再推第二次。
      const remaining = scenario.permissions.filter((item) => expected.has(item.permission_id));
      if (remaining.length > 0 && scenario.initialPermissions !== undefined) {
        for (const permission of remaining) {
          event("permission.requested", { tool: "computer_exec", command: '{"action":"call","tool":"click"}', rule: "call:click", scope: "session", options: [{ id: "allow_once", kind: "allow_once" }, { id: "reject", kind: "reject_once" }], ...permission });
        }
        scenario.initialPermissions = undefined;
        return;
      }
      if (expected.size === 0) finishRun();
      return;
    }
    json({ error: `Unexpected path ${request.url}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
  };
  setKBrainRuntimeConnection({ baseUrl: origin, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  globalThis.fetch = (url, init) => {
    assert.equal(new URL(url).origin, origin);
    return originalFetch(url, init);
  };
  t.after(() => {
    clearKBrainRuntimeConnection();
    globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    server.closeAllConnections();
    server.close();
  });
  const conversationId = `conversation-${scenario.name}`;
  const controller = new AbortController();
  const pendingSnapshots = [];
  const dispose = approval.subscribeToolApprovalsForConversation(conversationId, () => queueMicrotask(() => {
    const pendings = approval.listPendingToolApprovalsForConversation(conversationId);
    if (pendings.length === 0) return;
    pendingSnapshots.push(pendings.map((item) => item.toolCallId));
    scenario.onPending(pendings, {
      answer: (toolCallId, decision = "approve") => approval.answerToolApproval(toolCallId, decision, { conversationId }),
      stop: () => controller.abort(),
    });
  }));
  t.after(dispose);
  const context = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "click it" }], timestamp: 1 }] };
  let state = createConversationStateFromContext(context);
  const timeout = setTimeout(() => controller.abort(), 5000);
  t.after(() => clearTimeout(timeout));
  const errors = [];
  const outcome = await runAgentConversationTurn({
    providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
    runtime: { backend: "kbrain", baseUrl: "https://must-not-be-called.invalid", apiKey: "unused-secret", reasoning: "max" }, sessionId: "frontend-session", conversationId,
    trajectoryMessageId: `message-${scenario.name}`, conversationCwd: "/workspace", effectiveWorkdir: "/workspace", createdAt: 1, fallbackTitle: "Click", titlePromise: null,
    transcriptStore: {}, cancellation: { userStop: controller },
    gatewayBridgeEvents: { queueToken() {}, queueEvent(item) { gatewayEvents.push(item); }, queueToolStatus() {}, emitError(message) { errors.push(message); } },
    hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])),
    buildPreparedContext: () => context, getNextConversationState: () => state,
    applyConversationState: (value) => { state = value; },
    batchLiveRoundsUpdate: () => {}, settleLiveTranscript() {}, freezeGatewayFinalProjection() {}, updateToolStatus() {},
    persistConversationWithHistorySync: async () => true,
  }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  // 让审批落定后的微任务(重推 Gateway)跑完。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const callSyncs = gatewayEvents
    .filter((item) => item.type === "tool_call" && item.id === "call")
    .map((item) => ({
      pending: item.arguments.__toolApprovalPending === true,
      sessionWide: item.arguments.__toolApprovalSessionWide === true,
      round: item.round,
    }));
  return { outcome, requests, decisions, gatewayEvents, callSyncs, pendingSnapshots, errors, conversationId, aborted: controller.signal.aborted };
}

test("用户停止回合:挂起审批落定为取消,Gateway 收到带标记与清除标记的两次重推", async (t) => {
  const run = await runScenario(t, {
    name: "abort",
    permissions: [{ permission_id: "p-abort", tool_call_id: "call" }],
    onPending: (pendings, { stop }) => {
      assert.deepEqual(pendings.map((item) => item.toolCallId), ["call"]);
      stop();
    },
  });
  assert.equal(run.aborted, true);
  assert.equal(approval.hasPendingToolApproval("call"), false, "abort 后不得残留挂起项");
  assert.deepEqual(
    run.callSyncs,
    [
      { pending: false, sessionWide: false, round: 1 },
      { pending: true, sessionWide: true, round: 1 },
      { pending: false, sessionWide: false, round: 1 },
    ],
    "onToolCall 原始推送 → 审批开始带标记 → 取消后清除标记",
  );
});

test("tool_call_id 指向尚未到达的调用:退回 permission_id 登记,不向 Gateway 重推任何调用", async (t) => {
  const run = await runScenario(t, {
    name: "ghost-call",
    permissions: [{ permission_id: "p-ghost", tool_call_id: "ghost" }],
    onPending: (pendings, { answer }) => {
      for (const item of pendings) answer(item.toolCallId);
    },
  });
  assert.equal(run.outcome.ok, true, String(run.outcome.error));
  assert.deepEqual(run.pendingSnapshots, [["p-ghost"]]);
  assert.deepEqual(run.decisions, [["p-ghost", "allow_once"]]);
  assert.deepEqual(run.callSyncs, [{ pending: false, sessionWide: false, round: 1 }], "只有 onToolCall 的原始推送");
  assert.equal(run.gatewayEvents.some((item) => item.type === "tool_call" && item.id === "ghost"), false);
});

test("同一调用并发两次授权请求:第二次退回 permission_id,且不同步到 Gateway", async (t) => {
  const run = await runScenario(t, {
    name: "concurrent-same-call",
    permissions: [
      { permission_id: "p-first", tool_call_id: "call" },
      { permission_id: "p-second", tool_call_id: "call" },
    ],
    onPending: (pendings, { answer }) => {
      // 等两条都挂起再一起回答,确保第二条是在第一条仍挂起时登记的。
      if (pendings.length < 2) return;
      for (const item of pendings) answer(item.toolCallId);
    },
  });
  assert.equal(run.outcome.ok, true, String(run.outcome.error));
  assert.deepEqual(run.pendingSnapshots.at(-1), ["call", "p-second"]);
  assert.deepEqual(new Set(run.decisions.map(([id]) => id)), new Set(["p-first", "p-second"]));
  // 第二条审批只在桌面栏可见:Gateway 只收到第一条的带标记/清除标记重推。
  assert.deepEqual(
    run.callSyncs.map((item) => item.pending),
    [false, true, false],
    "第二条(permission_id 键)没有任何 Gateway 重推,WebUI 看不到也答不了它",
  );
});

test("同一调用先后两次授权请求:第一次落定后第二次仍按 tool_call_id 登记并重推", async (t) => {
  const run = await runScenario(t, {
    name: "sequential-same-call",
    initialPermissions: 1,
    permissions: [
      { permission_id: "p-review", tool_call_id: "call", description: "AI review: risky" },
      { permission_id: "p-again", tool_call_id: "call" },
    ],
    onPending: (pendings, { answer }) => {
      for (const item of pendings) answer(item.toolCallId);
    },
  });
  assert.equal(run.outcome.ok, true, String(run.outcome.error));
  assert.deepEqual(run.pendingSnapshots, [["call"], ["call"]]);
  assert.deepEqual(run.decisions, [["p-review", "allow_once"], ["p-again", "allow_once"]]);
  assert.deepEqual(
    run.callSyncs.map((item) => item.pending),
    [false, true, false, true, false],
    "两次审批各自带标记一次、清除一次",
  );
});

test("后端结清并发审批后立即清除桌面与 Gateway 标记,无需再次决定", async (t) => {
  let answered = false;
  let remaining;
  const run = await runScenario(t, {
    name: "server-resolved",
    resolveExternally: true,
    permissions: [
      { permission_id: "p-first", tool_call_id: "call" },
      { permission_id: "p-second", tool_call_id: "second-call" },
    ],
    onPending(pendings, { answer }) {
      if (pendings.length !== 2 || answered) return;
      answered = true;
      answer("call");
    },
    afterExternalResolution(pendings) { remaining = pendings; },
  });
  assert.equal(run.outcome.ok, true, String(run.outcome.error));
  assert.deepEqual(remaining, [], "run 尚未结束时,后端已解决的审批必须清除");
  assert.deepEqual(run.decisions, [["p-first", "allow_once"]]);
  const syncs = run.gatewayEvents.filter((item) => item.type === "tool_call" && item.id === "second-call");
  assert.deepEqual(syncs.map((item) => item.arguments.__toolApprovalPending === true), [false, true, false]);
});

test("并发决定遇到已被会话授权结清的 404 时继续读取回合结果", async (t) => {
  let answered = false;
  const run = await runScenario(t, {
    name: "resolved-decision-race",
    raceResolvedDecision: true,
    permissions: [
      { permission_id: "p-first", tool_call_id: "call" },
      { permission_id: "p-second", tool_call_id: "call" },
    ],
    onPending(pendings, { answer }) {
      if (pendings.length !== 2 || answered) return;
      answered = true;
      for (const item of pendings) answer(item.toolCallId);
    },
  });
  assert.equal(run.outcome.ok, true, String(run.outcome.error));
  assert.deepEqual(run.errors, []);
  assert.deepEqual(new Set(run.decisions.map(([id]) => id)), new Set(["p-first", "p-second"]));
});
