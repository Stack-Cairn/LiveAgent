import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const shared = (name) => fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));

async function renderProvider(initialData) {
  let vm;
  const requests = [];
  const env = await createDomTestEnv({
    mocks: {
      [shared("ProviderModalView.tsx")]: { ProviderModalView: ({ viewModel }) => { vm = viewModel; return null; } },
      "@liveagent/adapters/providerSettings": {
        providerCredentialsRedacted: true,
        revealStoredProviderApiKey: async () => { throw new Error("discovery must not reveal stored keys"); },
        discoverProviderModels: async (input) => {
          requests.push(input);
          return [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }];
        },
      },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/app/lib/providers/usageQuery": { testProviderUsage: async () => null },
      "@liveagent/ui/lib/models/thinkingLive": { loadThinkingLiveSupplement: async () => {} },
      "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
      "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
    },
  });
  const { ProviderModal } = env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  await env.act(async () => root.render(env.React.createElement(ProviderModal, {
    providerType: "deepseek", initialData, onSave() {}, onClose() {},
  })));
  return {
    env, requests, get vm() { return vm; },
    async waitForDiscovery() { await env.act(async () => new Promise((resolve) => setTimeout(resolve, 1000))); },
    async cleanup() { await env.act(async () => root.unmount()); env.cleanup(); },
  };
}

const savedProvider = {
  id: "builtin-deepseek", name: "DeepSeek", type: "deepseek",
  baseUrl: "https://api.deepseek.com", apiKey: "", apiKeyConfigured: true,
  models: [], activeModels: [],
};

test("DeepSeek automatically discovers models using the backend's saved credential", async () => {
  const fixture = await renderProvider(savedProvider);
  try {
    await fixture.waitForDiscovery();
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].providerId, "builtin-deepseek");
    assert.equal(fixture.requests[0].apiKey, "");
    assert.equal(fixture.requests[0].requestFormat, undefined);
    assert.deepEqual(Array.from(fixture.vm.models, (model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
    await fixture.env.act(async () => fixture.vm.handleRefresh());
    assert.equal(fixture.requests.length, 2, "manual refresh still works after automatic discovery");
  } finally { await fixture.cleanup(); }
});

test("DeepSeek does not reuse a saved credential after its endpoint changes", async () => {
  const fixture = await renderProvider(savedProvider);
  try {
    await fixture.env.act(async () => fixture.vm.setBaseUrl("https://other.example/v1"));
    await fixture.waitForDiscovery();
    assert.equal(fixture.requests.length, 0);
    await fixture.env.act(async () => fixture.vm.handleRefresh());
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.vm.fetchError, "settings.noBaseUrlApiKey");
  } finally { await fixture.cleanup(); }
});

test("DeepSeek with a new key discovers models without a hidden Responses format", async () => {
  const fixture = await renderProvider({ ...savedProvider, apiKey: "fixture-key", apiKeyConfigured: false });
  try {
    await fixture.waitForDiscovery();
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].apiKey, "fixture-key");
    assert.equal(fixture.requests[0].requestFormat, undefined);
  } finally { await fixture.cleanup(); }
});
