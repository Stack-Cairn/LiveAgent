import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Data handling behind the sandboxed UI: preview events and fences, MCP App resources and
// K-brain's tool naming, plugin list adoption, path checks, and capability gating.
const loader = createTsModuleLoader();
const previews = loader.loadModule("@liveagent/ui/lib/chat/htmlPreviews.ts");
const mcpApps = loader.loadModule("@liveagent/ui/lib/chat/mcpApps.ts");
const plugins = loader.loadModule("@liveagent/ui/lib/plugins/types.ts");
const { shouldAdoptPluginList } = loader.loadModule("@liveagent/ui/lib/plugins/usePluginList.ts");
const { resolvePathInsideWorkdir } = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/workspacePath.ts");

const previewEvent = (overrides = {}) => ({
  preview_id: "0123456789abcdef",
  source: "file",
  title: "Report",
  path: "/work/report.html",
  tool_call_id: "write-1",
  bytes: 2048,
  url: "/v1/sessions/s-1/previews/0123456789abcdef",
  created_at: "2026-11-22T10:00:00Z",
  ...overrides,
});

test("preview.created payloads are parsed strictly", () => {
  assert.deepEqual(previews.parseHtmlPreview(previewEvent()), {
    previewId: "0123456789abcdef", source: "file", title: "Report", path: "/work/report.html",
    toolCallId: "write-1", bytes: 2048, url: "/v1/sessions/s-1/previews/0123456789abcdef",
    createdAt: "2026-11-22T10:00:00Z",
  });
  assert.equal(previews.parseHtmlPreview(previewEvent({ preview_id: "../../etc" })), null);
  assert.equal(previews.parseHtmlPreview(previewEvent({ url: "https://example.com/x" })), null);
  assert.equal(previews.parseHtmlPreview(previewEvent({ url: "/v1/plugins/x" })), null);
  assert.equal(previews.parseHtmlPreview(null), null);
  assert.equal(previews.parseHtmlPreview(previewEvent({ source: "weird", bytes: -5 })).source, "message");
});

test("html preview fences are marked and their ids match the backend hash", async () => {
  const markdown = "Intro\n\n```html preview\n<h1>Hi</h1>\n<p>x</p>\n```\n\n```html\n<b>plain</b>\n```\n";
  const marked = previews.markHtmlPreviewFences(markdown);
  assert.ok(marked.includes("```html-preview\n<h1>"));
  assert.ok(marked.includes("```html\n<b>plain</b>"));
  // K-brain hashes the fence body with its trailing newline; the renderer drops it.
  const body = "<h1>Hi</h1>\n<p>x</p>\n";
  const backendId = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const candidates = await previews.htmlPreviewIdCandidates("<h1>Hi</h1>\n<p>x</p>");
  assert.ok(candidates.includes(backendId));
});

test("the preview store keeps one record per id and learns a later tool call id", () => {
  const conversation = "conv-previews";
  const message = previews.parseHtmlPreview(previewEvent({ source: "message", tool_call_id: undefined, path: undefined }));
  previews.recordHtmlPreviews(conversation, [message]);
  previews.recordHtmlPreviews(conversation, [message]);
  assert.equal(previews.listHtmlPreviews(conversation).length, 1);
  assert.equal(previews.findHtmlPreviewForToolCall(conversation, "write-1"), undefined);
  previews.recordHtmlPreviews(conversation, [previews.parseHtmlPreview(previewEvent())]);
  assert.equal(previews.findHtmlPreviewForToolCall(conversation, "write-1").previewId, "0123456789abcdef");
  previews.requestHtmlPreviewInSidePanel(conversation, "0123456789abcdef");
  const first = previews.readHtmlPreviewSidePanelRequest(conversation);
  previews.requestHtmlPreviewInSidePanel(conversation, "0123456789abcdef");
  assert.notEqual(previews.readHtmlPreviewSidePanelRequest(conversation).nonce, first.nonce);
  previews.clearHtmlPreviews(conversation);
  assert.deepEqual(previews.listHtmlPreviews(conversation), []);
});

