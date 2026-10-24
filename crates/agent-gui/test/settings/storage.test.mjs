import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const LOCAL_UI_SETTINGS_STORAGE_KEY = "liveagent.ui-settings.v1";
const BROWSER_SETTINGS_STORAGE_KEY = "liveagent.kbrain-browser-settings.v1";
const HOST_MODULE = new URL("../../src/lib/host.ts", import.meta.url).pathname;
const SETTINGS_DOCUMENT = {
  version: "kbrain.agent.v1",
  mode: "kbrain",
  defaultProvider: "backend-provider",
  defaultModel: "backend-model",
  providers: [{
    id: "backend-provider",
    name: "Backend provider",
    type: "codex",
    api: "openai-responses",
    baseUrl: "https://upstream.invalid/v1",
    apiKeyConfigured: true,
    models: [{ id: "backend-model", name: "Backend model", contextWindow: 32768, maxOutputTokens: 512 }],
  }],
};

function createMemoryLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

function jsonResponse(value) {
  return JSON.stringify(value);
}

async function startSettingsFixture({ document = SETTINGS_DOCUMENT, promptDocument = { revision: 1, globalTemplates: [], projectPrompts: {} }, mcpSettings = { servers: [], selected: [] }, getStatus = 200, putStatus = 200, mcpGetStatus = 200, mcpPutStatus = 200, timezoneStatuses = [200] } = {}) {
  let current = structuredClone(document);
  let prompts = structuredClone(promptDocument);
  let mcp = structuredClone(mcpSettings);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: request.method, path: request.url, headers: request.headers, body });
    if (request.url === "/v1/planning" && body?.action === "timezone") {
      const status = timezoneStatuses.length > 1 ? timezoneStatuses.shift() : timezoneStatuses[0];
      response.writeHead(status, { "content-type": "application/json" }); response.end(status === 200 ? "null" : JSON.stringify({ error: "timezone unavailable" })); return;
    }
    if (request.url?.startsWith("/v1/prompts") && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse(prompts));
      return;
    }
    if (request.url === "/v1/prompts/templates" && request.method === "PUT") {
      prompts = { ...prompts, revision: prompts.revision + 1, globalTemplates: body.templates ?? [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse(prompts));
      return;
    }
    if (request.url?.startsWith("/v1/prompts/templates/") && request.url.includes("/expand") && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse({ name: "review", text: `review ${body.args?.join(" ") ?? ""}`.trim() }));
      return;
    }
    if (request.url === "/v1/prompts/project" && request.method === "PUT") {
      prompts = {
        ...prompts,
        revision: prompts.revision + 1,
        projectPrompts: {
          ...prompts.projectPrompts,
          [body.workdir]: { workdir: body.workdir, prompt: body.prompt, strategy: body.strategy },
        },
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse(prompts));
      return;
    }
    if (request.url === "/v1/mcp" && request.method === "GET") {
      response.writeHead(mcpGetStatus, { "content-type": "application/json" });
      response.end(mcpGetStatus === 200 ? jsonResponse({ settings: mcp, statuses: [] }) : jsonResponse({ error: "MCP load diagnostic" }));
      return;
    }
    if (request.url === "/v1/mcp" && request.method === "PUT") {
      if (mcpPutStatus !== 200) {
        response.writeHead(mcpPutStatus, { "content-type": "application/json" });
        response.end(jsonResponse({ error: "MCP save diagnostic" }));
        return;
      }
      mcp = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse({ settings: mcp, statuses: [] }));
      return;
    }
    if (request.url === "/v1/settings" && request.method === "GET") {
      response.writeHead(getStatus, { "content-type": "application/json" });
      response.end(getStatus === 200
        ? jsonResponse({ ...current, providers: current.providers.map((provider) => ({ ...provider, apiKeyConfigured: true })) })
        : jsonResponse({ error: "backend storage diagnostic" }));
      return;
    }
    if (request.url === "/v1/settings" && request.method === "PUT") {
      if (putStatus !== 200) {
        response.writeHead(putStatus, { "content-type": "application/json" });
        response.end(jsonResponse({ error: "backend save diagnostic" }));
        return;
      }
      const update = body ?? {};
      if (Array.isArray(update.providers)) {
        current = {
          ...current,
          defaultProvider: update.defaultProvider || current.defaultProvider,
          defaultModel: update.defaultModel || current.defaultModel,
          providers: update.providers.map((provider) => ({
            ...provider,
            apiKey: undefined,
            apiKeyConfigured: provider.clearApiKey
              ? false
              : Boolean(provider.apiKey) || provider.apiKeyConfigured === true ||
                current.providers.find((existing) => existing.id === provider.id)?.apiKeyConfigured === true,
            models: (provider.models ?? []).map((model) => ({ provider: provider.id, ...model })),
          })),
        };
        current.providers = current.providers.map(({ apiKey: _apiKey, ...provider }) => provider);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jsonResponse(current));
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end(jsonResponse({ error: "unexpected fixture request" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    document: () => current,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withSettingsFixture({ browser = true, kbrainBackend = false, managedLocal = false, storageId = "fixture-storage", localStorage = createMemoryLocalStorage(), invoke, fixtureOptions, navigator = { languages: ["en-US"], language: "en-US" } }, task) {
  const fixture = await startSettingsFixture(fixtureOptions);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  const loader = createTsModuleLoader({
    mocks: {
      [HOST_MODULE]: {
        isKBrainBrowserHost: () => browser,
        isKBrainBackendEnabled: () => kbrainBackend,
        isTauriHost: () => !browser,
        kBrainOwnedDesktopCommand: () => false,
      },
      "@tauri-apps/api/core": {
        invoke: invoke ?? (async (command) => command === "settings_load_all" ? {} : assert.fail(`unexpected native command: ${command}`)),
      },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: fixture.baseUrl, token: "fixture-token", protocolVersion: "kbrain.agent.v1", managedLocal, storageId });
  try {
    return await task({ fixture, loader, storage: loader.loadModule("src/lib/settings/storage.ts") });
  } finally {
    runtime.clearKBrainRuntimeConnection();
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    await fixture.close();
  }
}

test("legacy local storage treats a null locale as an invalid saved preference", async () => {
  await withSettingsFixture({
    browser: false,
    localStorage: createMemoryLocalStorage({ [LOCAL_UI_SETTINGS_STORAGE_KEY]: JSON.stringify({ locale: null }) }),
    navigator: { languages: ["en-GB"], language: "en-GB" },
  }, async ({ storage }) => {
    assert.equal((await storage.loadPersistedSettings()).locale, "zh-CN");
  });
});

// retryErrorSettings is a local-only UI preference persisted in localStorage
// (not gateway-synced), so its read/write round-trip lives entirely in the
// local-ui settings path — no backend command is involved.

test("retryErrorSettings default to every Cloudflare preset when localStorage is empty", async () => {
  await withSettingsFixture({ browser: false }, async ({ storage }) => {
    const loaded = await storage.loadPersistedSettings();
    assert.deepEqual([...loaded.retryErrorSettings.presetStatusCodes].sort((a, b) => a - b), [520, 521, 522, 523, 525, 526, 527]);
    assert.deepEqual(loaded.retryErrorSettings.customPatterns, []);
  });
});

test("retryErrorSettings are read back from localStorage and normalized", async () => {
  await withSettingsFixture({
    browser: false,
    localStorage: createMemoryLocalStorage({ [LOCAL_UI_SETTINGS_STORAGE_KEY]: JSON.stringify({ retryErrorSettings: {
      presetStatusCodes: [525, 525, 999],
      customPatterns: ["SSL handshake failed", "  ssl handshake failed  ", ""],
    } }) }),
  }, async ({ storage }) => {
    const loaded = await storage.loadPersistedSettings();
    assert.deepEqual(loaded.retryErrorSettings.presetStatusCodes, [525]);
    assert.deepEqual(loaded.retryErrorSettings.customPatterns, ["SSL handshake failed"]);
  });
});

test("a missing retryErrorSettings field falls back to all presets (legacy snapshot)", async () => {
  await withSettingsFixture({
    browser: false,
    localStorage: createMemoryLocalStorage({ [LOCAL_UI_SETTINGS_STORAGE_KEY]: JSON.stringify({ theme: "dark" }) }),
  }, async ({ storage }) => {
    const loaded = await storage.loadPersistedSettings();
    assert.deepEqual([...loaded.retryErrorSettings.presetStatusCodes].sort((a, b) => a - b), [520, 521, 522, 523, 525, 526, 527]);
  });
});

test("sidebar shortcuts survive a local save and reload without changing resource activation", async () => {
  const commands = [];
  await withSettingsFixture({
    invoke: async (command) => { commands.push(command); return {}; },
  }, async ({ storage, fixture, loader }) => {
    const initial = await storage.loadPersistedSettings();
    assert.deepEqual(initial.customSettings.sidebarShortcuts, {
      skills: true, mcp: true, cron: true, planning: true, memory: true, "image-studio": true,
    });
    const hidden = { skills: false, mcp: true, cron: false, planning: false, memory: false, "image-studio": false };
    const settingsApi = loader.loadModule("src/lib/settings/index.ts");
    const next = settingsApi.updateCustomSettings(initial, { sidebarShortcuts: hidden });
    await storage.persistSettings(initial, next);
    const loaded = await storage.loadPersistedSettings();
    assert.deepEqual(loaded.customSettings.sidebarShortcuts, hidden);
    for (const key of ["skills", "mcp", "memory"]) assert.deepEqual(loaded[key], initial[key]);
    assert.deepEqual(commands, []);
    assert.deepEqual(fixture.requests.map((request) => request.method), ["GET", "GET", "GET", "GET"]);
  });
});

function credentialSnapshot(prefix) {
  const secret = field => `${prefix}-${field}-secret`;
  return {
    providers: [{ id: "old", type: "codex", apiKey: secret("key"), headers: { Authorization: secret("header") }, usageQuery: { apiKey: secret("usage"), headers: { Authorization: secret("usage-header") } } }],
    customProviders: [{ apiKey: secret("custom-key") }],
    backend: { token: secret("backend") },
    remote: { token: secret("remote") },
    stt: { providers: { tencent_cloud: { apiKey: secret("stt"), secretKey: secret("stt-key") } } },
    ssh: { hosts: [{ password: secret("ssh"), privateKey: secret("ssh-key") }] },
    mcp: { servers: [{ env: { API_KEY: secret("mcp-env") }, headers: { Authorization: secret("mcp-header") } }] },
    agents: [{ prompt: secret("agent-prompt") }],
    memory: { token: secret("memory") },
    modelFailover: { token: secret("failover") },
    system: { executionMode: "tools", workdir: "/repo/browser", systemProxy: { password: secret("proxy") }, workspaceResourceSettings: { "/repo": { projectPrompt: secret("project-prompt") } } },
    customSettings: { promptClarifyEnabled: false, composerContextDisplay: "both", rightDock: { width: 480, projects: { "/repo": { tools: { tunnel: { uiState: { token: secret("dock") } } } } } }, chatSidebar: { recentCollapsed: true, token: secret("sidebar") }, headers: { Authorization: secret("custom-header") }, usageQuery: { apiKey: secret("custom-usage") } },
    chatRuntimeControls: { thinkingEnabled: false, reasoning: "off", reasoningByModel: { [secret("model")]: "high" }, token: secret("controls") },
    theme: "dark", locale: "en-US",
  };
}

function assertBrowserWhitelist(localStorage, marker) {
  const raw = localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY);
  assert.ok(raw);
  assert.ok(!raw.includes(marker), "credentials and runtime prompt text must be removed from the stored JSON");
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ["chatRuntimeControls", "customSettings", "locale", "system", "theme"]);
  assert.deepEqual(Object.keys(saved.system).sort(), ["defaultTimeZone", "executionMode", "workdir"]);
  assert.deepEqual(saved.customSettings.rightDock.projects, {});
  assert.doesNotMatch(raw, /"(?:apiKey|headers|usageQuery|password|token|providers|customProviders|agents|remote|stt|ssh)"/);
  return saved;
}

test("browser settings saves never push a resolved time zone to Planning", async () => {
  // The calendar zone belongs to K-brain's own picker ("" follows the system); a resolved
  // zone sent from here would freeze "automatic" into a fixed zone.
  await withSettingsFixture({}, async ({ storage, fixture }) => {
    const prev = await storage.loadPersistedSettings();
    const custom = { ...prev, system: { ...prev.system, defaultTimeZone: "America/New_York" } };
    await storage.persistSettings(prev, custom);
    await storage.persistSettings(custom, { ...custom, system: { ...custom.system, defaultTimeZone: "" } });
    assert.equal(fixture.requests.filter(r => r.path === "/v1/planning").length, 0);
  });
});

test("K-brain browser load migrates credential-bearing snapshots before returning settings", async () => {
  const nativeUi = JSON.stringify({ theme: "light", locale: "zh-CN", skills: { selected: ["native-skill"] }, retryErrorSettings: { customPatterns: ["native preference"] }, selectedModel: { customProviderId: "native", model: "native-model" } });
  const localStorage = createMemoryLocalStorage({ [BROWSER_SETTINGS_STORAGE_KEY]: JSON.stringify(credentialSnapshot("legacy")), [LOCAL_UI_SETTINGS_STORAGE_KEY]: nativeUi });
  await withSettingsFixture({ localStorage }, async ({ storage }) => {
    const loaded = await storage.loadPersistedSettings();
    const saved = assertBrowserWhitelist(localStorage, "legacy-");
    assert.equal(loaded.customProviders[0].id, "backend-provider");
    assert.equal(loaded.customProviders[0].apiKey, "");
    assert.equal(loaded.customProviders[0].apiKeyConfigured, true);
    assert.equal(loaded.selectedModel.model, "backend-model");
    assert.equal(loaded.customSettings.promptClarifyEnabled, false);
    assert.equal(loaded.customSettings.chatSidebar.recentCollapsed, true);
    assert.equal(loaded.system.executionMode, "tools");
    assert.equal(loaded.system.workdir, "/repo/browser");
    assert.equal(loaded.theme, "dark");
    assert.equal(loaded.locale, "en-US");
    assert.deepEqual(loaded.customProviders[0].models.map((model) => model.id), ["backend-model"]);
    assert.equal(localStorage.getItem(LOCAL_UI_SETTINGS_STORAGE_KEY), nativeUi);
    await storage.loadPersistedSettings();
    assert.deepEqual(JSON.parse(localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY)), saved);
  });
});

test("K-brain browser persist keeps credentials in the backend and never in browser cache", async () => {
  const nativeUi = JSON.stringify({ theme: "light", locale: "zh-CN" });
  const localStorage = createMemoryLocalStorage({ [LOCAL_UI_SETTINGS_STORAGE_KEY]: nativeUi });
  const writes = [];
  const setItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => { writes.push({ key, value }); setItem(key, value); };
  await withSettingsFixture({ localStorage }, async ({ storage, fixture }) => {
    const prev = await storage.loadPersistedSettings();
    const next = { ...prev, ...credentialSnapshot("new"), customProviders: prev.customProviders.map((provider) => ({ ...provider, apiKey: "new-key-secret" })) };
    writes.length = 0;
    await storage.persistSettings(prev, next);
    const put = fixture.requests.find((request) => request.method === "PUT");
    assert.ok(put);
    assert.equal(put.headers.authorization, "Bearer fixture-token");
    assert.equal(put.body.providers[0].apiKey, "new-key-secret");
    assertBrowserWhitelist(localStorage, "new-");
    assert.deepEqual(writes.map((write) => write.key), [BROWSER_SETTINGS_STORAGE_KEY]);
    assert.ok(writes.every((write) => !write.value.includes("new-")));
    assert.equal(localStorage.getItem(LOCAL_UI_SETTINGS_STORAGE_KEY), nativeUi);
  });
});

for (const browser of [true, false]) {
  test(`K-brain MCP ${browser ? "browser" : "desktop"} settings load and save through the authenticated backend adapter`, async () => {
    const mcpSettings = {
      servers: [{ id: "backend-mcp", enabled: true, transport: "http", command: "", args: [], url: "https://mcp.invalid", timeoutMs: 60000 }],
      selected: ["backend-mcp"],
    };
    await withSettingsFixture({
      browser,
      kbrainBackend: true,
      fixtureOptions: { mcpSettings },
    }, async ({ storage, fixture }) => {
      const loaded = await storage.loadPersistedSettings();
      assert.deepEqual(loaded.mcp.servers.map((server) => server.id), ["backend-mcp"]);
      assert.deepEqual(loaded.mcp.selected, ["backend-mcp"]);
      const next = {
        ...loaded,
        mcp: {
          ...loaded.mcp,
          servers: [{ ...loaded.mcp.servers[0], enabled: false, description: "saved by backend" }],
        },
      };
      await storage.persistSettings(loaded, next);
      const mcpPut = fixture.requests.find((request) => request.method === "PUT" && request.path === "/v1/mcp");
      assert.ok(mcpPut, JSON.stringify(fixture.requests));
      assert.equal(mcpPut.headers.authorization, "Bearer fixture-token");
      assert.equal(mcpPut.body.servers[0].enabled, false);
      assert.equal(mcpPut.body.servers[0].description, "saved by backend");
      assert.equal(fixture.document().providers[0].id, "backend-provider");
      const reloaded = await storage.loadPersistedSettings();
      assert.equal(reloaded.mcp.servers[0].enabled, false);
      assert.equal(reloaded.mcp.servers[0].description, "saved by backend");
      assert.deepEqual(reloaded.mcp.selected, ["backend-mcp"]);
      assert.ok(fixture.requests.filter((request) => request.path === "/v1/mcp").every((request) => request.headers.authorization === "Bearer fixture-token"));
    });
  });

  test(`K-brain MCP ${browser ? "browser" : "desktop"} load and save failures reject instead of claiming success`, async () => {
    await withSettingsFixture({ browser, kbrainBackend: true, fixtureOptions: { mcpGetStatus: 503 } }, async ({ storage }) => {
      await assert.rejects(() => storage.loadPersistedSettings(), (error) => error.code === "load_failed" && error.message.includes("MCP load diagnostic"));
    });
    await withSettingsFixture({ browser, kbrainBackend: true, fixtureOptions: { mcpPutStatus: 503 } }, async ({ storage, fixture }) => {
      const loaded = await storage.loadPersistedSettings();
      const next = { ...loaded, mcp: { ...loaded.mcp, selected: ["failed-save"] } };
      await assert.rejects(() => storage.persistSettings(loaded, next), (error) => error.code === "save_failed" && error.message.includes("MCP save diagnostic"));
      assert.ok(fixture.requests.some((request) => request.method === "PUT" && request.path === "/v1/mcp"));
      assert.deepEqual((await storage.loadPersistedSettings()).mcp.selected, []);
    });
  });
}

test("managed desktop migrates missing legacy MCP servers without replacing backend records or resurrecting deletions", async () => {
  const legacy = { servers: [
    { id: "legacy", enabled: true, transport: "stdio", command: "legacy-server", args: ["--stdio"], env: { TOKEN: "legacy-secret" } },
    { id: "shared", enabled: true, transport: "stdio", command: "old-command" },
  ], selected: ["legacy", "shared"] };
  const backend = { servers: [{ id: "shared", enabled: false, transport: "stdio", command: "backend-command" }], selected: [] };
  await withSettingsFixture({
    browser: false, kbrainBackend: true, managedLocal: true,
    invoke: async (command) => command === "settings_load_all" ? { mcp: legacy } : {},
    fixtureOptions: { mcpSettings: backend },
  }, async ({ storage, fixture, loader }) => {
    const loaded = await storage.loadPersistedSettings();
    assert.deepEqual(loaded.mcp.servers.map(s => s.id), ["shared", "legacy"]);
    assert.equal(loaded.mcp.servers[0].command, "backend-command");
    assert.equal(loaded.mcp.servers[0].enabled, false);
    assert.deepEqual(loaded.mcp.selected, ["legacy"]);
    const put = fixture.requests.find(r => r.method === "PUT" && r.path === "/v1/mcp");
    assert.equal(put.body.servers[1].env.TOKEN, "legacy-secret");
    assert.equal(put.headers.authorization, "Bearer fixture-token");
    await storage.persistSettings(loaded, { ...loaded, mcp: backend });
    const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
    runtime.setKBrainRuntimeConnection({ baseUrl: fixture.baseUrl, token: "restarted-token", protocolVersion: "kbrain.agent.v1", managedLocal: true, storageId: "fixture-storage" });
    assert.deepEqual((await storage.loadPersistedSettings()).mcp.servers.map(s => s.id), ["shared"]);
    assert.equal(fixture.requests.filter(r => r.method === "PUT" && r.path === "/v1/mcp").length, 2);
  });
});

test("legacy MCP import retries failed writes and never imports desktop servers into an external backend", async () => {
  const legacy = { servers: [{ id: "legacy", enabled: true, command: "server", transport: "stdio" }], selected: [] };
  const localStorage = createMemoryLocalStorage();
  const options = { browser: false, kbrainBackend: true, managedLocal: true, localStorage, invoke: async command => command === "settings_load_all" ? { mcp: legacy } : {} };
  await withSettingsFixture({ ...options, fixtureOptions: { mcpPutStatus: 503 } }, async ({ storage }) => {
    await assert.rejects(() => storage.loadPersistedSettings(), /MCP save diagnostic/);
  });
  await withSettingsFixture(options, async ({ storage }) => {
    assert.deepEqual((await storage.loadPersistedSettings()).mcp.servers.map(s => s.id), ["legacy"]);
  });
  await withSettingsFixture({ ...options, managedLocal: false, localStorage: createMemoryLocalStorage() }, async ({ storage, fixture }) => {
    assert.equal((await storage.loadPersistedSettings()).mcp.servers.length, 0);
    assert.equal(fixture.requests.filter(r => r.method === "PUT" && r.path === "/v1/mcp").length, 0);
  });
});

test("K-brain prompt settings save through the authenticated adapter and reload with append/replace semantics", async () => {
  const workdir = "/repo/project";
  const localStorage = createMemoryLocalStorage({
    [BROWSER_SETTINGS_STORAGE_KEY]: JSON.stringify({ system: { workdir: "/repo/project" } }),
  });
  await withSettingsFixture({
    browser: true,
    kbrainBackend: true,
    localStorage,
    fixtureOptions: {
      promptDocument: {
        revision: 1,
        globalTemplates: [{ id: "review", name: "Review", description: "", prompt: "global review", enabled: true }],
        projectPrompts: { [workdir]: { workdir, prompt: "project policy", strategy: "append" } },
      },
    },
  }, async ({ storage, fixture, loader }) => {
    const settingsApi = loader.loadModule("src/lib/settings/index.ts");
    const loaded = await storage.loadPersistedSettings();
    assert.equal(loaded.agents[0].prompt, "global review");
    assert.equal(loaded.system.workspaceResourceSettings[workdir].projectPrompt, "project policy");
    assert.equal(loaded.system.workspaceResourceSettings[workdir].projectPromptStrategy, "append");
    const replaced = settingsApi.updateWorkspaceResourceSettings(loaded, workdir, {
      mode: "inherit", skillNames: [], mcpServerIds: [], projectPrompt: "replacement policy", projectPromptStrategy: "replace",
    });
    const switched = settingsApi.updateAgents(replaced, [{ ...replaced.agents[0], prompt: "new global review" }]);
    await storage.persistSettings(loaded, switched);
    const templatePut = fixture.requests.find((request) => request.method === "PUT" && request.path === "/v1/prompts/templates");
    const projectPut = fixture.requests.find((request) => request.method === "PUT" && request.path === "/v1/prompts/project");
    assert.ok(templatePut, JSON.stringify(fixture.requests));
    assert.ok(projectPut, JSON.stringify(fixture.requests));
    assert.equal(templatePut.headers.authorization, "Bearer fixture-token");
    assert.equal(projectPut.headers.authorization, "Bearer fixture-token");
    assert.equal(templatePut.body.templates[0].prompt, "new global review");
    assert.equal(projectPut.body.strategy, "replace");
    assert.equal(projectPut.body.prompt, "replacement policy");
    assert.equal((await loader.loadModule("src/lib/kbrain/prompts.ts").createKBrainPromptClient().expandMarkdown("review", ["src", "lib"], workdir)).text, "review src lib");
  });
});

test("native settings keep backend credentials separate from nonprovider preferences", async () => {
  const calls = [];
  const localStorage = createMemoryLocalStorage({ [BROWSER_SETTINGS_STORAGE_KEY]: "unrelated-browser-cache" });
  await withSettingsFixture({
    browser: false,
    localStorage,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "settings_load_all") return { system: { executionMode: "tools", workdir: "/native" }, mcp: { servers: [] } };
      return {};
    },
  }, async ({ storage, fixture }) => {
    const loaded = await storage.loadPersistedSettings();
    assert.equal(loaded.customProviders[0].apiKey, "");
    const next = { ...loaded, customProviders: loaded.customProviders.map((provider) => ({ ...provider, apiKey: "native-updated-key" })), system: { ...loaded.system, workdir: "/changed" } };
    await storage.persistSettings(loaded, next);
    const put = fixture.requests.find((request) => request.method === "PUT");
    assert.equal(put.body.providers[0].apiKey, "native-updated-key");
    const systemSave = calls.find((call) => call.command === "settings_save_system");
    assert.equal(systemSave.args.payload.workdir, "/changed");
    assert.deepEqual(calls.map((call) => call.command), ["settings_load_all", "settings_load_all", "settings_save_system"]);
    assert.equal(localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY), "unrelated-browser-cache");
  });
});

