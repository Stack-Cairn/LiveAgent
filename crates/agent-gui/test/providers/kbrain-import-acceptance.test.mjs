import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/provider-import-acceptance.json", import.meta.url), "utf8"));
const publicProvider = (provider) => ({
  ...provider,
  apiKey: undefined,
  apiKeyConfigured: true,
  models: provider.models.map((model) => ({ provider: provider.id, ...model })),
});

// The HTTP fixture is the shipped K-brain wire contract; provider source data is returned only by the real import commands mocked below.
test("CC Switch and Cherry original import controls save, reload, discover and switch chat through K-brain", { timeout: 30000 }, async (t) => {
  let document = { version: "kbrain.agent.v1", mode: "kbrain", defaultProvider: "", defaultModel: "", providers: [], models: [] };
  const sessions = new Map();
  const requests = [];
  const upstreamRequests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/settings" && req.method === "GET") return json(200, document);
    if (req.url?.startsWith("/v1/prompts") && req.method === "GET") return json(200, { revision: 1, globalTemplates: [], projectPrompt: "", projectPromptStrategy: "append" });
    if (req.url === "/v1/mcp" && req.method === "GET") return json(200, { servers: [], selected: [] });
    if (req.url === "/v1/settings" && req.method === "PUT") {
      document = {
        ...document,
        providers: (body.providers ?? []).map((provider) => {
          const previous = document.providers.find((item) => item.id === provider.id);
          return { ...provider, apiKey: provider.apiKey ?? previous?.apiKey ?? "", apiKeyConfigured: provider.clearApiKey ? false : Boolean(provider.apiKey ?? previous?.apiKey ?? provider.apiKeyConfigured), models: (provider.models ?? []).map((model) => ({ provider: provider.id, ...model })) };
        }),
      };
      document.models = document.providers.flatMap((provider) => provider.activeModels.map((id) => ({ provider: provider.id, model: id, ...provider.models.find((model) => model.id === id) })));
      return json(200, { ...document, providers: document.providers.map(publicProvider) });
    }
    if (req.url === "/v1/models" && req.method === "GET") return json(200, { models: document.models });
    const discovery = req.url.match(/^\/v1\/settings\/providers\/([^/]+)\/models$/);
    if (discovery && req.method === "POST") {
      const provider = document.providers.find((item) => item.id === decodeURIComponent(discovery[1]));
      const providerId = provider?.id ?? decodeURIComponent(discovery[1]);
      upstreamRequests.push({ provider: providerId, headers: req.headers, body });
      const source = providerId.startsWith("ccswitch") ? "cc" : "cherry";
      return json(200, { version: "kbrain.agent.v1", provider: providerId, models: [{ id: `${source}-first`, contextWindow: 65536, maxOutputToken: 1024 }, { id: `${source}-second`, contextWindow: 65536, maxOutputToken: 1024 }] });
    }
    if (req.url === "/v1/sessions" && req.method === "POST") {
      const id = `session-${sessions.size + 1}`;
      sessions.set(id, { id, model: body.model, messages: body.messages ?? [], seq: 1 });
      return json(201, sessions.get(id));
    }
    const history = req.url.match(/^\/v1\/sessions\/([^/]+)\/history\?/);
    if (history && req.method === "GET") { const value = sessions.get(history[1]); return json(200, { version: "kbrain.agent.v1", conversation_id: history[1], revision: "fixture-revision", session: { ...value, revision: "fixture-revision", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, messages: value.messages, active_messages: value.messages, message_offsets: value.messages.map((_, index) => index), oldest_offset: 0, has_more: false, next_before_offset: null }); }
    const session = req.url.match(/^\/v1\/sessions\/([^/]+)$/);
    if (session && req.method === "GET") return json(200, sessions.get(session[1]));
    if (session && req.method === "PATCH") { const value = sessions.get(session[1]); value.model = body.model; return json(200, value); }
    const run = req.url.match(/^\/v1\/sessions\/([^/]+)\/runs$/);
    if (run && req.method === "POST") {
      const value = sessions.get(run[1]);
      value.model = body.model;
      const runId = `run-${value.seq}`;
      value.messages.push({ role: "user", content: [{ type: "text", text: body.prompt }] }, { role: "assistant", content: [{ type: "text", text: `reply:${body.model.model}` }], model: body.model.model, provider: body.model.provider });
      value.seq += 4;
      return json(202, { version: "kbrain.agent.v1", conversation_id: run[1], run_id: runId, accepted_seq: value.seq - 4 });
    }
    const events = req.url.match(/^\/v1\/sessions\/([^/]+)\/events\?after_seq=(\d+)$/);
    if (events && req.method === "GET") {
      const value = sessions.get(events[1]);
      const runId = `run-${Number(events[2])}`;
      const sequence = Number(events[2]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (seq, type, payload) => `data: ${JSON.stringify({ version: "kbrain.agent.v1", seq, conversation_id: events[1], run_id: runId, type, created_at: new Date().toISOString(), payload })}\n\n`;
      res.end(event(sequence + 1, "assistant.text.delta", { text: `reply:${value.model.model}` }) + event(sequence + 2, "assistant.message.created", { role: "assistant", content: [{ type: "text", text: `reply:${value.model.model}` }], model: value.model.model, provider: value.model.provider }) + event(sequence + 3, "run.completed", { state: "completed" }));
      return;
    }
    json(404, { error: `unexpected K-brain request ${req.method} ${req.url}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });

  const ccs = { ...fixture.ccs.expected, id: "ccswitch-acceptance-cc", name: "CC 验收（ccswitch）" };
  const cherry = { ...fixture.cherry.expected, id: "cherry-studio-acceptance-cherry-openai-chat", name: "Cherry 验收（Cherry Studio）" };
  const nativeCommands = [];
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
    "@liveagent/app/shims/tauriCore": { invoke: async (command) => {
      nativeCommands.push(command);
      if (command === "settings_list_ccswitch_providers") return { status: "ok", providers: [ccs] };
      if (command === "settings_list_cherry_studio_providers") return { status: "ok", version: "2.x", providers: [cherry] };
      assert.fail(`unexpected native command ${command}`);
    } },
  } });
  t.after(() => env.cleanup());
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const cache = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, String(value)), removeItem: (key) => cache.delete(key) } });
  t.after(() => oldStorage ? Object.defineProperty(globalThis, "localStorage", oldStorage) : delete globalThis.localStorage);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { assert.equal(new URL(url).origin, baseUrl); return oldFetch(url, init); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const runtime = env.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  const settingsApi = env.loadModule("src/lib/settings/index.ts");
  const storage = env.loadModule("src/lib/settings/storage.ts");
  const { ProviderSettingsExtension, discoverProviderModels } = env.loadModule("src/agent-ui-adapters/providerSettings.tsx");
  const { projectKBrainProviders } = env.loadModule("src/lib/kbrain/catalog.ts");
  let current = settingsApi.getDefaultSettings();
  let saves = 0;
  let saveError;
  let pending = Promise.resolve();
  const domDocument = env.dom.window.document;
  const host = domDocument.body.appendChild(domDocument.createElement("div"));
  const root = env.createRoot(host);
  const render = () => root.render(env.React.createElement(ProviderSettingsExtension, { settings: current, setSettings: (updater) => { const previous = current; current = updater(current); pending = pending.then(() => storage.persistSettings(previous, current)).then(() => { saves += 1; }).catch((error) => { saveError = error; }); render(); } }));
  const waitFor = async (count) => { const deadline = Date.now() + 10000; while (saves < count) { if (saveError) throw saveError; assert.ok(Date.now() < deadline); await env.act(async () => new Promise((resolve) => setTimeout(resolve, 20))); } await pending; };
  const click = async (text, contains = false) => { const node = [...domDocument.querySelectorAll("button")].find((item) => contains ? item.textContent.includes(text) : item.textContent.trim() === text || item.getAttribute("aria-label") === text); assert.ok(node && !node.disabled, `missing button ${text}`); await env.act(async () => node.click()); };
  await env.act(async () => render());
  await click("settings.importProviders"); await click("CC Switch", true); await env.act(async () => domDocument.querySelector('input[type="checkbox"]').click()); await click("导入 1 项"); await waitFor(2);
  await click("关闭"); await click("settings.importProviders"); await click("Cherry Studio", true); await click("全选可用项"); await click("同步 1 个"); await waitFor(4);
  assert.deepEqual(nativeCommands, ["settings_list_ccswitch_providers", "settings_list_cherry_studio_providers"]);
  const importedProviders = current.customProviders.filter((provider) => provider.id.startsWith("ccswitch-") || provider.id.startsWith("cherry-studio-"));
  assert.equal(importedProviders.length, 2);
  const reloaded = await storage.loadPersistedSettings();
  const reloadedImported = reloaded.customProviders.filter((provider) => provider.id.startsWith("ccswitch-") || provider.id.startsWith("cherry-studio-"));
  assert.equal(reloadedImported.length, 2);
  for (const provider of reloadedImported) {
    assert.equal(provider.apiKey, ""); assert.equal(provider.apiKeyConfigured, true);
    const models = await discoverProviderModels({ ...provider, providerId: provider.id });
    assert.deepEqual(models.map((model) => model.id).sort(), provider.id.startsWith("ccswitch") ? ["cc-first", "cc-second"] : ["cherry-first", "cherry-second"]);
  }
  const { createKBrainClient } = env.loadModule("src/lib/kbrain/client.ts");
  const client = createKBrainClient();
  const catalog = projectKBrainProviders(await client.listModels(), reloadedImported);
  assert.equal(catalog.length, 2); assert.ok(catalog.every((provider) => provider.models.length === 2));
  const { runTextConversationTurn } = env.loadModule("src/pages/chat/turns/runTextConversationTurn.ts");
  const { createConversationStateFromContext } = env.loadModule("src/lib/chat/conversation/conversationState.ts");
  let state = createConversationStateFromContext({ messages: [] });
  for (const [index, provider] of catalog.entries()) {
    const model = provider.id.startsWith("ccswitch") ? "cc-second" : "cherry-second";
    const context = { messages: [{ role: "user", content: `turn-${index}`, timestamp: Date.now() }] };
    await runTextConversationTurn({ providerId: provider.type, model, selectedModel: { customProviderId: provider.id, model }, runtime: { backend: "kbrain" }, sessionId: "acceptance", conversationId: "acceptance", conversationCwd: "/tmp", clientRequestId: `request-${index}`, createdAt: 1, fallbackTitle: "供应商设置", titlePromise: null, transcriptStore: {}, cancellation: { userStop: new AbortController() }, buildPreparedContext: () => context, getNextConversationState: () => state, applyConversationState: (next) => { state = next; }, batchLiveRoundsUpdate() {}, updateToolStatus() {}, updateGatewayBridgeToolStatus() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {}, persistConversationWithHistorySync: async () => true, gatewayBridgeEvents: { queueToken() {}, queueEvent() {}, queueToolStatus() {}, emitError: (error) => { throw error; } }, hookLifecycle: Object.fromEntries(["startAgent", "startTurn", "ensureMessageEnded", "endTurn", "endAgent"].map((key) => [key, () => {}])) });
    const session = await client.getSession("session-1");
    assert.deepEqual(session.model, { provider: provider.id, model });
    assert.equal(session.messages.at(-1).content[0].text, `reply:${model}`);
  }
  assert.deepEqual(requests.filter((request) => request.method === "PUT").length, 4);
  assert.ok(cache.size > 0); assert.doesNotMatch(JSON.stringify([...cache.values()]), /acceptance-secret|header-secret/);
  assert.ok(requests.some((request) => request.method === "GET" && request.path === "/v1/models"));
  await pending;
  await env.act(async () => root.unmount()); host.remove();
});
