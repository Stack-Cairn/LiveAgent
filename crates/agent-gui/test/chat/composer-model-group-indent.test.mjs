import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 模型列表缩进容器 data-model-group-list 在折叠、搜索、按名排序与
// 键盘导航下的结构不变量。
async function setup() {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: (_t, name) => (name === "__esModule" ? true : icon) }),
    "@liveagent/ui/components/ProviderBrandIcon": {
      ProviderBrandIcon: ({ type, className }) => env.React.createElement("span", { "data-brand-icon": type ?? "", className }),
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  window.HTMLElement.prototype.getAnimations ??= () => [];
  // 组件 onKeyDown 用到全局 HTMLInputElement；fixture 未挂到 globalThis（浏览器里本来就有）。
  globalThis.HTMLInputElement ??= window.HTMLInputElement;
  const { ComposerModelControls } = env.loadModule("@liveagent/ui/components/chat/ComposerModelControls.tsx");
  const { toModelValue } = env.loadModule("@liveagent/ui/lib/models/modelValue.ts");
  const modelOptions = [
    { model: "zeta-1", providerId: "zp", providerName: "Zprov", providerType: "openai" },
    { model: "claude-sonnet-4-5", providerId: "anthropic", providerName: "Anthropic", providerType: "claude_code", reasoning: true, vision: true, contextWindow: 200000 },
    { model: "claude-opus-4-6", providerId: "anthropic", providerName: "Anthropic", providerType: "claude_code" },
    { model: "gemini-2.5-pro", providerId: "google", providerName: "Google", providerType: "gemini" },
  ].map(o => ({ ...o, label: o.model, value: toModelValue(o.providerId, o.model) }));
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  await env.act(async () => root.render(env.React.createElement(ComposerModelControls, {
    executionMode: "tools", hasModels: true, currentModelLabel: "claude-sonnet-4-5",
    selectedValue: toModelValue("anthropic", "claude-sonnet-4-5"), modelOptions,
    chatRuntimeControls: { reasoning: "low", thinkingEnabled: true, nativeWebSearchEnabled: false },
    reasoningOptions: ["low", "high"], thinkingAlwaysOn: false,
    onSelectModel: () => {}, onSelectExecutionMode: () => {}, onOpenSettings: () => {}, onChatRuntimeControlsChange: () => {},
  })));
  await env.act(async () => document.querySelector('[data-slot="popover-trigger"]').click());
  const toModel = [...document.querySelectorAll("button")].find(n => n.textContent.trim().startsWith("chat.selectModel"));
  await env.act(async () => toModel.click());
  return { env, root, modelOptions };
}

// 每个分组：标题 aria-controls 指向的容器就是 data-model-group-list，且该组的模型行全部是它的直接子元素。
function assertGroupStructure() {
  const headers = [...document.querySelectorAll("[data-model-group]")];
  const lists = [...document.querySelectorAll("[data-model-group-list]")];
  assert.equal(lists.length, headers.length);
  for (const header of headers) {
    const list = document.getElementById(header.getAttribute("aria-controls"));
    assert.ok(list?.hasAttribute("data-model-group-list"), "aria-controls 指向缩进容器");
    const expanded = header.getAttribute("aria-expanded") === "true";
    const rows = [...list.querySelectorAll("[data-model-option]")];
    if (!expanded) assert.equal(list.children.length, 0, "折叠分组容器为空");
    else {
      assert.ok(rows.length > 0);
      assert.ok(rows.every(r => r.parentElement === list));
      assert.equal(list.children.length, rows.length, "容器里没有混入非模型行节点");
    }
  }
}

function navOrder() {
  return [...document.querySelectorAll("button[data-model-option], button[data-model-group]")]
    .map(n => (n.hasAttribute("data-model-group") ? `G:${n.textContent.replace(/\d+$/, "")}` : `M:${n.querySelector("[title]").getAttribute("title")}`));
}

async function press(env, key) {
  await env.act(async () => {
    document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function focusedLabel() {
  const n = document.activeElement;
  if (n.hasAttribute("data-model-group")) return `G:${n.textContent.replace(/\d+$/, "")}`;
  if (n.hasAttribute("data-model-option")) return `M:${n.querySelector("[title]").getAttribute("title")}`;
  return n.tagName;
}

test("ArrowDown/ArrowUp 在缩进容器里按 标题→行→下一标题 顺序移动并回绕", async () => {
  const { env, root } = await setup();
  try {
    assertGroupStructure();
    const order = navOrder();
    document.querySelector("button[data-model-group]").focus();
    const seen = [focusedLabel()];
    for (let i = 0; i < order.length; i++) { await press(env, "ArrowDown"); seen.push(focusedLabel()); }
    assert.deepEqual(seen, [...order, order[0]]);
    await press(env, "ArrowUp");
    assert.equal(focusedLabel(), order[order.length - 1]);
  } finally { await env.act(async () => root.unmount()); }
});

test("折叠一组后容器为空、键盘顺序跳过该组模型；展开恢复", async () => {
  const { env, root } = await setup();
  try {
    const anthropic = [...document.querySelectorAll("[data-model-group]")].find(n => n.textContent.includes("Anthropic"));
    await env.act(async () => anthropic.click());
    assertGroupStructure();
    assert.ok(!navOrder().some(x => x.startsWith("M:claude")));
    anthropic.focus();
    await press(env, "ArrowDown");
    assert.ok(focusedLabel().startsWith("G:"), `折叠组标题的下一项是下一个标题，实际 ${focusedLabel()}`);
    await env.act(async () => anthropic.click());
    assertGroupStructure();
  } finally { await env.act(async () => root.unmount()); }
});

test("搜索与按名称排序下结构不变量保持", async () => {
  const { env, root } = await setup();
  try {
    const input = document.querySelector('input[aria-label="chat.searchModel"]');
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await env.act(async () => { setValue.call(input, "opus"); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
    assertGroupStructure();
    assert.deepEqual(navOrder(), ["G:Anthropic", "M:claude-opus-4-6"]);
    await env.act(async () => { setValue.call(input, ""); input.dispatchEvent(new window.Event("input", { bubbles: true })); });

    const sort = document.querySelector('button[aria-pressed][title^="chat.sortProviders"]');
    const before = navOrder();
    await env.act(async () => sort.click());
    assertGroupStructure();
    const after = navOrder();
    assert.notDeepEqual(after, before, "排序切换改变了分组顺序");
    // 每个模型行仍紧跟在它自己的供应商标题之后（不会因排序串到别组容器）。
    for (const list of document.querySelectorAll("[data-model-group-list]")) {
      const header = document.querySelector(`[aria-controls="${list.id}"]`);
      const name = header.textContent.replace(/\d+$/, "");
      const providerOf = { Anthropic: /^claude/, Google: /^gemini/, Zprov: /^zeta/ }[name];
      for (const row of list.querySelectorAll("[data-model-option]")) assert.match(row.querySelector("[title]").getAttribute("title"), providerOf);
    }
  } finally { await env.act(async () => root.unmount()); }
});