// Regression: a legacy provider K-brain rejects (shared model id with conflicting metadata) used
// to fail the whole load, so App fell back to default settings and the theme reset every launch.
test("a rejected legacy provider import does not fail the settings load", async () => {
  const localStorage = createMemoryLocalStorage({ [LOCAL_UI_SETTINGS_STORAGE_KEY]: JSON.stringify({ theme: "dark" }) });
  await withSettingsFixture({
    browser: false,
    kbrainBackend: true,
    localStorage,
    invoke: async (command) =>
      command === "settings_load_all"
        ? { providers: [{ id: "legacy-dup", name: "Old RightCode", type: "claude_code", baseUrl: "https://old.invalid", apiKey: "k", models: [{ id: "backend-model" }], activeModels: ["backend-model"] }] }
        : {},
    fixtureOptions: { putStatus: 400 },
  }, async ({ storage }) => {
    const loaded = await storage.loadPersistedSettings();
    assert.equal(loaded.theme, "dark");
    assert.deepEqual(loaded.customProviders.map((provider) => provider.id), ["backend-provider"]);
  });
});

// Regression: a provider save that K-brain rejects used to throw before the local UI write.
// failedProviderSave then retried (and failed) on every later save, so theme, locale and font
// preferences silently never reached storage and reverted on the next launch.
test("native UI preferences persist even when the K-brain provider save fails", async () => {
  const localStorage = createMemoryLocalStorage();
  await withSettingsFixture({
    browser: false,
    kbrainBackend: true,
    localStorage,
    invoke: async (command) => (command === "settings_load_all" ? {} : {}),
    fixtureOptions: { putStatus: 500 },
  }, async ({ storage, loader }) => {
    const settingsApi = loader.loadModule("src/lib/settings/index.ts");
    const loaded = settingsApi.normalizeSettings(await storage.loadPersistedSettings());
    const providerEdit = settingsApi.normalizeSettings({
      ...loaded,
      theme: "dark",
      customProviders: loaded.customProviders.map((provider) => ({ ...provider, name: "Renamed" })),
    });
    await assert.rejects(() => storage.persistSettings(loaded, providerEdit), (error) => error.code === "save_failed");
    assert.equal(JSON.parse(localStorage.getItem(LOCAL_UI_SETTINGS_STORAGE_KEY)).theme, "dark");

    // The pending provider retry still fails, but a pure UI change in the next save must land.
    const themeOnly = settingsApi.normalizeSettings({ ...providerEdit, theme: "light", locale: "en-US" });
    await assert.rejects(() => storage.persistSettings(providerEdit, themeOnly), (error) => error.code === "save_failed");
    const stored = JSON.parse(localStorage.getItem(LOCAL_UI_SETTINGS_STORAGE_KEY));
    assert.equal(stored.theme, "light");
    assert.equal(stored.locale, "en-US");
    assert.equal((await storage.loadPersistedSettings()).theme, "light");
  });
});

