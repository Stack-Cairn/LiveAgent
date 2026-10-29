// Opening the model list must bring the active model into view: with a long
// catalog the current choice is otherwise hidden below other providers.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("entering the model list scrolls the active model into view and expands its provider", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy(
        {},
        { get: (_target, name) => (name === "__esModule" ? true : icon) },
      ),
      "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    },
  });
  window.HTMLElement.prototype.getAnimations ??= () => [];
  const { ComposerModelControls } = env.loadModule(
    "@liveagent/ui/components/chat/ComposerModelControls.tsx",
  );
  const { toModelValue } = env.loadModule("@liveagent/ui/lib/models/modelValue.ts");

  // A long first provider pushes the active model (second provider) out of view.
  const modelOptions = [
    ...Array.from({ length: 30 }, (_, index) => ({
      model: `first-${index}`,
      label: `first-${index}`,
      providerId: "first",
      providerName: "First",
      providerType: "openai",
      value: toModelValue("first", `first-${index}`),
    })),
    ...["second-a", "second-b"].map((model) => ({
      model,
      label: model,
      providerId: "second",
      providerName: "Second",
      providerType: "openai",
      value: toModelValue("second", model),
    })),
  ];

  // JSDOM has no layout: place the viewport and the active row, and record scrolls.
  const scrolls = [];
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.matches?.("[data-scroll-viewport]")) {
      return { top: 100, bottom: 380, height: 280, left: 0, right: 300, width: 300 };
    }
    if (this.matches?.('button[data-model-option][aria-pressed="true"]')) {
      return { top: 1000, bottom: 1028, height: 28, left: 0, right: 300, width: 300 };
    }
    return originalRect.call(this);
  };
  const watchViewport = () => {
    const viewport = document.querySelector("[data-scroll-viewport]");
    assert.ok(viewport, "the model list has a scroll viewport");
    let top = 0;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = value;
        scrolls.push(value);
      },
    });
  };

  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const trigger = () => document.querySelector('[data-slot="popover-trigger"]');
  const enterModelList = async () => {
    const entry = [...document.querySelectorAll("button")].find((node) =>
      node.textContent.trim().startsWith("chat.selectModel"),
    );
    assert.ok(entry, "model page entry");
    await env.act(async () => entry.click());
    watchViewport();
    await env.act(async () => sleep(80));
  };
  try {
    await env.act(async () =>
      root.render(
        env.React.createElement(ComposerModelControls, {
          executionMode: "tools",
          hasModels: true,
          currentModelLabel: "second-b",
          selectedValue: toModelValue("second", "second-b"),
          modelOptions,
          chatRuntimeControls: { reasoning: "low", thinkingEnabled: false, nativeWebSearchEnabled: false },
          reasoningOptions: [],
          thinkingAlwaysOn: false,
          onSelectModel() {},
          onSelectExecutionMode() {},
          onOpenSettings() {},
          onChatRuntimeControlsChange() {},
        }),
      ),
    );
    await env.act(async () => trigger().click());
    await enterModelList();
    // Centered: 1000 - 100 - (280 - 28) / 2.
    assert.deepEqual(scrolls, [774], "the active model is scrolled to the middle of the list");

    // Collapse the active model's provider, close and reopen: it is expanded again.
    const second = [...document.querySelectorAll("[data-model-group]")].find((node) =>
      node.textContent.includes("Second"),
    );
    await env.act(async () => second.click());
    assert.equal(second.getAttribute("aria-expanded"), "false");
    await env.act(async () => trigger().click());
    await env.act(async () => sleep(50));
    await env.act(async () => trigger().click());
    scrolls.length = 0;
    await enterModelList();
    const reopened = [...document.querySelectorAll("[data-model-group]")].find((node) =>
      node.textContent.includes("Second"),
    );
    assert.equal(reopened.getAttribute("aria-expanded"), "true", "the active provider is expanded");
    assert.deepEqual(scrolls, [774]);

    // Typing a search does not move the list again.
    scrolls.length = 0;
    const search = document.querySelector('input[placeholder="chat.searchModel"]');
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        search,
        "second",
      );
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await env.act(async () => sleep(50));
    assert.deepEqual(scrolls, []);
  } finally {
    window.Element.prototype.getBoundingClientRect = originalRect;
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});
