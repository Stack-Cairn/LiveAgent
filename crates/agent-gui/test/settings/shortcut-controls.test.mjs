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

test("scope choice migrates an existing binding and preserves its accelerator", async () => {
  const row = host.querySelector('[data-ghk-row="newChat"]');
  const group = row.querySelector('[data-slot="toggle-group"]');
  const items = [...group.querySelectorAll('[data-slot="toggle-group-item"]')];
  assert.equal(row.querySelector("select"), null);
  assert.equal(items.length, 2);
  assert.equal(items[0].getAttribute("aria-pressed"), "true");
  assert.equal(items[1].getAttribute("aria-pressed"), "false");
  assert.match(group.textContent, /settings.shortcutScopeGlobal/);
  assert.match(group.textContent, /settings.shortcutScopeApp/);
  assert.ok(group.nextElementSibling.querySelector(".ghk-kbd"));
  await env.act(async () => items[1].click());
  assert.equal(items[1].getAttribute("aria-pressed"), "true");
  assert.deepEqual(shortcuts.readGlobalShortcutBindings().newChat, {
    accelerator: "Ctrl+KeyN",
    enabled: true,
    scope: "app",
  });
});
test("scope choice keeps the shared roving-tabindex keyboard model", async () => {
  const items = [
    ...host.querySelectorAll('[data-ghk-row="newChat"] [data-slot="toggle-group-item"]'),
  ];
  await env.act(async () => items[1].focus());
  assert.equal(items[1].getAttribute("tabindex"), "0");
  await env.act(async () =>
    items[1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    ),
  );
  assert.equal(document.activeElement, items[0]);
  assert.equal(items[0].getAttribute("tabindex"), "0");
  await env.act(async () => items[0].click());
  assert.equal(shortcuts.readGlobalShortcutBindings().newChat.scope, "global");
  await env.act(async () => items[1].click());
  assert.equal(shortcuts.readGlobalShortcutBindings().newChat.scope, "app");
  assert.ok(host.querySelector('[data-ghk-row="newChat"] [data-slot="toggle-group"]'));
});
test("send shortcut uses the shared segmented control and saves both directions", async () => {
  const row = host.querySelector('[data-ghk-row="sendMessage"]');
  assert.equal(row.parentElement, host.querySelector('[data-ghk-row="newChat"]').parentElement);
  assert.equal(row.querySelector("select"), null);
  const group = row.querySelector('[data-slot="toggle-group"]');
  const items = [...group.querySelectorAll('[data-slot="toggle-group-item"]')];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Enter/);
  assert.match(items[1].textContent, /Ctrl \+ Enter|⌘ \+ Enter/);
  assert.equal(items[0].getAttribute("aria-pressed"), "true");
  assert.deepEqual(
    items.map((item) => item.className),
    [...host.querySelectorAll('[data-ghk-row="newChat"] [data-slot="toggle-group-item"]')].map(
      (item) => item.className,
    ),
  );
  await env.act(async () => items[1].click());
  assert.equal(readSendShortcut(), "ctrlEnter");
  assert.equal(items[1].getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector('[data-slot="popover-content"]'), null);
  assert.doesNotMatch(row.textContent, /settings.shortcutRecordingHint/);
  await env.act(async () => items[0].click());
  assert.equal(readSendShortcut(), "enter");
  assert.equal(items[0].getAttribute("aria-pressed"), "true");
});
test("send shortcut choice keeps the shared roving-tabindex keyboard model", async () => {
  const items = [
    ...host.querySelectorAll('[data-ghk-row="sendMessage"] [data-slot="toggle-group-item"]'),
  ];
  await env.act(async () => items[0].focus());
  await env.act(async () =>
    items[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    ),
  );
  assert.equal(document.activeElement, items[1]);
  await env.act(async () => items[1].click());
  assert.equal(readSendShortcut(), "ctrlEnter");
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
