// K-brain web search fallback (capability web_search_fallback): when the composer may turn
// web search on, what Settings → Web search sends, and how the run gate follows it.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const fallback = loader.loadModule("@liveagent/ui/lib/providers/webSearchFallback.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");
const modelOptions = loader.loadModule("@liveagent/ui/lib/models/modelOptions.ts");

function webSearch(overrides = {}) {
  return {
    provider: "",
    maxResults: 0,
    apiKeyConfigured: false,
    available: false,
    reason: "web search provider is not configured",
    providers: ["tavily", "brave", "searxng", "bocha", "jina"],
    ...overrides,
  };
}

function withRecorded(state, task) {
  fallback.recordWebSearchFallbackState(state);
  try {
    return task();
  } finally {
    fallback.recordWebSearchFallbackState(null);
  }
}

test("the composer switch: native search, else a configured fallback, else blocked", () => {
  const available = { available: true, provider: "tavily" };
  const unconfigured = { available: false, provider: "" };
  const cases = [
    // [nativeSupported, fallback, usable, via, blocked]
    [true, null, true, "native", null],
    [true, unconfigured, true, "native", null],
    [true, available, true, "native", null],
    [false, null, false, null, "upgrade"],
    [false, undefined, false, null, "upgrade"],
    [false, unconfigured, false, null, "configure"],
    [false, { available: false, provider: "brave" }, false, null, "configure"],
    [false, available, true, "fallback", null],
  ];
  for (const [nativeSupported, state, usable, via, blocked] of cases) {
    const result = fallback.resolveWebSearchToggle({ nativeSupported, fallback: state });
    const label = JSON.stringify({ nativeSupported, state });
    assert.equal(result.usable, usable, label);
    assert.equal(result.via, via, label);
    assert.equal(result.blocked, blocked, label);
  }
  assert.equal(
    fallback.resolveWebSearchToggle({ nativeSupported: false, fallback: available })
      .fallbackProvider,
    "tavily",
  );
  // A key from the environment may leave the stored provider empty.
  assert.equal(
    fallback.resolveWebSearchToggle({
      nativeSupported: false,
      fallback: { available: true, provider: "" },
    }).fallbackProvider,
    "",
  );
});

test("the fallback needs the capability and a webSearch section", () => {
  const document = { webSearch: webSearch({ provider: "tavily", available: true }) };
  assert.equal(fallback.webSearchFallbackSupported(document, { web_search_fallback: 1 }), true);
  // Hosts that cannot read /v1/health rely on the section alone.
  assert.equal(fallback.webSearchFallbackSupported(document, null), true);
  assert.equal(fallback.webSearchFallbackSupported(document), true);
  // An explicit capability map without the flag wins over a stray section.
  assert.equal(fallback.webSearchFallbackSupported(document, { goal_control: 1 }), false);
  assert.equal(fallback.webSearchFallbackSupported(document, { web_search_fallback: 0 }), false);
  // Older K-brain: no section.
  assert.equal(fallback.webSearchFallbackSupported({}, { web_search_fallback: 1 }), false);
  assert.equal(fallback.webSearchFallbackSupported(null), false);
  // Malformed sections are treated as absent.
  assert.equal(fallback.webSearchFallbackSupported({ webSearch: { provider: "tavily" } }), false);
  assert.equal(fallback.webSearchFallbackSupported({ webSearch: [] }), false);

  assert.deepEqual(fallback.webSearchFallbackStateFrom(document, { web_search_fallback: 1 }), {
    available: true,
    provider: "tavily",
  });
  assert.equal(fallback.webSearchFallbackStateFrom(document, {}), null);
});

