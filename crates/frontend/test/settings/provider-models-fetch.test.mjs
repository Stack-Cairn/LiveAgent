import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const fetchInvokeCalls = [];
let nextInvokeResult = { data: [] };
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command, args) {
        if (command === "provider_models_fetch") {
          fetchInvokeCalls.push(args);
          return Promise.resolve(nextInvokeResult);
        }
        throw new Error(`unexpected invoke(${command})`);
      },
    },
  },
});
const providerUtils = loader.loadModule("src/pages/settings/providerUtils.ts");

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

test("fetchModelsFromApi delegates to the backend provider_models_fetch command", async () => {
  fetchInvokeCalls.length = 0;
  nextInvokeResult = { data: [{ id: "gpt-proxied" }] };
  const models = await providerUtils.fetchModelsFromApi(
    "codex",
    "https://relay.example.com/v1/responses",
    " test-key ",
    { useSystemProxy: true },
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-proxied"],
  );
  // 归一化在前端：命令收到的是已剥掉推理后缀的 base_url 和去空白的 key。
  assert.deepEqual(fetchInvokeCalls, [
    {
      provider_type: "codex",
      base_url: "https://relay.example.com/v1",
      api_key: "test-key",
      use_system_proxy: true,
    },
  ]);
});

test("fetchModelsFromApi surfaces backend payload errors and tolerates empty lists", async () => {
  nextInvokeResult = { error: "invalid api key" };
  await assert.rejects(
    providerUtils.fetchModelsFromApi("codex", "https://relay.example.com", "key"),
    /invalid api key/,
  );

  nextInvokeResult = {};
  assert.deepEqual(
    await providerUtils.fetchModelsFromApi("codex", "https://relay.example.com", "key"),
    [],
  );
});

test("fetchModelsFromApi canonicalizes a known 1M Claude model before display", async () => {
  nextInvokeResult = {
    data: [
      {
        id: "claude-opus-4-6",
        contextWindow: 999_999,
        maxOutputToken: 128_000,
      },
    ],
  };
  const [model] = await providerUtils.fetchModelsFromApi(
    "claude_code",
    "https://relay.example.com",
    "test-key",
  );
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(providerUtils.formatTokenCount(model.contextWindow), "1M");
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
