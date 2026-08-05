import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const gatewayInvokeCalls = [];
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command, args) {
        if (command === "proxy_get_server_info") {
          return Promise.resolve({ baseUrl: "http://proxy.local:9999", token: "proxy-token" });
        }
        if (command === "gateway_provider_models") {
          gatewayInvokeCalls.push(args);
          return Promise.resolve({ data: [{ id: "gpt-proxied" }] });
        }
        throw new Error(`unexpected invoke(${command})`);
      },
    },
  },
});
const providerUtils = loader.loadModule("src/pages/settings/providerUtils.ts");

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

function withFetchStub(responder, run) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    calls.push({ url: String(url), options });
    return Promise.resolve(responder(String(url), calls.length));
  };
  return Promise.resolve()
    .then(() => run(calls))
    .finally(() => {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
    });
}

test("buildProviderModelsUrl defaults to /v1/models and falls back to official endpoints", () => {
  assert.equal(
    providerUtils.buildProviderModelsUrl("gemini", "https://relay.example.com", "default"),
    "https://relay.example.com/v1/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("gemini", "https://relay.example.com", "official"),
    "https://relay.example.com/v1beta/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl(
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta",
      "default",
    ),
    "https://generativelanguage.googleapis.com/v1/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl(
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta",
      "official",
    ),
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("claude_code", "https://relay.example.com", "default"),
    "https://relay.example.com/v1/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("claude_code", "https://relay.example.com", "official"),
    "https://relay.example.com/v1/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("codex", "https://relay.example.com/v1", "default"),
    "https://relay.example.com/v1/models",
  );
});

test("buildProviderModelsAttempts uses Authorization first and official auth second", () => {
  const attemptsByProvider = ["claude_code", "codex", "gemini", "xai"].map((type) => [
    type,
    providerUtils.buildProviderModelsAttempts(type, "test-key"),
  ]);

  for (const [type, attempts] of attemptsByProvider) {
    assert.equal(attempts[0].kind, "default", type);
    assert.equal(attempts[0].headers.Authorization, "Bearer test-key");
    assert.equal(attempts[0].headers["x-api-key"], undefined);
    assert.equal(attempts[0].headers["x-goog-api-key"], undefined);
  }

  // codex/xai 官方形式与首次尝试一致，收敛为一次；claude_code/gemini 带官方鉴权头重试。
  const attemptsFor = Object.fromEntries(attemptsByProvider);
  for (const type of ["codex", "xai"]) {
    assert.deepEqual(
      attemptsFor[type].map((attempt) => attempt.kind),
      ["default"],
      type,
    );
  }
  for (const type of ["claude_code", "gemini"]) {
    assert.deepEqual(
      attemptsFor[type].map((attempt) => attempt.kind),
      ["default", "official"],
      type,
    );
    assert.equal(attemptsFor[type][1].headers.Authorization, undefined);
  }
  assert.equal(attemptsFor.claude_code[1].headers["x-api-key"], "test-key");
  assert.equal(attemptsFor.claude_code[1].headers["anthropic-version"], "2023-06-01");
  assert.equal(attemptsFor.gemini[1].headers["x-goog-api-key"], "test-key");

  const inferenceOnlyHeaders = [
    "x-app",
    "user-agent",
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "session_id",
    "conversation_id",
  ];
  for (const [, attempts] of attemptsByProvider) {
    for (const attempt of attempts) {
      const headerNames = Object.keys(attempt.headers).map((name) => name.toLowerCase());
      assert.ok(!headerNames.some((name) => name.startsWith("x-stainless-")));
      for (const name of inferenceOnlyHeaders) assert.ok(!headerNames.includes(name), name);
    }
  }
});

test("provider model fetch identity changes when system proxy routing changes", () => {
  const direct = providerUtils.buildProviderModelsFetchKey(
    " https://relay.example.com/v1 ",
    " test-key ",
    false,
  );
  const proxied = providerUtils.buildProviderModelsFetchKey(
    "https://relay.example.com/v1",
    "test-key",
    true,
  );

  assert.equal(direct, "https://relay.example.com/v1||test-key||direct");
  assert.equal(proxied, "https://relay.example.com/v1||test-key||proxy");
  assert.notEqual(direct, proxied);
});

