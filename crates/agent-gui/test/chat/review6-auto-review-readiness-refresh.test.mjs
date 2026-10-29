// Review 6: the re-read triggers added for the auto-review readiness check
// (menu openings + `kbrain:settings-changed`). Real shared selector, real desktop
// adapter; only the K-brain HTTP adapter is an in-memory settings document.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let ReactRef = null;
const iconCache = new Map();
function iconComponent(name) {
  if (!iconCache.has(name)) {
    iconCache.set(name, (props) =>
      ReactRef.createElement("svg", { "data-icon": name, className: props?.className }),
    );
  }
  return iconCache.get(name);
}

const configured = {
  providers: [{ id: "deepseek", name: "DeepSeek" }],
  models: [{ provider: "deepseek", id: "deepseek-chat" }],
  aiApproval: { mode: "off", provider: "deepseek", model: "deepseek-chat" },
};
const missing = { ...configured, aiApproval: { mode: "off" } };

// Each call takes the next responder; the default answers immediately.
let responders = [];
let getSettingsCalls = 0;
let current = configured;
const kbrainSettingsPath = path.join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "src",
  "agent-ui-adapters",
  "kbrainSettings.ts",
);

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": new Proxy(
      {},
      { get: (_target, name) => (name === "__esModule" ? true : iconComponent(String(name))) },
    ),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/adapters/sandboxCapability": { useSandboxCapability: () => null },
    [kbrainSettingsPath]: {
      kbrainSettingsAdapter: {
        getSettings: () => {
          getSettingsCalls += 1;
          const responder = responders.shift();
          return responder ? responder() : Promise.resolve(structuredClone(current));
        },
      },
    },
  },
});
ReactRef = env.React;
window.HTMLElement.prototype.getAnimations ??= () => [];
const { CommandSafetyModeSelector } = env.loadModule(
  "@liveagent/ui/components/chat/CommandSafetyModeSelector.tsx",
);

const settle = () => env.act(async () => {});
const changed = () =>
  env.act(async () => window.dispatchEvent(new Event("kbrain:settings-changed")));

async function mount(value) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  await env.act(async () =>
    root.render(
      env.React.createElement(CommandSafetyModeSelector, {
        value,
        onChange: () => {},
        onConfigureAutoReview: () => {},
      }),
    ),
  );
  await settle();
  const trigger = () => container.querySelector("button");
  return {
    trigger,
    warns: () => /autoReviewNeedsModel/.test(trigger().getAttribute("title")),
    click: async () => {
      await env.act(async () => trigger().click());
      await settle();
    },
    unmount: async () => {
      await env.act(async () => root.unmount());
      container.remove();
    },
  };
}

function reset(doc = configured) {
  current = doc;
  responders = [];
  getSettingsCalls = 0;
}

test("after unmount a settings-changed event triggers no read (listener removed)", async () => {
  reset();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const view = await mount("autoReview");
    assert.equal(getSettingsCalls, 1);
    await view.unmount();
    await changed();
    await changed();
    assert.equal(getSettingsCalls, 1, "an unmounted selector still reads on settings-changed");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, [], "no React update-after-unmount warnings");
});

test("an unmount while a read is in flight does not apply its result", async () => {
  reset();
  let release;
  responders.push(() => new Promise((resolve) => (release = () => resolve(structuredClone(missing)))));
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const view = await mount("autoReview");
    await view.unmount();
    await env.act(async () => release());
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, []);
});

test("a menu opening and a settings-changed event in the same tick read once", async () => {
  reset();
  const view = await mount("ask");
  try {
    assert.equal(getSettingsCalls, 0, "a non-review mode with a closed menu does not read");
    await env.act(async () => {
      view.trigger().click();
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    });
    await settle();
    assert.equal(getSettingsCalls, 1);
  } finally {
    await view.unmount();
  }
});

test("with the menu closed and a non-review mode, settings-changed does not read", async () => {
  reset();
  const view = await mount("always");
  try {
    await changed();
    assert.equal(getSettingsCalls, 0);
    // Open then close: the listener exists only while the menu is open.
    await view.click();
    assert.equal(getSettingsCalls, 1);
    await view.click();
    assert.equal(view.trigger().getAttribute("aria-expanded"), "false");
    await changed();
    assert.equal(getSettingsCalls, 1, "a closed menu keeps listening");
  } finally {
    await view.unmount();
  }
});

test("a slow earlier read cannot overwrite the result of a later one", async () => {
  reset();
  let releaseFirst;
  // Mount read: slow and stale (no reviewer yet).
  responders.push(
    () => new Promise((resolve) => (releaseFirst = () => resolve(structuredClone(missing)))),
  );
  const view = await mount("autoReview");
  try {
    // Reviewer saved in settings; the event read answers at once with it.
    current = configured;
    await changed();
    assert.equal(getSettingsCalls, 2);
    assert.equal(view.warns(), false);
    await env.act(async () => releaseFirst());
    await settle();
    assert.equal(view.warns(), false, "the stale mount read replaced the newer answer");
  } finally {
    await view.unmount();
  }
});

test("a burst of settings-changed events does not fan out into one read per event", async () => {
  // KBrainSettingsSection, MemorySwitch, KBrainComputerSection, AIApprovalSection and
  // saveKBrainProviderSettings all dispatch the event, but only once per save.
  reset();
  const view = await mount("autoReview");
  try {
    assert.equal(getSettingsCalls, 1);
    await env.act(async () => {
      for (let i = 0; i < 5; i += 1) window.dispatchEvent(new Event("kbrain:settings-changed"));
    });
    await settle();
    assert.equal(getSettingsCalls, 2, "events dispatched in one tick are batched into one read");
  } finally {
    await view.unmount();
  }
});

test("deactivating the reviewer model in K-brain warns after the provider save", async () => {
  // K-brain's top-level `models` is active-only (internal/backend/settings.go projectSettings).
  reset();
  const view = await mount("autoReview");
  try {
    assert.equal(view.warns(), false);
    current = { ...configured, models: [] };
    await changed();
    assert.equal(view.warns(), true);
  } finally {
    await view.unmount();
  }
});
