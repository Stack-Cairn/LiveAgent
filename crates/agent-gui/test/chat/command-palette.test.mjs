import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const iconProxy = () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? false : () => null) });

async function createEnv(pending = []) {
  return createDomTestEnv({
    mocks: {
      "../IconSet": iconProxy(),
      "../../components/IconSet": iconProxy(),
      "@liveagent/ui/components/IconSet": iconProxy(),
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "en" }) },
      "@liveagent/ui/lib/chat/conversationSearch": {
        searchPersistedConversations: (args) =>
          new Promise((resolve, reject) => pending.push({ args, resolve, reject })),
      },
    },
  });
}

const action = (id, group, label, extra = {}) => ({ id, group, label, run() {}, ...extra });

test("command palette filter is case-insensitive, token based and keeps group order", async () => {
  const env = await createEnv();
  try {
    const { filterCommandPaletteActions, parseCommandPaletteQuery } = env.loadModule(
      "@liveagent/ui/lib/chat/commandPalette.ts",
    );
    const actions = [
      action("model:a", "models", "Switch model: OpenAI / GPT", { searchOnly: true }),
      action("toggle-theme", "view", "Switch to dark theme", { keywords: ["appearance"] }),
      action("settings:providers", "settings", "Settings: Providers", { searchOnly: true, keywords: ["settings", "providers"] }),
      action("new", "suggested", "New conversation"),
      action("open-settings", "suggested", "Open settings", { keywords: ["preferences"] }),
    ];
    const ids = (query) => filterCommandPaletteActions(actions, query).map((item) => item.id);

    assert.deepEqual(ids(""), ["new", "open-settings", "toggle-theme"], "empty query hides search-only actions");
    assert.deepEqual(ids("THEME"), ["toggle-theme"]);
    assert.deepEqual(ids("appearance"), ["toggle-theme"], "keywords match");
    assert.deepEqual(ids("settings prov"), ["settings:providers"], "every token must match");
    assert.deepEqual(ids("gpt"), ["model:a"], "search-only actions appear once typed");
    assert.deepEqual(ids("settings"), ["settings:providers", "open-settings"], "label prefix ranks first");
    assert.deepEqual(ids("nothing-matches"), []);

    assert.deepEqual(parseCommandPaletteQuery("  > theme "), { actionsOnly: true, query: "theme" });
    assert.deepEqual(parseCommandPaletteQuery(" theme "), { actionsOnly: false, query: "theme" });
    assert.deepEqual(parseCommandPaletteQuery(">"), { actionsOnly: true, query: "" });
  } finally {
    env.cleanup();
  }
});

test("Cmd+K on macOS / Ctrl+K elsewhere, never inside editors, terminals or IME", async () => {
  const env = await createEnv();
  try {
    const { isCommandPaletteShortcut, isCommandPaletteSuppressed } = env.loadModule(
      "@liveagent/ui/lib/chat/commandPalette.ts",
    );
    const body = document.body;
    const monaco = body.appendChild(document.createElement("div"));
    monaco.className = "monaco-editor";
    const monacoInput = monaco.appendChild(document.createElement("textarea"));
    const xterm = body.appendChild(document.createElement("div"));
    xterm.className = "xterm";
    const composer = body.appendChild(document.createElement("textarea"));
    const event = (overrides = {}) => ({
      key: "k",
      code: "KeyK",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 75,
      repeat: false,
      defaultPrevented: false,
      target: body,
      ...overrides,
    });

    assert.equal(isCommandPaletteShortcut(event({ metaKey: true }), true), true);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, target: composer }), true), true, "works from the composer");
    assert.equal(isCommandPaletteShortcut(event({ ctrlKey: true }), true), false, "macOS Ctrl+K stays kill-line");
    assert.equal(isCommandPaletteShortcut(event({ ctrlKey: true }), false), true);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true }), false), false);
    assert.equal(isCommandPaletteShortcut(event({ ctrlKey: true, key: "K", code: "KeyK" }), false), true);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, shiftKey: true }), true), false);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, altKey: true }), true), false);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, isComposing: true }), true), false);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, keyCode: 229 }), true), false);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, defaultPrevented: true }), true), false);
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, target: monacoInput }), true), false, "Monaco owns Cmd+K chords");
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, target: xterm }), true), false, "terminal owns Cmd+K");
    assert.equal(isCommandPaletteShortcut(event({ metaKey: true, key: "j", code: "KeyJ" }), true), false);

    assert.equal(isCommandPaletteSuppressed(document), false);
    const overlay = body.appendChild(document.createElement("div"));
    overlay.setAttribute("data-command-palette-suppressed", "");
    assert.equal(isCommandPaletteSuppressed(document), true, "the settings overlay suppresses the palette");
  } finally {
    env.cleanup();
  }
});

