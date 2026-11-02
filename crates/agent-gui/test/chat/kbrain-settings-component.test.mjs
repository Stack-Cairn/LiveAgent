import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const shared = (name) => fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));

test("original ProviderModal retains model editing, order, enablement and write-only provider keys", async () => {
  let vm;
  const saved = [];
  const requests = [];
  const env = await createDomTestEnv({ mocks: {
    [shared("ProviderModalView.tsx")]: { ProviderModalView: ({ viewModel }) => { vm = viewModel; return null; } },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/app/lib/providers/usageQuery": { testProviderUsage: async () => null },
    "@liveagent/ui/lib/models/thinkingLive": { loadThinkingLiveSupplement: async () => {} },
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
  } });
  const runtime = env.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: "http://runtime.test", token: "backend-token", protocolVersion: "kbrain.agent.v1" });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ models: [{ id: "fresh", contextWindow: 32000, maxOutputToken: 2000 }] }));
  };
  const settings = env.loadModule("src/lib/settings/index.ts");
  const provider = settings.normalizeCustomProvider({
    id: "provider-a", type: "codex", name: "A", baseUrl: "https://vendor.invalid/v1",
    apiKey: "", apiKeyConfigured: true,
    models: [{ id: "first", contextWindow: 64000, maxOutputToken: 4000, limitsSource: "user" }, { id: "second" }],
    activeModels: ["first"], modelOrder: ["second", "first"], customHeaders: [{ key: "X-Client", value: "kept" }],
  });
  const { ProviderModal } = env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const render = async (value) => env.act(async () => root.render(env.React.createElement(ProviderModal, { key: value.id, providerType: value.type, initialData: value, onSave: (next) => saved.push(next), onClose: () => {} })));
  try {
    await render(provider);
    assert.equal(vm.apiKeyIsRedactedDisplay, true);
    await env.act(async () => { vm.handleRefresh(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(requests[0].url, "http://runtime.test/v1/settings/providers/provider-a/models");
    assert.equal(JSON.parse(requests[0].init.body).apiKey, "");
    await env.act(async () => vm.setNewModelName("manual"));
    await env.act(async () => vm.handleAddModel());
    await env.act(async () => vm.saveInlineModelSettings());
    await env.act(async () => vm.toggleModel("first"));
    await env.act(async () => vm.removeModel("second"));
    await env.act(async () => vm.handleModelReorder(["manual", "first", "fresh"]));
    await env.act(async () => vm.handleSave());
    assert.equal(saved[0].apiKey, "");
    assert.equal(saved[0].apiKeyConfigured, true);
    assert.deepEqual(saved[0].modelOrder, ["manual", "first", "fresh"]);
    assert.equal(saved[0].activeModels.includes("first"), false);
    assert.equal(saved[0].activeModels.includes("manual"), true);
    assert.equal(saved[0].models.find((model) => model.id === "first").contextWindow, 64000);
    assert.deepEqual(saved[0].customHeaders, provider.customHeaders);
    await render({ ...provider, id: "provider-b", name: "B" });
    assert.equal(vm.apiKeyIsRedactedDisplay, true);
    await env.act(async () => vm.setApiKey("replacement-key"));
    await env.act(async () => vm.handleSave());
    assert.equal(saved[1].apiKey, "replacement-key");
    await render({ ...provider, id: "provider-c", name: "C" });
    await env.act(async () => vm.setApiKey(""));
    await env.act(async () => vm.handleSave());
    assert.equal(saved[2].apiKeyConfigured, false, "explicitly clearing the placeholder clears only this provider's key");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    globalThis.fetch = oldFetch;
    env.cleanup();
  }
});

test("CC Switch and Cherry imports retain the original setSettings persistence chain without local credential writes", async () => {
  let cherry;
  const writes = [];
  const requests = [];
  const saves = [];
  const ccs = { sourceId: "cc-1", appType: "codex", providerType: "codex", name: "CC fixture", baseUrl: "https://cc.invalid/v1", apiKey: "cc-import-secret", requestFormat: "openai-responses", models: ["cc-model"] };
  const cherryItem = { sourceId: "ch-1", providerType: "codex", name: "Cherry fixture", baseUrl: "https://cherry.invalid/v1", apiKey: "cherry-import-secret", requestFormat: "openai-responses", importable: true };
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
    [fileURLToPath(new URL("../../src/pages/settings/CherryStudioImportModal.tsx", import.meta.url))]: { CherryStudioImportModal: (props) => { cherry = props; return null; } },
    "@liveagent/app/shims/tauriCore": { invoke: async (command) => {
      if (command === "settings_list_ccswitch_providers") return { status: "ok", providers: [ccs] };
      if (command === "settings_list_cherry_studio_providers") return { status: "ok", providers: [cherryItem] };
      assert.fail(`unexpected native command ${command}`);
    } },
  } });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: (key, value) => writes.push({ key, value }), removeItem: () => {} } });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    requests.push({ url, body, method: init?.method });
    return new Response(JSON.stringify(url.endsWith("/models") ? { models: [{ id: "discovered", contextWindow: 32000, maxOutputToken: 1000 }] } : { mode: "kbrain", defaultProvider: "", defaultModel: "", providers: [], models: [] }));
  };
  const runtime = env.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: "http://runtime.test", token: "runtime-token", protocolVersion: "kbrain.agent.v1" });
  const settingsApi = env.loadModule("src/lib/settings/index.ts");
  const { persistSettings } = env.loadModule("src/lib/settings/storage.ts");
  const { ProviderSettingsExtension } = env.loadModule("src/agent-ui-adapters/providerSettings.tsx");
  let current = settingsApi.getDefaultSettings();
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const render = () => root.render(env.React.createElement(ProviderSettingsExtension, { settings: current, setSettings: (updater) => {
    const previous = current;
    current = updater(current);
    saves.push(persistSettings(previous, current));
    render();
  } }));
  const click = async (text) => {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text || node.getAttribute("aria-label") === text);
    assert.ok(button, `missing button ${text}`);
    await env.act(async () => button.click());
  };
  try {
    await env.act(async () => render());
    await click("settings.importProviders");
    const ccButton = [...document.querySelectorAll("button")].find((node) => node.textContent.includes("CC Switch"));
    await env.act(async () => ccButton.click());
    await env.act(async () => document.querySelector('input[type="checkbox"]').click());
    await click("导入 1 项");
    await env.act(async () => Promise.all(saves));
    const imported = current.customProviders.find((provider) => provider.id === "ccswitch-cc-1");
    assert.equal(imported.apiKey, "cc-import-secret");
    assert.ok(imported.models.some((model) => model.id === "cc-model"));
    assert.ok(imported.models.some((model) => model.id === "discovered"));
    await click("关闭");
    await click("settings.importProviders");
    const cherryButton = [...document.querySelectorAll("button")].find((node) => node.textContent.includes("Cherry Studio"));
    await env.act(async () => cherryButton.click());
    await env.act(async () => { cherry.onConfirm([cherryItem]); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await env.act(async () => Promise.all(saves));
    assert.ok(current.customProviders.some((provider) => provider.id === "cherry-studio-ch-1"));
    current = { ...current, customProviders: current.customProviders.map((provider) => provider.id === "cherry-studio-ch-1" ? { ...provider, apiKey: "", apiKeyConfigured: true, activeModels: [], modelOrder: ["discovered"], models: provider.models.map((model) => ({ ...model, contextWindow: 96000, limitsSource: "user" })) } : provider) };
    await env.act(async () => render());
    await click("settings.importProviders");
    const cherryAgain = [...document.querySelectorAll("button")].find((node) => node.textContent.includes("Cherry Studio"));
    await env.act(async () => cherryAgain.click());
    await env.act(async () => { cherry.onConfirm([cherryItem]); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await env.act(async () => Promise.all(saves));
    const resynced = current.customProviders.find((provider) => provider.id === "cherry-studio-ch-1");
    assert.equal(resynced.apiKey, "", "resync must not replace a backend-owned key with the imported key");
    assert.equal(resynced.apiKeyConfigured, true);
    const resyncRequest = [...requests]
      .reverse()
      .find((request) => request.method === "POST" && request.url.endsWith("/models"));
    assert.equal(
      resyncRequest?.body.apiKey,
      "cherry-import-secret",
      "re-import must use the source key for discovery when the backend redacts the saved key",
    );
    assert.deepEqual(resynced.activeModels, [], "resync must not reactivate user-disabled models");
    assert.deepEqual(resynced.modelOrder, ["discovered"]);
    assert.equal(resynced.models[0].contextWindow, 96000);

    assert.ok(requests.some((request) => request.method === "PUT" && request.body.providers.some((provider) => provider.apiKey === "cc-import-secret")));
    assert.ok(requests.some((request) => request.method === "PUT" && request.body.providers.some((provider) => provider.apiKey === "cherry-import-secret")));
    assert.ok(requests.every((request) => request.url.startsWith("http://runtime.test/v1/settings")));
    assert.ok(writes.length > 0);
    assert.ok(writes.every(({ value }) => !value.includes("import-secret")), "only backend PUT may persist imported credentials");
  } finally {
    await env.act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
    env.cleanup();
  }
});