test("readWebSearchSettings keeps the documented fields and drops unknown values", () => {
  const read = fallback.readWebSearchSettings({
    provider: " SearXNG ",
    baseUrl: "http://127.0.0.1:8888",
    maxResults: 42,
    apiKeyConfigured: "yes",
    apiKeySource: "keychain",
    available: true,
    providers: ["tavily", "bing", "searxng"],
    apiKey: "must-not-surface",
  });
  assert.deepEqual(read, {
    provider: "searxng",
    baseUrl: "http://127.0.0.1:8888",
    maxResults: 10,
    apiKeyConfigured: false,
    apiKeySource: "",
    available: true,
    reason: "",
    providers: ["tavily", "searxng"],
  });
  assert.equal("apiKey" in read, false);
  assert.equal(fallback.readWebSearchSettings({ provider: "unknown", available: false }).provider, "");
  assert.deepEqual(
    fallback.readWebSearchSettings({ available: false }).providers,
    ["tavily", "brave", "searxng", "bocha", "jina"],
  );
  assert.equal(fallback.readWebSearchSettings({ available: "true" }), null);
});

test("the settings update carries only changed fields and never echoes a stored key", () => {
  const current = fallback.readWebSearchSettings(
    webSearch({
      provider: "tavily",
      apiKeyConfigured: true,
      apiKeySource: "config",
      available: true,
      reason: "",
    }),
  );
  const draft = fallback.webSearchDraftFrom(current);
  assert.deepEqual(draft, {
    provider: "tavily",
    apiKey: "",
    clearApiKey: false,
    baseUrl: "",
    maxResults: 5,
  });
  // Untouched draft: nothing to send. maxResults 0 (default) equals the shown 5.
  assert.equal(fallback.buildWebSearchSettingsUpdate(current, draft), null);

  // An empty key field keeps the stored key: no apiKey, no clearApiKey.
  assert.deepEqual(
    fallback.buildWebSearchSettingsUpdate(current, { ...draft, apiKey: "   ", maxResults: 8 }),
    { webSearch: { maxResults: 8 } },
  );
  // A new key is trimmed and sent once; clearApiKey never rides along with it.
  assert.deepEqual(
    fallback.buildWebSearchSettingsUpdate(current, {
      ...draft,
      apiKey: "  tvly-new  ",
      clearApiKey: true,
    }),
    { webSearch: { apiKey: "tvly-new" } },
  );
  // Clearing sends clearApiKey only when something is configured.
  assert.deepEqual(fallback.buildWebSearchSettingsUpdate(current, { ...draft, clearApiKey: true }), {
    webSearch: { clearApiKey: true },
  });
  const noKey = { ...current, apiKeyConfigured: false, apiKeySource: "" };
  assert.equal(
    fallback.buildWebSearchSettingsUpdate(noKey, { ...draft, clearApiKey: true }),
    null,
  );
  // Switching to SearXNG: provider and base URL (trimmed), nothing about keys.
  const update = fallback.buildWebSearchSettingsUpdate(current, {
    ...draft,
    provider: "searxng",
    baseUrl: " http://127.0.0.1:8888 ",
  });
  assert.deepEqual(update, {
    webSearch: { provider: "searxng", baseUrl: "http://127.0.0.1:8888" },
  });
  // Turning the service off sends the empty provider.
  assert.deepEqual(fallback.buildWebSearchSettingsUpdate(current, { ...draft, provider: "" }), {
    webSearch: { provider: "" },
  });
  // Read-only fields never appear in an update.
  for (const body of [update, fallback.buildWebSearchSettingsUpdate(current, { ...draft, maxResults: 3 })]) {
    for (const key of ["available", "reason", "providers", "apiKeyConfigured", "apiKeySource"]) {
      assert.equal(key in body.webSearch, false, key);
    }
  }
});

