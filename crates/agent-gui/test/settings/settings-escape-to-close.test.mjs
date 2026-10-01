import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function pressEscape(env, init = {}) {
  const event = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  // Dispatch from the document, like a real key press reaching the page: the
  // hook listens on window, so anything bound to document still runs first.
  document.dispatchEvent(event);
  return event;
}

test("Escape closes the settings surface", async () => {
  const env = await createDomTestEnv();
  const { useSettingsEscapeToClose } = env.loadModule(
    "@liveagent/ui/lib/settings/useSettingsEscapeToClose.ts",
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  let closes = 0;
  function Harness({ enabled = true }) {
    useSettingsEscapeToClose(() => {
      closes += 1;
    }, enabled);
    return env.React.createElement("div", null, "settings");
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));

    await env.act(async () => {
      const event = pressEscape(env);
      assert.equal(event.defaultPrevented, true, "the handled key must not fall through");
    });
    assert.equal(closes, 1, "Escape must return to chat");

    // A nested dismissable layer (Base UI calls preventDefault when it consumes
    // the key) has to win, or one press would close both the modal and settings.
    await env.act(async () => {
      const guard = (event) => event.preventDefault();
      document.addEventListener("keydown", guard);
      pressEscape(env);
      document.removeEventListener("keydown", guard);
    });
    assert.equal(closes, 1, "a consumed Escape must not also close settings");

    // Auto-repeat from a held key, and Escape during IME composition, are both
    // the user talking to something other than the settings surface.
    await env.act(async () => pressEscape(env, { repeat: true }));
    assert.equal(closes, 1, "auto-repeat must not fire again");

    await env.act(async () => pressEscape(env, { isComposing: true }));
    assert.equal(closes, 1, "Escape during IME composition must cancel the composition only");

    // Other keys are none of our business.
    await env.act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    assert.equal(closes, 1, "unrelated keys must be ignored");

    await env.act(async () => root.render(env.React.createElement(Harness, { enabled: false })));
    await env.act(async () => pressEscape(env));
    assert.equal(closes, 1, "a disabled hook must detach its listener");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup?.();
  }
});

test("unmounting the settings surface removes the Escape listener", async () => {
  const env = await createDomTestEnv();
  const { useSettingsEscapeToClose } = env.loadModule(
    "@liveagent/ui/lib/settings/useSettingsEscapeToClose.ts",
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  let closes = 0;
  function Harness() {
    useSettingsEscapeToClose(() => {
      closes += 1;
    });
    return env.React.createElement("div", null, "settings");
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    await env.act(async () => root.unmount());
    await env.act(async () => pressEscape(env));
    assert.equal(closes, 0, "a closed settings page must not keep swallowing Escape");
  } finally {
    host.remove();
    env.cleanup?.();
  }
});

test("SettingsShell wires Escape to its back action", async () => {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": { ArrowLeft: () => null, Search: () => null },
      "../../i18n": { useLocale: () => ({ t: (key) => key }) },
    },
  });
  const { SettingsShell } = env.loadModule("@liveagent/ui/pages/settings/SettingsShell.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  let backs = 0;
  const registry = {
    surface: "desktop",
    services: {},
    slots: {},
    settingsSections: [
      {
        id: "system",
        labelKey: "system",
        groupKey: "general",
        groupOrder: 1,
        order: 1,
        render: () => env.React.createElement("div", null, "system"),
      },
    ],
  };
  try {
    await env.act(async () =>
      root.render(
        env.React.createElement(SettingsShell, {
          registry,
          initialSection: "system",
          saveState: { status: "idle" },
          onBack() {
            backs += 1;
          },
        }),
      ),
    );
    await env.act(async () => pressEscape(env));
    assert.equal(backs, 1, "Escape inside settings must invoke onBack");

    const backButton = host.querySelector(".settings-back-button");
    assert.ok(backButton, "the back control must exist");
    assert.equal(
      backButton.getAttribute("aria-keyshortcuts"),
      "Escape",
      "the shortcut must be announced to assistive tech",
    );
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup?.();
  }
});
