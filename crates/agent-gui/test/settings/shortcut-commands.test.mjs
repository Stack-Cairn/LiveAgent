import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { locale: "en-US", t: (key) => key };
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": Object.fromEntries(
      ["AlertTriangle", "RotateCcw", "X"].map((name) => [name, () => null]),
    ),
    "@tauri-apps/api/core": { invoke: async () => [] },
  },
});
const commands = env.loadModule("@liveagent/ui/lib/shortcuts/shortcutCommands.ts");
const keys = env.loadModule("@liveagent/ui/lib/shortcuts/shortcutKeys.ts");
const { withCommandShortcuts } = env.loadModule("@liveagent/ui/lib/chat/commandPaletteActions.ts");
const globalShortcuts = env.loadModule("src/lib/shortcuts/globalShortcuts.ts");
const { ShortcutCommandsSection } = env.loadModule(
  "@liveagent/ui/pages/settings/ShortcutCommandsSection.tsx",
);

const LEGACY_KEY = "liveagent.globalShortcuts.v1";

function reset() {
  window.localStorage.clear();
  commands.invalidateShortcutOverrides();
  keys.setInAppShortcutsSuspended(false);
}

function keydown(init, target = document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

test.beforeEach(reset);

test("one table drives defaults: Mod resolves to Cmd on mac and Ctrl elsewhere", () => {
  const table = Object.fromEntries(
    commands.SHORTCUT_COMMANDS.map((command) => [command.id, command.defaultBinding]),
  );
  assert.deepEqual(table, {
    commandPalette: "Mod+KeyK",
    newConversation: "Mod+Shift+KeyO",
    openSettings: "Mod+Comma",
    searchConversations: null,
    previousConversation: "Mod+Alt+BracketLeft",
    nextConversation: "Mod+Alt+BracketRight",
    findInConversation: "Mod+KeyF",
    focusComposer: "Slash",
    openModelPicker: "Mod+Slash",
    toggleSidebar: "Mod+KeyB",
    toggleRightPanel: "Mod+Alt+KeyB",
  });
  assert.equal(commands.formatShortcutCommand("newConversation", true), "⇧⌘O");
  assert.equal(commands.formatShortcutCommand("newConversation", false), "Ctrl+Shift+O");
  assert.equal(commands.formatShortcutCommand("openSettings", true), "⌘,");
  assert.equal(commands.formatShortcutCommand("toggleRightPanel", false), "Ctrl+Alt+B");
  assert.equal(commands.formatShortcutCommand("searchConversations", true), undefined);
  assert.deepEqual(
    [...commands.findShortcutConflicts(
      commands.SHORTCUT_COMMANDS.map((command) => ({
        id: command.id,
        accelerator: commands.getShortcutBinding(command.id),
      })),
      true,
    ).keys()],
    [],
    "defaults never collide with each other",
  );
});

test("overrides persist, drop values equal to the default and keep explicit unbinds", () => {
  commands.writeShortcutOverrides({
    newConversation: "Mod+Shift+KeyO",
    toggleSidebar: "",
    openSettings: "Ctrl+Shift+KeyP",
  });
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(commands.SHORTCUT_OVERRIDES_STORAGE_KEY)),
    { toggleSidebar: "", openSettings: "Ctrl+Shift+KeyP" },
  );
  assert.equal(commands.getShortcutBinding("toggleSidebar"), "");
  assert.equal(commands.formatShortcutCommand("openSettings", false), "Ctrl+Shift+P");
  assert.equal(commands.isShortcutOverridden("newConversation"), false);
  commands.writeShortcutOverrides({});
  assert.equal(window.localStorage.getItem(commands.SHORTCUT_OVERRIDES_STORAGE_KEY), null);
});

test("legacy app-scoped desktop bindings migrate into the shared table once", () => {
  window.localStorage.setItem(
    LEGACY_KEY,
    JSON.stringify({
      newChat: { accelerator: "Ctrl+Alt+KeyN", enabled: false, scope: "app" },
      searchConversations: { accelerator: "Ctrl+KeyP", enabled: true, scope: "app" },
      pin: { accelerator: "Ctrl+KeyJ", enabled: true, scope: "app" },
      toggle: { accelerator: "Ctrl+Shift+KeyL", enabled: true },
    }),
  );
  const bindings = globalShortcuts.readGlobalShortcutBindings();
  assert.deepEqual(Object.keys(bindings).sort(), ["pin", "toggle"]);
  assert.deepEqual(commands.readShortcutOverrides(), {
    newConversation: "",
    searchConversations: "Ctrl+KeyP",
  });
  const stored = JSON.parse(window.localStorage.getItem(LEGACY_KEY));
  assert.equal(stored.newChat, undefined);
  assert.equal(stored.searchConversations, undefined);
  assert.deepEqual(globalShortcuts.readGlobalShortcutBindings(), bindings, "migration is idempotent");
});

