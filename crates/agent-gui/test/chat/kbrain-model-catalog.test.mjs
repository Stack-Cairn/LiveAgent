import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const historyWrites = [];
const env = await createDomTestEnv({
  mocks: {
    "../../../lib/chat/history/chatHistory": {
      async setChatHistoryModel(id, selectedModelJson) {
        historyWrites.push({ id, selectedModelJson });
        return { id, selectedModelJson };
      },
    },
  },
});
after(() => env.cleanup());
const { React, act, createRoot, loadModule } = env;
const { normalizeSettings } = loadModule("src/lib/settings/index.ts");
const { projectKBrainProviders, projectKBrainSettings, useKBrainCatalogSettings } = loadModule("src/lib/kbrain/catalog.ts");
const { useChatModelSelection } = loadModule("src/pages/chat/runtime/useChatModelSelection.ts");
const { resolveEffectiveChatModelSelection } = loadModule("src/pages/chat/runtime/modelSelection.ts");

const runtimeConnection = loadModule("src/lib/kbrain/runtimeConnection.ts");

function directSettings() {
  return normalizeSettings({
    customProviders: [{
      id: "local-provider", type: "codex", name: "Local", apiKey: "direct-secret",
      baseUrl: "https://direct.invalid/v1", models: ["local-model", "local-other"],
      activeModels: ["local-model", "local-other"],
    }],
    selectedModel: { customProviderId: "local-provider", model: "local-model" },
  });
}

async function mount(run) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const previousFetch = globalThis.fetch;
  runtimeConnection.setKBrainRuntimeConnection({ baseUrl: "http://kbrain.test/", token: "backend-token", protocolVersion: "kbrain.agent.v1" });
  try { await run(root); }
  finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = previousFetch;
    runtimeConnection.clearKBrainRuntimeConnection();
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const refs = [
  { provider: "backend-anthropic-account", model: "claude-test" },
  { provider: "backend-openai-account", model: "gpt-test" },
  { provider: "backend-anthropic-account", model: "claude-other" },
  { provider: "backend-anthropic-account", model: "claude-test" },
];

test("catalog projection keeps opaque backend IDs, deduplicates pairs and never carries direct credentials", () => {
  const direct = directSettings();
  const before = JSON.stringify(direct);
  const providers = projectKBrainProviders([...refs, { provider: "", model: "bad" }, null]);
  assert.deepEqual(providers.map(p => p.id), ["backend-anthropic-account", "backend-openai-account"]);
  assert.deepEqual(providers[0].activeModels, ["claude-test", "claude-other"]);
  assert.deepEqual(providers[0].models.map(m => m.id), providers[0].activeModels);
  for (const provider of providers) {
    assert.equal(provider.apiKey, "");
    assert.equal(provider.baseUrl, "");
    assert.equal(provider.customHeaders, undefined);
    assert.equal(provider.usageQuery.apiKey, "");
  }
  const projected = projectKBrainSettings(direct, providers);
  assert.equal(projected.customProviders, providers);
  assert.equal(projected.selectedModel, undefined, "a selection missing from the catalog is dropped");
  const kept = projectKBrainSettings(
    { ...direct, selectedModel: { customProviderId: "backend-anthropic-account", model: "claude-other" } },
    providers,
  );
  assert.deepEqual(kept.selectedModel, { customProviderId: "backend-anthropic-account", model: "claude-other" });
  assert.equal(projected.system, direct.system);
  assert.equal(JSON.stringify(direct), before);
});

test("catalog activates models newly added by a provider import", () => {
  const existing = directSettings();
  const providers = projectKBrainProviders(
    [{ provider: "local-provider", model: "imported-model", contextWindow: 64000 }],
    existing.customProviders,
  );
  assert.deepEqual(providers[0].activeModels, ["imported-model"]);
  assert.deepEqual(providers[0].models.map((model) => model.id), ["imported-model"]);
  assert.equal(providers[0].models[0].contextWindow, 64000);
});

