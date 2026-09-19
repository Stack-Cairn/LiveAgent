import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("drawer selects show translated labels before opening and update with the locale", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": { Check: icon, ChevronDown: icon, ChevronUp: icon },
  } });
  const { DrawerSelect } = env.loadModule("@liveagent/ui/pages/settings/memory/DrawerSelect.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const render = (value, label, disabled = false) => env.act(async () => root.render(env.React.createElement(DrawerSelect, {
    key: value, value, options: [{ value, label }], ariaLabel: "setting", disabled, onValueChange() {},
  })));
  try {
    for (const [value, label] of [["none", "不自动执行"], ["all", "全部（全局 + 所有项目）"], ["conservative", "保守模式"]]) {
      await render(value, label, value === "none");
      assert.equal(host.querySelector('[role="combobox"]').textContent, label);
      assert.equal(document.querySelector('[role="listbox"]'), null);
    }
    await render("conservative", "Conservative");
    assert.equal(host.querySelector('[role="combobox"]').textContent, "Conservative");
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});
