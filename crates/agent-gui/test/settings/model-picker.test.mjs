import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("model picker variants preserve selection, search, and clearing", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": { Check: icon, ChevronDown: icon, Search: icon, Sparkles: icon },
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  const { ModelPicker } = env.loadModule("@liveagent/ui/pages/settings/modelPicker.tsx");
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const values = [];
  function Harness() {
    const [value, setValue] = env.React.useState("a");
    return env.React.createElement(ModelPicker, {
      options: [
        { value: "a", label: "Alpha", providerName: "One" },
        { value: "b", label: "Beta", providerName: "Two" },
      ], value, onChange: next => { values.push(next); setValue(next); },
      variant: "quiet", placeholder: "Current", noneLabel: "Current", ariaLabel: "Model",
    });
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    const trigger = () => document.querySelector('[aria-label="Model"]');
    assert.ok(trigger().classList.contains("shadow-none"));
    assert.ok(trigger().classList.contains("border"));
    await env.act(async () => trigger().click());
    const input = document.querySelector("input");
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "Beta");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(n => n.textContent === "Beta");
    assert.ok(item, "search expands the matching provider");
    await env.act(async () => item.click());
    assert.deepEqual(values, ["b"]);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.match(trigger().textContent, /Beta/);
    await env.act(async () => trigger().click());
    const clear = [...document.querySelectorAll('[role="menuitem"]')].find(n => n.textContent === "Current");
    await env.act(async () => clear.click());
    assert.deepEqual(values, ["b", ""]);
  } finally {
    await env.act(async () => root.unmount()); env.cleanup();
  }
});