test("typing and IME guards: plain keys never fire from editors, modifier chords do", () => {
  const input = document.body.appendChild(document.createElement("textarea"));
  try {
    assert.ok(commands.matchesShortcutCommand(keydown({ key: "/", code: "Slash" }), "focusComposer", false));
    assert.ok(
      !commands.matchesShortcutCommand(keydown({ key: "/", code: "Slash" }, input), "focusComposer", false),
      "a bare / typed in the composer stays text",
    );
    const chord = { key: "O", code: "KeyO", ctrlKey: true, shiftKey: true };
    assert.ok(commands.matchesShortcutCommand(keydown(chord, input), "newConversation", false));
    assert.ok(!commands.matchesShortcutCommand(keydown(chord, input), "newConversation", true), "mac needs Cmd");
    assert.ok(
      !commands.matchesShortcutCommand(keydown({ ...chord, isComposing: true }, input), "newConversation", false),
      "nothing fires during IME composition",
    );
    keys.setInAppShortcutsSuspended(true);
    assert.ok(!commands.matchesShortcutCommand(keydown(chord), "newConversation", false), "recording suspends");
  } finally {
    input.remove();
  }
});

test("palette rows show the bound shortcut and follow overrides", () => {
  const rows = (isMac) =>
    withCommandShortcuts(
      [
        { id: "new-conversation", group: "suggested", title: "New", run() {} },
        { id: "toggle-sidebar", group: "view", title: "Sidebar", run() {} },
        { id: "toggle-theme", group: "view", title: "Theme", run() {} },
      ],
      isMac,
    ).map((action) => action.shortcut);
  assert.deepEqual(rows(true), ["⇧⌘O", "⌘B", undefined]);
  assert.deepEqual(rows(false), ["Ctrl+Shift+O", "Ctrl+B", undefined]);
  commands.writeShortcutOverrides({ toggleSidebar: "" });
  assert.deepEqual(rows(false), ["Ctrl+Shift+O", undefined, undefined]);
});

test("settings section records, flags conflicts, rejects taken chords and resets", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const recording = [];
  const render = () =>
    env.act(async () =>
      root.render(
        env.React.createElement(ShortcutCommandsSection, {
          isMac: false,
          externalBindings: [{ id: "global:toggle", label: "Show window", accelerator: "Ctrl+Shift+KeyL" }],
          onRecordingChange: (value) => recording.push(value),
        }),
      ),
    );
  const row = (id) => host.querySelector(`[data-shortcut-command="${id}"]`);
  const click = (el) => env.act(async () => el.click());
  const press = (init) => env.act(async () => keydown(init));
  try {
    await render();
    assert.equal(host.querySelectorAll("[data-shortcut-command]").length, commands.SHORTCUT_COMMANDS.length);
    assert.equal(host.querySelector("[data-shortcut-conflict]"), null);

    await env.act(async () =>
      commands.writeShortcutOverrides({ openModelPicker: "Mod+Shift+KeyO" }),
    );
    assert.ok(row("openModelPicker").querySelector("[data-shortcut-conflict]"), "stored duplicates are flagged");
    assert.ok(row("newConversation").querySelector("[data-shortcut-conflict]"));
    await click(row("openModelPicker").querySelector('[data-shortcut-reset="openModelPicker"]'));
    assert.deepEqual(commands.readShortcutOverrides(), {});
    assert.equal(host.querySelector("[data-shortcut-conflict]"), null);

    await click(row("openSettings").querySelector('[data-shortcut-record="openSettings"]'));
    assert.equal(keys.areInAppShortcutsSuspended(), true);
    await press({ key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    assert.deepEqual(commands.readShortcutOverrides(), {}, "a chord owned by a system-wide hotkey is rejected");
    assert.match(host.querySelector('[role="status"]').textContent, /shortcuts\.rejectedConflict/);

    await click(row("openSettings").querySelector('[data-shortcut-record="openSettings"]'));
    await press({ key: "Shift", code: "ShiftLeft", shiftKey: true });
    await press({ key: "F2", code: "F2", shiftKey: true });
    assert.deepEqual(commands.readShortcutOverrides(), { openSettings: "Shift+F2" });
    assert.equal(keys.areInAppShortcutsSuspended(), false);
    assert.deepEqual(recording, [true, false, true, false]);

    await click(row("toggleSidebar").querySelector('[data-shortcut-clear="toggleSidebar"]'));
    assert.deepEqual(commands.readShortcutOverrides(), { openSettings: "Shift+F2", toggleSidebar: "" });

    await click(host.querySelector("[data-shortcut-reset-all]"));
    assert.deepEqual(commands.readShortcutOverrides(), {});
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
  }
});

test.after(() => env.cleanup());
