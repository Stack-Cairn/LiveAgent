// First-run onboarding: when it opens by itself, where it starts, and that a
// skip or finish is remembered.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { loadModule } = createTsModuleLoader();
const state = loadModule("@liveagent/ui/lib/onboarding/onboardingState.ts");
const { normalizeSettings } = loadModule("@liveagent/ui/lib/settings/index.ts");

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

const env = (overrides = {}) => ({
  providerCount: 0,
  activeModelCount: 0,
  hasValidDefaultModel: false,
  userWorkspaceCount: 0,
  sessionCount: 0,
  notificationsSupported: true,
  ...overrides,
});

test("a fresh profile starts at the welcome step", () => {
  assert.deepEqual(state.decideAutoOnboarding(null, env()), {
    show: true,
    step: "welcome",
    resumed: false,
  });
});

test("existing sessions or a working provider plus default model count as configured", () => {
  assert.deepEqual(state.decideAutoOnboarding(null, env({ sessionCount: 3 })), {
    show: false,
    reason: "configured",
  });
  assert.deepEqual(
    state.decideAutoOnboarding(null, env({ providerCount: 1, hasValidDefaultModel: true })),
    { show: false, reason: "configured" },
  );
  assert.equal(state.isAlreadyConfigured(env({ providerCount: 2 })), false, "provider without model");
  // Set up outside the app (config file, import) before the first launch: a
  // provider with enabled models counts even without a default model.
  assert.deepEqual(
    state.decideAutoOnboarding(null, env({ providerCount: 1, activeModelCount: 2 })),
    { show: false, reason: "configured" },
  );
});

test("a partially configured profile starts at the first missing step", () => {
  assert.equal(state.firstMissingStep(env({ providerCount: 1 })), "model");
  assert.equal(
    state.firstMissingStep(env({ providerCount: 1, hasValidDefaultModel: true })),
    "workspace",
  );
  assert.equal(
    state.firstMissingStep(
      env({ providerCount: 1, hasValidDefaultModel: true, userWorkspaceCount: 2 }),
    ),
    "safety",
  );
  assert.deepEqual(state.decideAutoOnboarding(null, env({ providerCount: 1 })), {
    show: true,
    step: "model",
    resumed: false,
  });
});

test("unknown session count waits instead of guessing", () => {
  assert.deepEqual(state.decideAutoOnboarding(null, env({ sessionCount: null })), {
    show: false,
    reason: "pending",
  });
});

test("skip, finish and auto-skip are final; in-progress resumes at the saved step", () => {
  for (const status of ["skipped", "completed", "auto-skipped"]) {
    assert.deepEqual(state.decideAutoOnboarding(state.markOnboarding(status, "model"), env()), {
      show: false,
      reason: "finished",
    });
  }
  assert.deepEqual(
    state.decideAutoOnboarding(state.markOnboarding("in-progress", "safety"), env({ sessionCount: null })),
    { show: true, step: "safety", resumed: true },
  );
  // A saved step the host no longer offers falls back to the first missing one.
  assert.deepEqual(
    state.decideAutoOnboarding(
      state.markOnboarding("in-progress", "notifications"),
      env({ notificationsSupported: false, providerCount: 1 }),
    ),
    { show: true, step: "model", resumed: true },
  );
});

test("records round-trip through storage and bad data is ignored", () => {
  const storage = memoryStorage();
  assert.equal(state.readOnboardingRecord(storage), null);
  state.writeOnboardingRecord(state.markOnboarding("skipped", "provider", () => 42), storage);
  assert.deepEqual(state.readOnboardingRecord(storage), {
    version: 1,
    status: "skipped",
    step: "provider",
    updatedAt: 42,
  });
  for (const raw of ["{", '{"version":2,"status":"completed"}', '{"version":1,"status":"nope"}']) {
    assert.equal(state.readOnboardingRecord(memoryStorage({ [state.ONBOARDING_STORAGE_KEY]: raw })), null);
  }
  assert.deepEqual(
    state.readOnboardingRecord(
      memoryStorage({ [state.ONBOARDING_STORAGE_KEY]: '{"version":1,"status":"in-progress","step":"bogus"}' }),
    ),
    { version: 1, status: "in-progress", updatedAt: 0 },
  );
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {},
  };
  assert.equal(state.readOnboardingRecord(throwing), null);
  assert.doesNotThrow(() => state.writeOnboardingRecord(state.markOnboarding("completed"), throwing));
  assert.equal(state.readOnboardingRecord(null), null);
});

test("navigation follows the host's step list", () => {
  const withNotifications = state.onboardingSteps({ notificationsSupported: true });
  const withoutNotifications = state.onboardingSteps({ notificationsSupported: false });
  assert.deepEqual(withNotifications, [...state.ONBOARDING_STEPS]);
  assert.ok(!withoutNotifications.includes("notifications"));
  assert.equal(state.nextOnboardingStep(withoutNotifications, "safety"), "finish");
  assert.equal(state.nextOnboardingStep(withNotifications, "safety"), "notifications");
  assert.equal(state.nextOnboardingStep(withNotifications, "finish"), "finish");
  assert.equal(state.previousOnboardingStep(withNotifications, "welcome"), null);
  assert.equal(state.previousOnboardingStep(withNotifications, "model"), "provider");
  assert.deepEqual(state.onboardingProgress(withoutNotifications, "model"), { index: 2, total: 6 });
});

test("environment is derived from settings; the built-in project does not count", () => {
  const settings = normalizeSettings({});
  const empty = state.onboardingEnvironmentFromSettings(settings, {
    sessionCount: 0,
    notificationsSupported: false,
  });
  assert.equal(empty.providerCount, settings.customProviders.length);
  assert.equal(empty.activeModelCount, 0);
  assert.equal(empty.userWorkspaceCount, 0);
  assert.equal(empty.hasValidDefaultModel, false);

  const provider = { id: "fake", models: [{ id: "m1" }, { id: "m2" }], activeModels: ["m1"] };
  const configured = {
    ...settings,
    customProviders: [provider],
    selectedModel: { customProviderId: "fake", model: "m1" },
    system: {
      ...settings.system,
      workspaceProjects: [
        ...settings.system.workspaceProjects,
        { id: "p1", name: "proj", path: "/work/proj", kind: "managed" },
      ],
    },
  };
  const facts = { sessionCount: 0, notificationsSupported: true };
  const configuredEnv = state.onboardingEnvironmentFromSettings(configured, facts);
  assert.equal(configuredEnv.hasValidDefaultModel, true);
  assert.equal(configuredEnv.activeModelCount, 1);
  assert.equal(configuredEnv.userWorkspaceCount, 1);
  // A default model that is no longer active is not valid.
  assert.equal(
    state.onboardingEnvironmentFromSettings(
      { ...configured, selectedModel: { customProviderId: "fake", model: "m2" } },
      facts,
    ).hasValidDefaultModel,
    false,
  );
  assert.equal(
    state.onboardingEnvironmentFromSettings(
      { ...configured, selectedModel: { customProviderId: "gone", model: "m1" } },
      facts,
    ).hasValidDefaultModel,
    false,
  );
});

test("manual open requests reach subscribers", () => {
  let calls = 0;
  const off = state.subscribeOnboardingRequests(() => {
    calls += 1;
  });
  state.requestOnboarding();
  off();
  state.requestOnboarding();
  assert.equal(calls, 1);
});
