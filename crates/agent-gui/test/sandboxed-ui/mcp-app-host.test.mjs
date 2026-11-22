import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// MCP App views: tools/call stays on the view's own server and follows the tool policy
// (deny rejects, ask confirms, allow/unset runs); data is pushed after the handshake.
const loader = createTsModuleLoader();
const apps = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/mcpAppHost.ts");
const protocol = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/protocol.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const theme = { mode: "light", colors: { background: "#ffffff", foreground: "#111111", muted: "#666666", border: "#dddddd", accent: "#3366ff" }, fontFamily: "sans-serif" };

function appHost({ policies = {}, overrides = {} } = {}) {
  const posted = [];
  const calls = [];
  const confirms = [];
  const lookups = [];
  const sizes = [];
  const timers = [];
  const keys = new Set();
  let answer = "once";
  const view = apps.createMcpAppHost({
    serverId: "fixture-apps",
    serverLabel: "fixture-apps",
    toolName: "show_chart",
    toolInput: { series: [1, 2, 3] },
    toolOutput: "chart ready",
    toolFailed: false,
    locale: "en-US",
    getTheme: () => theme,
    resolveTool: async (serverId, toolName) => {
      lookups.push([serverId, toolName]);
      if (!(toolName in policies)) return null;
      return { fullName: `mcp__${serverId}__${toolName}`, policy: policies[toolName] };
    },
    callTool: async (fullName, args) => {
      calls.push([fullName, args]);
      return { output: "42", failed: false };
    },
    confirmToolCall: async (request) => {
      confirms.push(request);
      return answer;
    },
    onSizeChanged: (height) => sizes.push(height),
    post: (message) => posted.push(message),
    grants: { has: (key) => keys.has(key), add: (key) => keys.add(key) },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
    ...overrides,
  });
  const request = async (id, method, params) => {
    view.receive({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    await flush();
    return posted.find((message) => message.id === id);
  };
  return { view, posted, calls, confirms, lookups, sizes, timers, keys, request, setAnswer: (value) => { answer = value; } };
}

test("ui/initialize answers with host context; tool data follows initialized", async () => {
  const { view, posted, request, timers } = appHost();
  const reply = await request(1, "ui/initialize", { protocolVersion: "2026-01-26" });
  assert.equal(reply.result.protocolVersion, "2026-01-26");
  assert.equal(reply.result.hostContext.theme, "light");
  assert.equal(reply.result.hostContext.toolInfo.tool.name, "show_chart");
  // No link opening offered when the host has no confirmed opener.
  assert.equal("openLinks" in reply.result.hostCapabilities, false);
  view.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  await flush();
  const notes = posted.filter((message) => message.method);
  assert.deepEqual(notes.map((note) => note.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.deepEqual(notes[0].params, { arguments: { series: [1, 2, 3] } });
  assert.deepEqual(notes[1].params, { content: [{ type: "text", text: "chart ready" }], isError: false });
  // The grace timer that would send the same data again is a no-op now.
  timers[0]();
  assert.equal(posted.filter((message) => message.method).length, 2);
});

test("a view that never sends initialized still gets its data after the grace timer", async () => {
  const { posted, request, timers } = appHost();
  await request(1, "ui/initialize", {});
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(posted.filter((message) => message.method).length, 2);
});

test("policy deny rejects without a dialog", async () => {
  const { calls, confirms, request } = appHost({ policies: { refresh: "deny" } });
  const reply = await request(1, "tools/call", { name: "refresh", arguments: {} });
  assert.equal(reply.error.code, protocol.SANDBOXED_UI_NOT_ALLOWED);
  assert.equal(confirms.length, 0);
  assert.equal(calls.length, 0);
});

test("policy ask confirms first; deny stops, allow for session remembers", async () => {
  const { calls, confirms, keys, request, setAnswer } = appHost({ policies: { refresh: "ask" } });
  setAnswer("deny");
  assert.equal((await request(1, "tools/call", { name: "refresh" })).error.code, protocol.SANDBOXED_UI_DENIED);
  assert.equal(calls.length, 0);
  setAnswer("always");
  const reply = await request(2, "tools/call", { name: "refresh", arguments: { range: "7d" } });
  assert.deepEqual(reply.result, { content: [{ type: "text", text: "42" }], isError: false });
  await request(3, "tools/call", { name: "refresh" });
  assert.equal(confirms.length, 2);
  assert.deepEqual(confirms[1], { serverId: "fixture-apps", serverLabel: "fixture-apps", toolName: "refresh", args: { range: "7d" } });
  assert.deepEqual([...keys], ["mcp__fixture-apps__refresh"]);
  assert.equal(calls.length, 2);
});

test("policy allow runs directly", async () => {
  const { calls, confirms, request } = appHost({ policies: { refresh: "allow" } });
  const reply = await request(1, "tools/call", { name: "refresh" });
  assert.equal(reply.result.isError, false);
  assert.equal(confirms.length, 0);
  assert.deepEqual(calls, [["mcp__fixture-apps__refresh", {}]]);
});

test("tools are looked up on the view's own server only", async () => {
  const { lookups, request } = appHost({ policies: {} });
  const reply = await request(1, "tools/call", { name: "mcp__other__delete_everything" });
  assert.equal(reply.error.code, protocol.SANDBOXED_UI_NOT_ALLOWED);
  assert.deepEqual(lookups, [["fixture-apps", "mcp__other__delete_everything"]]);
});

test("size-changed is clamped; unknown methods and bad links are refused", async () => {
  const opened = [];
  const { view, sizes, request } = appHost({
    overrides: { confirmOpenLink: async () => true, openExternal: (url) => opened.push(url) },
  });
  for (const height of [10, 300, 99999, -1, "200"]) {
    view.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } });
  }
  await flush();
  assert.deepEqual(sizes, [apps.MCP_APP_MIN_HEIGHT, 300, apps.MCP_APP_MAX_HEIGHT]);
  assert.equal((await request(1, "ui/open-link", { url: "javascript:alert(1)" })).error.code, protocol.JSONRPC_INVALID_PARAMS);
  assert.equal((await request(2, "ui/open-link", { url: "file:///etc/passwd" })).error.code, protocol.JSONRPC_INVALID_PARAMS);
  assert.deepEqual((await request(3, "ui/open-link", { url: "https://example.com/docs" })).result, {});
  assert.deepEqual(opened, ["https://example.com/docs"]);
  assert.equal((await request(4, "resources/read", { uri: "ui://x" })).error.code, protocol.JSONRPC_METHOD_NOT_FOUND);
});

test("theme changes reach the view only after initialize", async () => {
  const { view, posted, request } = appHost();
  view.themeChanged();
  assert.equal(posted.length, 0);
  await request(1, "ui/initialize", {});
  view.themeChanged();
  assert.equal(posted.at(-1).method, "ui/notifications/host-context-changed");
  assert.equal(posted.at(-1).params.theme, "light");
});