test("action builder only lists actions the host wires", async () => {
  const env = await createEnv();
  try {
    const { buildCommandPaletteActions } = env.loadModule(
      "@liveagent/ui/lib/chat/commandPaletteActions.ts",
    );
    const t = (key) =>
      ({
        "chat.commandPalette.openSettingsSection": "Settings: {section}",
        "chat.commandPalette.switchModel": "Switch model: {model}",
        "chat.commandPalette.showView": "Show {name}",
      })[key] ?? key;

    assert.deepEqual(buildCommandPaletteActions({ t, isMac: true }), [], "no handlers, no actions");

    const calls = [];
    const actions = buildCommandPaletteActions({
      t,
      isMac: false,
      onNewConversation: () => calls.push("new"),
      onOpenSettings: (section) => calls.push(["settings", section]),
      settingsSections: [{ id: "providers", labelKey: "Providers" }],
      sidebar: { open: true, onToggle: () => calls.push("sidebar") },
      theme: { current: "light", onToggle: () => calls.push("theme") },
      resourceHubs: { visible: { planning: false }, onOpen: (id) => calls.push(["hub", id]) },
      conversationView: { active: "conversation", onChange: (view) => calls.push(["view", view]) },
      executionMode: { isAgent: true, onSelect: (mode) => calls.push(["mode", mode]) },
      models: {
        options: [
          { value: "openai::gpt", label: "GPT", providerName: "OpenAI" },
          { value: "anthropic::claude", label: "Claude", providerName: "Anthropic" },
        ],
        selectedValue: "anthropic::claude",
        onSelect: (value) => calls.push(["model", value]),
      },
    });
    const byId = new Map(actions.map((item) => [item.id, item]));

    assert.ok(byId.has("new-conversation"));
    assert.ok(!byId.has("stop-run"), "stop only shows while a run is active");
    assert.ok(!byId.has("open-workspace"));
    assert.ok(!byId.has("toggle-project-tools"));
    assert.ok(!byId.has("toggle-window-pin"));
    assert.ok(!byId.has("hub:planning"), "hidden resource hubs stay hidden");
    assert.ok(byId.has("hub:skills"));
    assert.equal(byId.get("toggle-sidebar").shortcut, "Ctrl+B");
    assert.equal(byId.get("toggle-sidebar").label, "sidebar.closeSidebar");
    assert.equal(byId.get("toggle-theme").label, "tooltip.switchToDark");
    assert.equal(byId.get("switch-conversation-view").label, "Show trajectory.tab.trajectory");
    assert.equal(byId.get("switch-execution-mode").label, "chat.commandPalette.switchToChatMode");
    assert.equal(byId.get("settings:providers").label, "Settings: Providers");
    assert.equal(byId.get("settings:providers").searchOnly, true);
    assert.equal(byId.get("model:openai::gpt").label, "Switch model: OpenAI / GPT");
    assert.equal(byId.get("model:openai::gpt").searchOnly, true);
    assert.equal(byId.get("model:openai::gpt").active, false);
    assert.equal(byId.get("model:anthropic::claude").active, true);

    byId.get("settings:providers").run();
    byId.get("open-settings").run();
    byId.get("model:openai::gpt").run();
    byId.get("switch-execution-mode").run();
    byId.get("hub:skills").run();
    byId.get("switch-conversation-view").run();
    assert.deepEqual(calls, [
      ["settings", "providers"],
      ["settings", undefined],
      ["model", "openai::gpt"],
      ["mode", "text"],
      ["hub", "skills"],
      ["view", "trajectory"],
    ]);
  } finally {
    env.cleanup();
  }
});

