import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

async function fixture(kbrain, task) {
  const toasts = [];
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { error: (message) => toasts.push(message), success() {} },
      },
    },
  });
  const { MemorySwitch, loadMemorySwitch } = env.loadModule(
    "@liveagent/ui/pages/settings/memory/MemorySwitch.tsx",
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const settle = () => env.act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
  const row = () => host.querySelector('[data-testid="memory-master-switch"]');
  const toggle = () => host.querySelector('[role="switch"]');
  try {
    await env.act(async () => root.render(env.React.createElement(MemorySwitch, { kbrain })));
    await settle();
    await task({ env, host, row, toggle, settle, toasts, loadMemorySwitch });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

function backend({ capabilities = { memory_switch: 1 }, enabled = true } = {}) {
  const state = { enabled, updates: [], failSave: false };
  state.kbrain = {
    isKbrain: true,
    getConnection: () => null,
    runtimeConnection: () => null,
    getCapabilities: async () => capabilities,
    getSettings: async () => ({ mode: "kbrain", providers: [], models: [], memory: { enabled: state.enabled } }),
    updateSettings: async (update) => {
      state.updates.push(update);
      if (state.failSave) throw new Error("persist failed");
      state.enabled = update.memory.enabled;
      return state.kbrain.getSettings();
    },
  };
  return state;
}

test("memory switch stays hidden without the backend capability or settings field", async () => {
  const legacy = backend({ capabilities: { session_queue: 1 } });
  await fixture(legacy.kbrain, async ({ row }) => assert.equal(row(), null));
  const noField = { ...backend().kbrain, getCapabilities: undefined, getSettings: async () => ({ mode: "kbrain", providers: [], models: [] }) };
  await fixture(noField, async ({ row }) => assert.equal(row(), null));
  const offline = { ...backend().kbrain, getCapabilities: async () => { throw new Error("connection not ready"); } };
  await fixture(offline, async ({ row, toasts }) => {
    assert.equal(row(), null);
    assert.deepEqual(toasts, [], "an unsupported or unreachable backend is not an error");
  });
});

test("memory switch saves through K-brain settings and reflects the saved state", async () => {
  const state = backend();
  await fixture(state.kbrain, async ({ env, row, toggle, settle }) => {
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.match(row().textContent, /对话会读取已存记忆/);
    let changed = 0;
    window.addEventListener("kbrain:settings-changed", () => { changed += 1; });
    await env.act(async () => toggle().click());
    await settle();
    assert.deepEqual(state.updates, [{ memory: { enabled: false } }]);
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.match(row().textContent, /已存记忆保留/);
    assert.equal(changed, 1);
  });
});

test("memory switch save failure restores the backend state instead of the optimistic value", async () => {
  const state = backend();
  state.failSave = true;
  await fixture(state.kbrain, async ({ env, toggle, settle, toasts }) => {
    await env.act(async () => toggle().click());
    await settle();
    assert.equal(toasts.length, 1);
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.equal(toggle().hasAttribute("data-disabled"), false, "control is usable again");
  });
});

test("memory switch loader reads the WebUI document when capabilities are unreachable", async () => {
  const state = backend({ enabled: false });
  await fixture({ ...state.kbrain, getCapabilities: undefined }, async ({ loadMemorySwitch, toggle }) => {
    assert.equal(await loadMemorySwitch({ ...state.kbrain, getCapabilities: undefined }), false);
    assert.equal(toggle().getAttribute("aria-checked"), "false");
  });
});
