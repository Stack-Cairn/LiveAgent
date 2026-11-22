// OnboardingDialog navigation with real step logic. Dialog chrome, the provider
// editor and host adapters are stubs; nothing reaches a backend.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

async function setup({ notifications = true } = {}) {
  let env;
  const Box = ({ children, ...rest }) =>
    env.React.createElement(
      "div",
      { "data-testid": rest["data-testid"], "data-step": rest["data-step"] },
      children,
    );
  const Empty = () => null;
  const icons = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? false : () => null) });
  env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": icons,
      "@liveagent/ui/components/ui/dialog": Object.fromEntries(
        "Dialog DialogBody DialogContent DialogDescription DialogFooter DialogHeader DialogTitle"
          .split(" ")
          .map((name) => [name, Box]),
      ),
      "@liveagent/ui/i18n/index": {
        SUPPORTED_LOCALES: ["en-US", "zh-CN"],
        useLocale: () => ({ locale: "en-US", setLocale: () => {}, t: (key) => key }),
      },
      "@liveagent/ui/pages/settings/ProviderModal": { ProviderModal: Empty },
      "@liveagent/ui/pages/settings/modelPicker": { ModelPicker: Empty },
      "@liveagent/ui/components/chat/workspace-project-settings/WorkspaceFolderTrustSection": {
        WorkspaceFolderTrustSection: Empty,
      },
      "@liveagent/adapters/directoryPicker": {
        useDirectoryPicker: () => ({
          pickDirectory: async () => null,
          suspendsParentModal: false,
          directoryPickerElement: null,
        }),
      },
      "@liveagent/adapters/providerSettings": {
        discoverProviderModels: async () => [],
        ProviderSettingsExtension: Empty,
        providerImportAvailable: () => false,
      },
      "@liveagent/adapters/sandboxCapability": { useSandboxCapability: () => null },
      "@liveagent/adapters/systemSettings": {
        NotificationSettingsRows: Empty,
        notificationSettingsAvailable: () => notifications,
      },
    },
  });
  const { normalizeSettings } = env.loadModule("@liveagent/ui/lib/settings/index.ts");
  const { OnboardingDialog } = env.loadModule(
    "@liveagent/ui/components/onboarding/OnboardingDialog.tsx",
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = env.createRoot(container);
  const settings = normalizeSettings({});
  const steps = [];
  const onStepChange = (step) => steps.push(step);
  const render = (props) =>
    env.act(async () =>
      root.render(
        env.React.createElement(OnboardingDialog, {
          open: true,
          initialStep: "welcome",
          settings,
          setSettings: () => {},
          onStepChange,
          onSkip: () => {},
          onFinish: () => {},
          ...props,
        }),
      ),
    );
  return {
    env,
    render,
    steps,
    step: () => container.querySelector("[data-testid=onboarding-dialog]")?.dataset.step,
    click: (testId) =>
      env.act(async () => container.querySelector(`[data-testid=${testId}]`).click()),
    async teardown() {
      await env.act(async () => root.unmount());
      container.remove();
      env.cleanup();
    },
  };
}

test("a re-rendered host does not send the guide back to the first step", async () => {
  const t = await setup();
  try {
    // The host rebuilds this object on every settings change (e.g. after a
    // provider is saved); the current step must survive that.
    await t.render({ workspace: { onAddWorkspace: () => {} } });
    assert.equal(t.step(), "welcome");
    await t.click("onboarding-next");
    assert.equal(t.step(), "provider");
    await t.render({ workspace: { onAddWorkspace: () => {} } });
    assert.equal(t.step(), "provider");
    assert.deepEqual(t.steps, ["welcome", "provider"]);
  } finally {
    await t.teardown();
  }
});

test("steps the host cannot offer are skipped in navigation", async () => {
  const t = await setup({ notifications: false });
  try {
    // No workspace host and no notifications: safety leads straight to finish.
    await t.render({ initialStep: "safety" });
    assert.equal(t.step(), "safety");
    await t.click("onboarding-next");
    assert.equal(t.step(), "finish");
    // A saved step that is not offered here falls back to the first step.
    await t.render({ initialStep: "workspace" });
    assert.equal(t.step(), "welcome");
  } finally {
    await t.teardown();
  }
});
