import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("composer model pages preserve selection, reasoning, search and return navigation", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : icon) }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  // JSDOM does not implement the Web Animations API used by Base UI ScrollArea.
  window.HTMLElement.prototype.getAnimations ??= () => [];
  const { ComposerModelControls } = env.loadModule("@liveagent/ui/components/chat/ComposerModelControls.tsx");
  const { toModelValue } = env.loadModule("@liveagent/ui/lib/models/modelValue.ts");
  const values = [], patches = [];
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  function Harness() {
    const [value, setValue] = env.React.useState(toModelValue("one", "Alpha"));
    const [runtime, setRuntime] = env.React.useState({ reasoning: "low", thinkingEnabled: true, nativeWebSearchEnabled: false });
    return env.React.createElement(ComposerModelControls, {
      executionMode: "tools", hasModels: true, currentModelLabel: "Alpha", selectedValue: value,
      modelOptions: ["Alpha", "Beta"].map((model, index) => ({ model, label: model, providerId: index ? "two" : "one", providerName: index ? "Second" : "First", providerType: "openai", value: toModelValue(index ? "two" : "one", model) })),
      chatRuntimeControls: runtime, reasoningOptions: ["low", "high"], thinkingAlwaysOn: false,
      onSelectModel: selection => { values.push(selection); setValue(toModelValue(selection.customProviderId, selection.model)); },
      onSelectExecutionMode: () => {}, onOpenSettings: () => {},
      onChatRuntimeControlsChange: patch => { patches.push(patch); setRuntime(prev => ({ ...prev, ...patch })); },
    });
  }
  const clickText = async text => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
    assert.ok(button, text); await env.act(async () => button.click());
  };
  const open = async () => { await env.act(async () => document.querySelector('[data-slot="popover-trigger"]').click()); };
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    await open();
    assert.equal(document.querySelector('input[placeholder="chat.searchModel"]'), null);
    await clickText("chat.selectModelAlpha");
    assert.ok(document.querySelector('input[placeholder="chat.searchModel"]'));
    assert.ok([...document.querySelectorAll('button')].some(n => n.textContent === 'Beta'), "all provider groups are visible");
    const secondGroup = [...document.querySelectorAll('[data-model-group]')].find(node => node.textContent.includes('Second'));
    assert.ok(secondGroup);
    await env.act(async () => secondGroup.click());
    assert.equal(secondGroup.getAttribute('aria-expanded'), 'false');
    assert.equal([...document.querySelectorAll('[data-model-option]')].some(n => n.textContent === 'Beta'), false, 'collapsed models leave the keyboard navigation order');
    await env.act(async () => secondGroup.click());
    assert.equal(secondGroup.getAttribute('aria-expanded'), 'true');
    assert.ok([...document.querySelectorAll('[data-model-option]')].some(n => n.textContent === 'Beta'));
    await env.act(async () => secondGroup.click());
    const search = document.querySelector('input[placeholder="chat.searchModel"]');
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "Second");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal([...document.querySelectorAll('button')].some(n => n.textContent === 'Alpha'), false);
    assert.equal(secondGroup.getAttribute('aria-expanded'), 'true', 'search expands matching groups');
    await clickText("Beta");
    assert.deepEqual(values, [{ customProviderId: "two", model: "Beta" }]);
    await open();
    await clickText("chat.runtime.reasoningsettings.reasoning.low");
    await env.act(async () => document.querySelector('input[value="high"]').click());
    assert.deepEqual(patches.at(-1), { thinkingEnabled: true, reasoning: "high" });
    // 推理页的返回按钮附带当前模型标签，文本不再精确等于标题：用语义钩子定位。
    const back = document.querySelector("[data-model-back]");
    assert.ok(back && back.textContent.includes("chat.runtime.reasoning"), "reasoning page back button");
    await env.act(async () => back.click());
    assert.ok([...document.querySelectorAll('button')].some(n => n.textContent.includes('settings.reasoning.high')));
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});
