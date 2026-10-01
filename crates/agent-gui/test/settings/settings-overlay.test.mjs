import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("reopening settings keeps the visible overlay opaque and cancels leaving", async () => {
  const env = await createDomTestEnv();
  const { useSettingsOverlay } = env.loadModule("@liveagent/ui/lib/settings/useSettingsOverlay.ts");
  const host = document.createElement("div");
  const root = env.createRoot(host);
  let controller;
  const frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  function Harness() {
    controller = useSettingsOverlay();
    return env.React.createElement("div", null, controller.overlay);
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    await env.act(async () => controller.openSettingsOverlay());
    assert.equal(host.textContent, "entering");
    await env.act(async () => { while (frames.length) frames.shift()(0); });
    assert.equal(host.textContent, "open");
    await env.act(async () => controller.openSettingsOverlay());
    assert.equal(host.textContent, "open", "opening visible settings must not re-enter opacity zero");
    await env.act(async () => controller.closeSettingsOverlay());
    assert.equal(host.textContent, "leaving");
    await env.act(async () => controller.openSettingsOverlay());
    assert.equal(host.textContent, "open");
    await env.act(async () => controller.handleSettingsOverlayTransitionEnd());
    assert.equal(host.textContent, "open", "late exit transition must not close reopened settings");
    await env.act(async () => controller.closeSettingsOverlay());
    await env.act(async () => controller.handleSettingsOverlayTransitionEnd());
    assert.equal(host.textContent, "closed");
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});

test("settings deep links commit the requested section without committing the previous one", async () => {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": { ArrowLeft: () => null, Search: () => null },
    "../../i18n": { useLocale: () => ({ t: key => key }) },
  }});
  const { SettingsShell } = env.loadModule("@liveagent/ui/pages/settings/SettingsShell.tsx");
  const host = document.createElement("div");
  const root = env.createRoot(host);
  const commits = [];
  function Section({ id }) {
    env.React.useLayoutEffect(() => { commits.push(id); });
    return env.React.createElement("div", null, id);
  }
  const registry = { surface: "desktop", services: {}, slots: {}, settingsSections:
    ["system", "providers"].map(id => ({ id, labelKey: id, groupKey: "general", groupOrder: 1,
      order: 1, render: () => env.React.createElement(Section, { id }) })) };
  const render = initialSection => env.act(async () => root.render(env.React.createElement(SettingsShell,
    { registry, initialSection, saveState: { status: "idle" }, onBack() {} })));
  try {
    await render("system");
    commits.length = 0;
    await render("providers");
    assert.deepEqual(commits, ["providers"]);
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});
