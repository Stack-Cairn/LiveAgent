import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("font picker keeps the empty announcement unpadded and does not autofocus search", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: { "../IconSet": { Check: icon, ChevronDown: icon, Search: icon } } });
  const { SettingsCombobox } = env.loadModule("@liveagent/ui/components/settings/SettingsCombobox.tsx");
  const previousNodeFilter = globalThis.NodeFilter;
  globalThis.NodeFilter = window.NodeFilter;
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const selected = [];
  try {
    await env.act(async () => root.render(env.React.createElement(SettingsCombobox, {
      value: "default",
      options: [{ value: "default", label: "System default" }, { value: "Inter", label: "Inter" }],
      onValueChange: value => selected.push(value),
      ariaLabel: "Font", searchPlaceholder: "Search fonts", emptyLabel: "No fonts",
    })));
    await env.act(async () => document.querySelector('button').click());
    const search = document.querySelector('input[placeholder="Search fonts"]');
    assert.ok(search);
    assert.notEqual(document.activeElement, search);
    const status = document.querySelector('[role="status"]');
    assert.equal(status.textContent, "");
    assert.equal(status.children.length, 0, "no padded child remains above the list");
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "missing-font");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(status.textContent, "No fonts");
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "Inter");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(status.children.length, 0);
    await env.act(async () => document.querySelector('[role="option"]').click());
    assert.deepEqual(selected, ["Inter"]);
  } finally {
    await env.act(async () => root.unmount());
    globalThis.NodeFilter = previousNodeFilter;
    env.cleanup();
  }
});
