import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
after(() => env.cleanup());
const { React, act, createRoot, loadModule } = env;
const { normalizeSettings } = loadModule("src/lib/settings/index.ts");
const { KBRAIN_SETTINGS_CHANGED_EVENT, useKBrainCatalogSettings } = loadModule(
  "src/lib/kbrain/catalog.ts",
);
const { mergeBackendOwnedSettings } = loadModule("src/lib/settings/backendOwnedMerge.ts");
const runtimeConnection = loadModule("src/lib/kbrain/runtimeConnection.ts");

const refs = [
  { provider: "backend-anthropic-account", model: "claude-test" },
  { provider: "backend-anthropic-account", model: "claude-other" },
  { provider: "backend-openai-account", model: "gpt-test" },
];

function backendSettings() {
  return normalizeSettings({
    customProviders: [
      {
        id: "backend-anthropic-account",
        type: "codex",
        name: "Anthropic",
        apiKey: "",
        baseUrl: "",
        models: ["claude-test", "claude-other"],
        activeModels: ["claude-test", "claude-other"],
      },
      {
        id: "backend-openai-account",
        type: "codex",
        name: "OpenAI",
        apiKey: "",
        baseUrl: "",
        models: ["gpt-test"],
        activeModels: ["gpt-test"],
      },
    ],
    selectedModel: { customProviderId: "backend-anthropic-account", model: "claude-test" },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount(run) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const previousFetch = globalThis.fetch;
  runtimeConnection.setKBrainRuntimeConnection({
    baseUrl: "http://kbrain.test/",
    token: "backend-token",
    protocolVersion: "kbrain.agent.v1",
  });
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = previousFetch;
    runtimeConnection.clearKBrainRuntimeConnection();
  }
}

/** Mounts the real catalog hook and records the provider list seen by every render. */
async function mountCatalog(root, initialSettings) {
  const pending = [];
  globalThis.fetch = async () => {
    const request = deferred();
    pending.push(request);
    return request.promise;
  };
  const renders = [];
  let snapshot;
  function Page({ settings }) {
    snapshot = useKBrainCatalogSettings(settings);
    renders.push(snapshot.settings.customProviders);
    return null;
  }
  const render = (settings) => act(async () => root.render(React.createElement(Page, { settings })));
  const respond = () =>
    act(async () => {
      for (const request of pending.splice(0)) {
        request.resolve(new Response(JSON.stringify({ models: refs }), { status: 200 }));
      }
    });
  await render(initialSettings);
  await respond();
  return { renders, render, respond, pending, get snapshot() { return snapshot; } };
}

test("a backend settings save (model pick) refreshes the catalog without an empty frame", async () => {
  await mount(async (root) => {
    const harness = await mountCatalog(root, backendSettings());
    const loaded = harness.snapshot.settings.customProviders;
    assert.equal(loaded.length, 2, "catalog loaded");
    harness.renders.length = 0;

    // saveKBrainProviderSettings broadcasts this after every PATCH, including a model pick.
    await act(async () => window.dispatchEvent(new Event(KBRAIN_SETTINGS_CHANGED_EVENT)));
    assert.equal(harness.pending.length, 1, "the catalog is still refreshed after a backend write");
    assert.ok(
      harness.renders.every((providers) => providers.length === 2),
      "the previous catalog stays visible while the refresh is in flight",
    );
    await harness.respond();
    assert.ok(harness.renders.every((providers) => providers.length === 2));
    assert.equal(
      harness.snapshot.settings.customProviders,
      loaded,
      "an unchanged catalog keeps its provider references so model memos stay stable",
    );
  });
});

test("a content-equal customProviders write-back never blanks the catalog", async () => {
  await mount(async (root) => {
    const settings = backendSettings();
    const harness = await mountCatalog(root, settings);
    const loaded = harness.snapshot.settings.customProviders;
    harness.renders.length = 0;

    const rewritten = normalizeSettings({
      ...settings,
      customProviders: JSON.parse(JSON.stringify(settings.customProviders)),
    });
    assert.notEqual(rewritten.customProviders, settings.customProviders);
    await harness.render(rewritten);
    await harness.respond();
    assert.ok(harness.renders.every((providers) => providers.length === 2));
    assert.equal(harness.snapshot.settings.customProviders, loaded);
  });
});

test("a changed catalog still replaces the projected providers", async () => {
  await mount(async (root) => {
    const harness = await mountCatalog(root, backendSettings());
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ models: [refs[2]] }), { status: 200 });
    await act(async () => window.dispatchEvent(new Event(KBRAIN_SETTINGS_CHANGED_EVENT)));
    assert.deepEqual(
      harness.snapshot.settings.customProviders.map((provider) => provider.id),
      ["backend-openai-account"],
    );
  });
});

