import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The MCP Apps / tool contract of newer K-brain backends (raw tool results, backend
// approvals, configured server ids, app-only tools) and the older behavior kept when a
// backend does not advertise it.
const source = (name) => new URL(`../../src/${name}`, import.meta.url).pathname;
const requests = [];
let respond = () => Response.json({});
const loader = createTsModuleLoader({
  mocks: {
    [source("lib/kbrain/transport.ts")]: {
      fetchKBrain: async (path, init = {}) => {
        requests.push({ path, init });
        return respond(path, init);
      },
    },
    [source("lib/kbrain/runtimeConnection.ts")]: {
      resolveKBrainClientOptions: () => ({ baseUrl: "http://fixture.test" }),
      subscribeKBrainRuntimeConnection: () => () => {},
    },
  },
});
const toolCall = loader.loadModule("@liveagent/ui/lib/mcp/toolCall.ts");
const mcpApps = loader.loadModule("@liveagent/ui/lib/chat/mcpApps.ts");
const apps = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/mcpAppHost.ts");
const protocol = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/protocol.ts");
const sandboxedUi = loader.loadModule("src/lib/kbrain/sandboxedUi.ts");
const toolList = loader.loadModule("src/lib/kbrain/mcpToolList.ts");
const { convertMessages } = loader.loadModule("src/lib/kbrain/history.ts");
const { applyChildEvent } = loader.loadModule("src/lib/kbrain/subagentEvents.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const RESULT_URL = "/v1/sessions/s-1/mcp-ui/results/4f0c9a1e7b2d3c5a6e8f9a0b1c2d3e4f";
const VIEW_URL = "/v1/sessions/s-1/mcp-ui?server=fixture-apps&uri=ui%3A%2F%2Ffixture%2Fchart";
const RAW = { content: [{ type: "text", text: "chart ready" }], structuredContent: { series: [1, 2, 3] } };
const APPROVAL = {
  id: "ap-1",
  name: "mcp__fixture-apps__refresh",
  server_id: "fixture-apps",
  tool_name: "refresh",
  policy: "ask",
  arguments: { range: "7d" },
  expires_at: "2026-11-22T10:05:00Z",
};

test("tools/call replies: status from older backends, raw result and approval from newer", () => {
  assert.deepEqual(toolCall.parseMcpToolCallResponse({ name: "x", output: "ok", failed: false }), {
    name: "x", output: "ok", failed: false, cancelled: false, status: "completed",
  });
  assert.equal(toolCall.parseMcpToolCallResponse({ output: "", cancelled: true }).status, "cancelled");
  assert.equal(toolCall.parseMcpToolCallResponse({ output: "", failed: true }).failed, true);
  const pending = toolCall.parseMcpToolCallResponse({ name: "x", output: "", status: "approval_required", approval: APPROVAL });
  assert.equal(pending.status, "approval_required");
  assert.equal(pending.failed, false);
  assert.deepEqual(pending.approval, {
    id: "ap-1", name: APPROVAL.name, serverId: "fixture-apps", toolName: "refresh", policy: "ask",
    arguments: { range: "7d" }, expiresAt: APPROVAL.expires_at,
  });
  // approval_required without an approval cannot be continued: it is a failure.
  assert.equal(toolCall.parseMcpToolCallResponse({ status: "approval_required" }).status, "failed");
  const done = toolCall.parseMcpToolCallResponse({ output: "chart ready", status: "completed", result: RAW });
  assert.deepEqual(toolCall.mcpToolCallViewResult(done), RAW);
  assert.deepEqual(toolCall.mcpToolCallViewResult(toolCall.parseMcpToolCallResponse({ output: "t", failed: true })), {
    content: [{ type: "text", text: "t" }], isError: true,
  });
});

test("caller and approval_id are only in the body when asked for", () => {
  assert.deepEqual(toolCall.mcpToolCallRequestBody("n", { a: 1 }, "/w"), { name: "n", arguments: { a: 1 }, cwd: "/w" });
  assert.deepEqual(toolCall.mcpToolCallRequestBody("n", {}, "", { caller: "app", approvalId: "ap-1" }), {
    name: "n", arguments: {}, caller: "app", approval_id: "ap-1",
  });
});

test("approval loop: approve repeats with the id, deny stops, 409 is a conflict", async () => {
  const calls = [];
  const replies = [
    { output: "", status: "approval_required", approval: APPROVAL },
    { output: "42", status: "completed" },
  ];
  const call = async (approvalId) => {
    calls.push(approvalId);
    return toolCall.parseMcpToolCallResponse(replies.shift());
  };
  const approved = await toolCall.runMcpToolCallWithApproval({ call, approve: async () => true });
  assert.equal(approved.kind, "done");
  assert.equal(approved.response.output, "42");
  assert.deepEqual(calls, [undefined, "ap-1"]);

  calls.length = 0;
  replies.push({ output: "", status: "approval_required", approval: APPROVAL });
  const denied = await toolCall.runMcpToolCallWithApproval({ call, approve: async () => false });
  assert.equal(denied.kind, "denied");
  assert.deepEqual(calls, [undefined]);

  let first = true;
  await assert.rejects(
    toolCall.runMcpToolCallWithApproval({
      call: async () => {
        if (first) {
          first = false;
          return toolCall.parseMcpToolCallResponse({ status: "approval_required", approval: APPROVAL });
        }
        throw Object.assign(new Error("approval expired"), { status: 409 });
      },
      approve: async () => true,
    }),
    (error) => error instanceof toolCall.McpToolApprovalConflictError && /expired/.test(error.message),
  );
});

test("ui_resource keeps tool_name, inline result and a well-formed result_url only", () => {
  const parsed = mcpApps.parseMcpUiResource({
    server_id: "fixture-apps", uri: "ui://fixture/chart", url: VIEW_URL,
    tool_name: "show_chart", result: RAW, result_url: RESULT_URL,
  });
  assert.deepEqual(parsed, {
    serverId: "fixture-apps", uri: "ui://fixture/chart", url: VIEW_URL,
    toolName: "show_chart", result: RAW, resultUrl: RESULT_URL,
  });
  // Older backends: the same three fields as before.
  assert.deepEqual(mcpApps.parseMcpUiResource({ server_id: "a", uri: "ui://a", url: VIEW_URL }), {
    serverId: "a", uri: "ui://a", url: VIEW_URL,
  });
  for (const bad of ["/v1/sessions/s/mcp-ui/results/../x", "https://evil.test/r", "/v1/sessions/s/mcp-ui/results/ABC"]) {
    assert.equal(mcpApps.parseMcpUiResource({ server_id: "a", uri: "ui://a", url: VIEW_URL, result_url: bad }).resultUrl, undefined);
  }
});

test("view result: inline result, else stored result_url, else the text output", async () => {
  const base = { serverId: "a", uri: "ui://a", url: VIEW_URL };
  const fetched = [];
  const fetchResult = async (url) => {
    fetched.push(url);
    return { content: [{ type: "text", text: "stored" }] };
  };
  assert.deepEqual(
    await mcpApps.resolveMcpAppToolResult({ resource: { ...base, result: RAW, resultUrl: RESULT_URL }, output: "o", failed: false, fetchResult }),
    RAW,
  );
  assert.deepEqual(fetched, []);
  assert.deepEqual(
    await mcpApps.resolveMcpAppToolResult({ resource: { ...base, resultUrl: RESULT_URL }, output: "o", failed: false, fetchResult }),
    { content: [{ type: "text", text: "stored" }] },
  );
  assert.deepEqual(fetched, [RESULT_URL]);
  const failing = async () => {
    throw new Error("404");
  };
  const text = { content: [{ type: "text", text: "o" }], isError: false };
  assert.deepEqual(await mcpApps.resolveMcpAppToolResult({ resource: { ...base, resultUrl: RESULT_URL }, output: "o", failed: false, fetchResult: failing }), text);
  assert.deepEqual(await mcpApps.resolveMcpAppToolResult({ resource: base, output: "o", failed: false, fetchResult }), text);
});

function appHost({ policy = "ask", backendApproval = false, replies = [], loadToolResult } = {}) {
  const posted = [];
  const calls = [];
  const confirms = [];
  const conflicts = [];
  const keys = new Set();
  let answer = "once";
  const view = apps.createMcpAppHost({
    serverId: "fixture-apps",
    serverLabel: "Fixture Apps",
    toolName: "show_chart",
    toolInput: {},
    toolOutput: "chart ready",
    toolFailed: false,
    ...(loadToolResult ? { loadToolResult } : {}),
    backendApproval,
    locale: "en-US",
    getTheme: () => ({ mode: "light", colors: {}, fontFamily: "sans-serif" }),
    resolveTool: async (_serverId, name) => ({ fullName: `mcp__fixture-apps__${name}`, policy }),
    callTool: async (fullName, args, approvalId) => {
      calls.push([fullName, args, approvalId]);
      const reply = replies.shift() ?? { output: "42", status: "completed" };
      if (reply instanceof Error) throw reply;
      return reply;
    },
    confirmToolCall: async (request) => {
      confirms.push(request);
      return answer;
    },
    onApprovalConflict: (message) => conflicts.push(message),
    onSizeChanged: () => {},
    post: (message) => posted.push(message),
    grants: { has: (key) => keys.has(key), add: (key) => keys.add(key) },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const request = async (id, method, params) => {
    view.receive({ jsonrpc: "2.0", id, method, params });
    await flush();
    await flush();
    return posted.find((message) => message.id === id);
  };
  return { view, posted, calls, confirms, conflicts, keys, request, setAnswer: (value) => { answer = value; } };
}

test("backend approvals: one confirmation, then the same call with approval_id", async () => {
  const host = appHost({
    backendApproval: true,
    replies: [{ output: "", status: "approval_required", approval: APPROVAL }, { output: "42", status: "completed", result: RAW }],
  });
  const reply = await host.request(1, "tools/call", { name: "refresh", arguments: { range: "7d" } });
  assert.deepEqual(reply.result, RAW);
  assert.equal(host.confirms.length, 1);
  assert.equal(host.confirms[0].approval.id, "ap-1");
  assert.deepEqual(host.confirms[0].args, { range: "7d" });
  assert.deepEqual(host.calls, [
    ["mcp__fixture-apps__refresh", { range: "7d" }, undefined],
    ["mcp__fixture-apps__refresh", { range: "7d" }, "ap-1"],
  ]);
});

test("backend approvals: no frontend ask when the backend runs the tool", async () => {
  const host = appHost({ backendApproval: true, replies: [{ output: "42", status: "completed" }] });
  const reply = await host.request(1, "tools/call", { name: "refresh" });
  assert.deepEqual(reply.result, { content: [{ type: "text", text: "42" }], isError: false });
  assert.equal(host.confirms.length, 0);
});

test("backend approvals: deny never repeats; allow-for-session approves the next prompt silently", async () => {
  const pending = () => ({ output: "", status: "approval_required", approval: APPROVAL });
  const host = appHost({ backendApproval: true, replies: [pending(), pending(), { output: "1", status: "completed" }, pending(), { output: "2", status: "completed" }] });
  host.setAnswer("deny");
  assert.equal((await host.request(1, "tools/call", { name: "refresh" })).error.code, protocol.SANDBOXED_UI_DENIED);
  assert.equal(host.calls.length, 1);
  host.setAnswer("always");
  await host.request(2, "tools/call", { name: "refresh" });
  const third = await host.request(3, "tools/call", { name: "refresh" });
  assert.equal(third.result.content[0].text, "2");
  assert.equal(host.confirms.length, 2);
  assert.deepEqual(host.calls.map((call) => call[2]), [undefined, undefined, "ap-1", undefined, "ap-1"]);
});

test("backend approvals: a 409 on the repeat reports the conflict", async () => {
  const host = appHost({
    backendApproval: true,
    replies: [{ output: "", status: "approval_required", approval: APPROVAL }, Object.assign(new Error("approval mismatch"), { status: 409 })],
  });
  const reply = await host.request(1, "tools/call", { name: "refresh" });
  assert.equal(reply.error.code, protocol.SANDBOXED_UI_EXECUTION_FAILED);
  assert.deepEqual(host.conflicts, ["approval mismatch"]);
});

test("older backends: the host asks for ask tools, exactly once per call", async () => {
  const host = appHost({ replies: [{ output: "42", failed: false }] });
  const reply = await host.request(1, "tools/call", { name: "refresh" });
  assert.deepEqual(reply.result, { content: [{ type: "text", text: "42" }], isError: false });
  assert.equal(host.confirms.length, 1);
  assert.equal(host.confirms[0].approval, undefined);
  assert.deepEqual(host.calls.map((call) => call[2]), [undefined]);
});

test("tool-result carries the raw result when one is available, else the text", async () => {
  const withRaw = appHost({ loadToolResult: async () => RAW });
  await withRaw.request(1, "ui/initialize", {});
  withRaw.view.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  await flush();
  assert.deepEqual(withRaw.posted.find((message) => message.method === "ui/notifications/tool-result").params, RAW);

  const failing = appHost({ loadToolResult: async () => { throw new Error("gone"); } });
  await failing.request(1, "ui/initialize", {});
  failing.view.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  await flush();
  await flush();
  assert.deepEqual(failing.posted.find((message) => message.method === "ui/notifications/tool-result").params, {
    content: [{ type: "text", text: "chart ready" }], isError: false,
  });
});

test("capabilities are read from health; every field defaults off", () => {
  const none = sandboxedUi.sandboxedUiCapabilitiesFromHealth({ capabilities: { mcp_apps: 1 } });
  assert.equal(none.mcpApps, true);
  assert.equal(none.mcpToolCallApproval, false);
  const all = sandboxedUi.sandboxedUiCapabilitiesFromHealth({
    capabilities: {
      mcp_apps_structured_content: 1, mcp_tool_visibility: 1, mcp_tool_call_approval: 1, mcp_tool_server_ids: 1,
      plugin_tool_names: 1, plugin_ui_errors: 1, plugin_manifest_unknown_fields: 1,
    },
  });
  for (const key of ["mcpAppsStructuredContent", "mcpToolVisibility", "mcpToolCallApproval", "mcpToolServerIds", "pluginToolNames", "pluginUiErrors", "pluginManifestUnknownFields"]) {
    assert.equal(all[key], true, key);
  }
  assert.equal(sandboxedUi.sameSandboxedUiCapabilities(none, { ...none }), true);
  assert.equal(sandboxedUi.sameSandboxedUiCapabilities(none, all), false);
});

test("serverId/serverKey: older replies resolve by derived name, newer by serverToolName", () => {
  // "my.apps" is not a simple name, so its name key carries a hash.
  const key = mcpApps.kbrainMcpServerKey("my.apps");
  assert.notEqual(key, "my.apps");
  const fullName = `mcp__${key}__show_chart`;
  const settings = { settings: { servers: [{ id: "my.apps", name: "My Apps", policy: { [fullName]: "ask" } }] } };

  const old = sandboxedUi.indexKBrainMcpServerTools("my.apps", { tools: [{ name: fullName, serverId: key, toolName: "show_chart" }] }, settings);
  assert.deepEqual(sandboxedUi.resolveMcpLookupTool(old, "my.apps", "show_chart"), { fullName, policy: "ask" });

  const fresh = sandboxedUi.indexKBrainMcpServerTools(
    "my.apps",
    { tools: [{ name: fullName, serverId: "my.apps", serverKey: key, serverLabel: "My Apps", toolName: "show_chart", serverToolName: "show-chart", visibility: ["app"] }] },
    settings,
  );
  assert.deepEqual(sandboxedUi.resolveMcpLookupTool(fresh, "my.apps", "show-chart"), { fullName, policy: "ask" });
  // The server's own name, not the sanitized one, is what a view calls.
  assert.equal(sandboxedUi.resolveMcpLookupTool(fresh, "my.apps", "other"), null);
  assert.equal(fresh.label, "My Apps");
});

test("the desktop sends caller/approval_id/audience only when told to", async () => {
  requests.length = 0;
  respond = () => Response.json({ name: "n", output: "ok", status: "completed", result: RAW });
  const response = await sandboxedUi.callKBrainMcpTool("/w", "mcp__a__t", { x: 1 });
  assert.deepEqual(JSON.parse(requests[0].init.body), { name: "mcp__a__t", arguments: { x: 1 }, cwd: "/w" });
  assert.deepEqual(response.result, RAW);
  await sandboxedUi.callKBrainMcpTool("/w", "mcp__a__t", {}, { appCaller: true, approvalId: "ap-1" });
  assert.deepEqual(JSON.parse(requests[1].init.body), { name: "mcp__a__t", arguments: {}, cwd: "/w", caller: "app", approval_id: "ap-1" });

  requests.length = 0;
  respond = (path) => Response.json(path.startsWith("/v1/mcp/tools") ? { tools: [] } : { settings: { servers: [] } });
  await sandboxedUi.resolveKBrainMcpAppTool("/w1", "apps", "t");
  await sandboxedUi.resolveKBrainMcpAppTool("/w2", "apps", "t", { appAudience: true });
  const toolPaths = requests.map((entry) => entry.path).filter((path) => path.startsWith("/v1/mcp/tools"));
  assert.equal(new URL(toolPaths[0], "http://x").searchParams.has("audience"), false);
  assert.equal(new URL(toolPaths[1], "http://x").searchParams.get("audience"), "app");

  requests.length = 0;
  respond = () => Response.json({ version: "kbrain.agent.v1", tool_call_id: "c", result: RAW });
  assert.deepEqual(await sandboxedUi.loadKBrainMcpToolResult(RESULT_URL), RAW);
  await assert.rejects(sandboxedUi.loadKBrainMcpToolResult("/v1/plugins/x"));
  assert.equal(requests.length, 1);
});

test("model tool list: app-only tools drop out, safe names stay on the name key", () => {
  const key = mcpApps.kbrainMcpServerKey("my.apps");
  const oldInfos = toolList.kbrainModelMcpToolInfos({ tools: [{ name: `mcp__${key}__a`, serverId: key, toolName: "a" }] });
  assert.deepEqual(oldInfos.map((info) => [info.serverId, info.serverKey, info.fullName]), [[key, key, `mcp__${key}__a`]]);
  const newInfos = toolList.kbrainModelMcpToolInfos({
    tools: [
      { name: `mcp__${key}__a`, serverId: "my.apps", serverKey: key, toolName: "a", visibility: ["model", "app"] },
      { name: `mcp__${key}__b`, serverId: "my.apps", serverKey: key, toolName: "b", visibility: ["app"] },
      { name: `mcp__${key}__c`, serverId: "my.apps", serverKey: key, toolName: "c", visibility: ["future"] },
    ],
  });
  assert.deepEqual(newInfos.map((info) => [info.serverId, info.serverKey, info.name]), [["my.apps", key, "a"], ["my.apps", key, "c"]]);
  const summaries = toolList.kbrainMcpServerToolSummaries([
    { tools: [{ name: "mcp__k__a", serverId: "my.apps", serverLabel: "My Apps", uiResourceUri: "ui://a", visibility: ["model", "app"] }] },
    { tools: [
      { name: "mcp__k__a", serverId: "my.apps", serverLabel: "My Apps", uiResourceUri: "ui://a", visibility: ["model", "app"] },
      { name: "mcp__k__b", serverId: "my.apps", serverLabel: "My Apps", visibility: ["app"] },
    ] },
  ]);
  assert.deepEqual(summaries.get("my.apps"), { label: "My Apps", uiTools: 1, appOnlyTools: 1 });
});

test("history and subagent transcripts re-create the view from tool_calls[].ui_resource", () => {
  const ui = { server_id: "fixture-apps", uri: "ui://fixture/chart", url: VIEW_URL, tool_name: "show_chart", result_url: RESULT_URL };
  const history = convertMessages([
    { role: "assistant", content: [], tool_calls: [{ id: "c1", name: "mcp__fixture-apps__show_chart", arguments: {}, ui_resource: ui }] },
    { role: "tool", tool_call_id: "c1", name: "mcp__fixture-apps__show_chart", content: [{ type: "text", text: "chart ready" }] },
  ]);
  const toolResult = history.find((message) => message.role === "toolResult");
  assert.deepEqual(mcpApps.readMcpUiResource(toolResult.details), {
    serverId: "fixture-apps", uri: ui.uri, url: VIEW_URL, toolName: "show_chart", resultUrl: RESULT_URL,
  });

  const event = (seq, type, payload) => ({ seq, type, created_at: "2026-11-22T10:00:00Z", payload: { task_id: "t", ...payload } });
  let messages = [];
  messages = applyChildEvent(messages, event(1, "trajectory.child.tool_start", { id: "c2", name: "mcp__fixture-apps__show_chart", arguments: "{}" }));
  messages = applyChildEvent(messages, event(2, "trajectory.child.tool_end", { id: "c2", name: "mcp__fixture-apps__show_chart", output: "chart ready", ui_resource: { ...ui, result: RAW } }));
  const child = convertMessages(messages).find((message) => message.role === "toolResult");
  assert.deepEqual(mcpApps.readMcpUiResource(child.details).result, RAW);
});
