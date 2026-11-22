// OnboardingHost decides when the guide opens and persists the outcome. The
// dialog itself is replaced by a stub that exposes its callbacks.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const dialogPath = fileURLToPath(
  new URL("../../../agent-ui/src/components/onboarding/OnboardingDialog.tsx", import.meta.url),
);
const STORAGE_KEY = "liveagent.onboarding.v1";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup({ stored, sessionCount = 0, settingsPatch, ready } = {}) {
  const dialogProps = [];
  let env;
  const StubDialog = (props) => {
    dialogProps.push(props);
    return env.React.createElement("div", {
      "data-testid": "onboarding-dialog",
      "data-step": props.initialStep,
    });
  };
  env = await createDomTestEnv({
    mocks: {
      [dialogPath]: { OnboardingDialog: StubDialog },
      "@liveagent/adapters/systemSettings": { notificationSettingsAvailable: () => true },
    },
  });
  const storage = memoryStorage(stored ? { [STORAGE_KEY]: JSON.stringify(stored) } : {});
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  const { normalizeSettings } = env.loadModule("@liveagent/ui/lib/settings/index.ts");
  const { OnboardingHost } = env.loadModule("@liveagent/ui/components/onboarding/OnboardingHost.tsx");
  const { requestOnboarding } = env.loadModule("@liveagent/ui/lib/onboarding/onboardingState.ts");
  const settings = { ...normalizeSettings({}), ...(settingsPatch ?? {}) };
  if (!settingsPatch?.customProviders) settings.customProviders = [];
  const inserted = [];
  let sessionCalls = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = env.createRoot(container);
  const loadSessionCount = async () => {
    sessionCalls += 1;
    if (sessionCount instanceof Error) throw sessionCount;
    return sessionCount;
  };
  const onInsertPrompt = (prompt) => inserted.push(prompt);
  const render = (props = {}) =>
    env.act(async () => {
      root.render(
        env.React.createElement(OnboardingHost, {
          settings,
          setSettings: () => {},
          autoStart: true,
          ...(ready === undefined ? {} : { ready }),
          loadSessionCount,
          onInsertPrompt,
          ...props,
        }),
      );
    });
  await render();
  // Lazy dialog chunk + session count promise.
  for (let i = 0; i < 4; i += 1) await env.act(flush);
  return {
    env,
    settings,
    async rerender(props) {
      await render(props);
      for (let i = 0; i < 4; i += 1) await env.act(flush);
    },
    storage,
    dialogProps,
    inserted,
    requestOnboarding,
    sessionCalls: () => sessionCalls,
    record: () => {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    },
    dialog: () => document.querySelector("[data-testid=onboarding-dialog]"),
    lastProps: () => dialogProps.at(-1),
    async teardown() {
      await env.act(async () => root.unmount());
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete globalThis.localStorage;
      env.cleanup();
    },
  };
}

test("fresh profile: opens at welcome and records progress", async () => {
  const t = await setup();
  try {
    assert.equal(t.dialog()?.dataset.step, "welcome");
    assert.equal(t.record().status, "in-progress");
    await t.env.act(async () => t.lastProps().onStepChange("model"));
    assert.equal(t.record().step, "model");
  } finally {
    await t.teardown();
  }
});

test("skip closes the guide and it never opens on its own again", async () => {
  const first = await setup();
  let stored;
  try {
    await first.env.act(async () => first.lastProps().onSkip("provider"));
    assert.equal(first.dialog(), null);
    stored = first.record();
    assert.equal(stored.status, "skipped");
  } finally {
    await first.teardown();
  }
  const second = await setup({ stored });
  try {
    assert.equal(second.dialog(), null);
    assert.equal(second.sessionCalls(), 0, "a finished record needs no backend round trip");
    // Still reachable by hand, from the first step.
    await second.env.act(async () => second.requestOnboarding());
    await second.env.act(flush);
    assert.equal(second.dialog()?.dataset.step, "welcome");
    // A manual run does not rewrite the stored outcome on navigation.
    await second.env.act(async () => second.lastProps().onStepChange("model"));
    assert.equal(second.record().status, "skipped");
  } finally {
    await second.teardown();
  }
});

