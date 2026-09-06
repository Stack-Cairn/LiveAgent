import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const calls = [];
let registrationGate;
const env = await createDomTestEnv({
  mocks: {
    "@tauri-apps/api/core": {
      invoke: async (...args) => {
        calls.push(args);
        if (registrationGate) await registrationGate;
        return [];
      },
    },
  },
});
const shortcuts = env.loadModule("src/lib/shortcuts/globalShortcuts.ts");
let focused = true;
document.hasFocus = () => focused;
// Match production ordering: main.tsx installs the guard before App mounts.
const navigation = env.loadModule("src/lib/system/webviewNavigationGuard.ts");
const cleanupGuard = navigation.installWebviewNavigationGuard({ isMac: true });
const cleanup = shortcuts.installAppShortcutListener();
const input = document.createElement("input");
document.body.append(input);
function key(options = {}, target = input) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "k",
    code: "KeyK",
    ctrlKey: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}
test.beforeEach(() => {
  focused = true;
  calls.length = 0;
  shortcuts.setShortcutsSuspended(false);
  shortcuts.writeGlobalShortcutBindings({
    searchConversations: { accelerator: "Ctrl+KeyK", enabled: true, scope: "app" },
  });
});
test("app scope persists and never registers with the OS; switching scope removes registration", async () => {
  const binding = { accelerator: "Ctrl+KeyK", enabled: true, scope: "global" };
  await shortcuts.applyGlobalShortcuts({ searchConversations: binding });
  await shortcuts.applyGlobalShortcuts(shortcuts.readGlobalShortcutBindings());
  assert.deepEqual(calls, [
    [
      "app_set_global_shortcuts",
      { bindings: [{ action: "searchConversations", accelerator: "Ctrl+KeyK" }] },
    ],
    ["app_set_global_shortcuts", { bindings: [] }],
  ]);
  assert.equal(shortcuts.readGlobalShortcutBindings().searchConversations.scope, "app");
});
test("rapid scope changes serialize full replacement requests", async () => {
  let release;
  registrationGate = new Promise((resolve) => {
    release = resolve;
  });
  const first = shortcuts.applyGlobalShortcuts({
    searchConversations: { accelerator: "Ctrl+KeyK", enabled: true, scope: "global" },
  });
  const second = shortcuts.applyGlobalShortcuts({
    searchConversations: { accelerator: "Ctrl+KeyK", enabled: true, scope: "app" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startedBeforeRelease = calls.length;
  release();
  registrationGate = undefined;
  await Promise.all([first, second]);
  assert.equal(startedBeforeRelease, 1);
  assert.deepEqual(calls.at(-1), ["app_set_global_shortcuts", { bindings: [] }]);
});
test("local shortcut dispatches once, matches modifiers exactly and consumes repeats", () => {
  assert.equal(key().defaultPrevented, true);
  assert.equal(key({ repeat: true }).defaultPrevented, true);
  assert.equal(key({ shiftKey: true }).defaultPrevented, false);
  assert.deepEqual(calls, [["app_run_shortcut", { action: "searchConversations" }]]);
});
test("blur, IME composition and shortcut recording suppress local actions", () => {
  focused = false;
  assert.equal(key().defaultPrevented, false);
  focused = true;
  assert.equal(key({ isComposing: true }).defaultPrevented, false);
  assert.equal(key({ keyCode: 229 }).defaultPrevented, false);
  shortcuts.setShortcutsSuspended(true);
  assert.equal(key().defaultPrevented, false);
  assert.equal(calls.length, 0);
});
test("global and disabled bindings are never dispatched by local listener", () => {
  for (const patch of [{ scope: "global" }, { enabled: false }]) {
    shortcuts.writeGlobalShortcutBindings({
      searchConversations: { accelerator: "Ctrl+KeyK", scope: "app", enabled: true, ...patch },
    });
    assert.equal(key().defaultPrevented, false);
  }
  assert.equal(calls.length, 0);
});
test("unmodified local shortcuts do not steal typing in editors", () => {
  shortcuts.writeGlobalShortcutBindings({
    newChat: { accelerator: "KeyK", scope: "app", enabled: true },
  });
  assert.equal(key({ ctrlKey: false }).defaultPrevented, false);
  assert.equal(key({ ctrlKey: false }, document.body).defaultPrevented, true);
  assert.deepEqual(calls, [["app_run_shortcut", { action: "newChat" }]]);
});
test("browser navigation protection does not swallow configured app shortcuts", () => {
  for (const accelerator of ["Super+KeyF", "Ctrl+KeyF", "Super+KeyS", "F3", "F5"]) {
    calls.length = 0;
    const code = accelerator.split("+").at(-1);
    shortcuts.writeGlobalShortcutBindings({
      searchConversations: { accelerator, enabled: true, scope: "app" },
    });
    const event = key({
      key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
      code,
      ctrlKey: accelerator.includes("Ctrl"),
      metaKey: accelerator.includes("Super"),
    });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(calls, [["app_run_shortcut", { action: "searchConversations" }]], accelerator);
  }
});
test("an event already handled before the navigation guard does not trigger app actions", () => {
  shortcuts.writeGlobalShortcutBindings({
    searchConversations: { accelerator: "Super+KeyF", enabled: true, scope: "app" },
  });
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "f",
    code: "KeyF",
    metaKey: true,
  });
  event.preventDefault();
  input.dispatchEvent(event);
  assert.equal(calls.length, 0);
});
test.after(() => {
  cleanupGuard();
  cleanup();
  env.cleanup();
});
