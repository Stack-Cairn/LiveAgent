import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { runTextConversationTurn } = loader.loadModule("src/pages/chat/turns/runTextConversationTurn.ts");
const { runAgentConversationTurn } = loader.loadModule("src/pages/chat/turns/runAgentConversationTurn.ts");
const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
const planMode = loader.loadModule("src/lib/tools/planModeTools.ts");
const { buildUiMessages } = loader.loadModule("src/lib/chat/messages/uiMessages.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

for (const [mode, runTurn] of [["text", runTextConversationTurn], ["agent", runAgentConversationTurn]]) {
  for (const failurePath of ["/v1/sessions", "/v1/sessions/session/runs"]) {
    test(`${mode} backend rejection at ${failurePath} never falls back to provider execution`, async (t) => {
      const requests = [];
      const attemptedUrls = [];
      const server = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests.push({ path: request.url, body, authorization: request.headers.authorization });
        response.setHeader("content-type", "application/json");
        if (request.url === failurePath) {
          response.writeHead(503);
          response.end(JSON.stringify({ error: "backend unavailable fixture" }));
        } else if (request.url === "/v1/sessions") {
          response.writeHead(201);
          response.end(JSON.stringify({ id: "session" }));
        } else {
          response.writeHead(404);
          response.end(JSON.stringify({ error: "unexpected request" }));
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const originalFetch = globalThis.fetch;
      const originalStorage = globalThis.localStorage;
      globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
      setKBrainRuntimeConnection({ baseUrl: origin, token: "backend-token", protocolVersion: "kbrain.agent.v1" });
      globalThis.fetch = (url, init) => {
        attemptedUrls.push(String(url));
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
      const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
      const hooks = [];
      let persisted = false;
      await assert.rejects(runTurn({
        providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
        runtime: { backend: "direct", baseUrl: "https://provider.invalid/v1", apiKey: "provider-secret" },
        sessionId: "frontend-session", conversationId: `failure-${mode}-${failurePath}`,
        conversationCwd: "/workspace", ...(mode === "agent" ? { effectiveWorkdir: "/workspace" } : {}),
        createdAt: 1, fallbackTitle: "Failure", titlePromise: null, transcriptStore: {},
        cancellation: { userStop: new AbortController() }, buildPreparedContext: () => context,
        getNextConversationState: () => createConversationStateFromContext(context), applyConversationState() {},
        batchLiveRoundsUpdate() {}, updateToolStatus() {}, updateGatewayBridgeToolStatus() {},
        freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
        persistConversationWithHistorySync: async () => { persisted = true; return true; },
        gatewayBridgeEvents: { queueToken() {}, queueEvent() {}, queueToolStatus() {}, emitError() {} },
        hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => hooks.push(key)])),
      }), /backend unavailable fixture/);
      // Before posting a run the client reads /v1/health once for capability ai_review_per_run.
      assert.deepEqual(requests.map(({ path }) => path), failurePath === "/v1/sessions" ? [failurePath] : ["/v1/sessions", "/v1/health", failurePath]);
      assert.equal(attemptedUrls.length, requests.length);
      assert.ok(attemptedUrls.every((url) => new URL(url).origin === origin));
      assert.ok(requests.every(({ authorization }) => authorization === "Bearer backend-token"));
      assert.doesNotMatch(JSON.stringify(requests), /provider-secret|provider\.invalid/);
      assert.equal(persisted, false);
      assert.deepEqual(hooks, ["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"]);
    });
  }
}