for (const operation of ["load", "save"]) {
  test(`K-brain browser ${operation} reports storage failures instead of claiming success`, async () => {
    const localStorage = createMemoryLocalStorage({ [BROWSER_SETTINGS_STORAGE_KEY]: JSON.stringify(credentialSnapshot("blocked")) });
    localStorage.setItem = () => { throw new Error("storage denied"); };
    await withSettingsFixture({ localStorage }, async ({ storage, loader }) => {
      const settingsApi = loader.loadModule("src/lib/settings/index.ts");
      const defaults = settingsApi.getDefaultSettings();
      await assert.rejects(operation === "load" ? storage.loadPersistedSettings() : storage.persistSettings(defaults, defaults),
        (error) => error.code === (operation === "load" ? "load_failed" : "save_failed") && error.message.includes("storage denied"));
    });
  });
}

for (const raw of ['{"apiKey":"corrupt-key-secret",', "null", '[{"headers":{"Authorization":"corrupt-key-secret"}}]']) {
  test(`K-brain browser load replaces invalid cache shape: ${raw}`, async () => {
    const nativeUi = JSON.stringify({ theme: "dark", locale: "en-US" });
    const localStorage = createMemoryLocalStorage({ [BROWSER_SETTINGS_STORAGE_KEY]: raw, [LOCAL_UI_SETTINGS_STORAGE_KEY]: nativeUi });
    await withSettingsFixture({ localStorage }, async ({ storage }) => {
      const loaded = await storage.loadPersistedSettings();
      assert.equal(loaded.theme, "dark");
      assert.equal(loaded.locale, "en-US");
      assert.equal(loaded.customProviders[0].id, "backend-provider");
      assert.equal(loaded.customProviders[0].apiKey, "");
      assertBrowserWhitelist(localStorage, "corrupt-key-secret");
      assert.equal(localStorage.getItem(LOCAL_UI_SETTINGS_STORAGE_KEY), nativeUi);
    });
  });
}