test("ui_resource rides on tool result details and only on success", () => {
  const raw = { server_id: "fixture-apps", uri: "ui://fixture/chart", url: "/v1/sessions/s/mcp-ui?server=fixture-apps&uri=ui%3A%2F%2Ffixture%2Fchart" };
  const details = mcpApps.withMcpUiResourceDetails({ kept: true }, raw);
  assert.equal(details.kept, true);
  assert.deepEqual(mcpApps.readMcpUiResource(details), { serverId: "fixture-apps", uri: "ui://fixture/chart", url: raw.url });
  assert.equal(mcpApps.readMcpUiResource(mcpApps.withMcpUiResourceDetails({}, undefined)), null);
  assert.equal(mcpApps.readMcpUiResource(mcpApps.withMcpUiResourceDetails({}, { ...raw, url: "https://evil.example/x" })), null);
});

test("K-brain MCP tool names match the backend's server key rule", () => {
  // Reference values computed with K-brain's internal/mcp serverKey (fnv-1a 32).
  assert.equal(mcpApps.kbrainMcpToolName("fixture-apps", "show.chart"), "mcp__fixture-apps__show_chart");
  assert.equal(mcpApps.kbrainMcpToolName("my server", "show.chart"), "mcp__my-server_809ef0ee__show_chart");
  assert.equal(mcpApps.kbrainMcpToolName("a__b", "show.chart"), "mcp__a--b_749bc500__show_chart");
  assert.equal(mcpApps.kbrainMcpToolName("数据", "show.chart"), "mcp__--_87e94f15__show_chart");
  assert.equal(mcpApps.mcpToolShortName("mcp__fixture-apps__show_chart"), "show_chart");
});

test("MCP tool policy: exact name, then *, else allow; unknown values deny", () => {
  const full = "mcp__fixture-apps__refresh";
  assert.equal(mcpApps.resolveMcpToolPolicy(undefined, full), "allow");
  assert.equal(mcpApps.resolveMcpToolPolicy({}, full), "allow");
  assert.equal(mcpApps.resolveMcpToolPolicy({ "*": "ask" }, full), "ask");
  assert.equal(mcpApps.resolveMcpToolPolicy({ "*": "ask", [full]: "allow" }, full), "allow");
  assert.equal(mcpApps.resolveMcpToolPolicy({ [full]: "deny" }, full), "deny");
  assert.equal(mcpApps.resolveMcpToolPolicy({ [full]: "sometimes" }, full), "deny");
});

test("plugin lists parse, list panels per placement, and adopt only real changes", () => {
  const list = plugins.parsePluginList({
    revision: 4,
    workdir: "/work",
    trusted: true,
    plugins: [{
      id: "fixture-notes", name: "Fixture Notes", version: "1.0.0", source: "user", enabled: true, path: "/home/p",
      // Shape as kn 0.107.42 lists it: model-facing tool names, capability asset URLs.
      contributes: { tools: ["plugin_fixture-notes_note_add", "plugin_fixture-notes_note_list"], hooks: [], prompt: false, ui: [
        { id: "board", title: "Board", placement: "sidePane", entry: "board.html", url: "/v1/plugin-assets/9ac0a3ff/fixture-notes/board.html" },
        { id: "prefs", title: "Prefs", placement: "settings", entry: "prefs.html", url: "/v1/plugin-assets/9ac0a3ff/fixture-notes/prefs.html" },
      ] },
    }],
    errors: [],
  });
  assert.ok(list);
  assert.deepEqual(plugins.listPluginPanels(list, "sidePane").map(({ panel }) => panel.id), ["board"]);
  assert.deepEqual(plugins.listPluginPanels(list, "settings").map(({ panel }) => panel.id), ["prefs"]);
  // A panel's host.callTool takes plugin.json names, not the model-facing ones.
  assert.deepEqual(plugins.pluginManifestToolNames(list.plugins[0]), ["note_add", "note_list"]);
  assert.deepEqual(
    plugins.pluginManifestToolNames({ id: "a", contributes: { tools: ["plugin_b_x", "plain", "plugin_a_"] } }),
    ["plugin_b_x", "plain", "plugin_a_"],
  );
  assert.equal(shouldAdoptPluginList(null, list), true);
  assert.equal(shouldAdoptPluginList(list, { ...list }), false);
  assert.equal(shouldAdoptPluginList(list, { ...list, revision: 5 }), true);
  assert.equal(shouldAdoptPluginList(list, { ...list, workdir: "/other" }), true);
  assert.equal(plugins.parsePluginList({ plugins: "nope" }), null);
});