test("K-brain turn abort cancels an accepted backend run", async (t) => {
  const requests = [];
  let markSubscribed;
  const subscribed = new Promise((resolve) => { markSubscribed = resolve; });
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: body ? JSON.parse(body) : undefined });
    if (request.url === "/v1/sessions") {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "session", model: { provider: "fixture", model: "model" } }));
      return;
    }
    if (request.url === "/v1/sessions/session/runs") {
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }));
      return;
    }
    if (request.url === "/v1/sessions/session/events?after_seq=1") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": keep-alive\n\n");
      markSubscribed();
      await new Promise((resolve) => setTimeout(resolve, 100));
      response.end();
      return;
    }
    if (request.url === "/v1/sessions/session/runs/run/cancel") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "unexpected path" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  setKBrainRuntimeConnection({ baseUrl: origin, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  t.after(() => {
    clearKBrainRuntimeConnection();
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    server.closeAllConnections();
    server.close();
  });
  const context = { messages: [{ role: "user", content: "stop me", timestamp: 1 }] };
  const run = runTextConversationTurn({
    providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
    runtime: { backend: "kbrain" }, sessionId: "frontend-session", conversationId: "conversation-abort",
    trajectoryMessageId: "message-abort", conversationCwd: "/workspace", createdAt: 1, fallbackTitle: "Stop", titlePromise: null,
    transcriptStore: {}, cancellation: { userStop: controller }, buildPreparedContext: () => context,
    getNextConversationState: () => createConversationStateFromContext(context), applyConversationState() {},
    batchLiveRoundsUpdate() {}, updateToolStatus() {}, updateGatewayBridgeToolStatus() {},
    freezeGatewayFinalProjection() {}, settleLiveTranscript() {}, persistConversationWithHistorySync: async () => true,
    gatewayBridgeEvents: { queueToken() {}, queueEvent() {}, queueToolStatus() {}, emitError() {} },
    hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])),
  });
  await subscribed;
  controller.abort();
  await run;
  assert.ok(requests.some(({ path }) => path === "/v1/sessions/session/runs/run/cancel"));
});