test("draft validation mirrors what K-brain rejects", () => {
  const base = { provider: "tavily", apiKey: "", clearApiKey: false, baseUrl: "", maxResults: 5 };
  assert.equal(fallback.validateWebSearchDraft(base), null);
  assert.equal(fallback.validateWebSearchDraft({ ...base, provider: "searxng" }), "baseUrlRequired");
  assert.equal(
    fallback.validateWebSearchDraft({ ...base, provider: "searxng", baseUrl: "http://127.0.0.1:8888" }),
    null,
  );
  assert.equal(fallback.validateWebSearchDraft({ ...base, baseUrl: "ftp://example.test" }), "baseUrlInvalid");
  assert.equal(fallback.validateWebSearchDraft({ ...base, baseUrl: "not a url" }), "baseUrlInvalid");
  for (const maxResults of [0, 11, 2.5, Number.NaN]) {
    assert.equal(fallback.validateWebSearchDraft({ ...base, maxResults }), "maxResults", String(maxResults));
  }
  assert.equal(fallback.validateWebSearchDraft({ ...base, maxResults: 1 }), null);
  assert.equal(fallback.validateWebSearchDraft({ ...base, maxResults: 10 }), null);
  // No service selected: nothing else matters except well-formed values.
  assert.equal(fallback.validateWebSearchDraft({ ...base, provider: "" }), null);
});

test("the status line names known problems and keeps K-brain's reason for the rest", () => {
  const read = (value) => fallback.readWebSearchSettings(webSearch(value));
  assert.deepEqual(fallback.webSearchStatus(read({ available: true, provider: "brave" })), {
    kind: "available",
  });
  assert.deepEqual(fallback.webSearchStatus(read({})), { kind: "noProvider" });
  assert.deepEqual(fallback.webSearchStatus(read({ provider: "searxng" })), {
    kind: "baseUrlRequired",
  });
  assert.deepEqual(fallback.webSearchStatus(read({ provider: "jina" })), { kind: "apiKeyRequired" });
  assert.deepEqual(
    fallback.webSearchStatus(
      read({ provider: "bocha", apiKeyConfigured: true, reason: "something new" }),
    ),
    { kind: "other", reason: "something new" },
  );
});

test("runs keep search on only where the composer would allow it", () => {
  const controls = { ...settings.getDefaultSettings().chatRuntimeControls, nativeWebSearchEnabled: true };
  const chatCompletions = {
    providerId: "codex",
    requestFormat: "openai-completions",
    modelId: "fixture-model",
  };
  const responses = { providerId: "codex", requestFormat: "openai-responses", modelId: "fixture-model" };

  // No fallback recorded: the local API rule decides.
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(controls, chatCompletions).nativeWebSearchEnabled,
    false,
  );
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(controls, responses).nativeWebSearchEnabled,
    true,
  );
  // K-brain's per-provider flag wins over the local rule, both ways.
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(controls, {
      ...chatCompletions,
      nativeWebSearchSupported: true,
    }).nativeWebSearchEnabled,
    true,
  );
  assert.equal(
    settings.normalizeChatRuntimeControlsForProvider(controls, {
      ...responses,
      nativeWebSearchSupported: false,
    }).nativeWebSearchEnabled,
    false,
  );
  // A configured fallback keeps search on for Chat Completions; an unconfigured one does not.
  withRecorded({ available: true, provider: "searxng" }, () => {
    assert.equal(
      settings.normalizeChatRuntimeControlsForProvider(controls, chatCompletions)
        .nativeWebSearchEnabled,
      true,
    );
    assert.equal(fallback.webSearchUsableForRun(false), true);
  });
  withRecorded({ available: false, provider: "searxng" }, () => {
    assert.equal(
      settings.normalizeChatRuntimeControlsForProvider(controls, chatCompletions)
        .nativeWebSearchEnabled,
      false,
    );
  });
  // A switch the user left off stays off.
  withRecorded({ available: true, provider: "tavily" }, () => {
    assert.equal(
      settings.normalizeChatRuntimeControlsForProvider(
        { ...controls, nativeWebSearchEnabled: false },
        chatCompletions,
      ).nativeWebSearchEnabled,
      false,
    );
  });
});

