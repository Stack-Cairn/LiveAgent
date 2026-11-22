import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Plugin list fields of newer K-brain backends (toolDetails, per-panel errors), the
// error page's host.panelLoadError notification, and the MCP display name that is
// only written to backends that accept it.
const loader = createTsModuleLoader();
const plugins = loader.loadModule("@liveagent/ui/lib/plugins/types.ts");
const panelHost = loader.loadModule("@liveagent/ui/lib/sandboxed-ui/pluginPanelHost.ts");
const { mergeKBrainMcpSettings, mcpServerNamesChanged, fromKBrainMcpSettings } = loader.loadModule("src/lib/kbrain/mcp.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("toolDetails names a panel's tools; older lists still strip the model prefix", () => {
  const list = plugins.parsePluginList({
    revision: 1, workdir: "/work", trusted: true, errors: [],
    plugins: [{
      id: "fixture-notes", name: "Fixture Notes", version: "1.0.0", source: "user", enabled: true, path: "/p",
      contributes: {
        tools: ["plugin_fixture-notes_note_add", "plugin_fixture-notes_x2"],
        // A sanitized model name no longer maps back by prefix: note.list became x2.
        toolDetails: [
          { name: "note_add", modelName: "plugin_fixture-notes_note_add", description: "Add a note" },
          { name: "note.list", modelName: "plugin_fixture-notes_x2" },
          { description: "no name" },
        ],
        hooks: [], prompt: false,
        ui: [
          { id: "board", title: "Board", placement: "sidePane", entry: "board.html", url: "/v1/plugin-assets/9ac0a3ff/fixture-notes/board.html" },
          { id: "broken", title: "Broken", placement: "sidePane", entry: "missing.html", url: "/v1/plugin-assets/9ac0a3ff/fixture-notes/missing.html", errorCode: "entry_missing", error: "missing.html does not exist" },
        ],
      },
    }],
  });
  const plugin = list.plugins[0];
  assert.deepEqual(plugins.pluginManifestToolNames(plugin), ["note_add", "note.list"]);
  assert.deepEqual(plugin.contributes.toolDetails[1], { name: "note.list", modelName: "plugin_fixture-notes_x2", description: "" });
  const panels = plugins.listPluginPanels(list, "sidePane").map(({ panel }) => panel);
  assert.deepEqual(panels.map((panel) => [panel.id, panel.errorCode ?? null]), [["board", null], ["broken", "entry_missing"]]);
  assert.equal(panels[1].error, "missing.html does not exist");
});

test("host.panelLoadError is reported once, cleaned up; malformed ones are ignored", async () => {
  const errors = [];
  const posted = [];
  const host = panelHost.createPluginPanelHost({
    plugin: { id: "fixture-notes", name: "Fixture Notes", version: "1.0.0", tools: [] },
    panel: { id: "board", placement: "sidePane" },
    workdir: "/work",
    locale: "en-US",
    getTheme: () => ({ mode: "light", colors: {}, fontFamily: "sans-serif" }),
    notify: () => {},
    openFile: () => {},
    confirmToolCall: async () => "deny",
    callTool: async () => ({ output: "", failed: false }),
    onLoadError: (error) => errors.push(error),
    post: (message) => posted.push(message),
    grants: { has: () => false, add: () => {} },
  });
  host.receive({ jsonrpc: "2.0", method: "host.panelLoadError", params: { status: 503, code: "plugin_unavailable", message: "plugin\n  disabled" } });
  host.receive({ jsonrpc: "2.0", method: "host.panelLoadError", params: { code: "Bad Code!" } });
  await flush();
  assert.deepEqual(errors, [{ status: 503, code: "plugin_unavailable", message: "plugin disabled" }]);
  assert.equal(posted.length, 0, "notifications get no reply");
  assert.equal(panelHost.parsePanelLoadError({ code: "asset_too_large", message: "x".repeat(400), status: 4.5 }).message.length, 300);
  assert.equal(panelHost.parsePanelLoadError({ code: "asset_too_large", status: 4.5 }).status, undefined);
  assert.equal(panelHost.parsePanelLoadError(null), null);
});

test("MCP display names reach PUT /v1/mcp only when the backend takes them", () => {
  const current = { settings: { servers: [{ id: "apps", transport: "stdio", command: "fixture" }] } };
  const previous = fromKBrainMcpSettings(current, { servers: [], selected: [] });
  const next = { ...previous, servers: [{ ...previous.servers[0], name: "  Fixture Apps " }] };
  assert.equal(mcpServerNamesChanged(previous, next), true);
  assert.equal(mcpServerNamesChanged(previous, previous), false);
  const old = mergeKBrainMcpSettings(current, next, previous);
  assert.equal("name" in old.servers[0], false);
  const fresh = mergeKBrainMcpSettings(current, next, previous, { serverNames: true });
  assert.equal(fresh.servers[0].name, "Fixture Apps");
  // Clearing the name removes it; an unchanged name keeps K-brain's value.
  const named = { settings: { servers: [{ id: "apps", name: "Fixture Apps", transport: "stdio", command: "fixture" }] } };
  const before = fromKBrainMcpSettings(named, { servers: [], selected: [] });
  assert.equal(before.servers[0].name, "Fixture Apps");
  const cleared = { ...before, servers: [{ ...before.servers[0], name: "" }] };
  assert.equal("name" in mergeKBrainMcpSettings(named, cleared, before, { serverNames: true }).servers[0], false);
  assert.equal(mergeKBrainMcpSettings(named, before, before, { serverNames: true }).servers[0].name, "Fixture Apps");
});