test("real catalog and selection hooks fetch /v1/models with the runtime connection", async () => {
  await mount(async root => {
    const request = deferred();
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return request.promise; };
    const direct = directSettings();
    const before = JSON.stringify(direct);
    let snapshot, writes = 0;
    const settingsWrites = [];
    const entryRef = { current: new Map([["conversation", { isSending: false }]]) };
    const idRef = { current: "conversation" };
    const rows = new Map();
    const sidebarStore = { peek: () => ({ id: "conversation", isPending: false }), upsertLocal() {} };
    function Page({ theme = direct.theme }) {
      const [selectedModel, setSelectedModel] = React.useState();
      const settings = React.useMemo(() => ({ ...direct, theme }), [theme]);
      const catalog = useKBrainCatalogSettings(settings);
      const selection = useChatModelSelection({
        settings: catalog.settings,
        // In the app the persisted settings hold the K-brain providers (same IDs as the catalog).
        setSettings(updater) { writes++; settingsWrites.push(updater({ ...direct, customProviders: catalog.settings.customProviders })); },
        t: key => key,
        sidebarStore,
        sidebarConversationsById: rows,
        currentConversationId: "conversation",
        currentConversationSelectedModel: selectedModel,
        currentConversationIdRef: idRef,
        conversationRuntimeCacheRef: entryRef,
        updateConversationRuntimeEntry: React.useCallback((id, updater) => {
          const next = updater(entryRef.current.get(id));
          entryRef.current.set(id, next);
          setSelectedModel(next.selectedModel);
          return next;
        }, []),
      });
      snapshot = { catalog, selection, selectedModel };
      return null;
    }
    await act(async () => root.render(React.createElement(Page)));
    assert.equal(snapshot.selection.hasModels, false, "pending catalog must not expose local providers");
    assert.equal(snapshot.selection.activeSelectedModel, undefined);
    await act(async () => request.resolve(new Response(JSON.stringify({ models: refs }), { status: 200 })));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://kbrain.test/v1/models");
    assert.equal(calls[0].init.headers.Authorization, "Bearer backend-token");
    assert.deepEqual(snapshot.selection.modelOptions.map(o => [o.providerId, o.model]), [
      ["backend-anthropic-account", "claude-test"],
      ["backend-anthropic-account", "claude-other"],
      ["backend-openai-account", "gpt-test"],
    ]);
    const selection = { customProviderId: "backend-anthropic-account", model: "claude-other" };
    await act(async () => snapshot.selection.handleSelectModel(selection));
    assert.deepEqual(snapshot.selection.activeSelectedModel, selection);
    assert.equal(snapshot.selection.currentModelLabel, "backend-anthropic-account / claude-other");
    const effective = resolveEffectiveChatModelSelection({
      settings: snapshot.catalog.settings, conversationSelectedModel: snapshot.selectedModel,
    });
    assert.equal(effective.provider, snapshot.catalog.settings.customProviders[0]);
    assert.equal(effective.provider.apiKey, "");
    assert.equal(effective.selectedModel.customProviderId, "backend-anthropic-account", "turn model.provider must use the backend ID");
    assert.deepEqual(JSON.parse(historyWrites.at(-1).selectedModelJson), selection);
    // The pick also becomes the default model (saved to K-brain) so a restart restores it.
    assert.equal(writes, 1);
    assert.deepEqual(settingsWrites[0].selectedModel, selection);
    assert.equal(JSON.stringify(direct), before);
    assert.equal(snapshot.catalog.settings.customProviders[0].apiKey, "");
    const modelOptions = snapshot.selection.modelOptions;
    await act(async () => root.render(React.createElement(Page, { theme: "dark" })));
    assert.equal(snapshot.selection.modelOptions, modelOptions);
    assert.equal(calls.length, 1, "unrelated settings changes must not refetch the catalog");
    const restored = { customProviderId: "backend-openai-account", model: "gpt-test" };
    rows.set("conversation", { selectedModelJson: JSON.stringify(restored) });
    await act(async () => root.render(React.createElement(Page, { theme: "light" })));
    assert.deepEqual(snapshot.selection.activeSelectedModel, restored, "history-sync must validate against the same backend catalog");
    assert.equal(writes, 1, "history-sync never rewrites the default model");
    assert.equal(JSON.stringify(direct), before);
  });
});

test("catalog failure and empty responses never fall back to direct providers; late requests are ignored", async () => {
  await mount(async root => {
    const oldRequest = deferred();
    const direct = directSettings();
    let snapshot;
    globalThis.fetch = async url => {
      if (url.startsWith("http://old.test")) return oldRequest.promise;
      if (url.startsWith("http://failed.test")) return new Response("offline", { status: 503 });
      return new Response("[]", { status: 200 });
    };
    function Page({ baseUrl }) {
      snapshot = useKBrainCatalogSettings(direct, { enabled: true, baseUrl, token: "backend-token" });
      return null;
    }
    await act(async () => root.render(React.createElement(Page, { baseUrl: "http://old.test" })));
    await act(async () => root.render(React.createElement(Page, { baseUrl: "http://failed.test" })));
    assert.match(snapshot.error, /offline/);
    assert.deepEqual(snapshot.settings.customProviders, []);
    await act(async () => oldRequest.resolve(new Response(JSON.stringify(refs))));
    assert.match(snapshot.error, /offline/);
    assert.deepEqual(snapshot.settings.customProviders, []);
    await act(async () => root.render(React.createElement(Page, { baseUrl: "http://empty.test" })));
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.settings.customProviders, []);
  });
});

test("catalog remains backend-owned without a direct-mode branch", async () => {
  await mount(async root => {
    let fetches = 0;
    let snapshot;
    const settings = directSettings();
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify({ models: refs }), { status: 200 });
    };
    function Page() {
      snapshot = useKBrainCatalogSettings(settings);
      return null;
    }
    await act(async () => root.render(React.createElement(Page)));
    assert.equal(snapshot.settings.customProviders.length, 2);
    assert.equal(fetches, 1);
    assert.equal(snapshot.settings.customProviders[0].apiKey, "");
    assert.equal(snapshot.settings.customProviders[0].baseUrl, "");
  });
});

test("ChatPage projects once before model selection and send, without replacing its settings writer", () => {
  const source = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  assert.match(source, /settings: directSettings,/);
  assert.match(source, /const \{ settings, error: modelCatalogError \}\s*=\s*useKBrainCatalogSettings\(directSettings\)/);
  assert.match(source, /useChatModelSelection\(\{\s*settings,\s*setSettings,/);
  assert.match(source, /useSendChatTurn\(\{\s*settings,/);
  assert.match(source, /errorMessage: errorMessage \?\? modelCatalogError/);
});
