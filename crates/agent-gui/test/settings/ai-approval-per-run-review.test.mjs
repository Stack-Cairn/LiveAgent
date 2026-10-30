// Review of the perRun hiding in AIApprovalSection: hiding "until perRun is known" also
// runs on every Reload against an older backend (no perRun), which still shows the section.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function settings(config = { mode: "off" }) {
  return {
    mode: "kbrain",
    models: [{ provider: "p", id: "small", name: "Small model" }],
    providers: [{ id: "p", name: "Fixture provider" }],
    aiApproval: config,
  };
}

async function render(task) {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/ui/button": {
        Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children),
      },
      "@liveagent/ui/components/settings/SettingsToggleGroup": {
        SettingsToggleGroup: ({ children, value, onValueChange, disabled, ...props }) =>
          env.React.createElement("div", props, children),
        SettingsToggleGroupItem: ({ children, value, ...props }) => env.React.createElement("button", props, children),
      },
      [new URL("../../../agent-ui/src/pages/settings/modelPicker.tsx", import.meta.url).pathname]: {
        ModelPicker: ({ ariaLabel }) => env.React.createElement("select", { "aria-label": ariaLabel }),
      },
    },
  });
  const { AIApprovalSection } = env.loadModule("@liveagent/ui/pages/settings/AIApprovalSection.tsx");
  let load = async () => settings();
  const kbrain = {
    getConnection: () => ({ baseUrl: "http://fixture", token: "fixture" }),
    getSettings: () => load(),
    updateSettings: async () => settings(),
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  try {
    await env.act(async () => root.render(env.React.createElement(AIApprovalSection, { kbrain })));
    await task({ env, host, setLoad: (next) => { load = next; } });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

test("older backend: Reload keeps the section, its focus and the loading status", async () => {
  await render(async ({ env, host, setLoad }) => {
    const section = () => host.querySelector('[data-testid="ai-approval-settings"]');
    assert.ok(section(), "older backend shows the section once loaded");
    const reload = [...host.querySelectorAll("button")].find((button) => button.textContent === "重新加载");
    reload.focus();
    let resolve;
    setLoad(() => new Promise((done) => { resolve = done; }));
    await env.act(async () => { reload.click(); await Promise.resolve(); });
    try {
      assert.ok(section(), "the section the user is reloading vanished while loading");
      assert.equal(host.querySelector('[role="status"]')?.textContent, "正在加载…");
      assert.equal(document.activeElement, reload, "focus left the Reload button");
    } finally {
      await env.act(async () => resolve(settings()));
    }
  });
});