test("K-brain failed runs with no assistant content remain visible after final persistence projection", async (t) => {
  const directFailureUi = buildUiMessages([
    { role: "user", content: "search the web", timestamp: 1 },
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "native web search is unsupported for Chat Completions",
      timestamp: 2,
    },
  ]);
  assert.match(directFailureUi.at(-1).text, /native web search is unsupported for Chat Completions/);

  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/v1/sessions") {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "session", model: { provider: "fixture", model: "model" } }));
      return;
    }
    if (request.url === "/v1/sessions/session/runs") {
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }));
      return;
    }
    if (request.url === "/v1/sessions/session/events?after_seq=1") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ version: "kbrain.agent.v1", seq: 2, conversation_id: "session", run_id: "run", type: "run.failed", created_at: new Date().toISOString(), payload: { state: "failed", error: "native web search is unsupported for Chat Completions" } })}\n\n`);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `unexpected path ${request.url}`, body }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  setKBrainRuntimeConnection({ baseUrl: origin, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  t.after(() => {
    clearKBrainRuntimeConnection();
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    server.closeAllConnections();
    server.close();
  });

  const context = { messages: [{ role: "user", content: "search the web", timestamp: 1 }] };
  let state = createConversationStateFromContext(context);
  let persisted;
  let finalProjectionState;
  const errors = [];
  await runTextConversationTurn({
    providerId: "codex",
    model: "model",
    selectedModel: { customProviderId: "fixture", model: "model" },
    runtime: { backend: "kbrain" },
    sessionId: "frontend-session",
    conversationId: "conversation-failed",
    conversationCwd: "/workspace",
    createdAt: 1,
    fallbackTitle: "Failure",
    titlePromise: null,
    transcriptStore: {},
    cancellation: { userStop: new AbortController() },
    buildPreparedContext: () => context,
    getNextConversationState: () => state,
    applyConversationState: (next) => { state = next; },
    batchLiveRoundsUpdate() {},
    updateToolStatus() {},
    updateGatewayBridgeToolStatus() {},
    freezeGatewayFinalProjection: (next) => { finalProjectionState = next; },
    settleLiveTranscript() {},
    persistConversationWithHistorySync: async (input) => {
      persisted = input;
      return true;
    },
    gatewayBridgeEvents: {
      queueToken() {},
      queueEvent() {},
      queueToolStatus() {},
      emitError(message) { errors.push(message); },
    },
    hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])),
  });

  assert.deepEqual(errors, ["native web search is unsupported for Chat Completions"]);
  for (const projectedState of [state, finalProjectionState, persisted.state]) {
    const messages = projectedState.segments.flatMap((segment) => segment.messages);
    const ui = buildUiMessages(messages);
    assert.equal(ui.at(-1).role, "assistant");
    assert.match(ui.at(-1).text, /native web search is unsupported for Chat Completions/);
  }
});

for (const [mode, runTurn, decision, expectedDecision] of [
  ["text", runTextConversationTurn, "approve", "allow_once"],
  ["agent", runAgentConversationTurn, "approve", "allow_once"],
  ["agent-controls", runAgentConversationTurn, "approve", "allow_once"],
  ["agent-deny", runAgentConversationTurn, "deny", "reject"],
  ["agent-session", runAgentConversationTurn, "approve_session", "allow_always"],
  ["agent-session-unoffered", runAgentConversationTurn, "approve_session", "allow_once"],
  ["agent-scope-session", runAgentConversationTurn, "approve", "allow_once"],
  ["agent-failed", runAgentConversationTurn, "approve", "allow_once"],
  ["agent-refresh-failed", runAgentConversationTurn, "approve", "allow_once"],
  ["text-legacy-direct", runTextConversationTurn, "approve", "allow_once"],
  ["agent-legacy-direct", runAgentConversationTurn, "approve", "allow_once"],
  ["text-no-backend", runTextConversationTurn, "approve", "allow_once"],
  ["agent-no-backend", runAgentConversationTurn, "approve", "allow_once"],
]) {
  test(`${mode} shipped turn uses K-brain HTTP, renders tools, and resolves the UI approval`, async (t) => {
    const requests = [];
    let stream;
    let sequence = 0;
    const event = (type, payload) => stream.write(`data: ${JSON.stringify({
      version: "kbrain.agent.v1", seq: ++sequence, conversation_id: "session", run_id: "run", type,
      created_at: new Date().toISOString(), payload,
    })}\n\n`);
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
        if (mode === "agent-refresh-failed") return json({ error: "history temporarily unavailable" }, 503);
        const messages = [
          { id: "user-persisted", role: "user", content: [{ type: "text", text: "inspect" }] },
          { id: "assistant-persisted", role: "assistant", content: [{ type: "text", text: "Hello" }], tool_calls: [{ id: "call", name: "read_file", arguments: { path: "README.md" } }] },
          { id: "tool-persisted", role: "tool", tool_call_id: "call", name: "read_file", content: [{ type: "text", text: expectedDecision === "reject" ? "permission rejected" : "file contents" }], stop_reason: expectedDecision === "reject" ? "error" : "stop" },
        ];
        const session = { id: "session", revision: "saved-revision", title: "Inspect", model: { provider: "fixture", model: "model" }, created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:01Z", message_count: messages.length, last_seq: sequence, messages,
          tasks: [{ id: "child", description: "Review", status: "done", model: { provider: "fixture", model: "model" }, report: "Reviewed" }] };
        return json(request.url.includes("/history") ? { session, revision: session.revision, oldest_offset: 0, has_more_before: false, total_message_count: messages.length, active_messages: messages } : session);
      }
      if (request.url.startsWith("/v1/sessions/session/events")) {
        stream = response;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        sequence = Number(new URL(request.url, "http://localhost").searchParams.get("after_seq") ?? 0);
        event("user.message.appended", { role: "user", content: [{ type: "text", text: "inspect" }] });
        event("assistant.thinking.delta", { text: "Checking" });
        event("assistant.text.delta", { text: "Hello" });
        event("tool.call", { tool_call: { id: "call", name: "read_file", arguments: { path: "README.md" } } });
        event("permission.requested", { permission_id: "permission", tool: "read_file", command: "README.md", description: "AI review: sensitive information risk",
          ...(mode === "agent-session" ? { rule: "call:click", options: [{ id: "allow_once", kind: "allow_once" }, { id: "allow_always", kind: "allow_always" }, { id: "reject", kind: "reject_once" }] } : {}),
          ...(mode === "agent-scope-session" ? { tool_call_id: "call", rule: "call:click", scope: "session", options: [{ id: "allow_once", label: "Allow for this session", kind: "allow_once" }, { id: "reject", kind: "reject_once" }] } : {}) });
        return;
      }
      if (request.url === "/v1/sessions/session/permissions/permission") {
        assert.equal(JSON.parse(body).decision.decision, expectedDecision);
        json({ ok: true });
        event("permission.resolved", { permission_id: "permission", decision: expectedDecision });
        event("tool.result", { tool_result: { id: "call", name: "read_file", output: expectedDecision === "reject" ? "permission rejected" : "file contents", failed: expectedDecision === "reject" } });
        event("subagent.completed", { subagent: { id: "child", description: "Review", status: "done", model: { provider: "fixture", model: "model" }, report: "Reviewed" } });
        if (mode === "agent-controls") {
          event("tool.call", { tool_call: { id: "plan-call", name: "ExitPlanMode", arguments: { plan: "Review before implementation" } } });
          event("tool.result", { tool_result: { id: "plan-call", name: "ExitPlanMode", output: "Plan submitted", failed: false } });
        }
        event("assistant.message.created", { role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 7, output_tokens: 2 } });
        if (mode === "agent-failed") event("run.failed", { state: "failed", error: "fixture upstream unavailable" });
        else event("run.completed", { state: "completed" });
        stream.end();
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
    const conversationId = `conversation-${mode}`;
    // Answer after the turn has synced the pending call, as a user click would.
    const dispose = approval.subscribeToolApprovalsForConversation(conversationId, () => queueMicrotask(() => {
      for (const pending of approval.listPendingToolApprovalsForConversation(conversationId)) {
        assert.match(pending.summary, /AI review: sensitive information risk/);
        assert.equal(pending.allowSession, mode === "agent-session");
        assert.equal(pending.sessionScope, mode === "agent-session" || mode === "agent-scope-session" ? "call:click" : "");
        assert.equal(pending.sessionWide, mode === "agent-scope-session");
        // K-brain names the waiting tool call, so the approval is keyed by it for the Gateway overlay.
        assert.equal(pending.toolCallId, mode === "agent-scope-session" ? "call" : "permission");
        approval.answerToolApproval(pending.toolCallId, decision, { conversationId });
      }
    }));
    t.after(dispose);
    const context = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "inspect" }], timestamp: 1 }] };
    let state = createConversationStateFromContext(context);
    let rounds = [];
    let persisted;
    const hooks = [];
    const errors = [];
    const gatewayEvents = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    t.after(() => clearTimeout(timeout));
    await runTurn({
      providerId: "codex", model: "model", selectedModel: { customProviderId: "fixture", model: "model" },
      runtime: mode.endsWith("no-backend") ? {} : { backend: mode.endsWith("legacy-direct") ? "direct" : "kbrain", baseUrl: "https://must-not-be-called.invalid", apiKey: "unused-secret", reasoning: mode === "agent-controls" ? "minimal" : "max" }, sessionId: "frontend-session", conversationId,
      trajectoryMessageId: `message-${mode}`, conversationCwd: "/workspace", ...(mode.startsWith("agent") ? { effectiveWorkdir: "/workspace", ...(mode === "agent-controls" ? { additionalRoots: [{ id: "external", alias: "external-root", path: "/tmp/external", access: "read" }], planModeEnabled: mode === "agent-controls", getToolPolicies: () => ({ Read: "allow", Write: "ask", Bash: "deny", Browser: "allow", McpManager: "deny", "group:browser": "ask", "server:cua-driver": "allow" }), commandSafetyMode: "auto" } : {}) } : {}), createdAt: 1, fallbackTitle: "Inspect", titlePromise: null,
      transcriptStore: {}, cancellation: { userStop: controller },
      gatewayBridgeEvents: { queueToken() {}, queueEvent(event) { gatewayEvents.push(event); }, queueToolStatus() {}, emitError(message) { errors.push(message); } },
      hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => hooks.push(key)])),
      buildPreparedContext: () => context, getNextConversationState: () => state,
      applyConversationState: (value) => { state = value; },
      batchLiveRoundsUpdate: (update) => { rounds = update(rounds); },
      updateToolStatus() {}, updateGatewayBridgeToolStatus() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
      persistConversationWithHistorySync: async (value) => { persisted = value; return true; },
    });
    assert.equal(requests.find((request) => request.path.endsWith("/runs")).body.prompt, "inspect");
    // The tied approval re-pushes its call to the Gateway: marked while pending, unmarked once settled.
    const approvalSyncs = gatewayEvents
      .filter((event) => event.type === "tool_call" && event.id === "call")
      .map((event) => [event.arguments.__toolApprovalPending === true, event.arguments.__toolApprovalSessionWide === true]);
    assert.deepEqual(approvalSyncs, mode === "agent-scope-session" ? [[false, false], [true, true], [false, false]] : [[false, false]]);
    assert.equal(requests.find((request) => request.path.endsWith("/runs")).body.model.provider, "fixture");
    const runBody = requests.find((request) => request.path.endsWith("/runs")).body;
    assert.equal(runBody.options.mode, mode.startsWith("agent") ? "agent" : "chat");
    assert.deepEqual(runBody.options.workspace_roots, mode === "agent-controls" ? [{ path: "/workspace", access: "write" }, { path: "/tmp/external", access: "read" }] : [{ path: "/workspace", access: "write" }]);
    assert.equal(runBody.options.search, "disabled");
    assert.equal(runBody.options.approval_policy, mode === "agent-controls" ? "auto" : "ask");
    if (!mode.endsWith("no-backend")) assert.equal(runBody.options.reasoning, mode === "agent-controls" ? "minimal" : "max");
    if (mode === "agent-controls") {
      assert.deepEqual(runBody.options.tools.policies, { Bash: "deny", Read: "allow", Write: "ask" });
      assert.equal(runBody.options.plan_mode_enabled, true);
      assert.deepEqual(planMode.getPendingPlanForConversation(conversationId), { toolCallId: "plan-call", plan: "Review before implementation" });
    } else assert.equal(runBody.options.tools, undefined);
    assert.equal(JSON.stringify(runBody).includes("system message"), false);
    assert.equal(rounds[0].blocks.find((block) => block.kind === "text").text, "Hello");
    assert.equal(rounds[0].blocks.find((block) => block.kind === "thinking").text, "Checking");
    const expectedOutput = expectedDecision === "reject" ? "permission rejected" : "file contents";
    const toolResult = rounds[0].blocks.find((block) => block.kind === "tool" && block.item.toolCall.id === "call").item.toolResult;
    assert.equal(toolResult.content[0].text, expectedOutput);
    assert.equal(toolResult.isError, expectedDecision === "reject");
    assert.equal(rounds[0].blocks.find((block) => block.kind === "tool" && block.item.toolCall.id === "kbrain-subagent:child").item.toolResult.content[0].text, "Reviewed");
    const messages = persisted.state.segments.flatMap((segment) => segment.messages);
    if (mode === "agent-refresh-failed") {
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Reply completed, but history refresh failed:.*history temporarily unavailable/);
      assert.equal(requests.filter((request) => request.path.endsWith("/runs")).length, 1);
    } else {
      assert.deepEqual(errors, mode === "agent-failed" ? ["fixture upstream unavailable"] : []);
      if (mode !== "agent-failed") assert.equal(messages.find((message) => message.role === "user").id, "user-persisted");
    }
    assert.equal(messages.find((message) => message.role === "assistant").stopReason, mode === "agent-failed" ? "error" : "stop");
    assert.ok(messages.some((message) => message.role === "toolResult" && message.toolCallId === "call"));
    assert.ok(messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === "call")));
    const restored = buildUiMessages(messages);
    const restoredTools = restored.flatMap((message) => message.rounds ?? []).flatMap((round) => round.blocks).filter((block) => block.kind === "tool");
    assert.ok(restoredTools.some((block) => block.item.toolCall.id === "call" && block.item.toolResult.content[0].text === expectedOutput && block.item.toolResult.isError === (expectedDecision === "reject")));
    assert.ok(restoredTools.some((block) => block.item.toolCall.id === "kbrain-subagent:child" && block.item.toolResult.content[0].text === "Reviewed"));
    assert.deepEqual(hooks, ["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"]);
    assert.equal(approval.listPendingToolApprovalsForConversation(conversationId).length, 0);
  });
}

for (const [mode, runTurn] of [["text", runTextConversationTurn], ["agent", runAgentConversationTurn]]) {
  test(`${mode} shipped model switches gate HTTP native search without changing the preference`, async (t) => {
    const { normalizeCustomProvider, DEFAULT_CHAT_RUNTIME_CONTROLS } = loader.loadModule("src/lib/settings/index.ts");
    const { resolveEffectiveChatModelSelection } = loader.loadModule("src/pages/chat/runtime/modelSelection.ts");
    const { createProviderRuntimeConfig } = loader.loadModule("src/lib/providers/runtime/providerRuntimeConfig.ts");
    const providers = [
      ["compatible", "codex", "openai-completions", "https://relay.example/v1"],
      ["responses", "codex", "openai-responses", "https://relay.example/v1"],
      ["gemini", "gemini", undefined, "https://generativelanguage.googleapis.com/v1beta"],
      ["search-preview", "codex", "openai-completions", "https://api.openai.com/v1"],
    ].map(([id, type, requestFormat, baseUrl]) => Object.freeze(normalizeCustomProvider({
      id, name: id, type, requestFormat, baseUrl, models: ["gpt-4o-search-preview"], activeModels: ["gpt-4o-search-preview"],
    })));
    assert.ok(providers.every((provider) => provider.nativeWebSearchEnabled === true));
    const runs = [];
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const json = (value, code = 200) => {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/v1/sessions") return json({ id: "session" }, 201);
      if (request.url === "/v1/sessions/session/runs") {
        runs.push(JSON.parse(body));
        return json({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }, 202);
      }
      if (request.url.startsWith("/v1/sessions/session/events")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end([
          ["assistant.message.created", { role: "assistant", content: [{ type: "text", text: "Hello" }] }],
          ["run.completed", { state: "completed" }],
        ].map(([type, payload], index) => `data: ${JSON.stringify({ version: "kbrain.agent.v1", seq: index + 2, conversation_id: "session", run_id: "run", type, created_at: new Date().toISOString(), payload })}\n\n`).join(""));
        return;
      }
      if (request.url === "/v1/sessions/session" || request.url.startsWith("/v1/sessions/session/history")) {
        const messages = [
          { id: "user", role: "user", content: [{ type: "text", text: "hello" }] },
          { id: "assistant", role: "assistant", content: [{ type: "text", text: "Hello" }] },
        ];
        const session = { id: "session", revision: "saved", model: runs.at(-1).model, messages, message_count: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        return json(request.url.includes("/history") ? { session, revision: "saved", oldest_offset: 0, has_more_before: false, total_message_count: 2, active_messages: messages } : session);
      }
      json({ error: `Unexpected path ${request.url}` }, 404);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const originalStorage = globalThis.localStorage;
    const storage = new Map();
    globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
    setKBrainRuntimeConnection({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
    t.after(() => {
      clearKBrainRuntimeConnection();
      if (originalStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = originalStorage;
      server.closeAllConnections();
      server.close();
    });
    for (const enabled of [true, false]) {
      const controls = Object.freeze({ ...DEFAULT_CHAT_RUNTIME_CONTROLS, nativeWebSearchEnabled: enabled });
      const settings = { customProviders: providers, chatRuntimeControls: controls };
      for (const index of [1, 0, 2, 3, 1]) {
        const selectedModel = { customProviderId: providers[index].id, model: "gpt-4o-search-preview" };
        const selection = resolveEffectiveChatModelSelection({
          settings,
          ...(mode === "text" ? { conversationSelectedModel: selectedModel } : { gatewaySelectedModel: { ...selectedModel, providerType: providers[index].type } }),
        });
        const runtime = createProviderRuntimeConfig(selection.provider, selection.model, controls);
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
        let state = createConversationStateFromContext(context);
        const errors = [];
        await runTurn({
          ...selection, runtime, sessionId: "frontend-session", conversationId: `search-switch-${mode}`,
          conversationCwd: "/workspace", ...(mode === "agent" ? { effectiveWorkdir: "/workspace" } : {}),
          createdAt: 1, fallbackTitle: "Search", titlePromise: null, transcriptStore: {},
          cancellation: { userStop: new AbortController() }, buildPreparedContext: () => context,
          getNextConversationState: () => state, applyConversationState: (next) => { state = next; },
          batchLiveRoundsUpdate() {}, updateToolStatus() {}, updateGatewayBridgeToolStatus() {},
          freezeGatewayFinalProjection() {}, settleLiveTranscript() {}, persistConversationWithHistorySync: async () => true,
          gatewayBridgeEvents: { queueToken() {}, queueEvent() {}, queueToolStatus() {}, emitError: (error) => errors.push(error) },
          hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])),
        });
        assert.deepEqual(errors, []);
        assert.equal(runs.at(-1).model.provider, selectedModel.customProviderId);
        assert.equal(runs.at(-1).options.search, enabled && [1, 2].includes(index) ? "enabled" : "disabled");
        assert.equal(runs.at(-1).options.mode, mode === "text" ? "chat" : "agent");
        assert.equal(controls.nativeWebSearchEnabled, enabled);
        assert.equal(selection.provider.nativeWebSearchEnabled, true);
      }
    }
    assert.equal(runs.length, 10);
  });
}