test("workdir path checks resolve relative paths and refuse escapes", () => {
  assert.equal(resolvePathInsideWorkdir("/work/p", "src/a.ts"), "/work/p/src/a.ts");
  assert.equal(resolvePathInsideWorkdir("/work/p", "./src/../b.ts"), "/work/p/b.ts");
  assert.equal(resolvePathInsideWorkdir("/work/p", "/work/p/c.ts"), "/work/p/c.ts");
  assert.equal(resolvePathInsideWorkdir("/work/p", "../q/x"), null);
  assert.equal(resolvePathInsideWorkdir("/work/p", "/work/pq/x"), null);
  assert.equal(resolvePathInsideWorkdir("/work/p", "C:\\x"), null);
  assert.equal(resolvePathInsideWorkdir("C:\\work\\p", "src\\a.ts"), "C:\\work\\p\\src\\a.ts");
  assert.equal(resolvePathInsideWorkdir("C:\\work\\p", "D:\\x"), null);
  assert.equal(resolvePathInsideWorkdir("", "a"), null);
});

test("html_previews reaches K-brain only when the backend advertises it", async () => {
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
  for (const capability of [true, false]) {
    let options;
    const client = createKBrainClient({
      baseUrl: "http://fixture.test",
      fetch: async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/v1/health") {
          return Response.json({ status: "ok", version: "kbrain.agent.v1", capabilities: capability ? { html_previews: 1 } : {} });
        }
        if (path.endsWith("/runs")) {
          options = JSON.parse(init.body).options;
          return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 }, { status: 202 });
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    await client.startRun({ conversation_id: "s", prompt: "hi", options: { html_previews: true } });
    assert.equal(options.html_previews, capability ? true : undefined, `capability=${capability}`);
  }
});

test("a turn records preview.created and keeps ui_resource on successful MCP results", async () => {
  const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
  let seq = 1;
  const event = (type, payload) =>
    `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", seq: ++seq, type, payload })}\n\n`;
  const ui = { server_id: "fixture-apps", uri: "ui://fixture/chart", url: "/v1/sessions/s/mcp-ui?server=fixture-apps&uri=ui%3A%2F%2Ffixture%2Fchart" };
  const stream = [
    event("tool.call", { tool_call: { id: "mcp-1", name: "mcp__fixture-apps__show_chart", arguments: {} } }),
    event("tool.result", { tool_result: { id: "mcp-1", name: "mcp__fixture-apps__show_chart", output: "chart ready", ui_resource: ui } }),
    event("tool.call", { tool_call: { id: "mcp-2", name: "mcp__fixture-apps__show_chart", arguments: {} } }),
    event("tool.result", { tool_result: { id: "mcp-2", name: "mcp__fixture-apps__show_chart", output: "boom", failed: true, ui_resource: ui } }),
    event("preview.created", previewEvent({ url: "/v1/sessions/s/previews/0123456789abcdef" })),
    event("preview.created", { preview_id: "bad" }),
    event("run.completed", {}),
  ].join("");
  let runOptions;
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/sessions") return Response.json({ id: "s" });
    if (path === "/v1/health") return Response.json({ status: "ok", version: "kbrain.agent.v1", capabilities: { html_previews: 1 } });
    if (path.endsWith("/runs")) {
      runOptions = JSON.parse(init.body).options ?? {};
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 });
    }
    if (path.endsWith("/events")) return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    throw new Error(`Unexpected request ${path}`);
  };
  const results = new Map();
  const created = [];
  await runKBrainTurn({
    baseUrl: "http://fixture.test", fetch, model: { provider: "fixture", model: "test" },
    sessionId: "frontend", conversationId: "sandboxed-ui", cwd: "/tmp", context: { messages: [] },
    prompt: "chart", signal: new AbortController().signal,
    onStatus() {}, onTextDelta() {}, onThinkingDelta() {}, onToolCall() {},
    onToolResult: (call, result) => results.set(call.id, result),
    onPreviewCreated: (preview) => created.push(preview),
  });
  assert.equal(runOptions.html_previews, true);
  assert.deepEqual(mcpApps.readMcpUiResource(results.get("mcp-1").details), { serverId: "fixture-apps", uri: ui.uri, url: ui.url });
  assert.equal(mcpApps.readMcpUiResource(results.get("mcp-2").details), null);
  assert.deepEqual(created.map((preview) => preview.previewId), ["0123456789abcdef"]);
});