test("pickProviderModelsFailure prefers informative errors over missing-endpoint noise", () => {
  assert.deepEqual(
    providerUtils.pickProviderModelsFailure([
      { status: 401, message: "invalid api key" },
      { status: 404, message: "not found" },
    ]),
    { status: 401, message: "invalid api key" },
  );
  assert.deepEqual(
    providerUtils.pickProviderModelsFailure([
      { status: 404, message: "not found" },
      { status: 400, message: "api key invalid" },
    ]),
    { status: 400, message: "api key invalid" },
  );
  assert.deepEqual(
    providerUtils.pickProviderModelsFailure([
      { status: 404, message: "first" },
      { status: 404, message: "second" },
    ]),
    { status: 404, message: "second" },
  );
  assert.equal(providerUtils.pickProviderModelsFailure([]), null);
});

test("fetchModelsFromApi falls back to the official gemini endpoint on 404", async () => {
  await withFetchStub(
    (url) =>
      url.includes("/v1/models")
        ? jsonResponse(404, { error: "not found" })
        : jsonResponse(200, { models: [{ name: "models/gemini-2.5-pro" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "gemini",
        "https://generativelanguage.googleapis.com/v1beta",
        "test-key",
      );
      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.endsWith("/proxy/gemini/v1/models"));
      assert.ok(calls[1].url.endsWith("/proxy/gemini/v1beta/models"));
      assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
      assert.equal(calls[0].options.headers["x-goog-api-key"], undefined);
      assert.equal(calls[1].options.headers.Authorization, undefined);
      assert.equal(calls[1].options.headers["x-goog-api-key"], "test-key");
      assert.deepEqual(
        models.map((model) => model.id),
        ["gemini-2.5-pro"],
      );
    },
  );
});

test("fetchModelsFromApi returns the default /v1/models result without falling back", async () => {
  await withFetchStub(
    () => jsonResponse(200, { data: [{ id: "gpt-5" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "codex",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith("/proxy/codex/v1/models"));
      assert.deepEqual(
        models.map((model) => model.id),
        ["gpt-5"],
      );
    },
  );
});

test("fetchModelsFromApi falls back to official when the default list is empty", async () => {
  await withFetchStub(
    (url) =>
      url.includes("/v1/models")
        ? jsonResponse(200, { data: [] })
        : jsonResponse(200, { models: [{ name: "models/gemini-2.5-flash" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "gemini",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(
        models.map((model) => model.id),
        ["gemini-2.5-flash"],
      );
    },
  );
});

test("fetchModelsFromApi surfaces the informative failure when every attempt fails", async () => {
  await withFetchStub(
    (url) =>
      url.includes("/v1/models")
        ? jsonResponse(401, { error: "invalid api key" })
        : jsonResponse(404, { error: "not found" }),
    async (calls) => {
      await assert.rejects(
        providerUtils.fetchModelsFromApi("gemini", "https://relay.example.com", "test-key"),
        /invalid api key/,
      );
      assert.equal(calls.length, 2);
    },
  );
});

test("fetchModelsFromApi retries claude_code with official anthropic auth", async () => {
  await withFetchStub(
    (_url, callIndex) =>
      callIndex === 1
        ? jsonResponse(401, { error: "authorization rejected" })
        : jsonResponse(200, { data: [{ id: "claude-opus-4-8" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "claude_code",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(calls.length, 2);
      assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
      assert.equal(calls[0].options.headers["x-api-key"], undefined);
      assert.equal(calls[1].options.headers.Authorization, undefined);
      assert.equal(calls[1].options.headers["x-api-key"], "test-key");
      assert.deepEqual(
        models.map((model) => model.id),
        ["claude-opus-4-8"],
      );
    },
  );
});

test("fetchModelsFromApi requests OpenAI-compatible providers exactly once", async () => {
  for (const type of ["codex", "xai"]) {
    await withFetchStub(
      () => jsonResponse(503, { error: "temporary failure" }),
      async (calls) => {
        // 官方形式与首次尝试完全一致，失败后不得原样重发同一请求。
        await assert.rejects(
          providerUtils.fetchModelsFromApi(type, `https://${type}.example.com/v1`, "test-key"),
          /temporary failure/,
        );
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.endsWith(`/proxy/${type}/v1/models`));
        assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
      },
    );
  }
});

test("fetchModelsFromApi canonicalizes a known 1M Claude model before display", async () => {
  await withFetchStub(
    () =>
      jsonResponse(200, {
        data: [
          {
            id: "claude-opus-4-6",
            contextWindow: 999_999,
            maxOutputToken: 128_000,
          },
        ],
      }),
    async () => {
      const [model] = await providerUtils.fetchModelsFromApi(
        "claude_code",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(model.contextWindow, 1_000_000);
      assert.equal(providerUtils.formatTokenCount(model.contextWindow), "1M");
    },
  );
});

test("gateway WebUI forwards the system proxy choice to desktop model fetching", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { documentElement: { dataset: { liveagentWebui: "gateway" } } };
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return key === "liveagent.gateway.token" ? "gateway-token" : null;
      },
    },
  };
  gatewayInvokeCalls.length = 0;
  try {
    const models = await providerUtils.fetchModelsFromApi(
      "codex",
      "https://relay.example.com/v1",
      "test-key",
      { useSystemProxy: true },
    );
    assert.deepEqual(
      models.map((model) => model.id),
      ["gpt-proxied"],
    );
    assert.deepEqual(gatewayInvokeCalls, [
      {
        type: "codex",
        base_url: "https://relay.example.com/v1",
        api_key: "test-key",
        use_system_proxy: true,
      },
    ]);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
test("formatTokenCount uses M units without changing K units", () => {
  assert.equal(providerUtils.formatTokenCount(999), "999");
  assert.equal(providerUtils.formatTokenCount(1_000), "1K");
  assert.equal(providerUtils.formatTokenCount(200_000), "200K");
  assert.equal(providerUtils.formatTokenCount(999_999), "1000K");
  assert.equal(providerUtils.formatTokenCount(1_000_000), "1M");
  assert.equal(providerUtils.formatTokenCount(1_500_000), "1.5M");
  assert.equal(providerUtils.formatTokenCount(2_000_000), "2M");
  const opus = providerUtils.createDraftModelConfig("claude_code", "claude-opus-4-6");
  const haiku = providerUtils.createDraftModelConfig("claude_code", "claude-haiku-4-5");
  assert.equal(providerUtils.formatTokenCount(opus.contextWindow), "1M");
  assert.equal(providerUtils.formatTokenCount(haiku.contextWindow), "200K");
});

test("normalizeFetchedModels preserves owned_by metadata and old entries remain compatible", () => {
  const [legacyModel] = providerUtils.normalizeFetchedModels([{ id: "relay-model" }], "codex");
  assert.equal(legacyModel.id, "relay-model");
  assert.equal(legacyModel.ownedBy, undefined);

  const [ownedModel] = providerUtils.normalizeFetchedModels(
    [{ id: "relay-model", ownedBy: " ", owned_by: " Anthropic " }],
    "codex",
  );
  assert.equal(ownedModel.id, "relay-model");
  assert.equal(ownedModel.ownedBy, "Anthropic");
});

test("mergeFetchedModels enriches existing settings with fetched owner metadata", () => {
  assert.deepEqual(
    providerUtils.mergeFetchedModels(
      [
        {
          id: "relay-model",
          contextWindow: 128_000,
          maxOutputToken: 16_384,
          ownedBy: "anthropic",
        },
      ],
      [
        {
          id: "relay-model",
          contextWindow: 777_000,
          maxOutputToken: 9_999,
        },
      ],
    ),
    [
      {
        id: "relay-model",
        contextWindow: 777_000,
        maxOutputToken: 9_999,
        ownedBy: "anthropic",
      },
    ],
  );
});

test("mergeFetchedModels immediately normalizes a stale 1000K context to 1M", () => {
  const [model] = providerUtils.mergeFetchedModels(
    [
      {
        id: "claude-opus-4-6",
        contextWindow: 1_000_000,
        maxOutputToken: 128_000,
      },
    ],
    [
      {
        id: "claude-opus-4-6",
        contextWindow: 999_999,
        maxOutputToken: 64_000,
      },
    ],
  );
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxOutputToken, 64_000);
  assert.equal(providerUtils.formatTokenCount(model.contextWindow), "1M");
});

test("model bulk helpers count and apply only selected active states", () => {
  const activeModels = new Set(["enabled-model", "untouched-model"]);
  const selectedModels = new Set(["enabled-model", "disabled-model"]);

  assert.deepEqual(providerUtils.getModelBulkActionCounts(selectedModels, activeModels), {
    enableCount: 1,
    disableCount: 1,
  });
  assert.deepEqual(
    [...providerUtils.applyModelBulkActiveState(activeModels, selectedModels, true)].sort(),
    ["disabled-model", "enabled-model", "untouched-model"],
  );
  assert.deepEqual(
    [...providerUtils.applyModelBulkActiveState(activeModels, selectedModels, false)].sort(),
    ["untouched-model"],
  );
  assert.deepEqual([...activeModels].sort(), ["enabled-model", "untouched-model"]);
});