test("finish records completion and hands the chosen prompt to the composer", async () => {
  const t = await setup();
  try {
    await t.env.act(async () => t.lastProps().onFinish("Explain this project"));
    await t.env.act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    assert.equal(t.dialog(), null);
    assert.equal(t.record().status, "completed");
    assert.deepEqual(t.inserted, ["Explain this project"]);
  } finally {
    await t.teardown();
  }
});

test("an interrupted first run resumes at the saved step", async () => {
  const t = await setup({ stored: { version: 1, status: "in-progress", step: "safety", updatedAt: 1 } });
  try {
    assert.equal(t.dialog()?.dataset.step, "safety");
  } finally {
    await t.teardown();
  }
});

test("existing users are not blocked: sessions mark the guide auto-skipped", async () => {
  const t = await setup({ sessionCount: 5 });
  try {
    assert.equal(t.dialog(), null);
    assert.equal(t.record().status, "auto-skipped");
  } finally {
    await t.teardown();
  }
});

test("an unreachable backend postpones the decision instead of guessing", async () => {
  const t = await setup({ sessionCount: new Error("offline") });
  try {
    assert.equal(t.dialog(), null);
    assert.equal(t.record(), null);
  } finally {
    await t.teardown();
  }
});

test("a provider without a default model starts at the model step", async () => {
  const t = await setup({
    settingsPatch: {
      customProviders: [{ id: "fake", name: "Fake", models: [{ id: "m1" }], activeModels: [] }],
      selectedModel: null,
    },
  });
  try {
    assert.equal(t.dialog()?.dataset.step, "model");
  } finally {
    await t.teardown();
  }
});

test("no decision before the host's settings are ready (providers still loading)", async () => {
  // Boot placeholder: no providers yet, although the backend has one.
  const t = await setup({ ready: false });
  try {
    assert.equal(t.dialog(), null);
    assert.equal(t.record(), null);
    assert.equal(t.sessionCalls(), 0);
    const loaded = {
      ...t.settings,
      customProviders: [{ id: "cfg", name: "Cfg", models: [{ id: "m1" }], activeModels: ["m1"] }],
      selectedModel: { customProviderId: "cfg", model: "m1" },
    };
    await t.rerender({ settings: loaded, ready: true });
    assert.equal(t.dialog(), null);
    assert.equal(t.record().status, "auto-skipped");
    assert.equal(t.sessionCalls(), 1);
    // Later settings changes do not trigger a second decision.
    await t.rerender({ settings: { ...loaded, customProviders: [] }, ready: true });
    assert.equal(t.dialog(), null);
    assert.equal(t.sessionCalls(), 1);
  } finally {
    await t.teardown();
  }
});

test("a provider configured before the first launch skips the guide without a default model", async () => {
  const t = await setup({
    settingsPatch: {
      customProviders: [{ id: "cfg", name: "Cfg", models: [{ id: "m1" }], activeModels: ["m1"] }],
      selectedModel: null,
    },
  });
  try {
    assert.equal(t.dialog(), null);
    assert.equal(t.record().status, "auto-skipped");
  } finally {
    await t.teardown();
  }
});

test("an outcome recorded while sessions load wins over the decision", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const t = await setup({ ready: false });
  try {
    await t.rerender({
      ready: true,
      loadSessionCount: async () => {
        await gate;
        return 0;
      },
    });
    t.storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, status: "completed", step: "finish", updatedAt: 1 }),
    );
    release();
    for (let i = 0; i < 4; i += 1) await t.env.act(flush);
    assert.equal(t.dialog(), null);
    assert.equal(t.record().status, "completed");
  } finally {
    await t.teardown();
  }
});
