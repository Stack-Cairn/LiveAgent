// Settings → Providers opens on a vendor tab that actually has providers, and
// an empty tab names its vendor instead of claiming nothing is configured.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const messages = {
  "settings.noProvidersHint": "NO-PROVIDERS",
  "settings.noProvidersForService": "NO-{service}-PROVIDERS",
};
const locale = { locale: "en-US", t: (key) => messages[key] ?? key };
const env = await createDomTestEnv({
  mocks: {
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": new Proxy(
      {},
      { get: (_target, name) => (name === "__esModule" ? true : () => null) },
    ),
  },
});
const { ProvidersSection } = env.loadModule("@liveagent/ui/pages/settings/ProvidersSection.tsx");
const { getDefaultSettings } = env.loadModule("@liveagent/ui/lib/settings/index.ts");

function provider(id, type) {
  return {
    id,
    name: `Provider ${id}`,
    type,
    baseUrl: "http://127.0.0.1:9/v1",
    isFullUrl: false,
    apiKey: "",
    models: [],
    activeModels: [],
  };
}

async function mount(customProviders) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  let settings = { ...getDefaultSettings(), customProviders };
  const render = () =>
    root.render(
      env.React.createElement(ProvidersSection, {
        settings,
        setSettings: (update) => {
          settings = typeof update === "function" ? update(settings) : update;
          render();
        },
      }),
    );
  await env.act(async () => render());
  const selectedTab = () =>
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";
  const panelText = () => host.querySelector('[role="tabpanel"]')?.textContent ?? "";
  const rerender = async (next) => {
    settings = { ...settings, customProviders: next };
    await env.act(async () => render());
  };
  const unmount = async () => {
    await env.act(async () => root.unmount());
    host.remove();
  };
  return { selectedTab, panelText, rerender, unmount };
}

test("opens the first vendor tab that has providers", async () => {
  const view = await mount([provider("a", "codex")]);
  try {
    assert.match(view.selectedTab(), /OpenAI/);
    assert.match(view.panelText(), /Provider a/);
    assert.doesNotMatch(view.panelText(), /NO-/);
  } finally {
    await view.unmount();
  }
});

test("follows providers that load after the section mounted", async () => {
  const view = await mount([]);
  try {
    assert.match(view.selectedTab(), /Anthropic/);
    await view.rerender([provider("b", "deepseek")]);
    assert.match(view.selectedTab(), /DeepSeek/);
  } finally {
    await view.unmount();
  }
});

test("an empty vendor tab names its vendor", async () => {
  const view = await mount([]);
  try {
    assert.match(view.panelText(), /NO-Anthropic-PROVIDERS/);
  } finally {
    await view.unmount();
  }
});

test.after(() => env.cleanup());
