import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

function settings(config = { mode: "off" }, models = [{ provider: "p", id: "small", name: "Small model" }]) {
  return { mode: "kbrain", models, providers: [{ id: "p", name: "Fixture provider" }], aiApproval: config };
}

async function fixture(task, initial = settings()) {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/ui/button": { Button: ({children, size, variant, ...props}) => env.React.createElement("button", props, children) },
    "@liveagent/ui/components/settings/SettingsToggleGroup": {
      SettingsToggleGroup: ({children, value, onValueChange, disabled, ...props}) => env.React.createElement("div", props,
        env.React.Children.map(children, (child) => env.React.cloneElement(child, { disabled, pressed: value.includes(child.props.value), onSelect: () => onValueChange([child.props.value]) }))),
      SettingsToggleGroupItem: ({children, value, pressed, onSelect, ...props}) => env.React.createElement("button", { ...props, "data-slot": "toggle-group-item", "aria-pressed": pressed, onClick: onSelect }, children),
    },
    [new URL("../../../agent-ui/src/pages/settings/modelPicker.tsx", import.meta.url).pathname]: { ModelPicker: ({ options, value, onChange, disabled, ariaLabel }) => env.React.createElement("select", {
      "aria-label": ariaLabel, value, disabled, onChange: (event) => onChange(event.target.value),
    }, env.React.createElement("option", { value: "" }, "Select"), ...options.map((option) => env.React.createElement("option", { key: option.value, value: option.value }, option.label))) },
  }});
  const { AIApprovalSection } = env.loadModule("@liveagent/ui/pages/settings/AIApprovalSection.tsx");
  let value = initial;
  let connection = { baseUrl: "http://fixture", token: "fixture" };
  let load = async () => value;
  let save = async (update) => { value = { ...value, ...update }; return value; };
  const updates = [];
  const kbrain = {
    getConnection: () => connection,
    getSettings: () => load(),
    updateSettings: (update) => { updates.push(update); return save(update); },
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const click = (element) => env.act(async () => { element.click(); await Promise.resolve(); });
  const button = (text) => [...host.querySelectorAll("button")].find((button) => button.textContent === text);
  const choose = (mode) => click(button({ off: "关闭", risk_only: "仅风险提示", auto: "自动审批" }[mode]));
  const select = () => env.act(async () => {
    const select = host.querySelector("select");
    select.value = JSON.stringify(["p", "small"]);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  try {
    await env.act(async () => root.render(env.React.createElement(AIApprovalSection, { kbrain })));
    await task({ env, host, root, kbrain, button, click, choose, select, updates,
      setValue: (next) => { value = next; }, setConnection: (next) => { connection = next; },
      setLoad: (next) => { load = next; }, setSave: (next) => { save = next; },
    });
  } finally {
    await env.act(async () => root.unmount());
    host.remove(); env.cleanup();
  }
}

test("AI approval uses shared settings controls and saves all three backend modes", async () => {
  await fixture(async ({ host, button, click, choose, select, updates }) => {
    assert.equal(host.querySelectorAll('input[type="radio"]').length, 0);
    assert.equal(host.querySelectorAll('[data-slot="toggle-group-item"]').length, 3);
    assert.equal(button("保存审批设置").disabled, true);
    assert.equal(host.querySelector("select").disabled, true, "off keeps the model picker disabled");
    await choose("auto");
    assert.equal(button("保存审批设置").disabled, true);
    assert.match(host.querySelector('[role="alert"]').textContent, /选择审批模型/);
    await select();
    assert.equal(button("保存审批设置").disabled, false);
    for (const mode of ["risk_only", "auto", "off"]) {
      await choose(mode);
      await click(button("保存审批设置"));
      assert.equal(updates.at(-1).aiApproval.mode, mode);
      assert.equal(updates.at(-1).aiApproval.model, "small");
      assert.equal(host.querySelector('[role="status"]').textContent, "已保存");
      assert.equal(button("保存审批设置").disabled, true);
    }
    assert.equal(host.querySelector("select").value, JSON.stringify(["p", "small"]));
  });
});

test("AI approval failed saves retain drafts and retry without a false saved state", async () => {
  await fixture(async ({ host, button, click, choose, select, setSave }) => {
    await choose("auto"); await select();
    setSave(async () => { throw Error("save failed"); });
    await click(button("保存审批设置"));
    assert.match(host.querySelector('[role="alert"]').textContent, /save failed/);
    assert.equal(host.querySelector('[role="status"]').textContent, "有未保存的修改");
    assert.equal(host.querySelector("select").value, JSON.stringify(["p", "small"]));
    setSave(async (update) => settings(update.aiApproval));
    await click(button("保存审批设置"));
    assert.equal(host.querySelector('[role="alert"]'), null);
    assert.equal(host.querySelector('[role="status"]').textContent, "已保存");
  });
});

test("AI approval reload confirms draft discard and handles unavailable backend capability", async () => {
  await fixture(async ({ host, button, click, choose, setValue }) => {
    await choose("risk_only");
    window.confirm = () => false;
    await click(button("重新加载"));
    assert.equal(button("仅风险提示").getAttribute("aria-pressed"), "true");
    window.confirm = () => true;
    await click(button("重新加载"));
    assert.equal(button("关闭").getAttribute("aria-pressed"), "true");
    // Explicit undefined is different from the fixture helper's default argument.
    setValue({ ...settings(), aiApproval: undefined });
    await click(button("重新加载"));
    assert.match(host.querySelector('[role="alert"]').textContent, /升级/);
    assert.equal(button("保存审批设置").disabled, true);
    setValue(settings()); await click(button("重新加载"));
    assert.equal(host.querySelector('[role="alert"]'), null);
  });
});

test("AI approval unavailable models cannot be enabled but can be switched off", async () => {
  await fixture(async ({ host, button, click, choose, updates }) => {
    assert.match(host.querySelector('[role="alert"]').textContent, /模型已不可用/);
    assert.equal(button("保存审批设置").disabled, true);
    await choose("off"); await click(button("保存审批设置"));
    assert.equal(updates.at(-1).aiApproval.mode, "off");
    assert.equal(updates.at(-1).aiApproval.model, "removed");
  }, settings({ mode: "auto", provider: "p", model: "removed" }, []));
});

test("AI approval load failures can be retried and WebUI explains manual approval availability", async () => {
  await fixture(async ({ host, button, click, setLoad, setConnection }) => {
    setConnection(null);
    setLoad(async () => { throw Error("load failed"); });
    await click(button("重新加载"));
    assert.match(host.querySelector('[role="alert"]').textContent, /load failed/);
    assert.match(host.textContent, /WebUI/);
    assert.equal(button("自动审批").disabled, true);
    setLoad(async () => settings()); await click(button("重新加载"));
    assert.equal(host.querySelector('[role="alert"]'), null);
  });
});

test("AI approval prevents saving a draft to a different backend", async () => {
  await fixture(async ({ host, button, click, choose, select, setConnection, updates }) => {
    await choose("auto"); await select();
    setConnection({ baseUrl: "http://another-backend", token: "other" });
    await click(button("保存审批设置"));
    assert.equal(updates.length, 0);
    assert.match(host.querySelector('[role="alert"]').textContent, /后端连接已改变/);
  });
});

test("AI approval ignores old pending load responses after adapter changes", async () => {
  await fixture(async ({ env, host, root, kbrain, button, click, setLoad }) => {
    let resolveOld;
    setLoad(() => new Promise((resolve) => { resolveOld = resolve; }));
    await click(button("重新加载"));
    const { AIApprovalSection } = env.loadModule("@liveagent/ui/pages/settings/AIApprovalSection.tsx");
    const replacement = { ...kbrain, getSettings: async () => settings({ mode: "risk_only", provider: "p", model: "small" }) };
    await env.act(async () => root.render(env.React.createElement(AIApprovalSection, { kbrain: replacement })));
    await env.act(async () => resolveOld(settings({ mode: "auto", provider: "p", model: "small" })));
    assert.equal(button("仅风险提示").getAttribute("aria-pressed"), "true");
    assert.equal(button("自动审批").getAttribute("aria-pressed"), "false");
    assert.equal(host.querySelector('[role="alert"]'), null);
  });
});

// K-brain with capability ai_review_per_run reports aiApproval.perRun: the composer's
// permission mode decides when to review and auto review falls back to the session's model,
// so the global setting is hidden. An older backend (no perRun) keeps the section.
test("AI approval setting is hidden on backends that review per permission mode", async () => {
  await fixture(async ({ host }) => {
    assert.equal(host.querySelector('[data-testid="ai-approval-settings"]'), null);
  }, settings({ mode: "off", perRun: true }));
  await fixture(async ({ host }) => {
    assert.ok(host.querySelector('[data-testid="ai-approval-settings"]'), "older backend keeps the section");
  }, settings({ mode: "off" }));
});