test("recorded state notifies subscribers only on real changes", () => {
  const seen = [];
  const unsubscribe = fallback.subscribeWebSearchFallbackState(() =>
    seen.push(fallback.getRecordedWebSearchFallbackState()),
  );
  try {
    const start = fallback.getWebSearchFallbackVersion();
    fallback.recordWebSearchFallbackState({ available: true, provider: "tavily" });
    fallback.recordWebSearchFallbackState({ available: true, provider: "tavily" });
    fallback.recordWebSearchFallbackState({ available: false, provider: "tavily" });
    fallback.recordWebSearchFallbackState(null);
    fallback.recordWebSearchFallbackState(null);
    assert.deepEqual(seen, [
      { available: true, provider: "tavily" },
      { available: false, provider: "tavily" },
      null,
    ]);
    assert.equal(fallback.getWebSearchFallbackVersion(), start + 3);
  } finally {
    unsubscribe();
  }
});

test("model options prefer K-brain's per-provider native search flag", () => {
  const provider = (overrides) => ({
    id: "route",
    name: "Route",
    type: "codex",
    requestFormat: "openai-completions",
    activeModels: ["fixture-model"],
    models: [{ id: "fixture-model" }],
    ...overrides,
  });
  const option = (overrides) =>
    modelOptions.buildModelOptions({ customProviders: [provider(overrides)] })[0]
      .nativeWebSearchSupported;
  assert.equal(option({}), false);
  assert.equal(option({ requestFormat: "openai-responses" }), true);
  assert.equal(option({ nativeWebSearchSupported: true }), true);
  assert.equal(option({ requestFormat: "openai-responses", nativeWebSearchSupported: false }), false);
});

test("K-brain's read-only native search flag survives normalization but is never pushed back", () => {
  const providerSettings = loader.loadModule("src/lib/kbrain/providerSettings.ts");
  const [fromKBrain] = providerSettings.appProvidersFromKBrain({
    providers: [
      {
        id: "relay",
        name: "Relay",
        type: "openai",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKeyConfigured: true,
        nativeWebSearchSupported: false,
        models: [{ id: "fixture-model", name: "fixture-model" }],
      },
    ],
  });
  assert.equal(fromKBrain.nativeWebSearchSupported, false);

  const previous = settings.normalizeSettings({
    ...settings.getDefaultSettings(),
    customProviders: [fromKBrain],
  });
  const next = { ...previous, customProviders: [{ ...fromKBrain, name: "Renamed relay" }] };
  const update = providerSettings.kBrainSettingsUpdateFromAppSettings(previous, next);
  assert.equal(update.providers.length, 1);
  assert.equal(update.providers[0].name, "Renamed relay");
  assert.equal("nativeWebSearchSupported" in update.providers[0], false);
  assert.equal("webSearch" in update, false);
});

test("Settings and the command palette list the web search section", () => {
  const palette = loader.loadModule("@liveagent/ui/lib/chat/commandPaletteActions.ts");
  const entry = palette.SHARED_COMMAND_PALETTE_SETTINGS_SECTIONS.find(
    (section) => section.id === "webSearch",
  );
  assert.deepEqual(entry, { id: "webSearch", labelKey: "settings.navWebSearch" });
  assert.equal(
    fallback.WEB_SEARCH_SERVICES.every((id) =>
      fallback.WEB_SEARCH_SERVICE_KEY_URLS[id].startsWith("https://"),
    ),
    true,
  );
});

test("the fallback web_search call reads as a search of its query", () => {
  const utils = loader.loadModule(
    "../agent-ui/src/components/chat/assistant-bubble/assistantBubbleUtils.ts",
  );
  const { getConciseToolTarget } = loader.loadModule(
    "../agent-ui/src/components/chat/assistant-bubble/conciseToolTarget.ts",
  );
  assert.equal(utils.getToolActivityCategory("web_search"), "search");
  assert.equal(utils.getToolMeta("web_search").category, "web");
  const target = getConciseToolTarget({
    toolCall: {
      type: "toolCall",
      id: "call-1",
      name: "web_search",
      arguments: { query: "LiveAgent  web search", max_results: 3 },
    },
  });
  assert.equal(target.text, "LiveAgent web search");
});
