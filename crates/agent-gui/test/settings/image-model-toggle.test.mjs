import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 供应商模型「生图模型」开关：imageAdapter 是用户选择（缺失 = 自动识别），
// imageModel 是 K-brain 回传的只读生效结果，只有新版 K-brain 才会回传。
const loader = createTsModuleLoader();
const { normalizeProviderModelConfig } = loader.loadModule("src/lib/settings/index.ts");
const { kBrainSettingsUpdateFromLegacyProviders } = loader.loadModule(
  "src/lib/kbrain/providerSettings.ts",
);
// providerUtils 依赖 tauri invoke；这里只用纯函数，mock 仅为满足模块加载。
const providerUtilsLoader = createTsModuleLoader({
  mocks: { "@tauri-apps/api/core": { invoke: async () => ({}) } },
});
const { applyModelImageMode, getModelImageMode, modelIsImage } = providerUtilsLoader.loadModule(
  "@liveagent/ui/pages/settings/providerUtils.ts",
);

const base = { contextWindow: 8192, maxOutputToken: 1024, limitsSource: "user" };

test("loading keeps the image toggle and K-brain's effective result", () => {
  const model = normalizeProviderModelConfig(
    { id: "gpt-image-2.5-flare", ...base, imageAdapter: "enabled", imageModel: true },
    "codex",
  );
  assert.equal(model.imageAdapter, "enabled");
  assert.equal(model.imageModel, true);
});

test("loading drops unknown toggle values and non-boolean results", () => {
  const model = normalizeProviderModelConfig(
    { id: "m", ...base, imageAdapter: "made-up", imageModel: "yes" },
    "codex",
  );
  assert.equal("imageAdapter" in model, false);
  assert.equal("imageModel" in model, false);
});

test("the three modes map to imageAdapter and back", () => {
  const model = { id: "m", ...base, imageModel: false };
  assert.equal(getModelImageMode(model), "auto");
  const on = applyModelImageMode(model, "on");
  assert.equal(on.imageAdapter, "enabled");
  assert.equal(getModelImageMode(on), "on");
  const off = applyModelImageMode(on, "off");
  assert.equal(off.imageAdapter, "disabled");
  assert.equal(getModelImageMode(off), "off");
  const auto = applyModelImageMode(off, "auto");
  assert.equal("imageAdapter" in auto, false);
  // A concrete protocol written by K-brain counts as "yes".
  assert.equal(getModelImageMode({ ...model, imageAdapter: "google-generate-content-image" }), "on");
});

test("the row badge follows the user's choice, else K-brain's guess", () => {
  assert.equal(modelIsImage({ id: "a", ...base, imageModel: true }), true);
  assert.equal(modelIsImage({ id: "b", ...base, imageModel: false }), false);
  assert.equal(modelIsImage({ id: "c", ...base, imageModel: true, imageAdapter: "disabled" }), false);
  assert.equal(modelIsImage({ id: "d", ...base, imageModel: false, imageAdapter: "enabled" }), true);
  assert.equal(modelIsImage({ id: "e", ...base }), false);
});

test("saving sends auto as an explicit clear, only to a K-brain that knows the toggle", () => {
  const provider = {
    id: "p",
    name: "P",
    type: "codex",
    baseUrl: "https://relay.invalid/v1",
    apiKey: "",
    apiKeyConfigured: true,
    models: [
      { id: "auto", ...base, imageModel: true },
      { id: "off", ...base, imageModel: true, imageAdapter: "disabled" },
      { id: "old", ...base },
    ],
    activeModels: ["auto", "off", "old"],
  };
  const models = kBrainSettingsUpdateFromLegacyProviders([provider], [provider]).providers[0].models;
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  // K-brain keeps an omitted field, so "auto" must clear the stored choice.
  assert.equal(byId.auto.imageAdapter, "");
  assert.equal(byId.off.imageAdapter, "disabled");
  assert.equal("imageAdapter" in byId.old, false);
});

test("loading rejects near-miss toggle values instead of guessing", () => {
  for (const imageAdapter of [" enabled", "Enabled", "ENABLED", "true", "", null, 1]) {
    const model = normalizeProviderModelConfig({ id: "m", ...base, imageAdapter }, "codex");
    assert.equal("imageAdapter" in model, false, `kept ${JSON.stringify(imageAdapter)}`);
    assert.equal(getModelImageMode(model), "auto");
  }
  // A null result (not a boolean) must not count as "this K-brain knows the toggle".
  const model = normalizeProviderModelConfig({ id: "m", ...base, imageModel: null }, "codex");
  assert.equal("imageModel" in model, false);
});

test("the same model ID under two providers keeps separate choices", () => {
  const provider = (id, imageAdapter) => ({
    id,
    name: id,
    type: "codex",
    baseUrl: `https://${id}.invalid/v1`,
    apiKey: "",
    apiKeyConfigured: true,
    models: [{ id: "agnes-image-2.5-flash", ...base, imageModel: true, ...(imageAdapter ? { imageAdapter } : {}) }],
    activeModels: ["agnes-image-2.5-flash"],
  });
  const providers = [provider("agnes-cn", "disabled"), provider("agnes-global")];
  const pushed = kBrainSettingsUpdateFromLegacyProviders(providers, providers).providers;
  assert.equal(pushed.find((p) => p.id === "agnes-cn").models[0].imageAdapter, "disabled");
  assert.equal(pushed.find((p) => p.id === "agnes-global").models[0].imageAdapter, "");
});
