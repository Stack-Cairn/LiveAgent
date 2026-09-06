import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { locale: "en-US", t: (key) => key };
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": Object.fromEntries(
      ["Send", "Keyboard", "MonitorSmartphone", "Pin", "Search", "SquarePen", "X", "Zap"].map(
        (name) => [name, () => null],
      ),
    ),
    "@tauri-apps/api/core": { invoke: async () => [] },
  },
});
const previousResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
const shortcuts = env.loadModule("src/lib/shortcuts/globalShortcuts.ts");
const { readSendShortcut } = env.loadModule("@liveagent/ui/lib/chat/sendShortcut.ts");
shortcuts.writeGlobalShortcutBindings({ newChat: { accelerator: "Ctrl+KeyN", enabled: true } });
const { GlobalShortcutsSection } = env.loadModule("src/pages/settings/GlobalShortcutsSection.tsx");
const host = document.createElement("div");
document.body.append(host);
const root = env.createRoot(host);
await env.act(async () => root.render(env.React.createElement(GlobalShortcutsSection)));

test("scope switch migrates an existing binding and preserves its accelerator", async () => {
  const row = host.querySelector('[data-ghk-row="newChat"]');
  const toggle = row.querySelector('button[role="switch"][aria-label]');
  assert.equal(row.querySelector("select"), null);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.match(toggle.textContent, /settings.shortcutScopeGlobal/);
  assert.match(toggle.textContent, /settings.shortcutScopeApp/);
  assert.ok(toggle.nextElementSibling.querySelector(".ghk-kbd"));
  await env.act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.deepEqual(shortcuts.readGlobalShortcutBindings().newChat, {
    accelerator: "Ctrl+KeyN",
    enabled: true,
    scope: "app",
  });
});
test("scope switch supports left and right arrow keys without entering recording", async () => {
  const toggle = host.querySelector('[data-ghk-row="newChat"] button[role="switch"][aria-label]');
  for (const [key, scope] of [
    ["ArrowLeft", "global"],
    ["ArrowRight", "app"],
  ]) {
    await env.act(async () =>
      toggle.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(shortcuts.readGlobalShortcutBindings().newChat.scope, scope);
    assert.ok(host.querySelector('[data-ghk-row="newChat"] button[role="switch"][aria-label]'));
  }
});
test("send shortcut uses a visible inline switch and saves both directions", async () => {
  const row = host.querySelector('[data-ghk-row="sendMessage"]');
  assert.equal(row.parentElement, host.querySelector('[data-ghk-row="newChat"]').parentElement);
  assert.equal(row.querySelector("select"), null);
  assert.equal(row.querySelectorAll("button").length, 1);
  const toggle = row.querySelector('[role="switch"]');
  assert.match(toggle.textContent, /Enter/);
  assert.match(toggle.textContent, /Ctrl \+ Enter|⌘ \+ Enter/);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(
    toggle.className,
    host.querySelector('[data-ghk-row="newChat"] [role="switch"]').className,
  );
  await env.act(async () => toggle.click());
  assert.equal(readSendShortcut(), "ctrlEnter");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(document.querySelector('[data-slot="popover-content"]'), null);
  assert.doesNotMatch(row.textContent, /settings.shortcutRecordingHint/);
  await env.act(async () => toggle.click());
  assert.equal(readSendShortcut(), "enter");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
});
test("send switch supports left and right arrow keys", async () => {
  const toggle = host.querySelector('[data-ghk-row="sendMessage"] [role="switch"]');
  for (const [key, expected] of [
    ["ArrowRight", "ctrlEnter"],
    ["ArrowLeft", "enter"],
  ]) {
    await env.act(async () =>
      toggle.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(readSendShortcut(), expected);
  }
});
test("recording a replacement shortcut retains the chosen app scope", async () => {
  await env.act(async () => host.querySelector('[data-ghk-row="newChat"] button').click());
  await env.act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyJ",
        key: "j",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await env.act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Enter",
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.deepEqual(shortcuts.readGlobalShortcutBindings().newChat, {
    accelerator: "Ctrl+KeyJ",
    enabled: true,
    scope: "app",
  });
});
test.after(async () => {
  await env.act(async () => root.unmount());
  if (previousResizeObserver === undefined) delete globalThis.ResizeObserver;
  else globalThis.ResizeObserver = previousResizeObserver;
  env.cleanup();
});
