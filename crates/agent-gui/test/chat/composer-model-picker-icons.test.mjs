import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 模型菜单的供应商分组标题与每行模型前都要显示供应商品牌图标（v1.3.5 的行为，
// UI 重构 #824 时丢失）。图标替身把收到的 type 与 className 落到 DOM 上，
// 断言渲染位置、供应商类型与尺寸层级。
test("model picker shows the provider brand icon on group headers and model rows", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : icon) }),
    "@liveagent/ui/components/ProviderBrandIcon": {
      // env 在渲染时已经赋值；替身只在渲染阶段被调用。
      ProviderBrandIcon: ({ type, className }) =>
        env.React.createElement("span", { "data-brand-icon": type ?? "", className }),
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  // JSDOM does not implement the Web Animations API used by Base UI ScrollArea.
  window.HTMLElement.prototype.getAnimations ??= () => [];
  const { ComposerModelControls } = env.loadModule("@liveagent/ui/components/chat/ComposerModelControls.tsx");
  const { toModelValue } = env.loadModule("@liveagent/ui/lib/models/modelValue.ts");
  const modelOptions = [
    { model: "claude-sonnet-4-5", providerId: "anthropic", providerName: "Anthropic", providerType: "claude_code" },
    { model: "claude-opus-4-6", providerId: "anthropic", providerName: "Anthropic", providerType: "claude_code" },
    { model: "gemini-2.5-pro", providerId: "google", providerName: "Google", providerType: "gemini" },
    { model: "deepseek-chat", providerId: "ds", providerName: "DeepSeek", providerType: "deepseek" },
  ].map(option => ({ ...option, label: option.model, value: toModelValue(option.providerId, option.model) }));
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const brandIcon = node => node.querySelector("[data-brand-icon]");
  try {
    await env.act(async () => root.render(env.React.createElement(ComposerModelControls, {
      executionMode: "tools", hasModels: true, currentModelLabel: "claude-sonnet-4-5",
      selectedValue: toModelValue("anthropic", "claude-sonnet-4-5"),
      modelOptions,
      chatRuntimeControls: { reasoning: "low", thinkingEnabled: true, nativeWebSearchEnabled: false },
      reasoningOptions: ["low", "high"], thinkingAlwaysOn: false,
      onSelectModel: () => {}, onSelectExecutionMode: () => {}, onOpenSettings: () => {},
      onChatRuntimeControlsChange: () => {},
    })));
    await env.act(async () => document.querySelector('[data-slot="popover-trigger"]').click());
    const toModelPage = [...document.querySelectorAll("button")].find(node => node.textContent.trim().startsWith("chat.selectModel"));
    assert.ok(toModelPage, "root panel links to the model page");
    await env.act(async () => toModelPage.click());

    const headers = [...document.querySelectorAll("[data-model-group]")];
    assert.deepEqual(
      headers.map(header => brandIcon(header)?.getAttribute("data-brand-icon")),
      ["claude_code", "gemini", "deepseek"],
      "each provider group header carries its own brand icon",
    );
    for (const header of headers) assert.match(brandIcon(header).className, /size-3\.5/);

    const rows = [...document.querySelectorAll("[data-model-option]")];
    assert.deepEqual(
      rows.map(row => brandIcon(row)?.getAttribute("data-brand-icon")),
      modelOptions.map(option => option.providerType),
      "each model row carries the brand icon of its provider",
    );
    // 行内图标比分组标题小一档；选中行更实，其余更淡。
    const selected = rows.find(row => row.getAttribute("aria-pressed") === "true");
    const unselected = rows.find(row => row.getAttribute("aria-pressed") === "false");
    assert.match(brandIcon(selected).className, /(^|\s)size-3(\s|$)/);
    assert.match(brandIcon(selected).className, /opacity-80/);
    assert.match(brandIcon(unselected).className, /opacity-45/);
    // 加图标不能挤掉模型名称，也不能改变 title。
    assert.deepEqual(
      rows.map(row => row.querySelector("[title]")?.getAttribute("title")),
      modelOptions.map(option => option.model),
    );
    assert.ok(rows.every((row, index) => row.textContent.includes(modelOptions[index].label)));

    // 模型行收在供应商下方的缩进容器里，带一条左侧引导线，形成上下级。
    const lists = [...document.querySelectorAll("[data-model-group-list]")];
    assert.equal(lists.length, headers.length);
    for (const list of lists) {
      assert.match(list.className, /(^|\s)ml-4(\s|$)/);
      assert.match(list.className, /(^|\s)border-l(\s|$)/);
    }
    assert.ok(rows.every(row => row.parentElement.hasAttribute("data-model-group-list")));
  } finally {
    await env.act(async () => root.unmount());
  }
});