test("a backend connection change refreshes an already mounted catalog without a parent render", async () => {
  await mount(async (root) => {
    const harness = await mountCatalog(root, backendSettings());
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, authorization: new Headers(init.headers).get("Authorization") });
      return Response.json({ models: [refs[2]] });
    };
    await act(async () => runtimeConnection.setKBrainRuntimeConnection({
      baseUrl: "http://restarted.test", token: "rotated-token", protocolVersion: "kbrain.agent.v1",
      managedLocal: true, storageId: "same-data-root",
    }));
    assert.deepEqual(calls, [{ url: "http://restarted.test/v1/models", authorization: "Bearer rotated-token" }]);
    assert.deepEqual(harness.snapshot.settings.customProviders.map(provider => provider.id), ["backend-openai-account"]);
  });
});

test("explicit catalog endpoints remain isolated when the default connection rotates", async () => {
  await mount(async (root) => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, authorization: new Headers(init.headers).get("Authorization") });
      return Response.json({ models: refs });
    };
    const settings = backendSettings();
    function Page() {
      useKBrainCatalogSettings(settings, { baseUrl: "https://external.test", token: "external-token" });
      return null;
    }
    await act(async () => root.render(React.createElement(Page)));
    await act(async () => runtimeConnection.setKBrainRuntimeConnection({
      baseUrl: "http://restarted.test", token: "local-token", protocolVersion: "kbrain.agent.v1",
    }));
    assert.deepEqual(calls, [{ url: "https://external.test/v1/models", authorization: "Bearer external-token" }]);
  });
});

test("mergeBackendOwnedSettings skips write-backs whose content did not change", () => {
  const current = backendSettings();
  const sameContent = JSON.parse(JSON.stringify(current.customProviders));
  assert.equal(
    mergeBackendOwnedSettings(current, { customProviders: sameContent }, normalizeSettings),
    undefined,
  );
  assert.equal(
    mergeBackendOwnedSettings(
      current,
      { customProviders: sameContent, ssh: JSON.parse(JSON.stringify(current.ssh)) },
      normalizeSettings,
    ),
    undefined,
  );
  assert.equal(mergeBackendOwnedSettings(current, {}, normalizeSettings), undefined);
});

test("mergeBackendOwnedSettings applies real changes and keeps unchanged references", () => {
  const current = backendSettings();
  const changedProviders = JSON.parse(JSON.stringify(current.customProviders));
  changedProviders[1].name = "OpenAI renamed";
  const merged = mergeBackendOwnedSettings(
    current,
    { customProviders: changedProviders, ssh: JSON.parse(JSON.stringify(current.ssh)) },
    normalizeSettings,
  );
  assert.ok(merged);
  assert.equal(merged.customProviders[1].name, "OpenAI renamed");
  assert.equal(merged.ssh, current.ssh, "an unchanged backend-owned field keeps its reference");
  assert.equal(merged.stt, current.stt);
});

test("App write-back routes backend-owned fields through mergeBackendOwnedSettings", () => {
  const source = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const queueSettingsSave = useCallback(");
  const end = source.indexOf("const setSettings = useCallback(", start);
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /mergeBackendOwnedSettings\(\s*settingsRef\.current,\s*persistResult,/);
  assert.doesNotMatch(
    body,
    /\.\.\.settingsRef\.current,/,
    "the write-back must not blindly spread backend fields over current settings",
  );
});