test("palette mode lists actions with conversations, runs actions and honours the > prefix", async () => {
  const pending = [];
  const env = await createEnv(pending);
  const { React, act, createRoot } = env;
  HTMLElement.prototype.scrollIntoView = () => {};
  const { ConversationSearchDialog } = env.loadModule(
    "@liveagent/ui/components/chat/ConversationSearchDialog.tsx",
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const events = [];
  const actions = [
    action("new-conversation", "suggested", "New conversation", { run: () => events.push("run:new") }),
    action("toggle-theme", "view", "Switch to dark theme", { run: () => events.push("run:theme") }),
    action("model:gpt", "models", "Switch model: GPT", { searchOnly: true, run: () => events.push("run:gpt") }),
  ];
  let providerCalls = 0;
  const getActions = () => {
    providerCalls += 1;
    return actions;
  };
  const props = {
    open: true,
    mode: "palette",
    getActions,
    currentWorkdir: "/project",
    conversations: [{ id: "recent", title: "Recent chat" }],
    onOpenChange: (value) => events.push(["open", value]),
    onSelectConversation: (...args) => events.push(["select", ...args]),
  };
  const render = (changes) =>
    act(async () => root.render(React.createElement(ConversationSearchDialog, { ...props, ...changes })));
  const input = () => document.querySelector("input");
  const options = () => [...document.querySelectorAll('[role="option"]')];
  const actionIds = () =>
    options()
      .map((el) => el.getAttribute("data-command-palette-action"))
      .filter(Boolean);
  const key = (value) =>
    act(async () =>
      input().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })),
    );
  const type = (value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const debounce = () => act(async () => new Promise((resolve) => setTimeout(resolve, 210)));

  try {
    await render();
    assert.ok(document.querySelector("[data-command-palette]"), "palette popup is marked");
    assert.equal(input().getAttribute("placeholder"), "chat.commandPalette.placeholder");
    assert.deepEqual(actionIds(), ["new-conversation", "toggle-theme"], "home lists non search-only actions");
    assert.ok(options().some((el) => el.textContent === "Recent chat"), "recent conversations stay listed");
    assert.ok(options()[0].hasAttribute("data-highlighted"), "first action is highlighted");

    await type("gpt");
    assert.deepEqual(actionIds(), ["model:gpt"]);
    await debounce();
    assert.deepEqual(pending.map((p) => p.args), [{ query: "gpt", currentWorkdir: "/project" }], "typing still searches conversations");
    await act(async () => pending[0].resolve([{ id: "found", title: "GPT notes" }]));
    assert.ok(options().some((el) => el.textContent === "GPT notes"));

    await key("Enter");
    assert.deepEqual(events, [["open", false], "run:gpt"], "Enter runs the highlighted action and closes");
    events.length = 0;

    await type("> theme");
    await debounce();
    assert.equal(pending.length, 1, "the > prefix never searches conversations");
    assert.deepEqual(actionIds(), ["toggle-theme"]);
    assert.ok(!options().some((el) => el.textContent === "Recent chat"));
    await act(async () => options()[0].click());
    assert.deepEqual(events, [["open", false], "run:theme"]);
    events.length = 0;

    const callsBefore = providerCalls;
    await render({ open: false });
    await render();
    assert.ok(providerCalls > callsBefore, "actions are re-read every time the palette opens");

    await render({ mode: "search" });
    assert.deepEqual(actionIds(), [], "search mode never lists actions");
    assert.deepEqual(options().map((el) => el.textContent), ["Recent chat"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});

test("desktop and WebUI hosts wire the palette and suppress it under settings", () => {
  const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const sidebar = read("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx");
  assert.match(sidebar, /isCommandPaletteShortcut\(event, isMac\)/);
  assert.match(sidebar, /isCommandPaletteSuppressed\(\)/);
  assert.match(sidebar, /mode=\{conversationSearchMode\}/);
  for (const host of [
    "../../src/pages/ChatPage.tsx",
    "../../../agent-gateway/web/src/app/GatewayAppView.tsx",
  ]) {
    const source = read(host);
    assert.match(source, /buildCommandPaletteActions\(/, host);
    assert.match(source, /getCommandPaletteActions=\{getCommandPaletteActions\}/, host);
  }
  for (const settingsHost of ["../../src/App.tsx", "../../../agent-gateway/web/src/app/GatewayAppView.tsx"]) {
    assert.match(read(settingsHost), /data-command-palette-suppressed=""/, settingsHost);
  }
});
