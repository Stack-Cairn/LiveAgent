import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const commands = loader.loadModule("@liveagent/ui/lib/shortcuts/shortcutCommands.ts");
const thinking = loader.loadModule("@liveagent/ui/lib/chat/thinkingLevels.ts");
const workbench = loader.loadModule("@liveagent/ui/lib/chat/workbenchCommands.ts");
const { buildCommandPaletteActions } = loader.loadModule("@liveagent/ui/lib/chat/commandPaletteActions.ts");
const settingsIndex = loader.loadModule("@liveagent/ui/lib/settings/settingsSearchIndex.ts");
const zoom = createTsModuleLoader({
  mocks: { "@liveagent/app/shims/tauriCore": { isTauri: () => false } },
}).loadModule("src/lib/system/webviewZoom.ts");

const readSource = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const NEW_COMMANDS = [
  "toggleTerminal",
  "cycleTheme",
  "navigateBack",
  "navigateForward",
  "cycleThinkingLevel",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "closeActiveContext",
];

test("every new command is rebindable, dispatched and backed by a palette action", () => {
  const sidebar = readSource("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx");
  const dispatched = sidebar.match(/const SIDEBAR_SHORTCUT_COMMANDS[^=]*=\s*\[([\s\S]*?)\];/)[1];
  const builder = readSource("../../../agent-ui/src/lib/chat/commandPaletteActions.ts");
  for (const id of NEW_COMMANDS) {
    const command = commands.getShortcutCommand(id);
    assert.ok(command, id);
    assert.ok(command.defaultBinding, `${id} has a default chord`);
    assert.ok(command.paletteActionId, `${id} runs a palette action`);
    assert.match(dispatched, new RegExp(`"${id}"`), `${id} is dispatched by the sidebar`);
    assert.match(builder, new RegExp(`id: "${command.paletteActionId}"`), `${id} palette action exists`);
  }
  // Rebinding one onto another flags the conflict both ways.
  const bindings = commands.SHORTCUT_COMMANDS.map((command) => ({
    id: command.id,
    accelerator: command.id === "zoomReset" ? "Mod+KeyJ" : commands.getShortcutBinding(command.id),
  }));
  assert.deepEqual([...commands.findShortcutConflicts(bindings, true).keys()].sort(), [
    "toggleTerminal",
    "zoomReset",
  ]);
});

test("thinking level cycles through the model's effort choices", () => {
  const levels = ["low", "medium", "high"];
  const step = (controls, options = levels, thinkingAlwaysOn = false) =>
    thinking.nextThinkingLevel({ reasoningOptions: options, thinkingAlwaysOn, controls });
  assert.deepEqual(step({ thinkingEnabled: false, reasoning: "medium" }).patch, {
    thinkingEnabled: true,
    reasoning: "low",
  }, "off → first level");
  assert.equal(step({ thinkingEnabled: true, reasoning: "medium" }).level, "high");
  assert.deepEqual(step({ thinkingEnabled: true, reasoning: "high" }).patch, { thinkingEnabled: false }, "wraps to off");
  assert.equal(step({ thinkingEnabled: true, reasoning: "high" }, levels, true).level, "low", "always-on models skip off");
  assert.deepEqual(step({ thinkingEnabled: false, reasoning: "high" }, ["high"]).patch, { thinkingEnabled: true }, "a plain switch toggles");
  assert.equal(step({ thinkingEnabled: true, reasoning: "high" }, ["high"], true), null, "always on, single level: nothing to cycle");
  assert.equal(step({ thinkingEnabled: false, reasoning: "high" }, []), null, "no thinking support");

  // The default level ("high") is not offered here, so the last one is used.
  const state = thinking.resolveThinkingLevels({
    reasoningOptions: ["low", "medium"],
    thinkingAlwaysOn: false,
    controls: { thinkingEnabled: true, reasoning: "xhigh" },
  });
  assert.deepEqual(state.choices, ["off", "low", "medium"]);
  assert.equal(state.selected, "medium", "an unsupported stored level falls back like the composer");
});

test("terminal toggle hides a shown terminal, otherwise shows the last used one", () => {
  const sessions = [
    { id: "t1", createdAt: 1 },
    { id: "t2", createdAt: 3 },
    { id: "t3", createdAt: 2 },
  ];
  const toggle = (input) => workbench.resolveTerminalToggle({ tabOrder: [], sessions, ...input });
  assert.deepEqual(toggle({ open: true, activeTabId: "t1" }), { kind: "close" });
  assert.deepEqual(
    toggle({ open: true, activeTabId: "file-tree", tabOrder: ["t3", "file-tree", "t1"] }),
    { kind: "open", sessionId: "t1" },
    "dock open on another tool: switch to the last terminal tab",
  );
  assert.deepEqual(toggle({ open: false, activeTabId: undefined }), { kind: "open", sessionId: "t2" }, "newest session");
  assert.deepEqual(toggle({ open: false, activeTabId: undefined, sessions: [] }), { kind: "open", sessionId: undefined });

  const state = { activeTabId: "file-tree", tabOrder: ["file-tree"], other: 1 };
  assert.deepEqual(workbench.activateRightDockTab(state, "t2"), {
    activeTabId: "t2",
    tabOrder: ["file-tree", "t2"],
    other: 1,
  });
  const active = { activeTabId: "t2", tabOrder: ["t2"] };
  assert.equal(workbench.activateRightDockTab(active, "t2"), active);
});

