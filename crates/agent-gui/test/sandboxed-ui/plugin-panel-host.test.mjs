import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// host.* for plugin UI panels: identity comes from the loaded panel, host.callTool reaches
// only the panel's own plugin tools and asks first, host.openFile stays inside the workdir.
const loader = createTsModuleLoader();
const host = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/pluginPanelHost.ts");
const protocol = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/protocol.ts");
const { PluginsHttpError } = loader.loadModule("@liveagent/ui/lib/plugins/types.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const theme = { mode: "dark", colors: { background: "#000000" }, fontFamily: "sans-serif" };

function memoryGrants() {
  const keys = new Set();
  return { keys, has: (key) => keys.has(key), add: (key) => keys.add(key) };
}

function panelHost(overrides = {}) {
  const posted = [];
  const calls = [];
  const confirms = [];
  const opened = [];
  const notices = [];
  const grants = memoryGrants();
  let answer = "once";
  const panel = host.createPluginPanelHost({
    plugin: { id: "fixture-notes", name: "Fixture Notes", version: "1.0.0", tools: ["note_add"] },
    panel: { id: "board", placement: "sidePane" },
    workdir: "/work/project",
    locale: "en-US",
    getTheme: () => theme,
    notify: (message, level) => notices.push([message, level]),
    openFile: (path, line) => opened.push([path, line]),
    confirmToolCall: async (request) => {
      confirms.push(request);
      return answer;
    },
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { output: `ran ${name}`, failed: false };
    },
    post: (message) => posted.push(message),
    grants,
    ...overrides,
  });
  const request = async (id, method, params) => {
    panel.receive({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    await flush();
    return posted.find((message) => message.id === id);
  };
  return {
    panel, posted, calls, confirms, opened, notices, grants, request,
    setAnswer: (value) => { answer = value; },
  };
}

test("initialize returns the loaded panel's identity, theme and method list", async () => {
  const { panel, request } = panelHost();
  assert.equal(panel.initialized, false);
  const reply = await request(1, "host.initialize", { plugin: { id: "spoofed" } });
  assert.equal(panel.initialized, true);
  assert.equal(reply.result.protocolVersion, "1");
  assert.deepEqual(reply.result.plugin, { id: "fixture-notes", version: "1.0.0" });
  assert.deepEqual(reply.result.panel, { id: "board", placement: "sidePane" });
  assert.deepEqual(reply.result.methods, [...host.PLUGIN_PANEL_METHODS]);
});

test("theme and visibility notifications start only after initialize", async () => {
  const { panel, posted, request } = panelHost();
  panel.themeChanged();
  panel.visibilityChanged(false);
  assert.equal(posted.length, 0);
  await request(1, "host.initialize");
  panel.themeChanged();
  panel.visibilityChanged(false);
  assert.equal(posted[1].method, "panel.themeChanged");
  assert.deepEqual(posted[2], { jsonrpc: "2.0", method: "panel.visibilityChanged", params: { visible: false } });
});

test("host.callTool asks before running the plugin's own tool", async () => {
  const { calls, confirms, request } = panelHost();
  const reply = await request(1, "host.callTool", { name: "note_add", arguments: { text: "hi" } });
  assert.equal(confirms.length, 1);
  assert.deepEqual(confirms[0], { pluginId: "fixture-notes", pluginName: "Fixture Notes", toolName: "note_add", args: { text: "hi" } });
  assert.deepEqual(calls, [["note_add", { text: "hi" }]]);
  assert.deepEqual(reply.result, { output: "ran note_add", failed: false });
  // "Allow once" does not remember: the next call asks again.
  await request(2, "host.callTool", { name: "note_add" });
  assert.equal(confirms.length, 2);
});

test("a denied confirmation never calls the tool", async () => {
  const { calls, request, setAnswer } = panelHost();
  setAnswer("deny");
  const reply = await request(1, "host.callTool", { name: "note_add", arguments: {} });
  assert.equal(reply.error.code, protocol.SANDBOXED_UI_DENIED);
  assert.equal(calls.length, 0);
});

test("allow for the session remembers this plugin's tool only", async () => {
  const { confirms, grants, request, setAnswer } = panelHost();
  setAnswer("always");
  await request(1, "host.callTool", { name: "note_add" });
  await request(2, "host.callTool", { name: "note_add" });
  assert.equal(confirms.length, 1);
  assert.deepEqual([...grants.keys], ["fixture-notes\u0000note_add"]);
});

test("other plugins' tools and built-ins are refused with -32002, without a dialog", async () => {
  const { calls, confirms, request } = panelHost();
  for (const [id, name] of [[1, "Bash"], [2, "other_plugin_tool"], [3, "plugin__fixture-notes__note_add"]]) {
    const reply = await request(id, "host.callTool", { name });
    assert.equal(reply.error.code, protocol.SANDBOXED_UI_NOT_ALLOWED);
  }
  assert.equal(confirms.length, 0);
  assert.equal(calls.length, 0);
});

test("host.callTool validates params and allows one pending confirmation", async () => {
  let release;
  const { request, panel, posted } = panelHost({
    confirmToolCall: () => new Promise((resolve) => { release = resolve; }),
  });
  assert.equal((await request(1, "host.callTool", { name: "" })).error.code, protocol.JSONRPC_INVALID_PARAMS);
  assert.equal((await request(2, "host.callTool", { name: "note_add", arguments: [1] })).error.code, protocol.JSONRPC_INVALID_PARAMS);
  panel.receive({ jsonrpc: "2.0", id: 3, method: "host.callTool", params: { name: "note_add" } });
  await flush();
  const second = await request(4, "host.callTool", { name: "note_add" });
  assert.equal(second.error.code, protocol.SANDBOXED_UI_LIMIT_EXCEEDED);
  release("deny");
  await flush();
  assert.equal(posted.find((message) => message.id === 3).error.code, protocol.SANDBOXED_UI_DENIED);
});

test("a tool the backend no longer has (404) maps to -32002", async () => {
  const { request } = panelHost({
    callTool: async () => { throw new PluginsHttpError(404, "tool not found"); },
  });
  const reply = await request(1, "host.callTool", { name: "note_add" });
  assert.equal(reply.error.code, protocol.SANDBOXED_UI_NOT_ALLOWED);
});

test("host.openFile opens paths inside the workdir and refuses the rest", async () => {
  const { opened, request } = panelHost();
  assert.equal((await request(1, "host.openFile", { path: "notes/todo.md", line: 3 })).result, null);
  assert.equal((await request(2, "host.openFile", { path: "/work/project/README.md" })).result, null);
  assert.deepEqual(opened, [["/work/project/notes/todo.md", 3], ["/work/project/README.md", undefined]]);
  for (const [id, path] of [[3, "../secrets.txt"], [4, "/etc/passwd"], [5, "/work/project-other/x"], [6, "a\u0000b"]]) {
    assert.equal((await request(id, "host.openFile", { path })).error.code, protocol.SANDBOXED_UI_NOT_ALLOWED, path);
  }
  assert.equal((await request(7, "host.openFile", { path: "a.md", line: 0 })).error.code, protocol.JSONRPC_INVALID_PARAMS);
  assert.equal(opened.length, 2);
  const noWorkdir = panelHost({ workdir: undefined });
  assert.equal((await noWorkdir.request(1, "host.openFile", { path: "a.md" })).error.code, protocol.SANDBOXED_UI_NOT_ALLOWED);
});

test("host.notify is plain text, capped at 200 characters and coalesced", async () => {
  const { notices, request } = panelHost();
  await request(1, "host.notify", { message: "Saved", level: "success" });
  await request(2, "host.notify", { message: "Saved", level: "success" });
  await request(3, "host.notify", { message: "x".repeat(500), level: "bogus" });
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[0], ["Saved", "success"]);
  assert.equal(notices[1][0].length, host.HOST_NOTIFY_MAX_CHARS);
  assert.equal(notices[1][1], "info");
  assert.equal((await request(4, "host.notify", { message: 5 })).error.code, protocol.JSONRPC_INVALID_PARAMS);
});

test("notify coalescer allows three distinct notices per five seconds", () => {
  let clock = 0;
  const shown = [];
  const notify = host.createNotifyCoalescer((message) => shown.push(message), () => clock);
  for (const message of ["a", "b", "c", "d"]) notify(message, "info");
  assert.deepEqual(shown, ["a", "b", "c"]);
  clock = 5000;
  notify("d", "info");
  assert.deepEqual(shown, ["a", "b", "c", "d"]);
});

test("methods outside the allowlist are not found", async () => {
  const { request } = panelHost();
  for (const [id, method] of [[1, "host.readFile"], [2, "host.exec"], [3, "tools/call"]]) {
    assert.equal((await request(id, method, {})).error.code, protocol.JSONRPC_METHOD_NOT_FOUND);
  }
});
