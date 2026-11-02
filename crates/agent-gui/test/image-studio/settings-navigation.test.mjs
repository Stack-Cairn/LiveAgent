import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("settings section navigation respects the registered image leave guard", async () => {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": { ArrowLeft: () => null, Search: () => null },
    "../../i18n": { useLocale: () => ({ t: key => key }) },
  } });
  const { SettingsShell } = env.loadModule("@liveagent/ui/pages/settings/SettingsShell");
  const container = document.createElement("div");
  const root = env.createRoot(container);
  let allowed = false, checks = 0;
  const registry = { surface: "desktop", services: {}, slots: {}, settingsSections: ["image-studio", "system"].map((id, order) => ({
    id, labelKey: id, groupKey: "general", groupOrder: 1, order,
    render: () => env.React.createElement("div", { "data-active-content": id }, id),
  })) };
  try {
    await env.act(async () => root.render(env.React.createElement(SettingsShell, {
      registry, initialSection: "image-studio", saveState: { status: "idle" }, onBack() {},
      canLeaveSection: () => { checks++; return allowed; },
    })));
    await env.act(async () => container.querySelector('[data-settings-nav-id="image-studio"]').click());
    assert.equal(checks, 0);
    await env.act(async () => container.querySelector('[data-settings-nav-id="system"]').click());
    assert.equal(checks, 1);
    assert.equal(container.querySelector('[data-active-content]').dataset.activeContent, "image-studio");
    allowed = true;
    await env.act(async () => container.querySelector('[data-settings-nav-id="system"]').click());
    assert.equal(checks, 2);
    assert.equal(container.querySelector('[data-active-content]').dataset.activeContent, "system");
  } finally { await env.act(async () => root.unmount()); env.cleanup?.(); }
});