test("close current view: hub, focused dock, split pane, dock — never the last pane", () => {
  const target = (input) =>
    workbench.resolveCloseContextTarget({
      activeView: "chat",
      paneCount: 1,
      rightDockOpen: false,
      focusInDock: false,
      ...input,
    });
  assert.equal(target({ activeView: "skills-hub", paneCount: 3, rightDockOpen: true }), "hub");
  assert.equal(target({ paneCount: 2, rightDockOpen: true, focusInDock: true }), "dock");
  assert.equal(target({ paneCount: 2, rightDockOpen: true }), "pane");
  assert.equal(target({ rightDockOpen: true }), "dock");
  assert.equal(target({}), null);
});

test("webview zoom steps through presets, clamps and persists per device", () => {
  assert.equal(zoom.stepWebviewZoom(1, 1), 1.1);
  assert.equal(zoom.stepWebviewZoom(1, -1), 0.9);
  assert.equal(zoom.stepWebviewZoom(1.05, 1), 1.1, "between presets snaps up");
  assert.equal(zoom.stepWebviewZoom(1.05, -1), 1, "and down");
  assert.equal(zoom.stepWebviewZoom(2, 1), 2);
  assert.equal(zoom.stepWebviewZoom(0.5, -1), 0.5);
  assert.equal(zoom.clampWebviewZoom(9), 2);
  assert.equal(zoom.clampWebviewZoom("nope"), 1);
  const store = (value) => ({ getItem: (key) => (key === zoom.WEBVIEW_ZOOM_STORAGE_KEY ? value : null) });
  assert.equal(zoom.readStoredWebviewZoom(store("1.25")), 1.25);
  assert.equal(zoom.readStoredWebviewZoom(store(null)), 1);
  assert.equal(zoom.readStoredWebviewZoom(store("0.1")), 0.5);

  const capability = JSON.parse(readSource("../../src-tauri/capabilities/default.json"));
  assert.ok(capability.permissions.includes("core:webview:allow-set-webview-zoom"));
});

test("palette lists the new view commands with their chords", () => {
  const noop = () => {};
  const actions = buildCommandPaletteActions({
    t: (key) => key,
    isMac: true,
    theme: { current: "system", onToggle: noop },
    terminal: { onToggle: noop },
    thinking: { onCycle: noop },
    zoom: { level: 1.25, onZoomIn: noop, onZoomOut: noop, onReset: noop },
    closeContext: { onClose: noop },
  });
  const byId = new Map(actions.map((action) => [action.id, action]));
  assert.equal(byId.get("toggle-terminal").shortcut, "⌘J");
  assert.equal(byId.get("toggle-theme").shortcut, "⇧⌘L");
  assert.equal(byId.get("cycle-thinking-level").shortcut, "⌥⌘T");
  assert.equal(byId.get("zoom-in").shortcut, "⌘=");
  assert.equal(byId.get("zoom-out").shortcut, "⌘-");
  assert.equal(byId.get("zoom-reset").shortcut, "⌘0");
  assert.equal(byId.get("zoom-reset").label, "chat.commandPalette.zoomResetWithLevel".replace("{level}", "125%"));
  assert.equal(byId.get("close-active-context").shortcut, "⌥⌘W");

  const without = buildCommandPaletteActions({ t: (key) => key, isMac: true }).map((action) => action.id);
  for (const id of ["toggle-terminal", "cycle-thinking-level", "zoom-in", "close-active-context"]) {
    assert.equal(without.includes(id), false, `${id} needs its host handler`);
  }
});

test("hosts wire the commands; the WebUI leaves zoom to the browser", async () => {
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  const gatewayView = readSource("../../../agent-gateway/web/src/app/GatewayAppView.tsx");
  for (const source of [chatPage, gatewayView]) {
    assert.match(source, /terminal:/);
    assert.match(source, /thinking: nextThinkingLevel\(/);
    assert.match(source, /closeContext: closeActiveContextTarget\(\)/);
  }
  assert.match(chatPage, /zoom: !isKBrainBrowserHost\(\)/);
  assert.doesNotMatch(gatewayView, /zoom:/);

  const web = createTsModuleLoader().loadModule("../agent-gateway/web/src/agent-ui-adapters/settingsSearch.ts");
  for (const id of ["zoomIn", "zoomOut", "zoomReset", "findInConversation"]) {
    assert.ok(web.WEB_UNSUPPORTED_SHORTCUT_COMMANDS.includes(id), id);
  }
  const webAnchors = settingsIndex.settingsSearchEntriesFor(web.webSettingsSearch).map((entry) => entry.anchor);
  assert.equal(webAnchors.includes("shortcut-zoomIn"), false, "hidden shortcut rows are not searchable on the web");
  assert.equal(webAnchors.includes("shortcut-toggleTerminal"), true);
  assert.equal(webAnchors.includes("devices"), true);
});
